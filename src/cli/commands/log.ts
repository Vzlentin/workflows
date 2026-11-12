/** `workflows log <run-id>`: the short log of a run, the full output of one call, or the log as the run goes on. */
import { parseArgs } from "node:util";
import { callKey, callText, findCall, type LogLine, shortLog } from "../../records/log.ts";
import { runRecords } from "../../records/store.ts";
import { type CallNode, callNodes } from "../../records/tree.ts";
import { hasEnded, type RunStatus, runStatus, taskOf } from "../../run/past.ts";
import { UsageError, withUsage } from "../../workflow/find.ts";
import { abortedWithin } from "../follow.ts";
import type { Terminal } from "../main.ts";
import { GoneRun, type SavedRun, savedBy, savedRun, shownStatus } from "../saved.ts";

export const LOG = "workflows log <run-id> [<call>] [--follow]";

/** How often `log --follow` reads the store again. */
const FOLLOW_POLL_MS = 1000;

/**
 * Prints the short log of a run, or with `<call>` the full text of that call, or with `--follow` the short log and its
 * new lines until the run's task does not run. It reads the project store only, for a run of any version.
 */
export async function log(args: readonly string[], terminal: Terminal, json: boolean): Promise<number> {
	const { values, positionals } = withUsage(
		() =>
			parseArgs({ args: [...args], options: { follow: { type: "boolean" } }, allowPositionals: true, strict: true }),
		LOG,
	);

	if (json) throw new UsageError("log has no --json", LOG);
	const [id, call, ...rest] = positionals;

	if (id === undefined || id.startsWith("-") || rest.length > 0) throw new UsageError("give one run ID", LOG);

	if (values.follow && call !== undefined) throw new UsageError("give --follow or a call, not both", LOG);
	const run = await savedRun(id, LOG);

	if (call !== undefined) {
		const { calls } = await readLog(run);
		const node = findCall(calls, callKey(id, call));

		if (node === undefined) throw new UsageError(`no call ${call} in run ${id}`, LOG);

		for (const line of callText(id, node)) terminal.stdout(line);

		return 0;
	}

	const printed = new Set<string>();

	for (;;) {
		const read = await readLog(run);

		for (const { item, text } of read.lines) {
			if (printed.has(item)) continue;
			printed.add(item);
			terminal.stdout(text);
		}

		if (!values.follow || read.status !== "running") return 0;

		if (await abortedWithin(terminal.interrupt, FOLLOW_POLL_MS)) return 130;
	}
}

/** A run as `log` reads it: its lines, its call tree, and the status of its task, if it has one. */
type ReadLog = { readonly lines: LogLine[]; readonly calls: CallNode[]; readonly status: RunStatus | undefined };

/** Reads the root tasks, the progress and the call records of `run` in one read. */
async function readLog(run: SavedRun): Promise<ReadLog> {
	const { id } = run;
	const read = await runRecords(run.store, id, () => true);
	const { tasks, events, records, live } = read;
	const task = taskOf(tasks);

	if (task === undefined && events.length === 0 && records.size === 0) throw new GoneRun(`run ${id} has no workflow`);
	const status = task === undefined ? undefined : runStatus(task);
	const ended = status === undefined || hasEnded(status);
	const calls = callNodes(records, id, { ended, waiting: status === "waiting", live });

	const head =
		task === undefined || status === undefined
			? `run ${id}`
			: `run ${id} ${savedBy(task).name} ${shownStatus(task, status)}`;

	return { lines: shortLog(head, id, read, calls), calls, status };
}
