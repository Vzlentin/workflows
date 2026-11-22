/**
 * The saved runs of the command line: their run directory, their root tasks with their keys, their status and their
 * progress, read from the host store.
 */
import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord/json";
import type { TaskId, TaskRecord } from "@earendil-works/pi-durable";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { hostFile, readHost, type ScriptInput } from "../launch/input.ts";
import { RUN_FIELDS, SWEPT, type TaskFields, taskFields } from "../records/run.ts";
import { type Progress, progressOf } from "../records/steps.ts";
import { inputName, progressEvents, reading, runTasks, type Store, startedTasks } from "../records/store.ts";
import { keyNumber, type RunTask, savedLater, taskKey, taskOf } from "../run/past.ts";
import type { ProgressEvent } from "../run/progress.ts";
import { title as titleOf } from "../run/result.ts";
import { current } from "../run/version.ts";
import { UsageError } from "../workflow/find.ts";
import { runsDirectory, storeOf } from "./host.ts";

/** The one run ID of `args`. Bad usage prints `usage`. */
export function oneRunId(args: readonly string[], usage: string): string {
	const [id, ...rest] = args;

	if (id === undefined || rest.length > 0 || id.startsWith("-")) throw new UsageError("give one run ID", usage);

	return id;
}

/**
 * The error of a command on a saved run that it can never follow: its run directory or its task is missing, or another
 * version saved it. It exits `UNFOLLOWABLE_EXIT`.
 */
export class UnfollowableRun extends Error {}

/** A run that the command started: its ID, its host, and the path of the host store. */
export type SavedRun = { readonly id: string; readonly host: string; readonly store: string };

/** The saved run `id`, from the host file of its run directory. A run ID that is a path is bad usage. */
export async function savedRun(id: string, usage: string): Promise<SavedRun> {
	if (id.includes("/") || id.includes("\\") || id === "." || id === "..") {
		throw new UsageError(`${id} is not a run ID`, usage);
	}

	const host = await readHost(join(runsDirectory(), id)).catch(() => {
		throw new UnfollowableRun(`no run ${id} in ${runsDirectory()}`);
	});

	return { id, host, store: storeOf(host) };
}

/**
 * A run of the host store that has a task and a run directory: the run fields, the repository of its worktree, or
 * null for a run without a worktree, and its step lines, as `show --json` gives them.
 */
export const ROW = Type.Object(
	{ ...RUN_FIELDS, repository: Type.Union([Type.String(), Type.Null()]), steps: Type.Array(Type.String()) },
	{ additionalProperties: false },
);

export type Row = Static<typeof ROW>;

/** A listed run: its row, and the progress of its steps, which `steps` of the row gives as lines. */
export type ListedRun = { readonly row: Row; readonly progress: Progress };

/** The runs `runs` of the open host store `store` that have a run directory, newest run ID first. */
export async function listedRuns(store: Store, runs: ReadonlyMap<string, readonly RunTask[]>): Promise<ListedRun[]> {
	const listed: ListedRun[] = [];

	for (const [id, tasks] of [...runs].sort(([a], [b]) => b.localeCompare(a))) {
		const task = taskOf(tasks);

		if (task === undefined || !existsSync(hostFile(join(runsDirectory(), id)))) continue;
		const fields = taskFields(tasks, task);
		const { workflow, title, progress, repository } = current(task) ? await viewOf(store, id, task) : otherView(task);

		progress.end(fields.state);
		const row = { ...(await runFields(id, workflow, title, fields)), repository, steps: progress.lines() };

		listed.push({ row, progress });
	}

	return listed;
}

/**
 * What `list` and `show` give of a run besides its task fields: its workflow, its title, the progress of its steps, and
 * the repository of its worktree, or null for a run without a worktree.
 */
type RunView = {
	readonly workflow: string;
	readonly title: string;
	readonly progress: Progress;
	readonly repository: string | null;
};

/** The view of the run `id` of the open host store `store`, whose task `task` this version saved. */
async function viewOf(store: Store, id: string, task: TaskRecord<ScriptInput, JsonValue, JsonValue>): Promise<RunView> {
	const { input } = task;
	const events = await progressEvents(store, id);

	return {
		workflow: input.name,
		title: titleOf(input, events),
		progress: progressOf(events),
		repository: input.worktree?.repository ?? null,
	};
}

/**
 * The view of the run whose task `task` another version saved: its workflow, as `savedBy` reads it, as its title, no
 * steps and no repository. This version does not read its input or its events.
 */
export function otherView(task: RunTask): RunView {
	const { name } = savedBy(task);

	return { workflow: name, title: name, progress: progressOf([]), repository: null };
}

/** The file of a run directory that holds the word of `sweep --yes`, `landed` or `dropped`. */
export const SWEPT_FILE = "swept";

/**
 * The run fields of the run `id`, with its workflow `workflow`, its title `title` and its task fields `fields`, and
 * `swept` when the `swept` file of the run holds a word.
 */
export async function runFields(
	id: string,
	workflow: string,
	title: string,
	fields: TaskFields,
): Promise<Static<Type.TObject<typeof RUN_FIELDS>>> {
	const run: Static<Type.TObject<typeof RUN_FIELDS>> = { runId: id, workflow, title, ...fields };
	const swept = await sweptOf(id);

	if (swept !== undefined) run.swept = swept;

	return run;
}

/** The word of the `swept` file of the run `id`, or undefined when the file is missing or holds another word. */
async function sweptOf(id: string): Promise<Static<typeof SWEPT> | undefined> {
	const word = (await readFile(join(runsDirectory(), id, SWEPT_FILE), "utf8").catch(() => undefined))?.trim();

	return Value.Check(SWEPT, word) ? word : undefined;
}

/**
 * A run directory whose run has no task: its run ID, its path, and the time of its host file in ms since the epoch.
 * `start` writes that file before the host creates the task, so it is a run that has not started yet, or whose
 * command stopped before the host created its task.
 */
export type Unstarted = { readonly runId: string; readonly directory: string; readonly since: number };

/**
 * The run directories whose host file names `host` and whose run ID has no entry in `runs`, the root runs of
 * the host store, newest run ID first. A child run directory has no host file.
 */
export async function unstartedRuns(host: string, runs: ReadonlyMap<string, unknown>): Promise<Unstarted[]> {
	const root = runsDirectory();
	const found: Unstarted[] = [];

	for (const id of (await readdir(root).catch((): string[] => [])).sort().reverse()) {
		if (runs.has(id)) continue;
		const directory = join(root, id);
		const named = await readHost(directory).catch(() => undefined);

		const since = await stat(hostFile(directory)).then(
			(info) => info.mtimeMs,
			() => undefined,
		);

		if (named === host && since !== undefined) found.push({ runId: id, directory, since });
	}

	return found;
}

/** The root tasks of `run`, oldest first. */
export function tasksOf(run: SavedRun): Promise<RunTask[]> {
	return reading(run.store, [], async ({ store }) => (await runTasks(store)).get(run.id) ?? []);
}

/** The `start` keys of the tasks of a run: the key of its task `task`, and the key of a new task. */
export type RunKeys = { readonly keyOf: (task: RunTask) => string; readonly next: string };

/**
 * The last root task of the run `id` in `store` and the keys of its tasks. They come from one read of the store:
 * harness writes a task and its key in one commit, so the read sees both or neither.
 */
export async function lastTaskIn(
	store: Store,
	id: string,
): Promise<{ readonly latest: RunTask | undefined; readonly keys: RunKeys }> {
	return { latest: taskOf((await runTasks(store)).get(id) ?? []), keys: await runKeys(store, id) };
}

/**
 * The last root task of `run` and the keys of its tasks, as `lastTaskIn` reads them. It throws `UnfollowableRun` when
 * the store is missing.
 */
export async function lastTask(run: SavedRun) {
	const read = await reading(run.store, undefined, ({ store }) => lastTaskIn(store, run.id));

	if (read === undefined) throw new UnfollowableRun(`run ${run.id} has no workflow`);

	return read;
}

/**
 * The `start` keys of the tasks of the run `id` in `store`, from harness's map of keys. The key of a new task has the
 * highest number of the run's keys, plus 1.
 */
async function runKeys(store: Store, id: string): Promise<RunKeys> {
	const numbers = new Map<number, number>();

	for (const [key, task] of (await startedTasks(store)) ?? []) {
		const n = keyNumber(id, key);

		if (n !== undefined) numbers.set(task, n);
	}

	const keyOf = (task: RunTask) => {
		const n = numbers.get(task.id);

		if (n === undefined) throw new Error(`run ${id} has no harness task key for its task ${task.id}`);

		return taskKey(id, n);
	};

	return { keyOf, next: taskKey(id, Math.max(0, ...numbers.values()) + 1) };
}

/** The saved input of the task `task` in the store of `run`, or undefined when the store has no such task. */
export function inputOf(run: SavedRun, task: TaskId<JsonValue>): Promise<JsonValue | undefined> {
	return reading(run.store, undefined, async ({ store }) => (await store.task(task, BACKGROUND_CONTEXT))?.input);
}

/** The progress events of the root run `run`. */
export function eventsOf(run: SavedRun): Promise<readonly ProgressEvent[]> {
	return reading(run.store, [], ({ store }) => progressEvents(store, run.id));
}

/**
 * The task `latest` of the run `id`. It throws `UnfollowableRun` when there is none or when another version saved it;
 * `verb` completes that error, as in `cannot <verb>`.
 */
export function checked(
	latest: TaskRecord<JsonValue, JsonValue, JsonValue> | undefined,
	id: string,
	verb: string,
): TaskRecord<ScriptInput, JsonValue, JsonValue> {
	if (latest === undefined) throw new UnfollowableRun(`run ${id} has no workflow`);

	if (current(latest)) return latest;
	const { name, later } = savedBy(latest);

	throw new UnfollowableRun(
		`run ${id} was saved by ${later ? "a later" : "an earlier"} version of ${name} and cannot ${verb}`,
	);
}

/**
 * The workflow of the task `latest` of any version, as the input schema of this version reads it, or `?`, and whether
 * the version that saved it is later than this one.
 */
export function savedBy(latest: TaskRecord<JsonValue, JsonValue, JsonValue>) {
	return { name: inputName(latest.input) ?? "?", later: savedLater(latest) };
}
