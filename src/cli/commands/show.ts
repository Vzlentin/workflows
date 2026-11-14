/** `workflows show <run-id>`: the steps, the calls or the agents of a run. */
import { parseArgs } from "node:util";
import type { Todo } from "@vzlentin/harness/todo";
import { endMark, type Progress } from "../../records/steps.ts";
import { runRecords } from "../../records/store.ts";
import {
	agentLines,
	agentRows,
	callTree,
	type Shown,
	showEntries,
	type TreeEntry,
	treeLines,
} from "../../records/tree.ts";
import { hasEnded, hasResult, type RunTask, runStatus, taskOf, taskOutcome } from "../../run/past.ts";
import { reportOf, type ShownInput, title as titleOf } from "../../run/result.ts";
import { UsageError, withUsage } from "../../workflow/find.ts";
import { abortedWithin, endOf } from "../follow.ts";
import type { Choose, Terminal } from "../main.ts";
import { oneRunId, readable, type SavedRun, savedRun, shownStatus } from "../saved.ts";
import type { PickItem } from "../terminal/pick.ts";

export const SHOW = "workflows show <run-id> [--pick | [--calls | --agents] [--json]]";

/** How often `show --pick` reads the store again while no line of the run can be picked. */
const PICK_POLL_MS = 1000;

/**
 * Prints the steps of a run as a tree, or with `--calls` its phases and calls, then its report lines, or how it ended.
 * A run without steps prints its calls. With `--pick`, it asks on the terminal for a line, and prints the conversation
 * of the agent of that line. It reads the task records, the progress, and the call records when it needs them, from
 * the project store only.
 */
export async function show(args: readonly string[], terminal: Terminal, json: boolean): Promise<number> {
	const { values, positionals } = withUsage(
		() =>
			parseArgs({
				args: [...args],
				options: { calls: { type: "boolean" }, agents: { type: "boolean" }, pick: { type: "boolean" } },
				allowPositionals: true,
				strict: true,
			}),
		SHOW,
	);

	if (values.calls && values.agents) throw new UsageError("give --calls or --agents, not both", SHOW);

	if (values.pick && (values.calls || values.agents || json)) {
		throw new UsageError("give --pick without --calls, --agents or --json", SHOW);
	}

	const id = oneRunId(positionals, SHOW);

	if (values.pick) {
		if (terminal.choose === undefined) throw new UsageError("--pick needs a terminal on stdin and stderr", SHOW);

		return pickAgent(await savedRun(id, SHOW), terminal, terminal.choose);
	}

	const mode = values.agents ? "agents" : values.calls ? "calls" : "steps";
	const shown = await readRun(await savedRun(id, SHOW), mode !== "steps" || json, "be shown");
	const { input, title, status, head, ended, todos, calls, progress, footer, end } = shown;
	const now = Date.now();
	const run = { runId: id, workflow: input.name };

	if (mode === "agents" && json) {
		const agents = agentRows(calls, 0, now);
		terminal.stdout(JSON.stringify({ ...run, title, status, ended, agents }));
	} else if (mode === "agents") {
		for (const line of [head, ...agentLines(agentRows(calls, 0, now)), ...footer]) terminal.stdout(line);
	} else if (json) {
		const steps = progress.lines();
		terminal.stdout(JSON.stringify({ ...run, title, status, ...end, todos, steps, calls }));
	} else if (mode === "calls") {
		for (const line of [head, ...treeLines(calls, "", now), ...footer]) terminal.stdout(line);
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
	readonly status: string;
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
 * as `readable` gives them. The footer tells how to resume only a `resumable` run. `verb` completes the error for a
 * run that cannot be read, as in `cannot <verb>`.
 */
export async function readRun(run: SavedRun, withCalls: boolean, verb: string): Promise<ShownRun> {
	const { id } = run;
	const read = await runRecords(run.store, id, (progress) => withCalls || !progress.stepped);
	const { events, progress, records, live, todos } = read;
	const { task: checkedTask, input, thisVersion } = readable(taskOf(read.tasks), id, verb);
	const known = runStatus(checkedTask);
	const completed = hasResult(known);
	const ended = hasEnded(known);
	const resumable = thisVersion && ended && known !== "done";
	const title = titleOf(input, events);
	const result = taskOutcome(checkedTask)?.result ?? null;
	const footer: string[] = [];
	let end: { report: string[] } | { error: string } | undefined;

	if (completed) {
		footer.push(...reportOf(input, result).lines);
		end = { report: footer };
	} else if (ended) {
		const shown = endOf(checkedTask, title, id, resumable);
		footer.push(...shown.lines);

		if (shown.error !== undefined) end = { error: shown.error };
	}

	const status = shownStatus(checkedTask, known);

	if (ended) progress.stop(endMark(known));
	const head = `run ${id} ${input.name} ${status} ${title}`;
	const calls = callTree(records, todos, id, { ended, waiting: known === "waiting", live });

	return {
		task: checkedTask,
		input,
		title,
		status,
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
 * line of `--calls`, for a run without steps, the conversation of its session or its ask. While no line maps to an
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
