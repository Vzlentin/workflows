/** `workflows list`: the runs of the host of the current directory. */
import { resolveHost } from "@vzlentin/harness/hosts";
import { type Static, Type } from "typebox";
import { reading, runTasks } from "../../records/store.ts";
import type { RunTask } from "../../run/past.ts";
import { stateText } from "../../tool.ts";
import { UsageError } from "../../workflow/find.ts";
import { type Changed, withChanges } from "../changes.ts";
import { storeOf } from "../host.ts";
import type { Terminal } from "../main.ts";
import { listedRuns, ROW, type Row, unstartedRuns } from "../saved.ts";
import { reportsTo, sweepMerged } from "./sweep.ts";

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
 * Prints the runs of the host of the current directory that have a run directory, newest run ID first, also the run
 * directories whose run has no task, as `unstarted`. It reads the host store, and with `json` the state of the change of
 * each ended run on the Git host, and sweeps the runs whose pull request is merged.
 */
export async function list(args: readonly string[], terminal: Terminal, json: boolean): Promise<number> {
	if (args.length > 0) throw new UsageError("list takes no arguments", LIST);

	const listed = await hostRuns(resolveHost(process.env, terminal.cwd), json, terminal);

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
 * The runs of the host `host` that have a run directory, newest run ID first, also the run directories whose run has no task,
 * as `unstarted`. With `changes`, the rows of the ended runs get the state of their change, after the store is closed,
 * and the warnings of that read go to the stderr of `terminal`; then the runs whose change is merged are swept.
 */
async function hostRuns(host: string, changes: boolean, terminal: Terminal): Promise<Listed[]> {
	const { rows, runs } = await reading(
		storeOf(host),
		{ rows: [], runs: new Map<string, RunTask[]>() },
		async ({ store }) => {
			const tasks = await runTasks(store);
			const rows = (await listedRuns(store, tasks)).map(({ row }) => row);

			return { rows, runs: tasks };
		},
	);

	const warn = (line: string) => terminal.stderr(`workflows: ${line}`);
	const changed = changes ? await swept(await withChanges(rows, warn), host, terminal) : rows;

	const unstarted = (await unstartedRuns(host, runs)).map(({ runId }): Listed => ({
		runId,
		state: "unstarted",
		repository: null,
	}));

	return [...changed, ...unstarted].sort((a, b) => b.runId.localeCompare(a.runId));
}

/**
 * The rows of `changed`, where each run whose pull request is merged is swept as `sweep <run-id> --yes` does, with the
 * merge commit of its pull request: its row gets the word of the sweep and no `change`. The first failure gives the
 * stderr of `terminal` one line, and the later rows are not swept.
 */
async function swept(changed: readonly Changed[], host: string, terminal: Terminal): Promise<Row[]> {
	const store = storeOf(host);
	const reports = reportsTo(terminal, host);
	const rows: Row[] = [];
	let failed = false;

	try {
		for (const { row, merge } of changed) {
			if (failed || merge === undefined) {
				rows.push(row);

				continue;
			}

			try {
				const word = await sweepMerged(row.runId, merge, store, reports);
				const { change: _, ...rest } = row;
				rows.push(word === undefined ? row : { ...rest, swept: word });
			} catch (error) {
				failed = true;
				terminal.stderr(
					`workflows: cannot sweep ${row.runId}: ${error instanceof Error ? error.message : String(error)}`,
				);
				rows.push(row);
			}
		}
	} finally {
		reports.close();
	}

	return rows;
}
