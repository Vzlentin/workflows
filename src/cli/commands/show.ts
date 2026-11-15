/** `workflows show <run-id>`: the steps, the calls or the agents of a run. */
import { parseArgs } from "node:util";
import { Todo } from "@vzlentin/harness/todo";
import { type Static, Type } from "typebox";
import { RUN_FIELDS, type TaskFields, taskFields } from "../../records/run.ts";
import { endMark, type Progress } from "../../records/steps.ts";
import { runRecords } from "../../records/store.ts";
import {
	AGENT_ROW,
	agentLines,
	agentRows,
	callTree,
	runAgent,
	SHOWN_CALL,
	type Shown,
	showEntries,
	type TreeEntry,
} from "../../records/tree.ts";
import { hasEnded, type RunTask, runOutcome, taskOf } from "../../run/past.ts";
import { type ShownInput, title as titleOf } from "../../run/result.ts";
import { stateText } from "../../tool.ts";
import { UsageError, withUsage } from "../../workflow/find.ts";
import { abortedWithin, endOf } from "../follow.ts";
import type { Choose, Terminal } from "../main.ts";
import { oneRunId, readable, type SavedRun, savedRun } from "../saved.ts";
import type { PickItem } from "../terminal/pick.ts";

export const SHOW = "workflows show <run-id> [--pick | [--agents] [--json]]";

/**
 * The agent of a run, as `harness attach` opens it: its conversation, and the project of the run, whose host has it.
 */
const RUN_AGENT = Type.Object({ conversation: Type.Number(), project: Type.String() }, { additionalProperties: false });

/**
 * The fields of every run of `show --json`: the run fields, its agent when it has one, its todos, its step lines and
 * its calls.
 */
const SHOWN_FIELDS = {
	...RUN_FIELDS,
	agent: Type.Optional(RUN_AGENT),
	todos: Type.Array(Todo),
	steps: Type.Array(Type.String()),
	calls: Type.Array(SHOWN_CALL),
};

/** The report lines of a run with a result. */
const REPORT_END = { report: Type.Array(Type.String()) };

/** The error of a failed or orphaned run. */
const ERROR_END = { error: Type.String() };

/** How a run that ended ended: the report lines of a run with a result, or the error of a failed or orphaned run. */
type ShownEnd = Static<Type.TObject<typeof REPORT_END>> | Static<Type.TObject<typeof ERROR_END>>;

/**
 * The run of `show --json`: the fields of every run, with the report lines of a run with a result, the error of a
 * failed or orphaned run, or neither.
 */
export const SHOWN = Type.Union([
	Type.Object(SHOWN_FIELDS, { additionalProperties: false }),
	Type.Object({ ...SHOWN_FIELDS, ...REPORT_END }, { additionalProperties: false }),
	Type.Object({ ...SHOWN_FIELDS, ...ERROR_END }, { additionalProperties: false }),
]);

/** The run of `show --agents --json`: the run fields, its agent when it has one, whether it ended, and its agents. */
export const SHOWN_AGENTS = Type.Object(
	{ ...RUN_FIELDS, agent: Type.Optional(RUN_AGENT), ended: Type.Boolean(), agents: Type.Array(AGENT_ROW) },
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
	const rows = agentRows(calls, 0, now);

	const fields: Static<Type.TObject<typeof RUN_FIELDS>> & { agent?: Static<typeof RUN_AGENT> } = {
		runId: id,
		workflow: input.name,
		title,
		...shown.fields,
	};

	const agent = runAgent(rows);

	if (agent !== undefined) fields.agent = { conversation: agent.conversation, project: shown.project };

	if (agents && json) {
		const agentsShown: Static<typeof SHOWN_AGENTS> = { ...fields, ended, agents: rows };
		terminal.stdout(JSON.stringify(agentsShown));
	} else if (agents) {
		for (const line of [head, ...agentLines(rows), ...footer]) terminal.stdout(line);
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
	readonly fields: TaskFields;
	/** The project of the run, whose host has its agents. */
	readonly project: string;
	readonly head: string;
	readonly ended: boolean;
	readonly todos: Todo[];
	readonly calls: Shown[];
	readonly progress: Progress;
	readonly footer: readonly string[];
	readonly end: ShownEnd | undefined;
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
	const fields = taskFields(read.tasks, checkedTask);
	const known = fields.state;
	const ended = hasEnded(known);
	const title = titleOf(input, events);
	const footer: string[] = [];
	let end: ShownEnd | undefined;

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
		project: run.project,
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
