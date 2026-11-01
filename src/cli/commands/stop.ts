/** `workflows stop <run-id>`: stops a run in its host. */
import { title as titleOf } from "../../run/result.ts";
import { current } from "../../run/version.ts";
import { abortRun, taskKey } from "../host.ts";
import type { Terminal } from "../main.ts";
import { oneRunId, progressOf, savedBy, savedRun, tasksOf } from "../saved.ts";

export const STOP = "workflows stop <run-id> [--json]";

/**
 * Stops the run of `args` in its host. Its task ends as stopped, and a resume continues it. A pending task of another
 * version, which no host can run, ends as orphaned.
 */
export async function stop(args: readonly string[], terminal: Terminal, json: boolean): Promise<number> {
	const run = await savedRun(oneRunId(args, STOP), STOP);
	const tasks = await tasksOf(run);
	const latest = tasks.at(-1);

	if (latest === undefined) throw new Error(`run ${run.id} has no workflow`);

	if (latest.state.status === "terminal") throw new Error(`run ${run.id} is not running`);
	const outcome = await abortRun(terminal, run.project, taskKey(run.id, tasks.length));

	if (outcome?.status !== "aborted" && outcome?.status !== "orphaned") throw new Error(`run ${run.id} is not running`);

	if (json) terminal.stdout(JSON.stringify({ runId: run.id, status: "stopped" }));
	else if (current(latest)) {
		const title = titleOf(latest.input, await progressOf(run));
		terminal.stdout(`stopped ${title}; continue with: workflows resume ${run.id}`);
	} else {
		const { name, later } = savedBy(latest);
		terminal.stdout(`stopped ${name}, which ${later ? "a later" : "an earlier"} version saved; it cannot resume`);
	}

	return 0;
}
