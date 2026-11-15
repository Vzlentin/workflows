/** `workflows list`: the runs of the project of the current directory. */
import { resolveProject } from "@vzlentin/harness/projects";
import { type Static, Type } from "typebox";
import { reading, runTasks } from "../../records/store.ts";
import type { RunTask } from "../../run/past.ts";
import { stateText } from "../../tool.ts";
import { UsageError } from "../../workflow/find.ts";
import { storeOf } from "../host.ts";
import type { Terminal } from "../main.ts";
import { listedRuns, ROW, unstartedRuns } from "../saved.ts";

export const LIST = "workflows list [--json]";

/** A run directory whose run has no task: its run ID, the state `unstarted`, and no repository. */
const UNSTARTED = Type.Object(
	{ runId: Type.String(), state: Type.Literal("unstarted"), repository: Type.Null() },
	{ additionalProperties: false },
);

/**
 * A run of `list --json`: a run with a task, with the run fields and the repository of its worktree, or a run directory
 * whose run has no task.
 */
export const LISTED = Type.Union([ROW, UNSTARTED]);

type Listed = Static<typeof LISTED>;

/**
 * Prints the runs of the project of the current directory that have a run directory, newest run ID first, also the run
 * directories whose run has no task, as `unstarted`. It reads the project store only.
 */
export async function list(args: readonly string[], terminal: Terminal, json: boolean): Promise<number> {
	if (args.length > 0) throw new UsageError("list takes no arguments", LIST);

	const listed = await projectRuns(resolveProject(process.env, terminal.cwd));

	if (json) terminal.stdout(JSON.stringify(listed));
	else for (const run of listed) terminal.stdout(listLine(run));

	return 0;
}

/**
 * The line of `run` in `list`: its run ID, workflow, state and title, with `-` for the workflow and the title of an
 * unstarted run.
 */
function listLine(run: Listed): string {
	if (run.state === "unstarted") return `${run.runId} - unstarted -`;

	return `${run.runId} ${run.workflow} ${stateText(run.state, run.result)} ${run.title}`;
}

/**
 * The runs of `project` that have a run directory, newest run ID first, also the run directories whose run has no task,
 * as `unstarted`. It reads the project store only.
 */
async function projectRuns(project: string): Promise<Listed[]> {
	const { rows, runs } = await reading(
		storeOf(project),
		{ rows: [], runs: new Map<string, RunTask[]>() },
		async (store) => {
			const tasks = await runTasks(store);

			return { rows: await listedRuns(store, tasks), runs: tasks };
		},
	);

	const unstarted = (await unstartedRuns(project, runs)).map(({ runId }): Listed => ({
		runId,
		state: "unstarted",
		repository: null,
	}));

	return [...rows, ...unstarted].sort((a, b) => b.runId.localeCompare(a.runId));
}
