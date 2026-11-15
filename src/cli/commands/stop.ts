/** `workflows stop <run-id>`: stops a run in its host. */
import { endedOutcome, hasEnded, runStatus } from "../../run/past.ts";
import { title as titleOf } from "../../run/result.ts";
import { current } from "../../run/version.ts";
import { abortRun } from "../host.ts";
import type { Terminal } from "../main.ts";
import { GoneRun, lastTask, oneRunId, progressOf, savedBy, savedRun } from "../saved.ts";

export const STOP = "workflows stop <run-id> [--json]";

/**
 * Stops the run of `args` in its host. Its task ends as aborted, and a resume continues it. A pending task of another
 * version, which no host can run, ends as orphaned.
 */
export async function stop(args: readonly string[], terminal: Terminal, json: boolean): Promise<number> {
	const run = await savedRun(oneRunId(args, STOP), STOP);

	const { latest, keys } = await lastTask(run);

	if (latest === undefined) throw new GoneRun(`run ${run.id} has no workflow`);

	if (hasEnded(runStatus(latest))) throw new Error(`run ${run.id} is not running`);
	const key = keys.keyOf(latest);
	const ended = await abortRun(terminal, run.project, key);
	const { outcome } = ended;

	if (outcome?.status !== "aborted" && outcome?.status !== "orphaned") throw new Error(`run ${run.id} is not running`);
	const stopped = endedOutcome(run.id, outcome);

	if (json) terminal.stdout(JSON.stringify(stopped));
	else if (current(latest)) {
		const title = titleOf(latest.input, await progressOf(run));
		terminal.stdout(`aborted ${title}; continue with: workflows resume ${run.id}`);
	} else {
		const { name, later } = savedBy(latest);
		terminal.stdout(
			`${stopped.state} ${name}, which ${later ? "a later" : "an earlier"} version saved; it cannot resume`,
		);
	}

	return 0;
}
