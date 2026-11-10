/**
 * The one definition of the `workflow` tool: its description, parameters and output schema, the `workflows` arguments
 * of a call, and the outcome and text of a result. The tool of the harness host (`entry.ts`) and the tool of the Pi
 * extension (`pi/index.ts`, which loads `dist/tool.js`) both use it. It imports only `typebox` and `node:url`.
 */
import { fileURLToPath } from "node:url";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

/** A JSON value. */
export const JSON_VALUE = Type.Cyclic(
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

export const SAVE = Type.Object(
	{
		runId: Type.String(),
		name: Type.String({ description: "Lowercase letters, digits and -" }),
		force: Type.Optional(Type.Boolean({ description: "Replace a workflow of that name" })),
	},
	{ description: "Writes the script of the run to .workflows/scripts/<name>.js of the project" },
);

export const PARAMETERS = Type.Object({
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

/** The arguments of a call of the tool, checked against `PARAMETERS`. */
export type WorkflowCall = Static<typeof PARAMETERS>;

/**
 * The stdout line of `workflows --json` after `run <run-id>`, and of `workflows wait <run-id> --json`, and the outcome
 * that a background run posts. It is also the output schema of the `workflow` tool.
 */
export const OUTCOME = Type.Union([
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

export type WorkflowOutcome = Static<typeof OUTCOME>;

/** The `status` of a JSON outcome line of the command. */
export type OutcomeStatus = WorkflowOutcome["status"];

export const DESCRIPTION =
	"Run a durable workflow and wait for its result. Give exactly one of: `name` (a workflow script such as " +
	"`ship`, `campaign` or `optimize`), `script` (the body of an inline workflow script), `resume` (a run " +
	"ID), or `save` (keeps the script of a run as a named workflow of the project). `args` are the arguments of " +
	"`name` or `script`, each passed as `--<key>`; a script's `meta` declares them. Every run also takes `agents`, " +
	"`<name>=<provider>/<id>:<thinking>,...` (`*` for every role), the models of its roles above the agents.json " +
	"tables. For " +
	"`ship`: `item` (the work item), and optional `repo`, `base`, `rounds` and `prompts`. For `campaign`, which " +
	"splits a goal into work items and ships each one as a commit on one branch: `goal`, and optional `repo`, " +
	"`base`, `rounds` and `prompts`. For `optimize`, which proposes edits to the ship prompts, skills " +
	"and `AGENTS.md` from past ship runs and keeps them when a blind judge prefers their diffs: `workflow` " +
	"(`ship`), and optional `runs`, `limit`, `items` and `always-on-max` (the most characters of `AGENTS.md`). For " +
	"`thermoloop`, which reviews a change and fixes it in rounds, and `judge`, which scores a change: optional " +
	"`change`, `item`, `base`, `rounds` (thermoloop only), and `repo`, the path of a local repository to run in. " +
	"Each `run()` call of a " +
	"script starts a child run, which a resume of its caller continues. A run goes on in the harness host of the " +
	"project: Esc detaches from it, and `resume` follows it again. A failed or stopped run stays resumable. With " +
	"`background: true`, the call returns at once and the result of the run comes later as a message in this " +
	"conversation: use it for long runs such as `campaign` or `optimize`, or for work that can go on while the " +
	"conversation continues. `input(question)` stops the run, and the tool gives a `waiting` result with the " +
	"question; answer it with `workflow` `resume: <run-id>` and `answer`, and `input` then returns the answer.";

/** `workflows/script.d.ts` of this package: the script API, which the model reads before it writes a script. */
const SCRIPT_TYPES = fileURLToPath(new URL("../workflows/script.d.ts", import.meta.url));

/** The rules that the tool adds to the system prompt. */
export const GUIDELINES = [
	`Before you write a \`workflow\` \`script\`, read ${SCRIPT_TYPES}: it declares the script globals, the lib helpers and \`meta\`, and gives the limits of a script and how a resume runs it again.`,
	"Use `background: true` for long runs, such as `campaign` or `optimize`: the call returns at once, the result comes later as a message, and `resume` follows the run.",
];

/**
 * The `workflows` arguments of a tool call, with each arg as a flag, and `--json` for a run. The command rejects a flag
 * it does not know, so a mistyped arg fails before a run exists.
 */
export function cliArgs({ name, script, resume, answer, save, args = {}, background }: WorkflowCall): string[] {
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

/** What the `workflows` command of a call printed, line by line, and its exit code. */
export type Output = {
	readonly code: number | null;
	readonly stdout: readonly string[];
	readonly stderr: readonly string[];
};

/** The exit code of a command on a saved run that is gone: its run directory or its task is missing. */
export const GONE_EXIT = 4;

/**
 * The outcome line after `run <run-id>`; throws the stderr text when the command stopped without one, after `run
 * <run-id>: ` when the command printed that line.
 */
export function outcomeOf(output: Output): WorkflowOutcome {
	const [first, line] = output.stdout;

	if (line === undefined) {
		const why = output.stderr.join("\n") || `workflows exited with ${output.code}`;

		throw new Error(first?.startsWith("run ") ? `${first}: ${why}` : why);
	}

	const outcome = JSON.parse(line);

	if (!Value.Check(OUTCOME, outcome)) throw new Error(`workflows printed an outcome that is not valid: ${line}`);

	return outcome;
}

/** The text and the outcome of a `save` call. */
export type Saved = { readonly text: string; readonly outcome: WorkflowOutcome };

/**
 * The file that `workflows save` wrote for the run `runId`, as a finished outcome, so that it fits the output schema.
 * Throws the stderr text when the command failed.
 */
export function savedOutcome(output: Output, runId: string): Saved {
	const file = output.stdout.at(-1);

	if (output.code !== 0 || file === undefined) {
		throw new Error(output.stderr.join("\n") || `workflows exited with ${output.code}`);
	}

	return {
		text: `saved the script of run ${runId} as ${file}`,
		outcome: { runId, status: "finished", result: { file }, report: [file] },
	};
}

/** The result of a run that waits on `input(question)`. */
export const WAITING = Type.Object({ status: Type.Literal("waiting"), question: Type.String() });

/** The most UTF-8 bytes of the JSON of a finished result that the summary gives. */
const RESULT_BYTES = 2000;

export function summary(outcome: WorkflowOutcome): string {
	switch (outcome.status) {
		case "finished":
			if (Value.Check(WAITING, outcome.result)) {
				return `run ${outcome.runId} waits for an answer: ${outcome.result.question}; answer it with resume: "${outcome.runId}" and answer: "<your answer>"`;
			}

			return finished(outcome.runId, JSON.stringify(outcome.result));
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

/** The summary of a finished run whose result is `json`, or the command that prints the result when it is too long. */
function finished(runId: string, json: string): string {
	if (new TextEncoder().encode(json).length <= RESULT_BYTES) return `run ${runId} finished: ${json}`;

	return `run ${runId} finished; its result is longer than ${RESULT_BYTES} bytes, so read it with the command workflows wait ${runId} --json`;
}

/** The text of `outcome` for the model: its summary, then the report lines of a finished run that does not wait. */
export function outcomeText(outcome: WorkflowOutcome): string {
	if (outcome.status !== "finished" || Value.Check(WAITING, outcome.result)) return summary(outcome);

	return [summary(outcome), ...outcome.report].join("\n");
}
