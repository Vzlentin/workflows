/**
 * The task of every script run: its saved input and checkpoint, its one phase, and the child runs that the `run` calls
 * of its script start.
 */
import { mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Context, JsonValue } from "@earendil-works/chord";
import {
	defineTask,
	type JsonObject,
	type RunningTask,
	type Task,
	type TaskId,
	type TaskRecord,
	type TaskRuntime,
} from "@earendil-works/pi-durable";
import { ensureWorktree } from "./git.ts";
import { childInput, type ScriptInput } from "./meta.ts";
import { newRunId } from "./run.ts";
import { CallDoc, type Child, type ExtensionHost, runScript } from "./script.ts";

/**
 * The checkpoint of a run: its one phase. The saved calls of its script are documents of the store, so a new task of
 * the run finds them.
 */
export type Checkpoint = { readonly phase: "run" };

export type Runtime = TaskRuntime<ScriptInput, Checkpoint, JsonValue, object>;

type ScriptTask = Task<ScriptInput, Checkpoint, JsonValue, object>;

/** The child run saved in the record of the `run` call `key`. */
async function savedChild(runtime: Runtime, key: string, context: Context): Promise<Child> {
	const child = (await runtime.snapshot(CallDoc, key, context))?.child;
	if (child === undefined) throw new Error(`the child run of ${key} is missing`);
	return child;
}

/**
 * A new child task of the `run` call `key` of the task of `runtime`, in a new run directory next to `input.runDir`. The
 * commit that creates it also saves it in the record of the call.
 */
async function startChild(
	definition: ScriptTask,
	runtime: Runtime,
	context: Context,
	caller: { readonly input: ScriptInput; readonly cwd: string },
	key: string,
	name: string,
	args: JsonObject,
): Promise<Child> {
	const id = newRunId();
	const directory = join(dirname(caller.input.runDir), id);
	await mkdir(directory, { recursive: true });
	try {
		const input = await childInput({ name, args, bundle: caller.input.bundle }, { id, directory, cwd: caller.cwd });
		await runtime.commit(async (tx) => {
			const task = await tx.createTask(definition, input, { ownership: { kind: "task", taskId: runtime.taskId } });
			const doc = await tx.doc(CallDoc, key, null);
			doc.child = { task, runId: id };
			return undefined;
		}, context);
	} catch (error) {
		await rm(directory, { recursive: true, force: true });
		throw error;
	}
	return savedChild(runtime, key, context);
}

/**
 * A new child task with the input, so also the run ID and directory, of the ended child task `ended`. The commit that
 * creates it also saves it in the record of the `run` call `key`.
 */
async function restartChild(
	definition: ScriptTask,
	runtime: Runtime,
	context: Context,
	key: string,
	ended: TaskId<JsonValue>,
): Promise<Child> {
	const record = await runtime.getTask(ended, context);
	if (record === undefined || !current(record)) throw new Error(`the child task ${ended} is missing`);
	const { input } = record;
	await runtime.commit(async (tx) => {
		const task = await tx.createTask(definition, input, { ownership: { kind: "task", taskId: runtime.taskId } });
		const doc = await tx.doc(CallDoc, key, null);
		doc.child = { task, runId: input.runId };
		return undefined;
	}, context);
	return savedChild(runtime, key, context);
}

/**
 * The one phase: it runs the script, in the run's worktree when it has one. The phase may run again after an
 * interruption: saved calls do not run again, and Git steps must be safe to repeat. A failed phase, in a root run or a
 * child run, ends the task as failed. Its saved calls stay in the store for the next task of the run.
 */
async function runPhase(
	definition: ScriptTask,
	task: RunningTask<ScriptInput, Checkpoint, JsonValue>,
	runtime: Runtime,
	context: Context,
	host: ExtensionHost,
) {
	const { input } = task;
	const { worktree } = input;
	const cwd = worktree?.path ?? input.cwd;
	try {
		if (worktree !== undefined)
			await ensureWorktree(worktree.repository, worktree.path, worktree.branch, worktree.start);
		const result = await runScript(runtime, context, cwd, host, {
			runId: input.runId,
			runDir: input.runDir,
			bundle: input.bundle,
			args: worktree === undefined ? input.args : { ...input.args, start: worktree.start },
			child: (key, name, args) => startChild(definition, runtime, context, { input, cwd }, key, name, args),
			restart: (key, ended) => restartChild(definition, runtime, context, key, ended),
		});
		await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result } }), context);
	} catch (error) {
		// A closing store cancels the phase; it runs again when the run resumes.
		if (runtime.signal.aborted) throw error;
		// A thrown phase would end the task as faulted, so the phase commits the failure itself.
		const message = error instanceof Error ? error.message : String(error);
		await runtime.commit(() => ({ status: "terminal", outcome: { status: "failed", error: { message } } }), context);
	}
}

/** The kind and version of the task of every script run. A run saved by an earlier version cannot resume. */
export const TASK = { name: "workflows.run", version: 9 } as const;

/** Whether the script task can continue the task `latest`. */
export function current(
	latest: TaskRecord<JsonValue, JsonValue, JsonValue>,
): latest is TaskRecord<ScriptInput, JsonValue, JsonValue> {
	return latest.kind === TASK.name && latest.version >= TASK.version;
}

/** The task of every script run, whose scripts reach the command through `host`; `list` shows the script name. */
export function scriptTask(host: ExtensionHost): ScriptTask {
	const definition: ScriptTask = defineTask<ScriptInput, Checkpoint, JsonValue>({
		...TASK,
		// No `migrate`: the store does not run a task of an earlier version, and `resume` refuses it.
		initial: () => ({ phase: "run" }),
		phases: { run: (task, runtime, context) => runPhase(definition, task, runtime, context, host) },
		abort: async (_task, runtime, context) => {
			await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context);
		},
	});
	return definition;
}
