/** The runs of `workflows web`: the runs of the projects, the snapshot of one run, and the stream of its snapshots. */
import type { ServerResponse } from "node:http";
import { type ListedRun, projectRuns } from "../cli/commands/list.ts";
import { readRun } from "../cli/commands/show.ts";
import { savedRun } from "../cli/saved.ts";
import { showEntries, type TreeEntry } from "../records/tree.ts";
import type { RunStatus } from "../run/past.ts";

/** The usage that a run ID that is not valid gives: the routes of one run. */
const RUN_ROUTE = "/api/runs/<run-id>";

/** How long a stream waits after a read of its run ends before it reads the run again. */
const STREAM_POLL_MS = 1000;

/** The badge of a run in the control center. */
export type Badge = "running" | "waiting" | "done" | "failed" | "stopped";

/**
 * The badge of a run of `status`: `failed` for a task that ended without a result and cannot go on as it was, and
 * `stopped` for a run that stopped, that has no task yet, or that another version saved.
 */
export function badgeOf(status: RunStatus | "unstarted"): Badge {
	switch (status) {
		case "running":
		case "waiting":
		case "done":
			return status;
		case "failed":
		case "orphaned":
			return "failed";
		case "aborted":
		case "earlier-version":
		case "later-version":
		case "unstarted":
			return "stopped";
	}
}

/** A run of `GET /api/runs`: a run of `workflows list --json`, with its project and its badge. */
export type WebRun = Omit<ListedRun, "run"> & { readonly project: string; readonly badge: Badge };

/** The runs of `projects`, newest run ID first. */
export async function runsOf(projects: readonly string[]): Promise<WebRun[]> {
	const each = await Promise.all(
		projects.map(async (project) =>
			(await projectRuns(project)).map(({ run, ...listed }): WebRun => ({ project, ...listed, badge: badgeOf(run) })),
		),
	);

	return each.flat().sort((a, b) => b.runId.localeCompare(a.runId));
}

/**
 * A run as the control center shows it: the lines of `show` with the agent of each, as `entries`, then its `footer`
 * lines. `end` has the report lines or the error of a run that ended, and `waitingQuestion` the question of a run that
 * waits for an answer.
 */
export type RunSnapshot = {
	readonly runId: string;
	readonly project: string;
	readonly workflow: string;
	readonly title: string;
	readonly status: string;
	readonly badge: Badge;
	readonly ended: boolean;
	readonly waitingQuestion: string | undefined;
	readonly entries: readonly TreeEntry[];
	readonly footer: readonly string[];
	readonly end: { report: string[] } | { error: string } | null;
};

/** The snapshot of the run `id`, from the project store of its project. */
export async function runSnapshot(id: string): Promise<RunSnapshot> {
	const run = await savedRun(id, RUN_ROUTE);
	const read = await readRun(run, true, "be shown");

	return {
		runId: id,
		project: run.project,
		workflow: read.input.name,
		title: read.title,
		status: read.status,
		badge: badgeOf(read.run),
		ended: read.ended,
		waitingQuestion: read.question,
		entries: showEntries(read.calls, read.progress, Date.now()),
		footer: read.footer,
		end: read.end ?? null,
	};
}

/**
 * Streams the snapshots of the run `id` to `res` as Server-Sent Events: one at once, then one each time that a read,
 * 1 s after the last one ends, gives another snapshot. It throws before the response starts when the first read
 * fails. A later read that fails sends nothing, and the stream goes on until the client closes it. A client that
 * closes it during the first read gets nothing.
 */
export async function streamRun(res: ServerResponse, id: string): Promise<void> {
	const first = await runSnapshot(id);

	// A response that closed during the read sent its `close` event then, so a listener that comes now never runs.
	if (res.destroyed) return;
	let timer: NodeJS.Timeout | undefined;
	res.on("close", () => clearTimeout(timer));
	res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store" });
	let last = "";

	// A snapshot that comes while the socket drains waits for the next read, which sends the newest one.
	const send = (snapshot: RunSnapshot) => {
		const frame = JSON.stringify(snapshot);

		if (frame === last || res.writableNeedDrain) return;
		last = frame;
		res.write(`data: ${frame}\n\n`);
	};

	const later = () => {
		timer = setTimeout(async () => {
			try {
				const snapshot = await runSnapshot(id);

				if (!res.destroyed) send(snapshot);
			} catch {
				// The stream keeps its last snapshot, and the next read tries again.
			}

			if (!res.destroyed) later();
		}, STREAM_POLL_MS);
	};

	send(first);
	later();
}
