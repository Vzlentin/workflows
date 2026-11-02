/**
 * The saved root runs of a project store, as the `pastRuns` script call and `run(name, { from })` read them from the
 * tasks of the kind `workflows.run`, at the current version and at earlier versions alike.
 */
import type { Context, JsonValue } from "@earendil-works/chord";
import type { Cursor, Page, TaskOutcome, TaskRecord } from "@earendil-works/pi-durable";
import { type Static, type TSchema, Type } from "typebox";
import { Value } from "typebox/value";
import { statusOf } from "./result.ts";
import { current, type Runtime, TASK, thisVersion } from "./version.ts";

export type RunTask = TaskRecord<JsonValue, JsonValue, JsonValue>;

/** A task as the host's `TaskInfo` gives it: its kind and version, and its outcome once it ended. */
export type TaskEnd = { readonly kind: string; readonly version: number; readonly outcome?: TaskOutcome<JsonValue> };

/**
 * The status of a run. A task that has not ended is `running`, or `earlier-version` or `later-version` when another
 * version saved it. A completed task is `waiting` when its result waits for an answer, else `done`. A task that ended
 * without a result is `failed` (also when pi-durable faulted it), `aborted` or `orphaned`.
 */
export type RunStatus =
	| "running"
	| "earlier-version"
	| "later-version"
	| "waiting"
	| "done"
	| "failed"
	| "aborted"
	| "orphaned";

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
	const outcome = taskOutcome(task);

	if (outcome === undefined) {
		if (thisVersion(task)) return "running";

		return savedLater(task) ? "later-version" : "earlier-version";
	}

	switch (outcome.status) {
		case "completed":
			return statusOf(outcome.result) === "waiting" ? "waiting" : "done";
		case "failed":
		case "faulted":
			return "failed";
		case "aborted":
			return "aborted";
		case "orphaned":
			return "orphaned";
	}
}

/** Whether a run of `status` has ended: its task is terminal. */
export function hasEnded(status: RunStatus): boolean {
	return status !== "running" && status !== "earlier-version" && status !== "later-version";
}

/** Whether a run of `status` has a result: it is `done`, or `waiting` for an answer. */
export function hasResult(status: RunStatus): boolean {
	return status === "done" || status === "waiting";
}

/**
 * The task of a run that the commands go by: its last task, unless that is a task of another version that ended after
 * a task of this version, as when the command refused the host's version and aborted it; then the last task of this
 * version.
 */
export function taskOf(tasks: readonly RunTask[]): RunTask | undefined {
	const latest = tasks.at(-1);

	if (latest === undefined || current(latest) || !hasEnded(runStatus(latest))) return latest;

	return tasks.findLast(current) ?? latest;
}

const PROFILE = Type.Object({
	model: Type.Optional(Type.Object({ provider: Type.String(), modelId: Type.String() })),
	thinking: Type.Optional(Type.String()),
	instructions: Type.String(),
});

/** The fields of a saved input that a past run gives; an input without them is not a past run. */
const SAVED = Type.Object({
	runId: Type.String(),
	name: Type.String(),
	args: Type.Object({ item: Type.Optional(Type.Unknown()) }),
	bundle: Type.Object({
		prompts: Type.Record(Type.String(), Type.String()),
		agents: Type.Record(Type.String(), PROFILE),
	}),
	worktree: Type.Optional(Type.Object({ repository: Type.String(), start: Type.String() })),
});

type Saved = Static<typeof SAVED>;

const WRAPPED = Type.Object({ input: Type.Object({}) });

const RUN_ID = Type.Object({ runId: Type.String() });

/** The saved input of a workflow task as `schema` gives it, also when some versions wrapped it as `{ input }`. */
export function savedInput<T extends TSchema>(schema: T, input: JsonValue): Static<T> | undefined {
	const saved = Value.Check(WRAPPED, input) ? input.input : input;

	return Value.Check(schema, saved) ? saved : undefined;
}

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
 * also of another version. `tasks` is in scan order.
 */
export function rootRuns(tasks: readonly RunTask[]): Map<string, RunTask[]> {
	const runs = new Map<string, RunTask[]>();

	for (const task of tasks) {
		const id = savedInput(RUN_ID, task.input)?.runId;

		if (task.owner !== undefined || id === undefined) continue;
		runs.set(id, [...(runs.get(id) ?? []), task]);
	}

	return runs;
}

/**
 * The root tasks of the kind `workflows.run` in the store, of every version, by run ID, oldest first. The commit only
 * reads, so it keeps the task state and takes no lock but the host's own.
 */
export async function scanRuns(runtime: Runtime, context: Context): Promise<Map<string, RunTask[]>> {
	let tasks: RunTask[] = [];

	await runtime.commit(async (tx) => {
		tasks = await allPages((cursor) => tx.scanTasks({ kind: TASK.name }, 256, cursor));

		return undefined;
	}, context);

	return rootRuns(tasks);
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
		const input = task === undefined ? undefined : savedInput(SAVED, task.input);

		if (task !== undefined && input !== undefined) saved.set(id, { task, input });
	}

	return saved;
}

/** The text of `agents/<name>.md` that gives `profile`. */
function profileText({ model, thinking, instructions }: Static<typeof PROFILE>): string {
	const fields = [
		...(model === undefined ? [] : [`model: ${model.provider}/${model.modelId}`]),
		...(thinking === undefined ? [] : [`thinking: ${thinking}`]),
	];

	return fields.length === 0 ? instructions : `---\n${fields.join("\n")}\n---\n${instructions}`;
}

/** The text of `agents/<name>.md` for each profile of `agents`, by name. */
export function profileTexts(agents: Saved["bundle"]["agents"]): { [name: string]: string } {
	return Object.fromEntries(Object.entries(agents).map(([name, profile]) => [name, profileText(profile)]));
}

/**
 * The completed root runs of `workflow` in `roots` (the root tasks by run ID, as `rootRuns` gives them), newest first:
 * all of them, the first `limit`, or the runs `runs` in that order. Throws `no completed <workflow> run <id>` for an ID
 * of `runs` that is not one of them.
 */
export function pastRuns(
	roots: ReadonlyMap<string, readonly RunTask[]>,
	workflow: string,
	options: PastOptions,
): JsonValue {
	const completed = new Map<string, JsonValue>();

	for (const [id, { task, input }] of savedRuns(roots)) {
		if (input.name !== workflow || runStatus(task) !== "done") continue;
		const { args, worktree, bundle } = input;

		completed.set(id, {
			runId: id,
			item: Value.Check(Type.String(), args.item) ? args.item : null,
			repository: worktree?.repository ?? null,
			start: worktree?.start ?? null,
			prompts: bundle.prompts,
			agents: profileTexts(bundle.agents),
			result: taskOutcome(task)?.result ?? null,
		});
	}

	if (options.runs !== undefined) {
		return options.runs.map((id) => {
			const run = completed.get(id);

			if (run === undefined) throw new Error(`no completed ${workflow} run ${id}`);

			return run;
		});
	}

	const newest = [...completed].sort(([a], [b]) => (a < b ? 1 : -1)).map(([, run]) => run);

	return newest.slice(0, options.limit ?? newest.length);
}

/**
 * The saved `prompts` and `agents` of the root run `id` of `roots` (the root tasks by run ID, as `rootRuns` gives
 * them), or undefined when it has none.
 */
export function savedBundle(roots: ReadonlyMap<string, readonly RunTask[]>, id: string) {
	return savedRuns(roots).get(id)?.input.bundle;
}
