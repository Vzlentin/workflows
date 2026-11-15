/** `workflows show <run-id>`: the steps, the calls or the agents of a run. */
import { parseArgs } from "node:util";
import type { Todo } from "@vzlentin/harness/todo";
import { type Static, Type } from "typebox";
import { endMark, type Progress } from "../../records/steps.ts";
import { runRecords } from "../../records/store.ts";
import { agentLines, agentRows, callTree, type Shown, showEntries, type TreeEntry } from "../../records/tree.ts";
import { hasEnded, type RunFields, type RunTask, runFields, runOutcome, taskOf } from "../../run/past.ts";
import { type ShownInput, title as titleOf } from "../../run/result.ts";
import { RUN_RESULT, RUN_STATE, stateText } from "../../tool.ts";
import { UsageError, withUsage } from "../../workflow/find.ts";
import { abortedWithin, endOf } from "../follow.ts";
import type { Choose, Terminal } from "../main.ts";
import { oneRunId, readable, type SavedRun, savedRun } from "../saved.ts";
import type { PickItem } from "../terminal/pick.ts";

export const SHOW = "workflows show <run-id> [--pick | [--agents] [--json]]";

/**
 * The fields of a run that `show --json` and `show --agents --json` both give. `result` is the result of a run that is
 * `done` or `waiting`, and `resumable` is true for a task of this version, which `resume` can continue.
 */
const RUN_FIELDS = {
	runId: Type.String(),
	workflow: Type.String(),
	title: Type.String(),
	state: RUN_STATE,
	result: Type.Optional(RUN_RESULT),
	resumable: Type.Boolean(),
};

/**
 * The run of `show --json`: its fields, the report lines of a run with a result or the error of a failed run, its
 * todos, its step lines and its calls.
 */
export const SHOWN = Type.Object(
	{
		...RUN_FIELDS,
		report: Type.Optional(Type.Array(Type.String())),
		error: Type.Optional(Type.String()),
		todos: Type.Array(Type.Unknown()),
		steps: Type.Array(Type.String()),
		calls: Type.Array(Type.Unknown()),
	},
	{ additionalProperties: false },
);

/** The run of `show --agents --json`: its fields, whether it ended, and its agents. */
export const SHOWN_AGENTS = Type.Object(
	{ ...RUN_FIELDS, ended: Type.Boolean(), agents: Type.Array(Type.Unknown()) },
	{ additionalProperties: false },
);

/** How often `show --pick` reads the store again while no line of the run can be picked. */
const PICK_POLL_MS = 1000;

/**
 * Prints the steps of a run as a tree, or with `--agents` its agents, then its report lines, or how it ended. A run
 * without steps prints its calls. With `--pick`, it asks on the terminal for a line, and prints the conversation
 * of the agent of that line. It reads the task records, the progress, and the call records when it needs them, from
 * the project store only.
 */
export async function show(args: readonly string[], terminal: Terminal, json: boolean): Promise<number> {
	const { values, positionals } = withUsage(
		() =>
			parseArgs({
				args: [...args],
				options: { agents: { type: "boolean" }, pick: { type: "boolean" } },
				allowPositionals: true,
				strict: true,
			}),
		SHOW,
	);

	if (values.pick && (values.agents || json)) {
		throw new UsageError("give --pick without --agents or --json", SHOW);
	}

	const id = oneRunId(positionals, SHOW);

	if (values.pick) {
		if (terminal.choose === undefined) throw new UsageError("--pick needs a terminal on stdin and stderr", SHOW);

		return pickAgent(await savedRun(id, SHOW), terminal, terminal.choose);
	}

	const agents = values.agents === true;
	const shown = await readRun(await savedRun(id, SHOW), agents || json, "be shown");
	const { input, title, head, ended, todos, calls, progress, footer, end } = shown;
	const now = Date.now();
	const fields = { runId: id, workflow: input.name, title, ...shown.fields };

	if (agents && json) {
		const agentsShown: Static<typeof SHOWN_AGENTS> = { ...fields, ended, agents: agentRows(calls, 0, now) };
		terminal.stdout(JSON.stringify(agentsShown));
	} else if (agents) {
		for (const line of [head, ...agentLines(agentRows(calls, 0, now)), ...footer]) terminal.stdout(line);
	} else if (json) {
		const runShown: Static<typeof SHOWN> = { ...fields, ...end, todos, steps: progress.lines(), calls };
		terminal.stdout(JSON.stringify(runShown));
	} else {
		for (const entry of shownLines(shown, now)) terminal.stdout(entry.text);
	}

	return 0;
}

/**
 * A saved run as `show` prints it. `task` is the task that it reads, `todos` is the list of todos of the run, and
 * `end` has the report lines or the error of a run that ended.
 */
type ShownRun = {
	readonly task: RunTask;
	readonly input: ShownInput;
	readonly title: string;
	readonly fields: RunFields;
	readonly head: string;
	readonly ended: boolean;
	readonly todos: Todo[];
	readonly calls: Shown[];
	readonly progress: Progress;
	readonly footer: readonly string[];
	readonly end: { report: string[] } | { error: string } | undefined;
};

/**
 * The saved run `run` as `show` prints it: its task, its head line, its steps, its list of todos, its calls, and its
 * footer lines. It reads the call records `withCalls`, or when the run has no steps, and the lists of todos of the run
 * and of the child runs of those records. It reads a task of this version, and a task of another version that ended,
 * as `readable` gives them. The footer tells how to resume only a run of this version. `verb` completes the error for a
 * run that cannot be read, as in `cannot <verb>`.
 */
export async function readRun(run: SavedRun, withCalls: boolean, verb: string): Promise<ShownRun> {
	const { id } = run;
	const read = await runRecords(run.store, id, (progress) => withCalls || !progress.stepped);
	const { events, progress, records, live, todos } = read;
	const { task: checkedTask, input } = readable(taskOf(read.tasks), id, verb);
	const fields = runFields(checkedTask);
	const known = fields.state;
	const ended = hasEnded(known);
	const title = titleOf(input, events);
	const footer: string[] = [];
	let end: { report: string[] } | { error: string } | undefined;

	if (ended) {
		const outcome = runOutcome(input, checkedTask);

		if ("report" in outcome) {
			footer.push(...outcome.report);
			end = { report: footer };
		} else {
			const shown = endOf(outcome, title, fields.resumable);
			footer.push(...shown.lines);

			if (shown.error !== undefined) end = { error: shown.error };
		}

		progress.stop(endMark(known));
	}

	const head = `run ${id} ${input.name} ${stateText(known, fields.result)} ${title}`;
	const calls = callTree(records, todos, id, { ended, waiting: known === "waiting", live });

	return {
		task: checkedTask,
		input,
		title,
		fields,
		head,
		ended,
		todos: todos.get(id) ?? [],
		calls,
		progress,
		footer,
		end,
	};
}

/** The lines of `show` of `read`, each with its agent: the head line, the lines of `showEntries`, then the footer. */
function shownLines(read: ShownRun, now: number): TreeEntry[] {
	const footer = read.footer.map((text) => ({ text }));

	return [{ text: read.head }, ...showEntries(read.calls, read.progress, now), ...footer];
}

/**
 * Asks on the terminal for a line of `show` of `run`, and prints the conversation of its agent. Only a line that maps
 * to an agent can be taken: a step line, a log line or a line of a child run gets the first session of its step, and a
 * call line of a run without steps the conversation of its session or its ask. While no line maps to an
 * agent and the run has not ended, it reads the store again every second. While the pick waits for a key, it reads the
 * run again every second.
 */
async function pickAgent(run: SavedRun, terminal: Terminal, choose: Choose): Promise<number> {
	for (;;) {
		const read = await readRun(run, true, "be shown");
		const entries = shownLines(read, Date.now());

		if (entries.some((entry) => entry.conversation !== undefined)) {
			const refresh = async () => agentItems(shownLines(await readRun(run, true, "be shown"), Date.now()));
			const conversation = await choose("Pick an agent:", agentItems(entries), refresh);

			if (conversation === undefined) return 130;
			terminal.stdout(String(conversation));

			return 0;
		}

		if (read.ended) throw new Error(`run ${run.id} has no agent`);

		if (await abortedWithin(terminal.interrupt, PICK_POLL_MS)) return 130;
	}
}

/** The items of the agent picker: the lines of `entries`, each with the conversation of its agent as its value. */
function agentItems(entries: readonly TreeEntry[]): PickItem<number>[] {
	return entries.map(({ text, conversation }) => ({ text, value: conversation }));
}
