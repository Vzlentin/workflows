/** `workflows log <run-id>`: the short log of a run, the full output of one call, or the log as the run goes on. */
import { parseArgs } from "node:util";
import { callText, findCall, type LogRun, type RunProgress, rootRun, runLines, stepLog } from "../../records/log.ts";
import { runRecords } from "../../records/store.ts";
import { type CallNode, callNodes } from "../../records/tree.ts";
import { keyOfName, stepOf } from "../../run/keys.ts";
import { hasEnded, recordedStatus } from "../../run/past.ts";
import { UsageError, withUsage } from "../../workflow/find.ts";
import { abortedWithin } from "../follow.ts";
import type { Terminal } from "../main.ts";
import { type SavedRun, savedRun, UnfollowableRun } from "../saved.ts";

export const LOG = "workflows log <run-id> [<step> | <call>] [--follow]";

/** How often `log --follow` reads the store again. */
const FOLLOW_POLL_MS = 1000;

/**
 * Prints the short log of a run, or with `<step>` the line of each call of that step, or with `<call>` the full text of
 * that call, or with `--follow` the short log and its
 * new lines until the run's task does not run. It reads the host store only, for a run of any version.
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
		const { calls, progress, root } = await readLog(run);
		let lines: string[] | undefined;

		if (step !== undefined) {
			lines = stepLog(root, progress, calls, step);
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

		const lines = runLines(id, read.root, read.progress, read.calls);

		for (const { item, text } of lines) {
			if (printed.has(item)) continue;
			printed.add(item);
			terminal.stdout(text);
		}

		const { task } = read.root;

		if (!values.follow || task === undefined || recordedStatus(task) !== "running") return 0;

		if (await abortedWithin(terminal.interrupt, FOLLOW_POLL_MS)) return 130;
	}
}

/** A run as `log` reads it: the root run, its call tree, and its progress. */
type ReadLog = { readonly root: LogRun; readonly calls: CallNode[]; readonly progress: RunProgress };

/** Reads the root tasks, the progress and the call records of `run` in one read. */
async function readLog(run: SavedRun): Promise<ReadLog> {
	const { id } = run;
	const read = await runRecords(run.store, id, () => true);
	const { tasks, events, records, live } = read;
	const root = rootRun(id, tasks);
	const { task } = root;

	if (task === undefined && events.length === 0 && records.size === 0) {
		throw new UnfollowableRun(`run ${id} has no workflow`);
	}

	// The calls, the steps and the end line of a task of another version that ended show how it ended.
	const status = task === undefined ? undefined : recordedStatus(task);
	const ended = status === undefined || hasEnded(status);
	const calls = callNodes(records, id, { ended, waiting: status === "waiting", live });

	if (status !== undefined) read.progress.end(status);

	return { root, calls, progress: read };
}
