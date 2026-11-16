/**
 * The one definition of the `workflow` tool: its description, parameters and output schema, the `workflows` command
 * of a call, the outcome and text of a result, and the cut rule of long texts, which the error text of a failed command
 * also uses. The tool of the harness host (`entry.ts`) and the tool of the Pi extension (`pi/index.ts`, which loads
 * `dist/tool.js`) both use it. It imports only `typebox`, `node:fs/promises`, `node:path` and `node:url`.
 */
import { stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
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

/** The names of the commands of `workflows`. No workflow can have one of these names. */
export const COMMAND_NAMES = [
	"list",
	"resume",
	"wait",
	"stop",
	"show",
	"log",
	"attach",
	"save",
	"sweep",
	"check",
	"outline",
] as const;

export type CommandName = (typeof COMMAND_NAMES)[number];

/** Whether `name` is the name of a command. */
export function isCommand(name: string): name is CommandName {
	return COMMAND_NAMES.some((command) => command === name);
}

export const SAVE = Type.Object(
	{
		runId: Type.String(),
		name: Type.String({ description: "Lowercase letters, digits and -" }),
		force: Type.Optional(Type.Boolean({ description: "Replace a workflow of that name" })),
	},
	{ description: "Writes the script of the run to .workflows/scripts/<name>.js of the project" },
);

export const PARAMETERS = Type.Object({
	name: Type.Optional(
		Type.String({
			description:
				"`ship`, `campaign`, `optimize`, or the name of a workflow script; not a command such as `list` or `sweep`",
		}),
	),
	script: Type.Optional(Type.String({ description: "An inline workflow script" })),
	resume: Type.Optional(Type.String({ description: "The ID of a run to continue" })),
	answer: Type.Optional(Type.String({ description: "With `resume`: the answer to the question of a waiting run" })),
	save: Type.Optional(SAVE),
	serves: Type.Optional(
		Type.String({
			description:
				"With `name` or `script`: what the run builds, the ID of a todo of the list of the project or the slug of a parley",
		}),
	),
	args: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
	background: Type.Optional(
		Type.Boolean({
			description:
				"With `name`, `script` or `resume`: start the run and return at once; its result comes as a message in this conversation, which drives the run",
		}),
	),
	cwd: Type.Optional(
		Type.String({
			description:
				"With `name` or `script`: the absolute path of the directory to start the run in, instead of the directory of this conversation",
		}),
	),
});

/** The arguments of a call of the tool, checked against `PARAMETERS`. */
export type WorkflowCall = Static<typeof PARAMETERS>;

/**
 * The state of a run, from the task of the run: `running`, or `earlier-version` or `later-version` for a task of another
 * version that has not ended, `waiting` for a result that waits for an answer, `done` for another result, and `failed`,
 * `aborted` or `orphaned` for a task that ended without a result.
 */
export const RUN_STATE = Type.Union([
	Type.Literal("running"),
	Type.Literal("earlier-version"),
	Type.Literal("later-version"),
	Type.Literal("waiting"),
	Type.Literal("done"),
	Type.Literal("failed"),
	Type.Literal("aborted"),
	Type.Literal("orphaned"),
]);

/**
 * The result of a run that is `done` or `waiting`: the status that its script returned, if any, its exit code, and the
 * `score` that its script returned, the score of its last judge, if any.
 */
export const RUN_RESULT = Type.Object(
	{ status: Type.Optional(Type.String()), code: Type.Integer(), score: Type.Optional(Type.Number()) },
	{ additionalProperties: false },
);

export type RunResult = Static<typeof RUN_RESULT>;

/**
 * The text of the state `state` and the result `result` of a run: `done`, `done, result shipped exit 0`, or `done,
 * exit 0` for a result without a status.
 */
export function stateText(state: string, result?: RunResult): string {
	if (result === undefined) return state;

	return result.status === undefined
		? `${state}, exit ${result.code}`
		: `${state}, result ${result.status} exit ${result.code}`;
}

/**
 * The stdout line of `workflows --json` after `run <run-id>`, and of `workflows wait <run-id> --json`, and the outcome
 * that a background run posts. It is also the output schema of the `workflow` tool. `state` is the state of the run. A
 * run that is `done` or `waiting` gives its `result`, and `value`, the whole result of its script. A run that still
 * runs gives `follow`: the command `started` it in the background, `detached` from it, or lost its host, which
 * `host-stopped`. A run `started` in the background `posts` its outcome to the conversation of the command when its
 * task ends, or posts nothing there.
 */
export const OUTCOME = Type.Union([
	Type.Object(
		{
			runId: Type.String(),
			state: Type.Literal("done"),
			result: RUN_RESULT,
			value: JSON_VALUE,
			/** The lines that the workflow's report prints without `--json`. */
			report: Type.Array(Type.String()),
		},
		{ additionalProperties: false },
	),
	/** `question` is the question of the open `input` call that the run waits on. */
	Type.Object(
		{
			runId: Type.String(),
			state: Type.Literal("waiting"),
			question: Type.String(),
			result: RUN_RESULT,
			value: JSON_VALUE,
			report: Type.Array(Type.String()),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			runId: Type.String(),
			state: Type.Union([Type.Literal("failed"), Type.Literal("orphaned")]),
			error: Type.String(),
		},
		{ additionalProperties: false },
	),
	Type.Object({ runId: Type.String(), state: Type.Literal("aborted") }, { additionalProperties: false }),
	/**
	 * `workflow` is the name of the run's workflow, and `repository` the repository of its worktree, else its directory,
	 * which a background run shows while it runs.
	 */
	Type.Object(
		{
			runId: Type.String(),
			state: Type.Literal("running"),
			follow: Type.Literal("started"),
			workflow: Type.String(),
			repository: Type.String(),
			posts: Type.Boolean(),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			runId: Type.String(),
			state: Type.Literal("running"),
			follow: Type.Union([Type.Literal("detached"), Type.Literal("host-stopped")]),
		},
		{ additionalProperties: false },
	),
]);

export type WorkflowOutcome = Static<typeof OUTCOME>;

/** Whether the tool gives `outcome` as a result and not as an error: a run that is `done` or `waiting`, or `started`. */
export function succeeded(outcome: WorkflowOutcome): boolean {
	return (
		outcome.state === "done" || outcome.state === "waiting" || ("follow" in outcome && outcome.follow === "started")
	);
}

export const DESCRIPTION =
	"Run a durable workflow and wait for its result. Start or resume a run only when the user asks for that run in " +
	"his message: a contract or a goal file is not a go. Give exactly one of: `name` (a workflow script such as " +
	"`ship`, `campaign` or `optimize`), `script` (the body of an inline workflow script), `resume` (a run " +
	"ID), or `save` (keeps the script of a run as a named workflow of the project). With `name` or `script`, the " +
	"optional `serves` names what the run builds: the ID of a todo of the list of the project, or the slug of an open " +
	"parley or a contract; the run fails when the todo is done or dropped, or the parley is not open and not a contract. " +
	"`args` are the arguments of " +
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
	"project: Esc detaches from it, and `resume` follows it again. A failed or aborted run stays resumable. With " +
	"`background: true`, the call returns at once and the result of the run comes later as a message in this " +
	"conversation, which drives the run: use it for long runs such as `campaign` or `optimize`, or for work that can go on while the " +
	"conversation continues. `input(question)` in a root run asks the user, as an ask of the project, and stops the " +
	"run: the tool gives a `waiting` result with the question; answer it with `workflow` `resume: <run-id>` and " +
	"`answer`, and `input` then returns the answer. `input` in a child run fails. With " +
	"`name` or `script`, `cwd` is the absolute path of the directory where the run starts: the project scripts, " +
	"the `.workflows` configuration and the default repository of the run come from it; without it, the run " +
	"starts in the directory of this conversation.";

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
function argsOf({ name, script, resume, answer, save, serves, args = {}, background, cwd }: WorkflowCall): string[] {
	const given = [name, script, resume, save].filter((value) => value !== undefined).length;

	if (given !== 1) throw new Error("give exactly one of name, script, resume or save");

	if (answer !== undefined && resume === undefined) throw new Error("answer works only with resume");

	if (background && save !== undefined) throw new Error("background works only with name, script or resume");

	if (cwd !== undefined && (resume !== undefined || save !== undefined)) {
		throw new Error("cwd works only with name or script");
	}

	if (serves !== undefined && (resume !== undefined || save !== undefined)) {
		throw new Error("serves works only with name or script");
	}

	if (name !== undefined && isCommand(name)) throw new Error(`${name} is a command, not a workflow`);

	if (name?.startsWith("-")) throw new Error(`${name} is not a workflow name`);

	const json = background ? ["--background", "--json"] : ["--json"];

	if (resume !== undefined) return ["resume", resume, ...(answer === undefined ? [] : [`--answer=${answer}`]), ...json];

	if (save !== undefined) return ["save", save.runId, save.name, ...(save.force ? ["--force"] : [])];

	const flags = Object.entries(args).flatMap(([key, flag]) => {
		if (flag === false) return [];

		if (flag === true) return [`--${key}`];

		return [`--${key}=${Value.Check(Type.String(), flag) ? flag : JSON.stringify(flag)}`];
	});

	const served = serves === undefined ? [] : [`--serves=${serves}`];

	return [name ?? "-", ...flags, ...served, ...json];
}

/**
 * The `workflows` command of a tool call: its arguments, from `argsOf`, and the directory where it runs, the `cwd` of
 * the call, else `conversation`, the directory of the conversation. Throws on a bad call before it reads the file
 * system, and when `cwd` is not the absolute path of a directory.
 */
export async function commandOf(call: WorkflowCall, conversation: string): Promise<{ args: string[]; cwd: string }> {
	const args = argsOf(call);

	if (call.cwd !== undefined) {
		if (!isAbsolute(call.cwd)) throw new Error(`cwd must be an absolute path: ${call.cwd}`);
		const info = await stat(call.cwd).catch(() => undefined);

		if (info === undefined || !info.isDirectory()) throw new Error(`cwd is not a directory: ${call.cwd}`);
	}

	return { args, cwd: call.cwd ?? conversation };
}

/** What the `workflows` command of a call printed, line by line, and its exit code. */
export type Output = {
	readonly code: number | null;
	readonly stdout: readonly string[];
	readonly stderr: readonly string[];
};

/**
 * The exit code of a command on a saved run that it can never follow: its run directory or its task is missing, or
 * another version saved it.
 */
export const UNFOLLOWABLE_EXIT = 4;

/** The name of the tool, in the harness host and in Pi. */
export const TOOL_NAME = "workflow";

/**
 * The name of the entry of workflows: its key in harness's `entries.json`, and the name of the extension that the
 * entry gives the tool in.
 */
export const ENTRY_NAME = "workflows";

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
 * The file that `workflows save` wrote for the run `runId`, as a `done` outcome, so that it fits the output schema.
 * Throws the stderr text when the command failed.
 */
export function savedOutcome(output: Output, runId: string): Saved {
	const file = output.stdout.at(-1);

	if (output.code !== 0 || file === undefined) {
		throw new Error(output.stderr.join("\n") || `workflows exited with ${output.code}`);
	}

	return {
		text: `saved the script of run ${runId} as ${file}`,
		outcome: { runId, state: "done", result: { code: 0 }, value: { file }, report: [file] },
	};
}

/** The result of a run that waits on `input(question)`: the question, which is also its one report line. */
export const WAITING = Type.Object({
	status: Type.Literal("waiting"),
	question: Type.String(),
	report: Type.Array(Type.String()),
});

/**
 * Whether `result` is the result of a run that waits for an answer: the one test of waiting, which an open `input`
 * call alone gives.
 */
export function waits(result: unknown): result is Static<typeof WAITING> {
	return Value.Check(WAITING, result);
}

/** The most UTF-8 bytes of a summary text. A longer text keeps its first line and its end, with a cut line between. */
const OUTCOME_BYTES = 2000;

/** The most UTF-8 bytes of command output in the error text of a failed command. */
export const OUTPUT_BYTES = 4096;

/** The most UTF-8 bytes of the first line of a cut summary text. */
const HEAD_BYTES = 500;

/** The most UTF-8 bytes of a report line in the text for the caller, with its `…` when it is cut. */
const REPORT_LINE_BYTES = 500;

const ENCODER = new TextEncoder();

/**
 * The text of `outcome` for the caller, at most {@link OUTCOME_BYTES} UTF-8 bytes. A longer text keeps its first line,
 * then a line with the count of cut bytes and the command that shows the rest, then its end.
 */
export function summary(outcome: WorkflowOutcome): string {
	return texts(outcome).summary;
}

/** The text of `outcome` for the model: its summary, then the report lines of a run that is `done`. */
export function outcomeText(outcome: WorkflowOutcome): string {
	const { summary, report } = texts(outcome);

	return [summary, ...report].join("\n");
}

/** The summary text of an outcome, and the report lines that follow it in the text for the model. */
type Texts = { readonly summary: string; readonly report: readonly string[] };

function texts(outcome: WorkflowOutcome): Texts {
	const id = outcome.runId;
	const log = `the command workflows log ${id} shows the run and its calls, and workflows log ${id} <call> prints the whole output of a call`;

	switch (outcome.state) {
		case "waiting": {
			const text = `run ${id} waits for an answer: ${outcome.question}; answer it with resume: "${id}" and answer: "<your answer>"`;

			return { summary: bounded(text, log), report: [] };
		}

		case "done":
			return {
				summary: bounded(
					`run ${id} ${stateText(outcome.state, outcome.result)}: ${JSON.stringify(outcome.value)}`,
					`the command workflows wait ${id} --json prints the whole result`,
				),
				report: outcome.report.map(reportLine),
			};
		case "failed":
			return {
				summary: bounded(`run ${id} failed: ${outcome.error}; continue it with resume: "${id}"`, log),
				report: [],
			};
		case "orphaned":
			return { summary: bounded(`run ${id} orphaned: ${outcome.error}`, log), report: [] };
		case "aborted":
			return { summary: `run ${id} aborted; continue it with resume: "${id}"`, report: [] };
		case "running":
			return {
				summary: outcome.follow === "started" ? startedText(id, outcome.posts) : runningText(id, outcome.follow),
				report: [],
			};
	}
}

/** The text of the run `id` started in the background, whose result comes as a message when it `posts`. */
function startedText(id: string, posts: boolean): string {
	return posts
		? `run ${id} started in the background; its result comes as a message in this conversation when it ends; follow it with resume: "${id}", or stop it with the command workflows stop ${id}`
		: `run ${id} started in the background; no message in this conversation gives its result; follow it with resume: "${id}", or stop it with the command workflows stop ${id}`;
}

/** The text of the run `id` that still runs after the command `follow`. */
function runningText(id: string, follow: "detached" | "host-stopped"): string {
	switch (follow) {
		case "detached":
			return `run ${id} detached and goes on in the harness host; follow it with resume: "${id}", or stop it with the command workflows stop ${id}`;
		case "host-stopped":
			return `the harness host of run ${id} stopped; the run continues when the host starts again, so follow it with resume: "${id}"`;
	}
}

/** `text` when it fits in {@link OUTCOME_BYTES}, else its first line, the cut line with `hint`, and its end. */
function bounded(text: string, hint: string): string {
	const bytes = ENCODER.encode(text);

	if (bytes.length <= OUTCOME_BYTES) return text;
	const newline = bytes.indexOf(0x0a);
	const head = prefix(bytes.subarray(0, newline === -1 ? bytes.length : newline), HEAD_BYTES);
	const decoder = new TextDecoder();

	return `${decoder.decode(head)}\n${cutTail(decoder.decode(bytes.subarray(head.length)), OUTCOME_BYTES - head.length - 1, hint)}`;
}

/**
 * `text` when it fits in `max` UTF-8 bytes, else the cut line with `hint`, a newline, and the longest end of `text`
 * that fits, together at most `max` bytes.
 */
export function cutTail(text: string, max: number, hint?: string): string {
	const bytes = ENCODER.encode(text);

	if (bytes.length <= max) return text;
	// The cut count has at most as many digits as the text length, so this cut line is the longest one.
	const tail = suffix(bytes, max - ENCODER.encode(cutLine(bytes.length, hint)).length - 1);

	return `${cutLine(bytes.length - tail.length, hint)}\n${new TextDecoder().decode(tail)}`;
}

/** `line` when it fits in {@link REPORT_LINE_BYTES}, else its start, cut at a code point, and `…`. */
function reportLine(line: string): string {
	const bytes = ENCODER.encode(line);

	if (bytes.length <= REPORT_LINE_BYTES) return line;

	return `${new TextDecoder().decode(prefix(bytes, REPORT_LINE_BYTES - ENCODER.encode("…").length))}…`;
}

function cutLine(cut: number, hint?: string): string {
	return `[… ${cut} bytes cut${hint === undefined ? "" : `; ${hint}`}]`;
}

/** The longest start of `bytes` of at most `max` bytes that ends at a code point boundary. */
function prefix(bytes: Uint8Array, max: number): Uint8Array {
	if (bytes.length <= max) return bytes;
	let end = max;

	while (end > 0 && isContinuation(bytes[end])) end -= 1;

	return bytes.subarray(0, end);
}

/**
 * The longest end of `bytes` of at most `max` bytes that starts at a line start when that window has one, else at a
 * code point boundary.
 */
function suffix(bytes: Uint8Array, max: number): Uint8Array {
	let start = Math.max(0, bytes.length - max);

	if (start === 0) return bytes;
	const newline = bytes.indexOf(0x0a, start - 1);

	if (newline !== -1 && newline + 1 < bytes.length) return bytes.subarray(newline + 1);

	while (start < bytes.length && isContinuation(bytes[start])) start += 1;

	return bytes.subarray(start);
}

function isContinuation(byte: number | undefined): boolean {
	return byte !== undefined && (byte & 0xc0) === 0x80;
}
