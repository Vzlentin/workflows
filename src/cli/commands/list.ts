/** `workflows list`: the runs of the project of the current directory. */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { resolveProject } from "@vzlentin/harness/projects";
import { statePaths } from "@vzlentin/harness/protocol";
import { type Static, Type } from "typebox";
import { endMark, type Mark, Progress } from "../../records/steps.ts";
import { inputWorktree, progressEvents, reading, runTasks, type Store } from "../../records/store.ts";
import { hasEnded, type RunStatus, type RunTask, runFields, savedInput, taskOf } from "../../run/past.ts";
import { SHOWN_INPUT, title as titleOf } from "../../run/result.ts";
import { RUN_RESULT, RUN_STATE, stateText } from "../../tool.ts";
import { UsageError } from "../../workflow/find.ts";
import { runsDirectory, STORE_FILE } from "../host.ts";
import type { Choose, Terminal } from "../main.ts";
import { savedBy, unstartedRuns } from "../saved.ts";
import type { PickItem } from "../terminal/pick.ts";

export const LIST = "workflows list [--pick] [--json]";

/**
 * A run of `list --json`. `state` is the state of the run, or `unstarted` for a run directory whose run has no task.
 * `result` is the result of a run that is `done` or `waiting`. `resumable` is true for a task of this version, which
 * `resume` can continue.
 */
export const LISTED = Type.Object(
	{
		runId: Type.String(),
		workflow: Type.String(),
		title: Type.String(),
		state: Type.Union([RUN_STATE, Type.Literal("unstarted")]),
		result: Type.Optional(RUN_RESULT),
		resumable: Type.Boolean(),
		repository: Type.Union([Type.String(), Type.Null()]),
	},
	{ additionalProperties: false },
);

type Listed = Static<typeof LISTED>;

/** A listed run that has a task, with its state, which orders it in the picker and gives its mark. */
type Row = Listed & { readonly state: RunStatus };

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
	else {
		for (const run of listed)
			terminal.stdout(`${run.runId} ${run.workflow} ${stateText(run.state, run.result)} ${run.title}`);
	}

	return 0;
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
		workflow: "-",
		title: "-",
		state: "unstarted",
		resumable: false,
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
		listed.push({ runId: id, workflow, title, ...runFields(task), repository });
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
