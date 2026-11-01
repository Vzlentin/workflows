/**
 * The Pi extension: the `workflow` tool and the `/workflows` command. Each run is a child process of the `workflows`
 * command of `@vzlentin/workflows`, the dependency of this package, so a run started in Pi is a normal run that
 * `workflows resume` also continues. The `.bin` folder that holds its `workflows` command goes last on `PATH`.
 */
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, delimiter, dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { type Static, Type } from "@earendil-works/pi-ai";
import type {
	AgentToolResult,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ExtensionUIContext,
	RegisteredCommand,
	Theme,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Value } from "typebox/value";
import type { Output, Saved, WorkflowCall, WorkflowOutcome } from "../src/tool.ts";
import { MARKS, parseRun, RunView } from "./run-view.ts";

const WORKFLOWS_PACKAGE = "@vzlentin/workflows";

/** The tool module of the workflows package, `dist/tool.js`, or `src/tool.ts` in the tests. */
type ToolModule = typeof import("../src/tool.ts");

/** The arguments of a call while it streams, which Pi has not checked yet, so any field can be missing. */
type PartialCall = Omit<WorkflowCall, "save"> & { save?: Partial<NonNullable<WorkflowCall["save"]>> };

/**
 * The `details` of each update and of the result, so the steps draw the same after a reload. `steps` are the progress
 * lines that the command drew last, then any other stderr line, such as a warning.
 */
function detailsOf(tool: ToolModule) {
	return Type.Object({ steps: Type.Array(Type.String()), outcome: Type.Optional(tool.OUTCOME) });
}

type WorkflowDetails = Static<ReturnType<typeof detailsOf>>;

/** The part of the details that a result of an older session must have to draw its steps. */
const STEPS = Type.Object({ steps: Type.Array(Type.String()) });

const PROGRESS = Type.Object({ progress: Type.Array(Type.Unknown()), status: Type.Optional(Type.String()) });

/** The entry that a background call records, so a later start of the session watches the run again. */
const STARTED_ENTRY = Type.Object({
	type: Type.Literal("custom"),
	customType: Type.Literal("workflow-background"),
	/** Without `workflow`, the widget shows `?` for the run. */
	data: Type.Object({ runId: Type.String(), cwd: Type.String(), workflow: Type.Optional(Type.String()) }),
});

/** The entry that the watcher records after it posts the outcome of a background run. */
const ENDED_ENTRY = Type.Object({
	type: Type.Literal("custom"),
	customType: Type.Literal("workflow-background-end"),
	data: Type.Object({ runId: Type.String() }),
});

/**
 * The lines and the status of a `{"progress":[...]}` stderr line of `workflows --json`, or undefined for any other
 * line.
 */
function progressLines(line: string): { lines: string[]; status: string | undefined } | undefined {
	if (!line.startsWith('{"progress":')) return undefined;

	try {
		const parsed = JSON.parse(line);

		return Value.Check(PROGRESS, parsed) ? { lines: parsed.progress.map(String), status: parsed.status } : undefined;
	} catch {
		return undefined;
	}
}

/** Runs `command` with `args` in `cwd`; each stderr line goes to `progress`, and `signal` sends SIGINT, which detaches. */
async function runCli(
	command: readonly string[],
	args: readonly string[],
	cwd: string,
	options: {
		stdin?: string | undefined;
		signal?: AbortSignal | undefined;
		progress?: (line: string) => void;
	},
): Promise<Output> {
	const [program = "", ...prefix] = command;
	const child = spawn(program, [...prefix, ...args], { cwd, stdio: ["pipe", "pipe", "pipe"] });
	child.stdin.on("error", () => {});
	const stdout: string[] = [];
	const stderr: string[] = [];
	const out = createInterface({ input: child.stdout });
	const err = createInterface({ input: child.stderr });
	out.on("line", (line) => stdout.push(line));
	err.on("line", (line) => {
		stderr.push(line);
		options.progress?.(line);
	});
	const interrupt = () => child.kill("SIGINT");
	options.signal?.addEventListener("abort", interrupt, { once: true });

	try {
		child.stdin.end(options.stdin ?? "");
		await Promise.all([once(child, "close"), once(out, "close"), once(err, "close")]);

		return { code: child.exitCode, stdout, stderr };
	} finally {
		options.signal?.removeEventListener("abort", interrupt);
	}
}

/**
 * The steps of the stderr lines of the command: the lines of the last `{"progress":[...]}` line, then any other line.
 */
class Steps {
	#drawn: readonly string[] = [];
	#status: string | undefined;
	readonly #other: string[] = [];

	/** Adds a stderr line, and returns the text of its update: the last progress line, or the line itself. */
	add(line: string): string {
		const progress = progressLines(line);

		if (progress === undefined) {
			this.#other.push(line);

			return line;
		}

		this.#drawn = progress.lines;
		this.#status = progress.status;

		return progress.lines.at(-1)?.trim() ?? "";
	}

	get lines(): string[] {
		return [...this.#drawn, ...this.#other];
	}

	/** The status of the last progress line, else its last line, trimmed, or `starting` before the first one. */
	get step(): string {
		return this.#status ?? this.#drawn.at(-1)?.trim() ?? "starting";
	}
}

/** The result of a `save` call. */
function savedOf({ text, outcome }: Saved): AgentToolResult<WorkflowDetails> {
	return { content: [{ type: "text", text }], details: { steps: [], outcome }, structuredContent: outcome };
}

function resultOf(tool: ToolModule, outcome: WorkflowOutcome, steps: string[]): AgentToolResult<WorkflowDetails> {
	const result: AgentToolResult<WorkflowDetails> = {
		content: [{ type: "text", text: tool.outcomeText(outcome) }],
		details: { steps, outcome },
		structuredContent: outcome,
	};

	if (outcome.status !== "finished" && outcome.status !== "started") result.isError = true;

	return result;
}

/**
 * `<name> <slug>`, `<name>`, `script`, `resume <run-id>` or `save <run-id> <name>`. The slug comes from the first
 * string argument. The arguments can be partial while the call streams.
 */
function callLabel({ name, script, resume, save, args }: PartialCall): string {
	if (resume !== undefined) return `resume ${resume}`;

	if (save !== undefined) return ["save", save.runId, save.name].filter((word) => word !== undefined).join(" ");

	if (script !== undefined) return "script";
	const item = Object.values(args ?? {}).find((value) => Value.Check(Type.String(), value));

	if (item === undefined) return name ?? "";

	if (item.endsWith(".md")) return `${name} ${basename(item, ".md")}`;
	const line = item.split("\n").find((candidate) => candidate.trim() !== "") ?? "";

	return `${name} ${line.replace(/^#+/, "").trim().slice(0, 40)}`;
}

/**
 * The progress lines as the command drew them, with themed marks, then the report lines of a finished run, a line for a
 * run that started in the background, or the summary of a failed, detached or stopped one, or of one whose host stopped.
 */
function detailLines(
	tool: ToolModule,
	steps: readonly string[],
	outcome: WorkflowOutcome | undefined,
	theme: Theme,
): string[] {
	const lines = steps.map((step) => {
		const [, indent = "", mark, text = step] = /^(\s*)(?:([✓◉✗·]) )?(.*)$/.exec(step) ?? [];
		const color = MARKS.get(mark ?? "");
		const shown = mark === undefined || color === undefined ? "" : `${theme.fg(color, mark)} `;

		return `${indent}${shown}${theme.fg("muted", text)}`;
	});

	if (outcome === undefined) return lines;

	if (outcome.status === "finished") return [...lines, ...outcome.report];

	if (outcome.status === "started") return [...lines, `${theme.fg("accent", "◉")} started in the background`];

	return [...lines, theme.fg("error", `✗ ${tool.summary(outcome)}`)];
}

/** The `workflow` tool, which runs `command`, and gives `watcher` each run that it started in the background. */
export function workflowTool(command: readonly string[], watcher: Watcher, tool: ToolModule) {
	return {
		name: "workflow",
		label: "Workflow",
		description: tool.DESCRIPTION,
		promptGuidelines: tool.GUIDELINES,
		parameters: tool.PARAMETERS,
		outputSchema: tool.OUTCOME,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			if (params.save !== undefined) {
				const output = await runCli(command, tool.cliArgs(params), ctx.cwd, { signal });

				return savedOf(tool.savedOutcome(output, params.save.runId));
			}

			const steps = new Steps();

			const output = await runCli(command, tool.cliArgs(params), ctx.cwd, {
				stdin: params.script,
				signal,
				progress: (line) => {
					const text = steps.add(line);
					onUpdate?.({ content: [{ type: "text", text }], details: { steps: steps.lines } });
				},
			});

			const outcome = tool.outcomeOf(output);

			if (outcome.status === "started") watcher.started(outcome.runId, ctx.cwd, outcome.workflow);

			return resultOf(tool, outcome, steps.lines);
		},
		renderCall(args: PartialCall, theme: Theme) {
			return new Text(theme.fg("toolTitle", theme.bold("workflow ")) + theme.fg("accent", callLabel(args)), 0, 0);
		},
		renderResult(result, _options, theme) {
			// A result of an older session, or of a call that failed before a run existed, has no details.
			const { details } = result;

			if (!Value.Check(STEPS, details)) {
				const [first] = result.content;

				return new Text(first?.type === "text" ? first.text : "", 0, 0);
			}

			const outcome = Value.Check(tool.OUTCOME, details.outcome) ? details.outcome : undefined;

			return new Text(detailLines(tool, details.steps, outcome, theme).join("\n"), 0, 0);
		},
	} satisfies ToolDefinition<ToolModule["PARAMETERS"], WorkflowDetails>;
}

/** The stdout line of `workflows list --json`, as far as the `/workflows` command reads it. */
const LISTED = Type.Array(
	Type.Object({ runId: Type.String(), workflow: Type.String(), status: Type.String(), title: Type.String() }),
);

const BINDINGS = {
	up: "tui.select.up",
	down: "tui.select.down",
	confirm: "tui.select.confirm",
	cancel: "tui.select.cancel",
} as const;

/**
 * The `/workflows` command: it lists the runs of the project with `workflows list --json`, shows the chosen run in the
 * run view, and opens the chosen agent with `workflows attach --conversation` in Herdr, or says how to attach from
 * another terminal.
 */
export function workflowsCommand(command: readonly string[]) {
	return {
		description: "Show a workflow run of this project, and attach to one of its agents in Herdr",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			const listed = await runCli(command, ["list", "--json"], ctx.cwd, {});
			const runs = listed.code === 0 ? JSON.parse(listed.stdout.join("\n")) : undefined;

			if (!Value.Check(LISTED, runs)) {
				ctx.ui.notify(listed.stderr.join("\n") || `workflows list exited with ${listed.code}`, "error");

				return;
			}

			if (runs.length === 0) {
				ctx.ui.notify("No workflow runs in this project", "info");

				return;
			}

			const lines = new Map(
				runs.map((run) => [`${run.runId}  ${run.workflow}  ${run.status}  ${run.title}`, run.runId]),
			);

			const chosen = await ctx.ui.select("Show workflow run", [...lines.keys()]);
			const runId = chosen === undefined ? undefined : lines.get(chosen);

			if (runId === undefined) return;

			const conversation = await ctx.ui.custom<number | undefined>(
				(tui, theme, keybindings, done) =>
					new RunView({
						read: async () => parseRun(await runCli(command, ["show", runId, "--agents", "--json"], ctx.cwd, {})),
						render: () => tui.requestRender(),
						theme,
						matches: (data, binding) => keybindings.matches(data, BINDINGS[binding]),
						done,
					}),
			);

			if (conversation === undefined) return;
			const attach = ["attach", runId, "--conversation", String(conversation)];
			const hint = `Run in another terminal: workflows ${attach.join(" ")}`;

			// `workflows attach` opens a Herdr tab only with HERDR_ENV.
			if (!process.env.HERDR_ENV) {
				ctx.ui.notify(hint, "info");

				return;
			}

			const output = await runCli(command, attach, ctx.cwd, {});

			if (output.code !== 0) ctx.ui.notify(`${output.stderr.join("\n")}. ${hint}`, "error");
		},
	} satisfies Omit<RegisteredCommand, "name" | "sourceInfo">;
}

type Api = Pick<
	ExtensionAPI,
	"registerTool" | "registerCommand" | "registerMessageRenderer" | "on" | "sendMessage" | "appendEntry"
>;

/** A run that the watcher follows: its ID, its directory, its workflow name, or `?` when unknown, and its steps. */
type Followed = { readonly runId: string; readonly cwd: string; readonly workflow: string; readonly steps: Steps };

/**
 * Follows the background runs of a session with `workflows wait`, and posts the outcome of each one as a
 * `workflow-result` message that starts a turn. Shutdown sends SIGINT to the waits, which detach and post nothing. With
 * a UI from `session_start`, the widget `workflows` above the editor shows the step of each followed run.
 */
class Watcher {
	readonly #pi: Api;
	readonly #command: readonly string[];
	readonly #tool: ToolModule;
	readonly #controller = new AbortController();
	/** The runs that a wait of this instance follows, by run ID, in the order they started to be followed. */
	readonly #watched = new Map<string, Followed>();
	#ui: ExtensionUIContext | undefined;

	constructor(pi: Api, command: readonly string[], tool: ToolModule) {
		this.#pi = pi;
		this.#command = command;
		this.#tool = tool;
	}

	/** Records the run that a call started in the background, and follows it. */
	started(runId: string, cwd: string, workflow: string): void {
		this.#pi.appendEntry("workflow-background", { runId, cwd, workflow });
		this.#watch(runId, cwd, workflow);
	}

	/**
	 * Takes the UI of the session when it has one, and follows each run of the session that has a start entry after its
	 * last end entry.
	 */
	resume(ctx: ExtensionContext): void {
		if (ctx.hasUI) this.#ui = ctx.ui;
		const pending = new Map<string, { cwd: string; workflow: string }>();

		for (const entry of ctx.sessionManager.getEntries()) {
			if (Value.Check(STARTED_ENTRY, entry)) {
				const { runId, cwd, workflow = "?" } = entry.data;
				pending.set(runId, { cwd, workflow });
			} else if (Value.Check(ENDED_ENTRY, entry)) pending.delete(entry.data.runId);
		}

		for (const [runId, { cwd, workflow }] of pending) this.#watch(runId, cwd, workflow);
		this.#draw();
	}

	stop(): void {
		this.#controller.abort();
		this.#ui = undefined;
	}

	#watch(runId: string, cwd: string, workflow: string): void {
		if (this.#watched.has(runId)) return;
		const run: Followed = { runId, cwd, workflow, steps: new Steps() };
		this.#watched.set(runId, run);
		this.#draw();
		this.#post(run)
			.catch(() => {})
			.finally(() => {
				this.#watched.delete(runId);
				this.#draw();
			});
	}

	/** Draws one line with the workflow name, the short ID and the step of each followed run, or removes the widget. */
	#draw(): void {
		const ui = this.#ui;

		if (ui === undefined) return;

		if (this.#watched.size === 0) {
			ui.setWidget("workflows", undefined);

			return;
		}

		const { theme } = ui;

		const shown = [...this.#watched.values()].map(({ runId, workflow, steps }) => {
			const short = runId.slice(runId.lastIndexOf("-") + 1);

			return `${theme.fg("dim", `${workflow}:`)} ${short} ${steps.step}`;
		});

		ui.setWidget("workflows", [shown.join(theme.fg("dim", " | "))]);
	}

	async #post({ runId, cwd, steps }: Followed): Promise<void> {
		const { signal } = this.#controller;

		const output = await runCli(this.#command, ["wait", runId, "--json"], cwd, {
			signal,
			progress: (line) => {
				steps.add(line);
				this.#draw();
			},
		});

		// No outcome, or an outcome that is not valid, posts nothing: the next start of the session watches the run again.
		const outcome = this.#tool.outcomeOf(output);

		if (signal.aborted) return;

		if (outcome.status !== "finished" && outcome.status !== "failed" && outcome.status !== "stopped") return;
		const details: WorkflowDetails = { steps: steps.lines, outcome };
		this.#pi.sendMessage(
			{
				customType: "workflow-result",
				content: [{ type: "text", text: this.#tool.outcomeText(outcome) }],
				display: true,
				details,
			},
			{ triggerTurn: true, deliverAs: "followUp" },
		);
		// a crash between the post and the end entry posts again at the next start; accepted, the window is one sync call
		this.#pi.appendEntry("workflow-background-end", { runId });
	}
}

/**
 * Registers the tool, the command, the watcher and the renderer that run `local.command` with the tool module
 * `local.tool`. Without `local`, they run `dist/cli.js` of the workflows package that this extension resolves, with the
 * Node of Pi, and its `dist/tool.js`, and the harness host loads the entry of that package.
 */
export default async function workflows(
	pi: Api,
	local?: { readonly command: readonly string[]; readonly tool: ToolModule },
): Promise<void> {
	if (local !== undefined) {
		register(pi, local.command, local.tool);

		return;
	}

	const require = createRequire(import.meta.url);
	const folder = dirname(require.resolve(`${WORKFLOWS_PACKAGE}/package.json`));
	putWorkflowsBinLast(require);
	await setWorkflowsEntry(folder);
	register(pi, [process.execPath, join(folder, "dist", "cli.js")], await loadTool(folder));
}

/**
 * Puts the `.bin` folder next to the workflows package last on `PATH`, so Pi's tools find `workflows`. It goes last
 * because the folder also holds the commands of other dependencies, such as an older `pi`, which must not hide the
 * user's own. It removes the folder first, so each load of the extension leaves it on `PATH` once.
 */
function putWorkflowsBinLast(require: NodeJS.Require): void {
	const modules = require.resolve
		.paths(WORKFLOWS_PACKAGE)
		?.find((dir) => existsSync(join(dir, WORKFLOWS_PACKAGE, "package.json")));

	if (modules === undefined) return;
	const bin = join(modules, ".bin");
	const rest = process.env.PATH ? process.env.PATH.split(delimiter).filter((entry) => entry !== bin) : [];
	process.env.PATH = [...rest, bin].join(delimiter);
}

/**
 * Sets the entry `workflows` in harness's `entries.json` to `dist/entry.js` of the workflows package in `folder`, with
 * the harness that this package imports, so a host that the tool starts loads the entry of the same install.
 */
async function setWorkflowsEntry(folder: string): Promise<void> {
	const resolved = createRequire(join(folder, "package.json")).resolve("@vzlentin/harness/entries");
	const entries: typeof import("@vzlentin/harness/entries") = await import(pathToFileURL(resolved).href);
	entries.setEntry("workflows", join(folder, "dist", "entry.js"));
}

/** The tool module `dist/tool.js` of the workflows package in `folder`. */
async function loadTool(folder: string): Promise<ToolModule> {
	return import(pathToFileURL(join(folder, "dist", "tool.js")).href);
}

function register(pi: Api, command: readonly string[], tool: ToolModule): void {
	const watcher = new Watcher(pi, command, tool);
	const details = detailsOf(tool);
	pi.registerTool(workflowTool(command, watcher, tool));
	pi.registerCommand("workflows", workflowsCommand(command));
	pi.on("session_start", (_event, ctx) => watcher.resume(ctx));
	pi.on("session_shutdown", () => watcher.stop());
	pi.registerMessageRenderer("workflow-result", (message, _options, theme) => {
		if (Value.Check(details, message.details)) {
			return new Text(detailLines(tool, message.details.steps, message.details.outcome, theme).join("\n"), 0, 0);
		}

		const { content } = message;

		const text = Value.Check(Type.String(), content)
			? content
			: content.map((part) => (part.type === "text" ? part.text : "")).join("\n");

		return new Text(text, 0, 0);
	});
}
