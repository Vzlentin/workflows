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
	type TaskRecord,
	type TaskRuntime,
} from "@earendil-works/pi-durable";
import { ensureWorktree } from "./git.ts";
import { isObject, prepare, readMeta, type ScriptInput } from "./meta.ts";
import { instructions } from "./prompts.ts";
import { newRunId, type Run } from "./run.ts";
import { type Child, type ExtensionHost, type RunBundle, runScript } from "./script.ts";

/** The checkpoint of a run: its one phase. The saved calls of its script are memos of the task. */
export type Checkpoint = { readonly phase: "run" };

/** The saved input of a run's task; `call` is the key of the `run` call that started a child run. */
export type TaskInput = { readonly input: ScriptInput; readonly call?: string };

export type Runtime = TaskRuntime<TaskInput, Checkpoint, JsonValue, object>;

type ScriptTask = Task<TaskInput, Checkpoint, JsonValue, object>;

/**
 * The child run of the `run` call `key` of the task of `runtime`: the live child task that the call started before an
 * interruption, or a new child task in a new run directory next to `input.runDir`.
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
	// The `run` memo is saved after the commit that creates the child task, so an interruption between them leaves
	// a child task that only its `call` finds.
	const found = (await runtime.ownedTasks(context)).filter(current).find((owned) => owned.input.call === key);
	if (found !== undefined) return { task: found.id, runId: found.input.input.runId };
	const id = newRunId();
	const directory = join(dirname(caller.input.runDir), id);
	await mkdir(directory, { recursive: true });
	try {
		const input = await childInput({ name, args, bundle: caller.input.bundle }, { id, directory, cwd: caller.cwd });
		const stored: TaskInput = { input, call: key };
		let task: Child["task"] | undefined;
		await runtime.commit(async (tx) => {
			task = await tx.createTask(definition, stored, { ownership: { kind: "task", taskId: runtime.taskId } });
			return undefined;
		}, context);
		return { task: task as Child["task"], runId: id };
	} catch (error) {
		await rm(directory, { recursive: true, force: true });
		throw error;
	}
}

/**
 * The one phase: it runs the script, in the run's worktree when it has one. The phase may run again after an
 * interruption or a failure: saved calls do not run again, and Git steps must be safe to repeat. A failed phase, in a
 * root run or a child run, reports the failure to `host` and stays pending, so that it keeps its saved calls.
 */
async function runPhase(
	definition: ScriptTask,
	task: RunningTask<TaskInput, Checkpoint, JsonValue>,
	runtime: Runtime,
	context: Context,
	host: ExtensionHost,
) {
	const { input } = task.input;
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
		});
		// A child run whose failure the script caught is still live, and the task cannot end while it owns live tasks.
		for (const child of await runtime.ownedTasks(context)) await runtime.abortOwned(child.id, context);
		await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result } }), context);
	} catch (error) {
		// A closing store cancels the phase; it runs again when the run resumes.
		if (runtime.signal.aborted) throw error;
		// A failed task would drop the saved calls, so the task stays pending until the store closes.
		host.fail(runtime.taskId, error instanceof Error ? error.message : String(error));
		const { signal } = runtime;
		await new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
	}
}

/** The kind and version of the task of every script run. A run saved by an earlier version cannot resume. */
export const TASK = { name: "workflows.run", version: 7 } as const;

/** Whether the script task can continue the task `latest`. */
export function current(
	latest: TaskRecord<JsonValue, JsonValue, JsonValue>,
): latest is TaskRecord<TaskInput, JsonValue, JsonValue> {
	return latest.kind === TASK.name && latest.version >= TASK.version;
}

/** The task of every script run, whose scripts reach the command through `host`; `list` shows the script name. */
export function scriptTask(host: ExtensionHost): ScriptTask {
	const definition: ScriptTask = defineTask<TaskInput, Checkpoint, JsonValue>({
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

/**
 * The input of the child run `run` of a `run(name, args)` call: the script `name` of the caller's `bundle`, with the
 * `meta` defaults and the given args. With `meta.worktree` and `repo`, the child gets its own worktree from `repo` and
 * `base`; otherwise it runs in the caller's directory. `prompts` maps prompt names to texts that replace them in this
 * run only. The args are not checked against `meta`.
 */
async function childInput(
	request: { readonly name: string; readonly args: JsonObject; readonly bundle: RunBundle },
	run: Run,
): Promise<ScriptInput> {
	const { name, bundle } = request;
	const source = Object.hasOwn(bundle.scripts, name) ? bundle.scripts[name] : undefined;
	if (source === undefined) throw new Error(`no workflow ${name}`);
	const meta = await readMeta(source, name);
	const { repo, base = "main", prompts = {}, ...given } = request.args;
	if (!isObject(prompts)) throw new Error(`run ${name}: prompts is not an object of prompt texts`);
	const replaced = { ...bundle.prompts };
	for (const [prompt, value] of Object.entries(prompts)) {
		if (!Object.hasOwn(bundle.prompts, prompt)) throw new Error(`run ${name}: no prompt ${prompt}`);
		replaced[prompt] = instructions(String(value));
	}
	const defaults = Object.entries(meta.args).flatMap(([arg, spec]) =>
		spec.default === undefined ? [] : [[arg, spec.default] as const],
	);
	const args = { ...Object.fromEntries(defaults), ...given };
	const input = { name, args, meta, bundle: { ...bundle, prompts: replaced, main: source } };
	if (repo === undefined || !meta.worktree) return { ...input, runId: run.id, runDir: run.directory, cwd: run.cwd };
	return prepare({ ...input, repo: String(repo), base: String(base) }, run);
}
