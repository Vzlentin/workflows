/**
 * The Pi extension: the `workflow` tool. Each run is a child process of this package's
 * `workflows` command, so a run started in Pi is a normal run that `workflows resume` also continues.
 */
import { spawn } from "node:child_process";
import { once } from "node:events";
import { basename } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type { JsonValue } from "@earendil-works/chord";
import { Type } from "@earendil-works/pi-ai";
import type { AgentToolResult, ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

type SaveCall = { readonly runId?: string; readonly name?: string; readonly force?: boolean };

type WorkflowCall = {
	readonly name?: string;
	readonly script?: string;
	readonly resume?: string;
	readonly save?: SaveCall;
	readonly args?: Readonly<Record<string, unknown>>;
};

/** The stdout line of `workflows --json` after `run <run-id>`. */
type WorkflowOutcome =
	| {
			readonly runId: string;
			readonly status: "finished";
			readonly result: JsonValue;
			/** The lines that the workflow's report prints without `--json`. */
			readonly report: readonly string[];
	  }
	| { readonly runId: string; readonly status: "failed"; readonly error: string }
	| { readonly runId: string; readonly status: "interrupted" };

/** The `details` of each update and of the result, so the steps draw the same after a reload. */
type WorkflowDetails = { readonly steps: readonly string[]; readonly outcome?: WorkflowOutcome };

const CLI = [process.execPath, fileURLToPath(new URL("../src/cli.ts", import.meta.url))];

const text = (value: unknown) => (typeof value === "string" ? value : JSON.stringify(value));

/**
 * The `workflows` arguments of a tool call, with each arg as a flag, and `--json` for a run. The command rejects a flag
 * it does not know, so a mistyped arg fails before a run exists.
 */
function cliArgs({ name, script, resume, save, args = {} }: WorkflowCall): string[] {
	const given = [name, script, resume, save].filter((value) => value !== undefined).length;
	if (given !== 1) throw new Error("give exactly one of name, script, resume or save");
	if (resume !== undefined) return ["resume", resume, "--json"];
	if (save !== undefined) return ["save", save.runId ?? "", save.name ?? "", ...(save.force ? ["--force"] : [])];
	const flags = Object.entries(args).flatMap(([key, flag]) =>
		flag === false ? [] : [flag === true ? `--${key}` : `--${key}=${text(flag)}`],
	);
	return [name ?? "-", ...flags, "--json"];
}

type Output = { readonly code: number | null; readonly stdout: readonly string[]; readonly stderr: readonly string[] };

/** Runs `command` with `args` in `cwd`; each stderr line goes to `progress`, and `signal` sends SIGINT. */
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
		const [[code]] = await Promise.all([once(child, "close"), once(out, "close"), once(err, "close")]);
		return { code: code as number | null, stdout, stderr };
	} finally {
		options.signal?.removeEventListener("abort", interrupt);
	}
}

/** The outcome line after `run <run-id>`; throws the stderr text when the command stopped without one. */
function outcomeOf(output: Output): WorkflowOutcome {
	const [, line] = output.stdout;
	if (line === undefined) throw new Error(output.stderr.join("\n") || `workflows exited with ${output.code}`);
	return JSON.parse(line) as WorkflowOutcome;
}

function summary(outcome: WorkflowOutcome): string {
	switch (outcome.status) {
		case "finished":
			return `run ${outcome.runId} finished: ${JSON.stringify(outcome.result)}`;
		case "failed":
			return `run ${outcome.runId} failed: ${outcome.error}; continue it with resume: "${outcome.runId}"`;
		case "interrupted":
			return `run ${outcome.runId} interrupted; continue it with resume: "${outcome.runId}"`;
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

function resultOf(outcome: WorkflowOutcome, steps: readonly string[]): AgentToolResult<WorkflowDetails> {
	return {
		content: [{ type: "text", text: summary(outcome) }],
		details: { steps, outcome },
		structuredContent: outcome,
		...(outcome.status === "finished" ? {} : { isError: true }),
	};
}

/**
 * `<name> <slug>`, `<name>`, `script`, `resume <run-id>` or `save <run-id> <name>`. The slug comes from the first
 * string argument. The arguments can be partial while the call streams.
 */
function callLabel({ name, script, resume, save, args }: WorkflowCall): string {
	if (resume !== undefined) return `resume ${resume}`;
	if (save !== undefined) return ["save", save.runId, save.name].filter((word) => word !== undefined).join(" ");
	if (script !== undefined) return "script";
	const item = Object.values(args ?? {}).find((value) => typeof value === "string");
	if (typeof item !== "string") return name ?? "";
	if (item.endsWith(".md")) return `${name} ${basename(item, ".md")}`;
	const line = item.split("\n").find((candidate) => candidate.trim() !== "") ?? "";
	return `${name} ${line.replace(/^#+/, "").trim().slice(0, 40)}`;
}

/**
 * The steps, the last one as running, done or failed, then the report lines of a finished run, or the summary of a
 * failed or interrupted one.
 */
function detailLines({ steps, outcome }: WorkflowDetails, theme: Theme): string[] {
	const done = theme.fg("success", "✓");
	const last =
		outcome === undefined ? theme.fg("accent", "◉") : outcome.status === "finished" ? done : theme.fg("error", "✗");
	const lines = steps.map((step, index) => `${index === steps.length - 1 ? last : done} ${theme.fg("muted", step)}`);
	if (outcome === undefined) return lines;
	if (outcome.status === "finished") return [...lines, ...outcome.report];
	return [...lines, theme.fg("error", `✗ ${summary(outcome)}`)];
}

/** How to write an inline script. Keep it in step with `workflows/script.d.ts`; a test checks the globals. */
const GUIDELINES = [
	"A `workflow` `script` is the body of an async function, so top-level `await` and `return` work. An optional " +
		'`export const meta = { args: { <name>: { type: "string" | "number" | "boolean" | "text" } } }` at ' +
		"the top declares the args, which the tool's `args` fill and the script reads as `args.<name>`.",
	"Script globals: `agent(prompt, { as, schema })` is one turn in a new session and returns the reply, or the " +
		"checked answer with a JSON Schema. `session(profile).ask(prompt, { schema })` is one turn in a session that " +
		"keeps its history. `sh(cmd)` returns stdout and throws on a nonzero exit, `ok(cmd)` returns true on exit 0. " +
		"`run(name, args)` runs a named workflow as a child run. `parallel([() => ...])` and " +
		"`pipeline(items, ...stages)` run calls at once. `prompts.<name>(inputs)` gives a prompt template. `phase(title)` " +
		"and `log(text)` write progress lines. `args`, `runId` and `runDir` are values.",
	"A script has no file system, network, modules or timers, so effects go through `sh`. `Date`, `Date.now()` and " +
		"`Math.random()` throw. A resume runs the script again from the top: saved calls return their results, and a " +
		"command that did not finish runs again, so keep `sh` and `ok` commands safe to repeat.",
	"To keep a good inline script as a named workflow of the project, call `workflow` with " +
		"`save: { runId, name }` after its run. Add `force: true` to replace a workflow of that name.",
];

export default function workflows(pi: ExtensionAPI, command: readonly string[] = CLI) {
	pi.registerTool({
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
			"script starts a child run, which a resume of its caller continues. A failed or interrupted run stays resumable.",
		promptGuidelines: GUIDELINES,
		parameters: Type.Object({
			name: Type.Optional(
				Type.String({ description: "`ship`, `campaign`, `optimize`, or the name of a workflow script" }),
			),
			script: Type.Optional(Type.String({ description: "An inline workflow script" })),
			resume: Type.Optional(Type.String({ description: "The ID of a run to continue" })),
			save: Type.Optional(
				Type.Object(
					{
						runId: Type.String(),
						name: Type.String({ description: "Lowercase letters, digits and -" }),
						force: Type.Optional(Type.Boolean({ description: "Replace a workflow of that name" })),
					},
					{ description: "Writes the script of the run to .workflows/workflows/<name>.js of the project" },
				),
			),
			args: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
		}),
		outputSchema: Type.Object({
			runId: Type.String(),
			status: Type.Union([Type.Literal("finished"), Type.Literal("failed"), Type.Literal("interrupted")]),
			result: Type.Optional(Type.Unknown()),
			report: Type.Optional(Type.Array(Type.String())),
			error: Type.Optional(Type.String()),
		}),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			if (params.save !== undefined) {
				const output = await runCli(command, cliArgs(params), ctx.cwd, { signal });
				return savedOf(output, params.save.runId);
			}
			const steps: string[] = [];
			const output = await runCli(command, cliArgs(params), ctx.cwd, {
				stdin: params.script,
				signal,
				progress: (line) => {
					steps.push(line);
					onUpdate?.({ content: [{ type: "text", text: line }], details: { steps: [...steps] } });
				},
			});
			return resultOf(outcomeOf(output), steps);
		},
		renderCall(args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("workflow ")) + theme.fg("accent", callLabel(args)), 0, 0);
		},
		renderResult(result, _options, theme) {
			// A result of an older session, or of a call that failed before a run existed, has no details.
			const details = result.details as WorkflowDetails | undefined;
			if (details?.steps === undefined) {
				const [first] = result.content;
				return new Text(first?.type === "text" ? first.text : "", 0, 0);
			}
			return new Text(detailLines(details, theme).join("\n"), 0, 0);
		},
	});
}
