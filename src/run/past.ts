/**
 * The saved root runs of a host store, as the `pastRuns` script call and `run(name, { from })` read them from the
 * tasks of the kind `workflows.run`, at the current version and at earlier versions alike, and the first task of a run,
 * whose list of todos is the list of the run.
 */
import type { Context } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord/json";
import type { Cursor, Page, TaskOutcome, TaskRecord } from "@earendil-works/pi-durable";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import type { Mark } from "../records/steps.ts";
import { RUN_STATE, type RunResult, type WorkflowOutcome, waits } from "../tool.ts";
import { ROLE } from "../workflow/roles.ts";
import { reportOf, runResult, type ShownInput } from "./result.ts";
import { current, type Runtime, TASK, thisVersion } from "./version.ts";

export type RunTask = TaskRecord<JsonValue, JsonValue, JsonValue>;

/** The start of the `start` key of every task of the run `id`. */
const keyPrefix = (id: string) => `wf:${id}#`;

/** The `start` key of the task `n` of the run `id`, counting from 1. */
export const taskKey = (id: string, n: number) => `${keyPrefix(id)}${n}`;

/** The number `n` of the `start` key `key` of a task of the run `id`, or undefined when `key` is not one. */
export function keyNumber(id: string, key: string): number | undefined {
	const prefix = keyPrefix(id);
	const n = key.startsWith(prefix) ? key.slice(prefix.length) : "";

	return /^[1-9]\d*$/.test(n) ? Number(n) : undefined;
}

/** A task as the host's `TaskInfo` gives it: its kind and version, and its outcome once it ended. */
export type TaskEnd = { readonly kind: string; readonly version: number; readonly outcome?: TaskOutcome<JsonValue> };

/**
 * The status of a run. A task that another version saved is `earlier-version` or `later-version`, also when it ended. A
 * task of this version that has not ended is `running`. A completed task is `waiting` when its result waits for an
 * answer, else `done`. A task that ended without a result is `failed` (also when pi-durable faulted it), `aborted` or
 * `orphaned`.
 */
export type RunStatus = Static<typeof RUN_STATE>;

/** The outcome of `task`, or undefined when it has not ended. */
export function taskOutcome(task: RunTask | TaskEnd): TaskOutcome<JsonValue> | undefined {
	return "state" in task ? task.state.outcome : task.outcome;
}

/** Whether a task of another version than this one, the version of `task`, is later. */
export function savedLater(task: { readonly kind: string; readonly version: number }): boolean {
	return task.kind === TASK.name && task.version > TASK.version;
}

/** The status of the run whose task is `task`. It is the one place that computes it. */
export function runStatus(task: RunTask | TaskEnd): RunStatus {
	if (!thisVersion(task)) return savedLater(task) ? "later-version" : "earlier-version";

	return endedStatus(task) ?? "running";
}

/**
 * The state of the outcome of `task`, of any version, or undefined when it has not ended. It is the state that
 * `runStatus` gives for a task of this version that ended.
 */
export function endedStatus(task: RunTask | TaskEnd): EndedStatus | undefined {
	const outcome = taskOutcome(task);

	return outcome === undefined ? undefined : endedState(outcome);
}

/**
 * The status of the run whose task is `task` as its records show it: the state of its outcome for a task of any version
 * that ended, else `runStatus`.
 */
export function recordedStatus(task: RunTask | TaskEnd): RunStatus {
	return endedStatus(task) ?? runStatus(task);
}

/** The state of a run whose task ended with `outcome`. */
function endedState(outcome: TaskOutcome<JsonValue>): EndedStatus {
	switch (outcome.status) {
		case "completed":
			return waits(outcome.result) ? "waiting" : "done";
		case "failed":
		case "faulted":
			return "failed";
		case "aborted":
			return "aborted";
		case "orphaned":
			return "orphaned";
	}
}

/** The state of a run whose task has ended. */
export type EndedStatus = Exclude<RunStatus, "running" | "earlier-version" | "later-version">;

/** The state of a run that ended without a result. */
export type EndState = Exclude<EndedStatus, "done" | "waiting">;

/** The outcome of a run that ended without a result. */
export type EndedOutcome = Extract<WorkflowOutcome, { state: EndState }>;

/** The outcome of a run that has a result. */
export type CompletedOutcome = Extract<WorkflowOutcome, { state: "done" | "waiting" }>;

/** Whether a run of `status` has ended: its task is terminal. */
export function hasEnded(status: RunStatus): status is EndedStatus {
	return status !== "running" && status !== "earlier-version" && status !== "later-version";
}

/** Whether a run of `status` has a result: it is `done`, or `waiting` for an answer. */
export function hasResult(status: RunStatus): status is "done" | "waiting" {
	return status === "done" || status === "waiting";
}

/**
 * The mark of the steps that run and the exit code of a run that ended in `state` without a result: `✗` and 1 when it
 * failed or was orphaned, `·` and 130 when it was aborted.
 */
export function ending(state: EndState): { readonly mark: Mark; readonly code: number } {
	return state === "aborted" ? { mark: "·", code: 130 } : { mark: "✗", code: 1 };
}

/** The outcome of the run `runId` whose task ended with `outcome`, without a result. */
export function endedOutcome(
	runId: string,
	outcome: Exclude<TaskOutcome<JsonValue>, { status: "completed" }>,
): EndedOutcome {
	switch (outcome.status) {
		case "failed":
		case "faulted":
			return { runId, state: "failed", error: outcome.error.message };
		case "orphaned":
			return { runId, state: "orphaned", error: outcome.reason };
		case "aborted":
			return { runId, state: "aborted" };
	}
}

/** The outcome of the run `input` whose script returned `value`: its state, its result, its value and its report. */
function completedOutcome(input: ShownInput, value: JsonValue): CompletedOutcome {
	const report = reportOf(input, value);
	const fields = { result: runResult(report), value, report: report.lines };
	const runId = input.runId;

	return waits(value)
		? { runId, state: "waiting", question: value.question, ...fields }
		: { runId, state: "done", ...fields };
}

/** The outcome of the run `input` whose task ended with `outcome`. */
export function outcomeFrom(input: ShownInput, outcome: TaskOutcome<JsonValue>): CompletedOutcome | EndedOutcome {
	return outcome.status === "completed" ? completedOutcome(input, outcome.result) : endedOutcome(input.runId, outcome);
}

/** The outcome of the run `input` whose task `task` ended. It throws for a task that has not ended. */
export function runOutcome(input: ShownInput, task: RunTask | TaskEnd): CompletedOutcome | EndedOutcome {
	const outcome = taskOutcome(task);

	if (outcome === undefined) throw new Error(`run ${input.runId} has not ended`);

	return outcomeFrom(input, outcome);
}

/** The result of the run whose task is `task`, when this version saved it and it completed. */
export function taskResult(task: RunTask): RunResult | undefined {
	const outcome = taskOutcome(task);

	if (outcome?.status !== "completed" || !current(task)) return undefined;

	return completedOutcome(task.input, outcome.result).result;
}

/** The state of the run whose task is `task`, and the result of a run that has one, as the JSON of a run gives them. */
export type StateFields = { state: RunStatus; result?: RunResult };

/** The state fields of the run whose task is `task`. */
export function stateFields(task: RunTask): StateFields {
	const fields: StateFields = { state: runStatus(task) };
	const result = taskResult(task);

	if (result !== undefined) fields.result = result;

	return fields;
}

/**
 * The task of a run that the commands go by: its last task, unless that is a task of another version that ended after
 * a task of this version, as when the command refused the host's version and aborted it; then the last task of this
 * version.
 */
export function taskOf(tasks: readonly RunTask[]): RunTask | undefined {
	const latest = tasks.at(-1);

	if (latest === undefined || current(latest) || endedStatus(latest) === undefined) return latest;

	return tasks.findLast(current) ?? latest;
}

/** The fields of a saved input that a past run gives; an input without them is not a past run. */
const SAVED = Type.Object({
	runId: Type.String(),
	name: Type.String(),
	cwd: Type.String(),
	args: Type.Object({ item: Type.Optional(Type.Unknown()) }),
	bundle: Type.Object({
		prompts: Type.Record(Type.String(), Type.String()),
		after: Type.Optional(Type.Record(Type.String(), Type.String())),
		agents: Type.Record(Type.String(), ROLE),
	}),
	worktree: Type.Optional(Type.Object({ repository: Type.String(), start: Type.String() })),
	labels: Type.Optional(Type.Array(Type.String())),
});

type Saved = Static<typeof SAVED>;

const RUN_ID = Type.Object({ runId: Type.String() });

/** All the items of the pages that `page` reads, from the first cursor to the last. */
export async function allPages<T>(page: (cursor: Cursor | undefined) => Promise<Page<T, Cursor>>): Promise<T[]> {
	const items: T[] = [];
	let cursor: Cursor | undefined;

	do {
		const read = await page(cursor);
		items.push(...read.items);
		cursor = read.next;
	} while (cursor !== undefined);

	return items;
}

/**
 * The tasks of `tasks` that no task owns, so not the tasks of child runs, by the run ID of their input, oldest first,
 * also of another version. `tasks` is in task ID order.
 */
export function rootRuns(tasks: readonly RunTask[]): Map<string, RunTask[]> {
	const runs = new Map<string, RunTask[]>();

	for (const task of tasks) {
		const id = runIdOf(task);

		if (task.owner !== undefined || id === undefined) continue;
		runs.set(id, [...(runs.get(id) ?? []), task]);
	}

	return runs;
}

/**
 * The first task of the run `runId` in `tasks`, which are in scan order: the oldest task, root or child, of any version,
 * whose saved input has the run ID. Its list of todos is the list of the run, which every later task of the run uses.
 */
export function firstTask(tasks: readonly RunTask[], runId: string): RunTask | undefined {
	return tasks.find((task) => isOfRun(task, runId));
}

/** Whether the saved input of `task`, of any version, has the run ID `runId`. */
export function isOfRun(task: RunTask, runId: string): boolean {
	return runIdOf(task) === runId;
}

/** The run ID of the saved input of `task`, of any version, or undefined when the input has none. */
export function runIdOf(task: RunTask): string | undefined {
	return Value.Check(RUN_ID, task.input) ? task.input.runId : undefined;
}

/**
 * The tasks of the kind `workflows.run` in the store, root and child, of every version, in scan order. The commit only
 * reads, so it keeps the task state and takes no lock but the host's own.
 */
export async function scanTasks(runtime: Runtime, context: Context): Promise<RunTask[]> {
	let tasks: RunTask[] = [];

	await runtime.commit(async (tx) => {
		tasks = await allPages((cursor) => tx.scanTasks({ kind: TASK.name }, 256, cursor));

		return undefined;
	}, context);

	return tasks;
}

/** The root tasks of the kind `workflows.run` in the store, of every version, by run ID, oldest first. */
export async function scanRuns(runtime: Runtime, context: Context): Promise<Map<string, RunTask[]>> {
	return rootRuns(await scanTasks(runtime, context));
}

/** The options of `pastRuns(workflow, options)`. */
export const PAST_OPTIONS = Type.Object(
	{ runs: Type.Optional(Type.Array(Type.String())), limit: Type.Optional(Type.Integer({ minimum: 0 })) },
	{ additionalProperties: false },
);

export type PastOptions = Static<typeof PAST_OPTIONS>;

/** The last task of each root run of `roots`, with its saved input, when that input has the fields of a past run. */
function savedRuns(roots: ReadonlyMap<string, readonly RunTask[]>): Map<string, { task: RunTask; input: Saved }> {
	const saved = new Map<string, { task: RunTask; input: Saved }>();

	for (const [id, tasks] of roots) {
		const task = tasks.at(-1);

		if (task !== undefined && Value.Check(SAVED, task.input)) saved.set(id, { task, input: task.input });
	}

	return saved;
}

/**
 * The completed root runs of `workflow`, or of every workflow for null, in `roots` (the root tasks by run ID, as
 * `rootRuns` gives them), newest first: all of them, the first `limit`, or the runs `runs` in that order. Throws
 * `no completed <workflow> run <id>`, or `no completed run <id>` for null, for an ID of `runs` that is not one of them.
 */
export function pastRuns(
	roots: ReadonlyMap<string, readonly RunTask[]>,
	workflow: string | null,
	options: PastOptions,
): JsonValue {
	const completed = new Map<string, JsonValue>();

	for (const [id, { task, input }] of savedRuns(roots)) {
		if ((workflow !== null && input.name !== workflow) || endedStatus(task) !== "done") continue;
		const { args, cwd, worktree, bundle, labels } = input;

		completed.set(id, {
			runId: id,
			item: Value.Check(Type.String(), args.item) ? args.item : null,
			cwd,
			repository: worktree?.repository ?? null,
			start: worktree?.start ?? null,
			prompts: bundle.prompts,
			// A run of an older version has no labels.
			labels: labels ?? [],
			key: taskKey(id, 1),
			result: taskOutcome(task)?.result ?? null,
		});
	}

	if (options.runs !== undefined) {
		return options.runs.map((id) => {
			const run = completed.get(id);

			if (run === undefined) throw new Error(`no completed ${workflow === null ? "" : `${workflow} `}run ${id}`);

			return run;
		});
	}

	const newest = [...completed].sort(([a], [b]) => (a < b ? 1 : -1)).map(([, run]) => run);

	return newest.slice(0, options.limit ?? newest.length);
}

/**
 * The saved `prompts` and agents table of the root run `id` of `roots` (the root tasks by run ID, as `rootRuns` gives
 * them), or undefined when it has none.
 */
export function savedBundle(roots: ReadonlyMap<string, readonly RunTask[]>, id: string) {
	return savedRuns(roots).get(id)?.input.bundle;
}
