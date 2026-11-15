/**
 * The saved runs of the command line: their run directory, their root tasks with their keys, their status and their
 * progress, read from the project store.
 */
import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord/json";
import type { TaskId, TaskRecord } from "@earendil-works/pi-durable";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { readProject, type ScriptInput } from "../launch/input.ts";
import { RUN_FIELDS, SWEPT, type TaskFields, taskFields } from "../records/run.ts";
import { progressOf as stepsOf } from "../records/steps.ts";
import {
	inputName,
	inputWorktree,
	progressEvents,
	reading,
	runTasks,
	type Store,
	startedTasks,
} from "../records/store.ts";
import { hasEnded, type RunTask, runStatus, savedInput, savedLater, taskOf } from "../run/past.ts";
import type { ProgressEvent } from "../run/progress.ts";
import { SHOWN_INPUT, type ShownInput, title as titleOf } from "../run/result.ts";
import { current } from "../run/version.ts";
import { UsageError } from "../workflow/find.ts";
import { keyNumber, runsDirectory, storeOf, taskKey } from "./host.ts";

/** The one run ID of `args`. Bad usage prints `usage`. */
export function oneRunId(args: readonly string[], usage: string): string {
	const [id, ...rest] = args;

	if (id === undefined || rest.length > 0 || id.startsWith("-")) throw new UsageError("give one run ID", usage);

	return id;
}

/** The error of a command on a saved run that is gone: its run directory or its task is missing. It exits `GONE_EXIT`. */
export class GoneRun extends Error {}

/** A run that the command started: its ID, its project, and the path of the project store. */
export type SavedRun = { readonly id: string; readonly project: string; readonly store: string };

/** The saved run `id`, from the `project` file of its run directory. A run ID that is a path is bad usage. */
export async function savedRun(id: string, usage: string): Promise<SavedRun> {
	if (id.includes("/") || id.includes("\\") || id === "." || id === "..") {
		throw new UsageError(`${id} is not a run ID`, usage);
	}

	const project = await readProject(join(runsDirectory(), id)).catch(() => {
		throw new GoneRun(`no run ${id} in ${runsDirectory()}`);
	});

	return { id, project, store: storeOf(project) };
}

/**
 * A run of the project store that has a task and a run directory: the run fields, the repository of its worktree, or
 * null for a run without a worktree, and its step lines, as `show --json` gives them.
 */
export const ROW = Type.Object(
	{ ...RUN_FIELDS, repository: Type.Union([Type.String(), Type.Null()]), steps: Type.Array(Type.String()) },
	{ additionalProperties: false },
);

export type Row = Static<typeof ROW>;

/** The runs `runs` of the open project store `store` that have a run directory, newest run ID first. */
export async function listedRuns(store: Store, runs: ReadonlyMap<string, readonly RunTask[]>): Promise<Row[]> {
	const listed: Row[] = [];

	for (const [id, tasks] of [...runs].sort(([a], [b]) => b.localeCompare(a))) {
		const task = taskOf(tasks);

		if (task === undefined || !existsSync(join(runsDirectory(), id, "project"))) continue;
		const repository = inputWorktree(task.input)?.repository ?? null;

		// A task of every version whose input has the fields of a title gets its title; another keeps its workflow name.
		const input = savedInput(SHOWN_INPUT, task.input);
		const workflow = savedBy(task).name;
		const events = await progressEvents(store, id);
		const title = input === undefined ? workflow : titleOf(input, events);
		const fields = taskFields(tasks, task);
		const progress = stepsOf(events);

		progress.end(fields.state);
		listed.push({ ...(await runFields(id, workflow, title, fields)), repository, steps: progress.lines() });
	}

	return listed;
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
 * A run directory whose run has no task: its run ID, its path, and the time of its `project` file in ms since the epoch.
 * `start` writes that file before the host creates the task, so it is a run that has not started yet, or whose
 * command stopped before the host created its task.
 */
export type Unstarted = { readonly runId: string; readonly directory: string; readonly since: number };

/**
 * The run directories whose `project` file names `project` and whose run ID has no entry in `runs`, the root runs of
 * the project store, newest run ID first. A child run directory has no `project` file.
 */
export async function unstartedRuns(project: string, runs: ReadonlyMap<string, unknown>): Promise<Unstarted[]> {
	const root = runsDirectory();
	const found: Unstarted[] = [];

	for (const id of (await readdir(root).catch((): string[] => [])).sort().reverse()) {
		if (runs.has(id)) continue;
		const file = join(root, id, "project");
		const named = await readFile(file, "utf8").catch(() => undefined);

		const since = await stat(file).then(
			(info) => info.mtimeMs,
			() => undefined,
		);

		if (named?.trim() === project && since !== undefined) found.push({ runId: id, directory: join(root, id), since });
	}

	return found;
}

/** The root tasks of `run`, oldest first. */
export function tasksOf(run: SavedRun): Promise<RunTask[]> {
	return reading(run.store, [], async (store) => (await runTasks(store)).get(run.id) ?? []);
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
 * The last root task of `run` and the keys of its tasks, as `lastTaskIn` reads them. It throws `GoneRun` when the store
 * is missing.
 */
export async function lastTask(run: SavedRun) {
	const read = await reading(run.store, undefined, (store) => lastTaskIn(store, run.id));

	if (read === undefined) throw new GoneRun(`run ${run.id} has no workflow`);

	return read;
}

/**
 * The `start` keys of the tasks of the run `id` in `store`, from harness's map of keys. The key of a new task has the
 * highest number of the run's keys, plus 1.
 */
async function runKeys(store: Store, id: string): Promise<RunKeys> {
	const numbers = new Map<number, number>();

	for (const [key, task] of await startedTasks(store)) {
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
	return reading(run.store, undefined, async (store) => (await store.task(task, BACKGROUND_CONTEXT))?.input);
}

/** The progress events of the root run `run`. */
export function progressOf(run: SavedRun): Promise<readonly ProgressEvent[]> {
	return reading(run.store, [], (store) => progressEvents(store, run.id));
}

const PREFIX = "workflows.";

/** The task `latest` of the run `id`. It throws `GoneRun` when there is none, and an error when another version saved it. */
export function checked(
	latest: TaskRecord<JsonValue, JsonValue, JsonValue> | undefined,
	id: string,
	verb: string,
): TaskRecord<ScriptInput, JsonValue, JsonValue> {
	if (latest === undefined) throw new GoneRun(`run ${id} has no workflow`);

	if (current(latest)) return latest;
	throw otherVersion(latest, id, verb);
}

/** A task that `show` can read, with the fields of its input that it reads. */
type ReadableTask = { readonly task: RunTask; readonly input: ShownInput };

/**
 * The task `latest` of the run `id`, with the fields of its input that `show` reads: a task of this version, or a task
 * of another version that ended and whose input has these fields. It throws `GoneRun` when there is no task, and
 * an error for another task of another version.
 */
export function readable(latest: RunTask | undefined, id: string, verb: string): ReadableTask {
	if (latest === undefined) throw new GoneRun(`run ${id} has no workflow`);

	if (current(latest)) return { task: latest, input: latest.input };
	const input = savedInput(SHOWN_INPUT, latest.input);

	if (input !== undefined && hasEnded(runStatus(latest))) return { task: latest, input };
	throw otherVersion(latest, id, verb);
}

function otherVersion(latest: RunTask, id: string, verb: string): Error {
	const { name, later } = savedBy(latest);

	return new Error(`run ${id} was saved by ${later ? "a later" : "an earlier"} version of ${name} and cannot ${verb}`);
}

/** The workflow of the task `latest` of any version, and whether the version that saved it is later than this one. */
export function savedBy(latest: TaskRecord<JsonValue, JsonValue, JsonValue>) {
	// A script task names its workflow in its input; an earlier task kind names it in the kind.
	const name = inputName(latest.input) ?? latest.kind.slice(PREFIX.length);

	return { name, later: savedLater(latest) };
}
