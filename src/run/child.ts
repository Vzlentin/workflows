/** The child runs that the `run` calls of a script start, as child tasks of the caller's task. */
import { mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Context, JsonValue } from "@earendil-works/chord";
import type { JsonObject, TaskId } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { childInput, newRunId, type ScriptInput } from "../launch/input.ts";
import { CallDoc, type Calls, type Child, type ScriptRun } from "./calls.ts";
import { hasEnded, hasResult, runStatus, savedBundle, scanRuns } from "./past.ts";
import { current, type Runtime, type ScriptTask } from "./version.ts";

/** The child run saved in the record of the `run` call `key`. */
async function savedChild(runtime: Runtime, key: string, context: Context): Promise<Child> {
	const child = (await runtime.snapshot(CallDoc, key, context))?.child;

	if (child === undefined) throw new Error(`the child run of ${key} is missing`);

	return child;
}

/** `bundle` with the prompts and profiles of the saved root run `from`, the arg of the `run` call of `name`. */
async function bundleFrom(
	runtime: Runtime,
	context: Context,
	name: string,
	bundle: ScriptInput["bundle"],
	from: JsonValue | undefined,
): Promise<ScriptInput["bundle"]> {
	if (from === undefined) return bundle;

	if (!Value.Check(Type.String(), from)) throw new Error(`run ${name}: from is not a run ID`);
	const saved = savedBundle(await scanRuns(runtime, context), from);

	if (saved === undefined) throw new Error(`run ${name}: no run ${from}`);

	return { ...bundle, prompts: saved.prompts, agents: saved.agents };
}

/**
 * A new child task of the `run` call `key` of the task of `runtime`, in a new run directory next to `script.runDir`,
 * whose calls run in `cwd`. The commit that creates it also saves it in the record of the call. With `from`, the child
 * gets the prompts and profiles of that saved root run in place of the caller's.
 */
async function startChild(
	runtime: Runtime,
	context: Context,
	script: ScriptRun,
	cwd: string,
	key: string,
	name: string,
	{ from, ...args }: JsonObject,
): Promise<Child> {
	const bundle = await bundleFrom(runtime, context, name, script.bundle, from);
	const id = newRunId();
	const directory = join(dirname(script.runDir), id);
	await mkdir(directory, { recursive: true });

	try {
		const run = { id, directory, cwd, root: script.root };
		const own = await childInput({ name, args, bundle, overlay: script.overlay }, run);
		const { session: parent, herdr, definition } = script;
		const parented = parent === undefined ? own : { ...own, parent };
		const input = herdr === undefined ? parented : { ...parented, herdr };
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
 * The result of the child run of the `run` call `key`, whose calls run in `cwd`: the `child` of its record, or a new
 * child task, run to its end. A saved child task that ended without completing gets a new child task with the same
 * input and run ID. Throws `child run <id> failed: <error>` when the child run fails, and
 * `child run <id> stopped: <reason>` when it was aborted or orphaned.
 */
export async function childResult(
	calls: Calls,
	cwd: string,
	key: string,
	name: string,
	args: JsonObject,
): Promise<JsonValue> {
	const { runtime, context, script } = calls;
	const saved = (await runtime.snapshot(CallDoc, key, context))?.child;
	const started = saved ?? (await startChild(runtime, context, script, cwd, key, name, args));
	const record = await runtime.getTask(started.task, context);
	const before = record === undefined ? undefined : runStatus(record);
	const ended = before !== undefined && hasEnded(before) && !hasResult(before);
	const { task, runId } = ended ? await restartChild(script.definition, runtime, context, key, started.task) : started;
	const waited = await runtime.waitForTask(task, context);
	const { outcome } = waited.state;
	const status = runStatus(waited);

	if (hasResult(status)) return { runId, result: outcome.result ?? null };
	const cause = outcome.error?.message ?? outcome.reason ?? outcome.status;
	const verb = status === "failed" ? "failed" : "stopped";

	// The error of a nested child run already names the deepest run and whether it failed or stopped.
	throw new Error(cause.startsWith("child run ") ? cause : `child run ${runId} ${verb}: ${cause}`);
}
