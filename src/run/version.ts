/**
 * The kind and version of the task of every script run, and the types that the files of `run/` share: the checkpoint,
 * the runtime and the definition of the task, and what it gets from the harness host.
 */
import type { JsonValue } from "@earendil-works/chord";
import type { Task, TaskRecord, TaskRuntime } from "@earendil-works/pi-durable";
import type { Children, Place } from "@vzlentin/harness/children";
import type { ScriptInput } from "../launch/input.ts";

/** What the script task gets from the harness host: the children library and the place of the project's children. */
export type Host = { readonly children: Children; readonly place: Place };

/**
 * The checkpoint of a run: its one phase. The saved calls of its script are documents of the store, so a new task of
 * the run finds them.
 */
export type Checkpoint = { readonly phase: "run" };

export type Runtime = TaskRuntime<ScriptInput, Checkpoint, JsonValue, object>;

export type ScriptTask = Task<ScriptInput, Checkpoint, JsonValue, object>;

/** The kind and version of the task of every script run. A run saved by another version cannot resume. */
export const TASK = { name: "workflows.run", version: 18 } as const;

/** Whether the script task can continue the task `latest`. */
export function current<R>(
	latest: TaskRecord<JsonValue, JsonValue, R>,
): latest is TaskRecord<ScriptInput, JsonValue, R> {
	return latest.kind === TASK.name && latest.version === TASK.version;
}
