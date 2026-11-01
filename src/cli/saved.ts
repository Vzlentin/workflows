/** The saved runs of the command line: their run directory, their root tasks, their status and their progress, read from the project store. */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { JsonValue } from "@earendil-works/chord";
import type { TaskRecord } from "@earendil-works/pi-durable";
import { statePaths } from "@vzlentin/harness/protocol";
import type { ScriptInput } from "../launch/input.ts";
import { inputString, progressEvents, reading, runTasks } from "../records/store.ts";
import type { RunTask } from "../run/past.ts";
import type { ProgressEvent } from "../run/progress.ts";
import { statusOf } from "../run/result.ts";
import { current, TASK } from "../run/version.ts";
import { UsageError } from "../workflow/find.ts";
import { runsDirectory, STORE_FILE } from "./host.ts";

/** The one run ID of `args`. Bad usage prints `usage`. */
export function oneRunId(args: readonly string[], usage: string): string {
	const [id, ...rest] = args;

	if (id === undefined || rest.length > 0 || id.startsWith("-")) throw new UsageError("give one run ID", usage);

	return id;
}

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
			throw new Error(`no run ${id} in ${runsDirectory()}`);
		})
	).trim();

	return { id, project, store: join(statePaths(project).dir, STORE_FILE) };
}

/** The root tasks of `run`, oldest first. */
export function tasksOf(run: SavedRun): Promise<RunTask[]> {
	return reading(run.store, [], async (store) => (await runTasks(store)).get(run.id) ?? []);
}

/**
 * The task of a run that the commands go by: its last task, unless that is a task of another version that ended after
 * a task of this version, as when the command refused the host's version and aborted it; then the last task of this
 * version.
 */
export function taskOf(tasks: readonly RunTask[]): RunTask | undefined {
	const latest = tasks.at(-1);

	if (latest === undefined || current(latest) || latest.state.status !== "terminal") return latest;

	return tasks.findLast(current) ?? latest;
}

/** The status of a run whose task is `task`, for `list` and `show`. */
export function runStatus(task: RunTask): string {
	const { state } = task;

	if (state.status !== "terminal") {
		if (current(task)) return "running";

		return savedBy(task).later ? "later-version" : "earlier-version";
	}

	const { outcome } = state;

	if (outcome.status === "completed") return statusOf(outcome.result) ?? "done";

	return outcome.status;
}

/** The progress events of the root run `run`. */
export function progressOf(run: SavedRun): Promise<readonly ProgressEvent[]> {
	return reading(run.store, [], (store) => progressEvents(store, run.id));
}

const PREFIX = "workflows.";

/** The task `latest` of the run `id`. It throws when there is none, or when another version saved it. */
export function checked(
	latest: TaskRecord<JsonValue, JsonValue, JsonValue> | undefined,
	id: string,
	verb: string,
): TaskRecord<ScriptInput, JsonValue, JsonValue> {
	if (latest === undefined) throw new Error(`run ${id} has no workflow`);

	if (current(latest)) return latest;
	const { name, later } = savedBy(latest);
	throw new Error(`run ${id} was saved by ${later ? "a later" : "an earlier"} version of ${name} and cannot ${verb}`);
}

/** The workflow of the task `latest` that another version saved, and whether that version is later. */
export function savedBy(latest: TaskRecord<JsonValue, JsonValue, JsonValue>) {
	// A script task of an earlier version names its workflow in its input; an earlier task kind names it in the kind.
	const name = inputString(latest.input, "name") ?? latest.kind.slice(PREFIX.length);

	return { name, later: latest.kind === TASK.name && latest.version > TASK.version };
}
