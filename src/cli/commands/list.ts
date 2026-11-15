/** `workflows list`: the runs of the project of the current directory. */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { resolveProject } from "@vzlentin/harness/projects";
import { statePaths } from "@vzlentin/harness/protocol";
import { type Static, Type } from "typebox";
import { RUN_FIELDS, taskFields } from "../../records/run.ts";
import { endMark, type Mark, Progress } from "../../records/steps.ts";
import { inputWorktree, progressEvents, reading, runTasks, type Store } from "../../records/store.ts";
import { hasEnded, type RunStatus, type RunTask, savedInput, taskOf } from "../../run/past.ts";
import { SHOWN_INPUT, title as titleOf } from "../../run/result.ts";
import { stateText } from "../../tool.ts";
import { UsageError } from "../../workflow/find.ts";
import { runsDirectory, STORE_FILE } from "../host.ts";
import type { Choose, Terminal } from "../main.ts";
import { savedBy, unstartedRuns } from "../saved.ts";
import type { PickItem } from "../terminal/pick.ts";

export const LIST = "workflows list [--pick] [--json]";

/**
 * A run of the project store that has a task and a run directory: the run fields, and the repository of its worktree,
 * or null for a run without a worktree.
 */
export const ROW = Type.Object(
	{ ...RUN_FIELDS, repository: Type.Union([Type.String(), Type.Null()]) },
	{ additionalProperties: false },
);

type Row = Static<typeof ROW>;

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
 * directories whose run has no task, as `unstarted`. It reads the project store only. The picker leaves out these.
 */
export async function list(args: readonly string[], terminal: Terminal, json: boolean): Promise<number> {
	const pick = args[0] === "--pick";

	if (args.length > Number(pick)) throw new UsageError("list takes no arguments but --pick", LIST);

	if (pick) {
		if (terminal.choose === undefined) throw new UsageError("--pick needs a terminal on stdin and stderr", LIST);
		const run = await pickRun(terminal, terminal.choose);

		if (run === undefined) return 130;
		terminal.stdout(run);

		return 0;
	}

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
		join(statePaths(project).dir, STORE_FILE),
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

/** The runs `runs` of the open project store `store` that have a run directory, newest run ID first. */
async function listedRuns(store: Store, runs: ReadonlyMap<string, readonly RunTask[]>): Promise<Row[]> {
	const listed: Row[] = [];

	for (const [id, tasks] of [...runs].sort(([a], [b]) => b.localeCompare(a))) {
		const task = taskOf(tasks);

		if (task === undefined || !existsSync(join(runsDirectory(), id, "project"))) continue;
		const repository = inputWorktree(task.input)?.repository ?? null;

		// A task of every version whose input has the fields of a title gets its title; another keeps its workflow name.
		const input = savedInput(SHOWN_INPUT, task.input);
		const workflow = savedBy(task).name;
		const title = input === undefined ? workflow : titleOf(input, await progressEvents(store, id));
		listed.push({ runId: id, workflow, title, ...taskFields(tasks, task), repository });
	}

	return listed;
}

/**
 * Asks on the terminal which run of the project of the current directory to take, and gives its run ID, or undefined
 * when the person cancels. The runs that have not ended come first, each with the steps that run now. While it waits,
 * it reads the runs again every second.
 */
async function pickRun(terminal: Terminal, choose: Choose): Promise<string | undefined> {
	const items = await runItems(terminal);

	if (items.length === 0) throw new Error(`no runs in the project of ${terminal.cwd}`);

	return choose("Pick a run:", items, () => runItems(terminal));
}

/** The items of the run picker, from the project store of the current directory, each with its run ID as its value. */
async function runItems(terminal: Terminal): Promise<PickItem<string>[]> {
	const empty = { runs: [], steps: new Map<string, string>() };

	const { runs, steps } = await reading(
		join(statePaths(resolveProject(process.env, terminal.cwd)).dir, STORE_FILE),
		empty,
		async (store) => {
			const live = ({ state }: Row) => state === "running" || state === "waiting";
			// A stable sort keeps the newest first within each group.
			const tasks = await runTasks(store);
			const sorted = (await listedRuns(store, tasks)).toSorted((a, b) => Number(live(b)) - Number(live(a)));
			const found = new Map<string, string>();

			for (const { runId } of sorted.filter((each) => each.state === "running")) {
				const progress = new Progress();

				for (const event of await progressEvents(store, runId)) progress.add(event);
				const status = progress.status();

				if (status !== undefined) found.set(runId, status);
			}

			return { runs: sorted, steps: found };
		},
	);

	return runs.map(({ runId, title, workflow, state, result }) => {
		const step = steps.get(runId);
		const text = `${markOf(state)} ${title}  ${workflow} ${stateText(state, result)}${step === undefined ? "" : `: ${step}`}`;

		return { text, value: runId };
	});
}

/**
 * The mark of a run in the picker by its state: `◉` running, `?` waiting for an answer, `·` done or of another version,
 * else the mark of the steps of a run that ended in that state.
 */
function markOf(state: RunStatus): Mark | "?" {
	if (state === "running") return "◉";

	if (state === "waiting") return "?";

	if (state === "done" || !hasEnded(state)) return "·";

	return endMark(state);
}
