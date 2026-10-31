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
import { MARKS, parseRun, RunView } from "./run-view.ts";

const WORKFLOWS_PACKAGE = "@vzlentin/workflows";

const SAVE = Type.Object(
	{
		runId: Type.String(),
		name: Type.String({ description: "Lowercase letters, digits and -" }),
		force: Type.Optional(Type.Boolean({ description: "Replace a workflow of that name" })),
	},
	{ description: "Writes the script of the run to .workflows/scripts/<name>.js of the project" },
);

const PARAMETERS = Type.Object({
	name: Type.Optional(Type.String({ description: "`ship`, `campaign`, `optimize`, or the name of a workflow script" })),
	script: Type.Optional(Type.String({ description: "An inline workflow script" })),
	resume: Type.Optional(Type.String({ description: "The ID of a run to continue" })),
	answer: Type.Optional(Type.String({ description: "With `resume`: the answer to the question of a waiting run" })),
	save: Type.Optional(SAVE),
	args: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
	background: Type.Optional(
		Type.Boolean({
			description:
				"With `name`, `script` or `resume`: start the run and return at once; its result comes as a message in this conversation",
		}),
	),
});

/** The arguments of a call of the tool, which Pi checks against `PARAMETERS`. */
type WorkflowCall = Static<typeof PARAMETERS>;

/** The arguments of a call while it streams, which Pi has not checked yet, so any field can be missing. */
const STREAMING = Type.Object({ ...PARAMETERS.properties, save: Type.Optional(Type.Partial(SAVE)) });

type PartialCall = Static<typeof STREAMING>;

const JSON_VALUE = Type.Cyclic(
	{
		Json: Type.Union([
			Type.Null(),
			Type.Boolean(),
			Type.Number(),
			Type.String(),
			Type.Array(Type.Ref("Json")),
			Type.Record(Type.String(), Type.Ref("Json")),
		]),
	},
	"Json",
);

/** The stdout line of `workflows --json` after `run <run-id>`, and of `workflows wait <run-id> --json`. */
const OUTCOME = Type.Union([
	Type.Object({
		runId: Type.String(),
		status: Type.Literal("finished"),
		result: JSON_VALUE,
		/** The lines that the workflow's report prints without `--json`. */
		report: Type.Array(Type.String()),
	}),
	Type.Object({ runId: Type.String(), status: Type.Literal("failed"), error: Type.String() }),
	/** `workflow` is the name of the run's workflow, which a background run shows while it runs. */
	Type.Object({ runId: Type.String(), status: Type.Literal("started"), workflow: Type.String() }),
	Type.Object({
		runId: Type.String(),
		status: Type.Union([Type.Literal("detached"), Type.Literal("stopped"), Type.Literal("host-stopped")]),
	}),
]);

type WorkflowOutcome = Static<typeof OUTCOME>;

/**
 * The `details` of each update and of the result, so the steps draw the same after a reload. `steps` are the progress
 * lines that the command drew last, then any other stderr line, such as a warning.
 */
const DETAILS = Type.Object({ steps: Type.Array(Type.String()), outcome: Type.Optional(OUTCOME) });

type WorkflowDetails = Static<typeof DETAILS>;

/** The part of `DETAILS` that a result of an older session must have to draw its steps. */
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

/**
 * The `workflows` arguments of a tool call, with each arg as a flag, and `--json` for a run. The command rejects a flag
 * it does not know, so a mistyped arg fails before a run exists.
 */
function cliArgs({ name, script, resume, answer, save, args = {}, background }: WorkflowCall): string[] {
	const given = [name, script, resume, save].filter((value) => value !== undefined).length;

	if (given !== 1) throw new Error("give exactly one of name, script, resume or save");

	if (answer !== undefined && resume === undefined) throw new Error("answer works only with resume");

	if (background && save !== undefined) throw new Error("background works only with name, script or resume");
	const json = background ? ["--background", "--json"] : ["--json"];

	if (resume !== undefined) return ["resume", resume, ...(answer === undefined ? [] : [`--answer=${answer}`]), ...json];

	if (save !== undefined) return ["save", save.runId, save.name, ...(save.force ? ["--force"] : [])];

	const flags = Object.entries(args).flatMap(([key, flag]) => {
		if (flag === false) return [];

		if (flag === true) return [`--${key}`];

		return [`--${key}=${Value.Check(Type.String(), flag) ? flag : JSON.stringify(flag)}`];
	});

	return [name ?? "-", ...flags, ...json];
}

export type Output = {
	readonly code: number | null;
	readonly stdout: readonly string[];
	readonly stderr: readonly string[];
};

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

/** The outcome line after `run <run-id>`; throws the stderr text when the command stopped without one. */
function outcomeOf(output: Output): WorkflowOutcome {
	const [, line] = output.stdout;

	if (line === undefined) throw new Error(output.stderr.join("\n") || `workflows exited with ${output.code}`);
	const outcome = JSON.parse(line);

	if (!Value.Check(OUTCOME, outcome)) throw new Error(`workflows printed an outcome that is not valid: ${line}`);

	return outcome;
}

/** The result of a run that waits on `input(question)`. */
const WAITING = Type.Object({ status: Type.Literal("waiting"), question: Type.String() });

function summary(outcome: WorkflowOutcome): string {
	switch (outcome.status) {
		case "finished":
			if (Value.Check(WAITING, outcome.result)) {
				return `run ${outcome.runId} waits for an answer: ${outcome.result.question}; answer it with resume: "${outcome.runId}" and answer: "<your answer>"`;
			}

			return `run ${outcome.runId} finished: ${JSON.stringify(outcome.result)}`;
		case "failed":
			return `run ${outcome.runId} failed: ${outcome.error}; continue it with resume: "${outcome.runId}"`;
		case "started":
			return `run ${outcome.runId} started in the background; its result comes as a message in this conversation when it ends; follow it with resume: "${outcome.runId}", or stop it with the command workflows stop ${outcome.runId}`;
		case "detached":
			return `run ${outcome.runId} detached and goes on in the harness host; follow it with resume: "${outcome.runId}", or stop it with the command workflows stop ${outcome.runId}`;
		case "stopped":
			return `run ${outcome.runId} stopped; continue it with resume: "${outcome.runId}"`;
		case "host-stopped":
			return `the harness host of run ${outcome.runId} stopped; the run continues when the host starts again, so follow it with resume: "${outcome.runId}"`;
	}
}

/**
 * The file that `workflows save` wrote, as a finished outcome, so that it fits the tool's output schema. Throws the
 * stderr text when the command failed.
 */
function savedOf(output: Output, runId: string): AgentToolResult<WorkflowDetails> {
	const file = output.stdout.at(-1);

	if (output.code !== 0 || file === undefined) {
		throw new Error(output.stderr.join("\n") || `workflows exited with ${output.code}`);
	}

	const outcome: WorkflowOutcome = { runId, status: "finished", result: { file }, report: [file] };

	return {
		content: [{ type: "text", text: `saved the script of run ${runId} as ${file}` }],
		details: { steps: [], outcome },
		structuredContent: outcome,
	};
}

function resultOf(outcome: WorkflowOutcome, steps: string[]): AgentToolResult<WorkflowDetails> {
	const result: AgentToolResult<WorkflowDetails> = {
		content: [{ type: "text", text: summary(outcome) }],
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
function detailLines(steps: readonly string[], outcome: WorkflowOutcome | undefined, theme: Theme): string[] {
	const lines = steps.map((step) => {
		const [, indent = "", mark, text = step] = /^(\s*)(?:([✓◉✗]) )?(.*)$/.exec(step) ?? [];
		const color = MARKS.get(mark ?? "");
		const shown = mark === undefined || color === undefined ? "" : `${theme.fg(color, mark)} `;

		return `${indent}${shown}${theme.fg("muted", text)}`;
	});

	if (outcome === undefined) return lines;

	if (outcome.status === "finished") return [...lines, ...outcome.report];

	if (outcome.status === "started") return [...lines, `${theme.fg("accent", "◉")} started in the background`];

	return [...lines, theme.fg("error", `✗ ${summary(outcome)}`)];
}

/** How to write an inline script. Keep it in step with `workflows/script.d.ts`; a test checks the globals. */
const GUIDELINES = [
	"A `workflow` `script` is the body of an async function, so top-level `await` and `return` work. An optional " +
		'`export const meta = { args: { <name>: { type: "string" | "number" | "boolean" | "text" } } }` at ' +
		"the top declares the args, which the tool's `args` fill and the script reads as `args.<name>`.",
	"Script globals: `agent(prompt, { as, provider, model, thinking, schema })` is one turn in a new session and " +
		"returns the reply, or the checked answer with a JSON Schema. `session(profile)` or " +
		"`session({ as, provider, model, thinking })` gives a session that keeps its history, and its " +
		"`.ask(prompt, { schema })` is one turn. `as` names an agent profile (default `default`), and `provider`, " +
		"`model` and `thinking` override it. `sh(cmd)` returns stdout and throws on a nonzero exit, `ok(cmd)` returns true on exit 0. " +
		"`run(name, args)` runs a named workflow as a child run. `input(question)` stops the run, and the tool gives a " +
		"`waiting` result with the question; answer it with `workflow` `resume: <run-id>` and `answer`, and `input` " +
		"then returns the answer. `parallel([() => ...])` and " +
		"`pipeline(items, ...stages)` run calls at once. `prompts.<name>(inputs)` gives a prompt template. `phase(title)` " +
		"and `log(text)` write progress lines, and `title(text)` names the run. `args`, `runId`, `runDir` and `cwd`, the " +
		"directory of `sh`, are values.",
	"Script lib: `subjectOf(text)` gives the first non-empty line without leading `#`. `oneLine(text)` gives the text with each whitespace run made one space, trimmed. `memory(path, item)` gives a promise of a run memory in an " +
		"OptMem store, `<runDir>/memory` without `path`: `.path` and `.item` to pass to a child run, `.note(author, round, notes)`, " +
		"`.text` (a promise of the notes), `.opened` (the store opened here), `.harvest(item, outcome)` (0 to 3 " +
		"lessons `{ cue, lesson, evidence }` of the notes, `[]` with no turn when there are none), and `.session(profile)`, whose first `.ask` starts with the notes and whose " +
		"`.noted(round, prompt, rule)` asks for `{ text, notes }` and keeps the notes. `commitAll(message)` stages and commits every change, " +
		"`diffStat(from, to)` gives `+12 -3 in 2 files`, `assertClean()` throws on changes that are not committed, " +
		"`changeOf(args, { wip })` gives `{ start, intent, checkout, dirty }` of `args.start` and `args.item`, or else of " +
		"`args.change` (the current branch, a PR number, a ref or a range) and names the run, and `inCheckout(name, change, args)` runs the script again in a worktree on the " +
		"branch of the change and adds the line `worktree <path>` to its report.",
	"A script has no file system, network, modules or timers, so effects go through `sh`. `Date`, `Date.now()` and " +
		"`Math.random()` throw. A resume runs the script again from the top: saved calls return their results, and a " +
		"command that did not finish runs again, so keep `sh` and `ok` commands safe to repeat.",
	"To keep a good inline script as a named workflow of the project, call `workflow` with " +
		"`save: { runId, name }` after its run. Add `force: true` to replace a workflow of that name.",
	"Use `background: true` for long runs, such as `campaign` or `optimize`, or for work that can go on while the " +
		"conversation continues. The call returns at once, and the result of the run comes later as a message in the " +
		"conversation. `resume` follows the run.",
];

/** The `workflow` tool, which runs `command`, and gives `watcher` each run that it started in the background. */
export function workflowTool(command: readonly string[], watcher: Watcher) {
	return {
		name: "workflow",
		label: "Workflow",
		description:
			"Run a durable workflow and wait for its result. Give exactly one of: `name` (a workflow script such as " +
			"`ship`, `campaign` or `optimize`), `script` (the body of an inline workflow script), `resume` (a run " +
			"ID), or `save` (keeps the script of a run as a named workflow of the project). `args` are the arguments of " +
			"`name` or `script`, each passed as `--<key>`; a script's `meta` declares them. For " +
			"`ship`: `item` (the work item), and optional `repo`, `base`, `rounds` and `prompts`. For `campaign`, which " +
			"splits a goal into work items and ships each one as a commit on one branch: `goal`, and optional `repo`, " +
			"`base`, `rounds` and `prompts`. For `optimize`, which searches for better ship prompts over a folder of work " +
			"items: `workflow` (`ship`) and `items`, and optional `improve` and `trials`. Each `run()` call of a " +
			"script starts a child run, which a resume of its caller continues. A run goes on in the harness host of the " +
			"project: Esc detaches from it, and `resume` follows it again. A failed or stopped run stays resumable. With " +
			"`background: true`, the call returns at once and the result of the run comes later as a message in this " +
			"conversation: use it for long runs such as `campaign` or `optimize`, or for work that can go on while the " +
			"conversation continues.",
		promptGuidelines: GUIDELINES,
		parameters: PARAMETERS,
		outputSchema: Type.Object({
			runId: Type.String(),
			status: Type.Union([
				Type.Literal("finished"),
				Type.Literal("failed"),
				Type.Literal("started"),
				Type.Literal("detached"),
				Type.Literal("stopped"),
				Type.Literal("host-stopped"),
			]),
			result: Type.Optional(Type.Unknown()),
			report: Type.Optional(Type.Array(Type.String())),
			error: Type.Optional(Type.String()),
			workflow: Type.Optional(Type.String()),
		}),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			if (params.save !== undefined) {
				const output = await runCli(command, cliArgs(params), ctx.cwd, { signal });

				return savedOf(output, params.save.runId);
			}

			const steps = new Steps();

			const output = await runCli(command, cliArgs(params), ctx.cwd, {
				stdin: params.script,
				signal,
				progress: (line) => {
					const text = steps.add(line);
					onUpdate?.({ content: [{ type: "text", text }], details: { steps: steps.lines } });
				},
			});

			const outcome = outcomeOf(output);

			if (outcome.status === "started") watcher.started(outcome.runId, ctx.cwd, outcome.workflow);

			return resultOf(outcome, steps.lines);
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

			const outcome = Value.Check(OUTCOME, details.outcome) ? details.outcome : undefined;

			return new Text(detailLines(details.steps, outcome, theme).join("\n"), 0, 0);
		},
	} satisfies ToolDefinition<typeof PARAMETERS, WorkflowDetails>;
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
	readonly #controller = new AbortController();
	/** The runs that a wait of this instance follows, by run ID, in the order they started to be followed. */
	readonly #watched = new Map<string, Followed>();
	#ui: ExtensionUIContext | undefined;

	constructor(pi: Api, command: readonly string[]) {
		this.#pi = pi;
		this.#command = command;
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
		const outcome = outcomeOf(output);

		if (signal.aborted) return;

		if (outcome.status !== "finished" && outcome.status !== "failed" && outcome.status !== "stopped") return;
		const details: WorkflowDetails = { steps: steps.lines, outcome };
		this.#pi.sendMessage(
			{ customType: "workflow-result", content: [{ type: "text", text: summary(outcome) }], display: true, details },
			{ triggerTurn: true, deliverAs: "followUp" },
		);
		// a crash between the post and the end entry posts again at the next start; accepted, the window is one sync call
		this.#pi.appendEntry("workflow-background-end", { runId });
	}
}

/**
 * Registers the tool, the command, the watcher and the renderer that run `command`. Without `command`, they run
 * `dist/cli.js` of the workflows package that this extension resolves, with the Node of Pi, and the harness host loads
 * the entry of that package.
 */
export default async function workflows(pi: Api, command?: readonly string[]): Promise<void> {
	if (command !== undefined) {
		register(pi, command);

		return;
	}

	const require = createRequire(import.meta.url);
	const folder = dirname(require.resolve(`${WORKFLOWS_PACKAGE}/package.json`));
	putWorkflowsBinLast(require);
	await setWorkflowsEntry(folder);
	register(pi, [process.execPath, join(folder, "dist", "cli.js")]);
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

function register(pi: Api, command: readonly string[]): void {
	const watcher = new Watcher(pi, command);
	pi.registerTool(workflowTool(command, watcher));
	pi.registerCommand("workflows", workflowsCommand(command));
	pi.on("session_start", (_event, ctx) => watcher.resume(ctx));
	pi.on("session_shutdown", () => watcher.stop());
	pi.registerMessageRenderer("workflow-result", (message, _options, theme) => {
		if (Value.Check(DETAILS, message.details)) {
			return new Text(detailLines(message.details.steps, message.details.outcome, theme).join("\n"), 0, 0);
		}

		const { content } = message;

		const text = Value.Check(Type.String(), content)
			? content
			: content.map((part) => (part.type === "text" ? part.text : "")).join("\n");

		return new Text(text, 0, 0);
	});
}
