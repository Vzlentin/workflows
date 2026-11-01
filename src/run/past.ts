/**
 * The saved root runs of a project store, as the `pastRuns` script call and `run(name, { from })` read them from the
 * tasks of the kind `workflows.run`, at the current version and at earlier versions alike.
 */
import type { Context, JsonValue } from "@earendil-works/chord";
import type { Cursor, Page, TaskRecord } from "@earendil-works/pi-durable";
import { type Static, type TSchema, Type } from "typebox";
import { Value } from "typebox/value";
import { type Runtime, TASK } from "./version.ts";

export type RunTask = TaskRecord<JsonValue, JsonValue, JsonValue>;

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
		const { state } = task;

		if (input.name !== workflow || state.status !== "terminal" || state.outcome.status !== "completed") continue;
		const { args, worktree, bundle } = input;

		completed.set(id, {
			runId: id,
			item: Value.Check(Type.String(), args.item) ? args.item : null,
			repository: worktree?.repository ?? null,
			start: worktree?.start ?? null,
			prompts: bundle.prompts,
			agents: profileTexts(bundle.agents),
			result: state.outcome.result ?? null,
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
