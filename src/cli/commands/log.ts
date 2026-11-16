/** `workflows log <run-id>`: the short log of a run, the full output of one call, or the log as the run goes on. */
import { parseArgs } from "node:util";
import { callText, errorLines, findCall, type RunProgress, runLines, stepLog } from "../../records/log.ts";
import { runRecords } from "../../records/store.ts";
import { type CallNode, callNodes } from "../../records/tree.ts";
import { keyOfName, stepOf } from "../../run/keys.ts";
import {
	endedOutcome,
	endedStatus,
	hasEnded,
	type RunStatus,
	type RunTask,
	runStatus,
	taskOf,
	taskOutcome,
	taskResult,
} from "../../run/past.ts";
import { stateText } from "../../tool.ts";
import { UsageError, withUsage } from "../../workflow/find.ts";
import { abortedWithin } from "../follow.ts";
import type { Terminal } from "../main.ts";
import { type SavedRun, savedBy, savedRun, UnfollowableRun } from "../saved.ts";

export const LOG = "workflows log <run-id> [<step> | <call>] [--follow]";

/** How often `log --follow` reads the store again. */
const FOLLOW_POLL_MS = 1000;

/**
 * Prints the short log of a run, or with `<step>` the line of each call of that step, or with `<call>` the full text of
 * that call, or with `--follow` the short log and its
 * new lines until the run's task does not run. It reads the project store only, for a run of any version.
 */
export async function log(args: readonly string[], terminal: Terminal, json: boolean): Promise<number> {
	const { values, positionals } = withUsage(
		() =>
			parseArgs({ args: [...args], options: { follow: { type: "boolean" } }, allowPositionals: true, strict: true }),
		LOG,
	);

	if (json) throw new UsageError("log has no --json", LOG);
	const [id, named, ...rest] = positionals;

	if (id === undefined || id.startsWith("-") || rest.length > 0) throw new UsageError("give one run ID", LOG);

	const step = named === undefined ? undefined : stepOf(id, named);

	if (values.follow && named !== undefined) {
		throw new UsageError(`give --follow or a ${step !== undefined ? "step" : "call"}, not both`, LOG);
	}

	const run = await savedRun(id, LOG);

	if (named !== undefined) {
		const { calls, progress } = await readLog(run);
		let lines: string[] | undefined;

		if (step !== undefined) {
			lines = stepLog(id, progress, calls, step);
		} else {
			const node = findCall(calls, (n) => n.key === keyOfName(id, named));
			lines = node && callText(id, node);
		}

		if (lines === undefined)
			throw new UsageError(`no ${step !== undefined ? "step" : "call"} ${named} in run ${id}`, LOG);

		for (const line of lines) terminal.stdout(line);

		return 0;
	}

	const printed = new Set<string>();

	for (;;) {
		const read = await readLog(run);

		const lines = [
			{ item: "run", text: read.head },
			...runLines(id, id, read.status, read.progress, read.calls, ""),
			...errorLines(id, read.error),
		];

		for (const { item, text } of lines) {
			if (printed.has(item)) continue;
			printed.add(item);
			terminal.stdout(text);
		}

		if (!values.follow || read.status !== "running") return 0;

		if (await abortedWithin(terminal.interrupt, FOLLOW_POLL_MS)) return 130;
	}
}

/**
 * A run as `log` reads it: its head line, its call tree, its progress, the status of its task, if it has one, as its
 * outcome gives it for a task of another version that ended, and the error of the task when it ended with one.
 */
type ReadLog = {
	readonly head: string;
	readonly calls: CallNode[];
	readonly progress: RunProgress;
	readonly status: RunStatus | undefined;
	readonly error: string | undefined;
};

/** Reads the root tasks, the progress and the call records of `run` in one read. */
async function readLog(run: SavedRun): Promise<ReadLog> {
	const { id } = run;
	const read = await runRecords(run.store, id, () => true);
	const { tasks, events, records, live } = read;
	const task = taskOf(tasks);

	if (task === undefined && events.length === 0 && records.size === 0) {
		throw new UnfollowableRun(`run ${id} has no workflow`);
	}

	// The calls, the steps and the end line of a task of another version that ended show how it ended; its head shows
	// its state.
	const status = task === undefined ? undefined : (endedStatus(task) ?? runStatus(task));
	const ended = status === undefined || hasEnded(status);
	const calls = callNodes(records, id, { ended, waiting: status === "waiting", live });

	if (status !== undefined) read.progress.end(status);

	const head =
		task === undefined
			? `run ${id}`
			: `run ${id} ${savedBy(task).name} ${stateText(runStatus(task), taskResult(task))}`;

	return { head, calls, progress: read, status, error: errorOf(id, task) };
}

/** The error of the task `task` of the run `id`, when it ended with one: failed, faulted or orphaned. */
function errorOf(id: string, task: RunTask | undefined): string | undefined {
	const outcome = task === undefined ? undefined : taskOutcome(task);

	if (outcome === undefined || outcome.status === "completed") return undefined;
	const ended = endedOutcome(id, outcome);

	return ended.state === "aborted" ? undefined : ended.error;
}
