/** `workflows stop <run-id>`: stops a run in its host. */
import { endedOutcome, endedStatus, type RunTask } from "../../run/past.ts";
import { title as titleOf } from "../../run/result.ts";
import { current } from "../../run/version.ts";
import { abortRun } from "../host.ts";
import type { Terminal } from "../main.ts";
import { eventsOf, lastTask, oneRunId, savedBy, savedRun, UnfollowableRun } from "../saved.ts";

export const STOP = "workflows stop <run-id> [--json]";

/**
 * Stops the run of `args` in its host. Its task ends as aborted, and a resume continues it. A pending task of another
 * version, which no host can run, ends as orphaned. The text tells what the abort gave: only an orphaned task cannot
 * resume, and only a task of this version tells how to continue.
 */
export async function stop(args: readonly string[], terminal: Terminal, json: boolean): Promise<number> {
	const run = await savedRun(oneRunId(args, STOP), STOP);

	const { latest, keys } = await lastTask(run);

	if (latest === undefined) throw new UnfollowableRun(`run ${run.id} has no workflow`);

	if (endedStatus(latest) !== undefined) throw new Error(`run ${run.id} is not running`);
	const key = keys.keyOf(latest);
	const ended = await abortRun(terminal, run.host, key);
	const { outcome } = ended;

	if (outcome?.status !== "aborted" && outcome?.status !== "orphaned") throw new Error(`run ${run.id} is not running`);
	const stopped = endedOutcome(run.id, outcome);

	if (json) {
		terminal.stdout(JSON.stringify(stopped));

		return 0;
	}

	const [subject, resume] = current(latest)
		? [titleOf(latest.input, await eventsOf(run)), `; continue with: workflows resume ${run.id}`]
		: [savedText(latest), ""];

	terminal.stdout(
		stopped.state === "orphaned" ? `orphaned ${subject}; it cannot resume` : `aborted ${subject}${resume}`,
	);

	return 0;
}

/** The workflow of `task`, which another version saved, and which version saved it. */
function savedText(task: RunTask): string {
	const { name, later } = savedBy(task);

	return `${name}, which ${later ? "a later" : "an earlier"} version saved`;
}
