/** `workflows show <run-id>`: the steps, the calls or the agents of a run. */
import { parseArgs } from "node:util";
import type { ScriptInput } from "../../launch/input.ts";
import { endMark, Progress } from "../../records/steps.ts";
import { callRecords, progressEvents, reading, runTasksAndLive } from "../../records/store.ts";
import {
	agentLines,
	agentRows,
	callTree,
	type Shown,
	showEntries,
	type TreeEntry,
	treeLines,
} from "../../records/tree.ts";
import type { SavedCall } from "../../run/calls.ts";
import { hasEnded, hasResult, runStatus, taskOf, taskOutcome } from "../../run/past.ts";
import { reportOf, title as titleOf } from "../../run/result.ts";
import { UsageError, withUsage } from "../../workflow/find.ts";
import { abortedWithin, endOf } from "../follow.ts";
import type { Choose, Terminal } from "../main.ts";
import { checked, oneRunId, type SavedRun, savedRun, shownStatus } from "../saved.ts";
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
	const shown = await readRun(await savedRun(id, SHOW), terminal, mode !== "steps" || json, "be shown");
	const { input, title, status, head, ended, calls, progress, footer, end } = shown;
	const now = Date.now();

	if (mode === "agents" && json) {
		const agents = agentRows(calls, 0, now);
		terminal.stdout(JSON.stringify({ runId: id, workflow: input.name, title, status, ended, agents }));
	} else if (mode === "agents") {
		for (const line of [head, ...agentLines(agentRows(calls, 0, now)), ...footer]) terminal.stdout(line);
	} else if (json) {
		const steps = progress.lines();
		terminal.stdout(JSON.stringify({ runId: id, workflow: input.name, title, status, ...end, steps, calls }));
	} else if (mode === "calls") {
		for (const line of [head, ...treeLines(calls, "", now), ...footer]) terminal.stdout(line);
	} else {
		for (const entry of shownEntries(shown, now)) terminal.stdout(entry.text);
	}

	return 0;
}

/** A saved run as `show` prints it. `end` has the report lines or the error of a run that ended. */
type ShownRun = {
	readonly input: ScriptInput;
	readonly title: string;
	readonly status: string;
	readonly head: string;
	readonly ended: boolean;
	readonly calls: Shown[];
	readonly progress: Progress;
	readonly footer: readonly string[];
	readonly end: { report: string[] } | { error: string } | undefined;
};

/**
 * The saved run `run` as `show` prints it: its task, its head line, its steps, its calls, and its footer lines. It
 * reads the call records `withCalls`, or when the run has no steps. `verb` completes the error for a run that cannot
 * be read, as in `cannot <verb>`.
 */
export async function readRun(run: SavedRun, terminal: Terminal, withCalls: boolean, verb: string): Promise<ShownRun> {
	const { id } = run;

	const empty = {
		task: undefined,
		saved: new Map<string, SavedCall>(),
		progress: new Progress(),
		events: [],
		live: new Set<number>(),
	};

	const { task, saved, progress, events, live } = await reading(run.store, empty, async (store) => {
		const read = new Progress();
		const stored = await progressEvents(store, id);

		for (const event of stored) read.add(event);
		const calls = withCalls || !read.stepped ? await callRecords(store, id) : new Map<string, SavedCall>();
		const { runs, live } = await runTasksAndLive(store);

		return { task: taskOf(runs.get(id) ?? []), saved: calls, progress: read, events: stored, live };
	});

	const checkedTask = checked(task, id, verb);
	const { input } = checkedTask;
	const known = runStatus(checkedTask);
	const completed = hasResult(known);
	const ended = hasEnded(known);
	const title = titleOf(input, events);
	const footer: string[] = [];
	let end: { report: string[] } | { error: string } | undefined;

	if (completed) {
		footer.push(...reportOf(input, taskOutcome(checkedTask)?.result ?? null).lines);
		end = { report: footer };
	} else if (ended) {
		const shown = endOf(checkedTask, title, id);
		footer.push(...shown.lines);

		if (shown.error !== undefined) end = { error: shown.error };
	}

	const status = shownStatus(checkedTask, known);

	if (ended) progress.stop(endMark(known));
	const head = `run ${id} ${input.name} ${status} ${title}`;
	const calls = callTree(saved, id, { ended, waiting: known === "waiting", live });

	return { input, title, status, head, ended, calls, progress, footer, end };
}

/** The lines of `show` of `read`, each with its agent: the head line, the lines of `showEntries`, then the footer. */
function shownEntries(read: ShownRun, now: number): TreeEntry[] {
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
		const read = await readRun(run, terminal, true, "be shown");
		const entries = shownEntries(read, Date.now());

		if (entries.some((entry) => entry.conversation !== undefined)) {
			const refresh = async () => agentItems(shownEntries(await readRun(run, terminal, true, "be shown"), Date.now()));
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
