/**
 * The saved runs of the command line: their run directory, their root tasks with their keys, their status and their
 * progress, read from the project store.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { TaskId, TaskRecord } from "@earendil-works/pi-durable";
import { statePaths } from "@vzlentin/harness/protocol";
import type { ScriptInput } from "../launch/input.ts";
import { inputString, progressEvents, reading, runTasks, startedTasks } from "../records/store.ts";
import { type RunStatus, type RunTask, savedLater, taskOutcome } from "../run/past.ts";
import type { ProgressEvent } from "../run/progress.ts";
import { statusOf } from "../run/result.ts";
import { current } from "../run/version.ts";
import { UsageError } from "../workflow/find.ts";
import { keyNumber, runsDirectory, STORE_FILE, taskKey } from "./host.ts";

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

	const file = join(runsDirectory(), id, "project");

	const project = (
		await readFile(file, "utf8").catch(() => {
			throw new GoneRun(`no run ${id} in ${runsDirectory()}`);
		})
	).trim();

	return { id, project, store: join(statePaths(project).dir, STORE_FILE) };
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

	for (const id of (await readdir(root).catch(() => [])).sort().reverse()) {
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

/**
 * The status of the run whose task is `task` and whose run status is `status`, as `list` and `show` print it: the
 * `status` of the result of a `done` run, or `done` when the result has none, else `status`.
 */
export function shownStatus(task: RunTask, status: RunStatus): string {
	return status === "done" ? (statusOf(taskOutcome(task)?.result ?? null) ?? "done") : status;
}

/** The `start` keys of the tasks of a run: the key of its task `task`, and the key of a new task. */
export type RunKeys = { readonly keyOf: (task: RunTask) => string; readonly next: string };

/**
 * The `start` keys of the tasks of `run`, from harness's map of keys. The key of a new task has the highest number of
 * the run's keys, plus 1.
 */
export async function keysOf(run: SavedRun): Promise<RunKeys> {
	const numbers = await reading(run.store, new Map<number, number>(), async (store) => {
		const found = new Map<number, number>();

		for (const [key, task] of await startedTasks(store)) {
			const n = keyNumber(run.id, key);

			if (n !== undefined) found.set(task, n);
		}

		return found;
	});

	const keyOf = (task: RunTask) => {
		const n = numbers.get(task.id);

		if (n === undefined) throw new Error(`run ${run.id} has no harness task key for its task ${task.id}`);

		return taskKey(run.id, n);
	};

	return { keyOf, next: taskKey(run.id, Math.max(0, ...numbers.values()) + 1) };
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
	const { name, later } = savedBy(latest);
	throw new Error(`run ${id} was saved by ${later ? "a later" : "an earlier"} version of ${name} and cannot ${verb}`);
}

/** The workflow of the task `latest` that another version saved, and whether that version is later. */
export function savedBy(latest: TaskRecord<JsonValue, JsonValue, JsonValue>) {
	// A script task of an earlier version names its workflow in its input; an earlier task kind names it in the kind.
	const name = inputString(latest.input, "name") ?? latest.kind.slice(PREFIX.length);

	return { name, later: savedLater(latest) };
}
