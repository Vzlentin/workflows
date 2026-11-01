/** `workflows stop <run-id>`: stops a run in its host. */
import { hasEnded, runStatus, taskOf } from "../../run/past.ts";
import { title as titleOf } from "../../run/result.ts";
import { current } from "../../run/version.ts";
import type { OutcomeStatus } from "../../tool.ts";
import { abortRun } from "../host.ts";
import type { Terminal } from "../main.ts";
import { keysOf, oneRunId, progressOf, savedBy, savedRun, tasksOf } from "../saved.ts";

export const STOP = "workflows stop <run-id> [--json]";

/**
 * Stops the run of `args` in its host. Its task ends as stopped, and a resume continues it. A pending task of another
 * version, which no host can run, ends as orphaned.
 */
export async function stop(args: readonly string[], terminal: Terminal, json: boolean): Promise<number> {
	const run = await savedRun(oneRunId(args, STOP), STOP);
	const latest = taskOf(await tasksOf(run));

	if (latest === undefined) throw new Error(`run ${run.id} has no workflow`);

	if (hasEnded(runStatus(latest))) throw new Error(`run ${run.id} is not running`);
	const key = (await keysOf(run)).keyOf(latest);
	const status = runStatus(await abortRun(terminal, run.project, key));

	if (status !== "aborted" && status !== "orphaned") throw new Error(`run ${run.id} is not running`);

	if (json) terminal.stdout(JSON.stringify({ runId: run.id, status: "stopped" satisfies OutcomeStatus }));
	else if (current(latest)) {
		const title = titleOf(latest.input, await progressOf(run));
		terminal.stdout(`stopped ${title}; continue with: workflows resume ${run.id}`);
	} else {
		const { name, later } = savedBy(latest);
		terminal.stdout(`stopped ${name}, which ${later ? "a later" : "an earlier"} version saved; it cannot resume`);
	}

	return 0;
}
