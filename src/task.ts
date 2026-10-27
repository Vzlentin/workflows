/**
 * The task of every script run: its saved input and checkpoint, its one phase, the child runs that the `run` calls of
 * its script start, and the end of its sessions.
 */
import { mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Context, JsonValue } from "@earendil-works/chord";
import {
	type ConversationId,
	defineTask,
	type JsonObject,
	type RunningTask,
	type Task,
	type TaskId,
	type TaskRecord,
	type TaskRuntime,
} from "@earendil-works/pi-durable";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { branchOf, ensureWorktree, renameBranch } from "./git.ts";
import { childInput, report, type ScriptInput, statusOf } from "./meta.ts";
import { newRunId } from "./run.ts";
import { addProgress, CallDoc, type Child, type Host, JSON_VALUE, ownerOf, runScript, SessionsDoc } from "./script.ts";

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
		const run = { id, directory, cwd: caller.cwd, root: caller.input.root };
		const own = await childInput({ name, args, bundle: caller.input.bundle }, run);
		const { parent } = caller.input;
		const input = parent === undefined ? own : { ...own, parent };
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

/** The stdout line of `workflows --json` after `run <run-id>`, and the outcome that a background run posts. */
export const OUTCOME = Type.Union([
	Type.Object({
		runId: Type.String(),
		status: Type.Literal("finished"),
		result: JSON_VALUE,
		/** The lines that the workflow's report prints without `--json`. */
		report: Type.Array(Type.String()),
	}),
	Type.Object({ runId: Type.String(), status: Type.Literal("failed"), error: Type.String() }),
	/** `workflow` is the name of the run's workflow, which a background run shows while it runs. */
	Type.Object({ runId: Type.String(), status: Type.Literal("started"), workflow: Type.String() }),
	Type.Object({
		runId: Type.String(),
		status: Type.Union([Type.Literal("detached"), Type.Literal("stopped"), Type.Literal("host-stopped")]),
	}),
]);

export type WorkflowOutcome = Static<typeof OUTCOME>;

/** The result of a run that waits on `input(question)`. */
const WAITING = Type.Object({ status: Type.Literal("waiting"), question: Type.String() });

function summary(outcome: WorkflowOutcome): string {
	switch (outcome.status) {
		case "finished":
			if (Value.Check(WAITING, outcome.result)) {
				return `run ${outcome.runId} waits for an answer: ${outcome.result.question}; answer it with resume: "${outcome.runId}" and answer: "<your answer>"`;
			}

			return `run ${outcome.runId} finished: ${JSON.stringify(outcome.result)}`;
		case "failed":
			return `run ${outcome.runId} failed: ${outcome.error}; continue it with resume: "${outcome.runId}"`;
		case "started":
			return `run ${outcome.runId} started in the background; its result comes as a message in this conversation when it ends; follow it with resume: "${outcome.runId}", or stop it with the command workflows stop ${outcome.runId}`;
		case "detached":
			return `run ${outcome.runId} detached and goes on in the harness host; follow it with resume: "${outcome.runId}", or stop it with the command workflows stop ${outcome.runId}`;
		case "stopped":
			return `run ${outcome.runId} stopped; continue it with resume: "${outcome.runId}"`;
		case "host-stopped":
			return `the harness host of run ${outcome.runId} stopped; the run continues when the host starts again, so follow it with resume: "${outcome.runId}"`;
	}
}

/** The text of `outcome` for the model: its summary, then the report lines of a finished run that does not wait. */
export function outcomeText(outcome: WorkflowOutcome): string {
	if (outcome.status !== "finished" || Value.Check(WAITING, outcome.result)) return summary(outcome);

	return [summary(outcome), ...outcome.report].join("\n");
}

/** The outcome of the finished run `input` with `result`, with the report lines that the command prints. */
function finishedOutcome(input: ScriptInput, result: JsonValue): WorkflowOutcome {
	const lines: string[] = [];

	const io = {
		cwd: input.cwd,
		stdin: async () => undefined,
		stdout: (line: string) => lines.push(line),
		stderr: () => {},
	};

	report(input, result, io);

	return { runId: input.runId, status: "finished", result, report: lines };
}

/**
 * Posts `outcome` as a message to the conversation `input.parent` when the run started with `notify`. Its request ID
 * has the task ID, so a rerun of the phase posts once, and a later task of the run posts again. A failed post does not
 * change the outcome of the run, but a closing host rethrows it, so the task stays pending and posts after the restart.
 */
async function notify(runtime: Runtime, input: ScriptInput, outcome: WorkflowOutcome, context: Context): Promise<void> {
	const { notify: wanted, parent } = input;

	// A Pi session ID is a UUID, and only a host conversation has a number.
	if (!wanted || parent === undefined || !/^\d+$/.test(parent)) return;

	try {
		// SAFETY: a conversation ID is a number, and `parent` is the number of the conversation of the `workflow` call.
		const conversation = await runtime.conversation(Number(parent) as ConversationId, context);

		await conversation?.submit(
			{
				type: "input",
				whenBusy: "followUp",
				content: outcomeText(outcome),
				entry: { kind: "workflows.result", data: { runId: input.runId, status: outcome.status } },
				requestId: `workflows.result:${input.runId}/${runtime.taskId}`,
			},
			context,
		);
	} catch (error) {
		if (runtime.signal.aborted) throw error;
		runtime.report(error);
	}
}

/**
 * Ends the sessions of the run `input`. After a completed root run, it closes the sessions of the run and of its child
 * runs, also of a failed child run that the script caught, with everything under them. After a completed child run, it
 * closes the sessions of that run. After a failed or aborted run, it closes only what is under the sessions of the run,
 * such as their subagents, and keeps them for a resume. The store aborts the turns of the sessions that this task owns,
 * but not of those that an earlier task of the run opened, so it aborts those itself.
 */
async function endSessions(
	host: Host,
	runtime: Runtime,
	input: ScriptInput,
	completed: boolean,
	context: Context,
): Promise<void> {
	const { children, place } = host;
	const { runId, root } = input;
	const all = completed && runId === root;

	for (const { run, conversation, task } of (await runtime.snapshot(SessionsDoc, root, context))?.sessions ?? []) {
		if (!all && run !== runId) continue;
		const child = await children.find(place, ownerOf(runtime, run), { id: String(conversation) }, context);

		if (child === undefined) continue;

		if (completed) {
			await child.close(context);
			continue;
		}

		await child.close(context, { below: true });

		if (task !== runtime.taskId) await child.conversation.abort(context, { background: true });
	}
}

const NAMED = Type.Object({ subject: Type.String(), report: Type.Optional(Type.Array(Type.String())) });

/**
 * `result` of a run with a worktree of its own, with the branch that the worktree ends on. A result with a `subject`
 * renames the branch `<wf>/<run-id>` to the name of `subject`, and gets `branch` and the report line `branch <name>`.
 * A `--branch` worktree is not on `<wf>/<run-id>`, so it keeps its branch. Safe to repeat: a repeat finds the worktree
 * on the new branch.
 */
async function named(input: ScriptInput, result: JsonValue, signal: AbortSignal): Promise<JsonValue> {
	const { worktree } = input;

	if (worktree === undefined || !Value.Check(NAMED, result)) return result;
	const wanted = branchOf(result.subject);
	const from = `${input.name}/${input.runId}`;
	const renamed = wanted === "" ? worktree.branch : await renameBranch(worktree.path, from, wanted, signal);

	const line =
		renamed === undefined
			? `branch ${wanted} is in conflict with an existing branch; kept ${from}`
			: `branch ${renamed}`;

	return { ...result, branch: renamed ?? from, report: [...(result.report ?? []), line] };
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
	host: Host,
) {
	const { input } = task;
	const { worktree, runId, root } = input;
	const cwd = worktree?.path ?? input.cwd;
	const caller = task.owner === undefined ? undefined : await runtime.getTask(task.owner, context);
	const parent = caller !== undefined && current(caller) ? caller.input.runId : null;

	try {
		// A command that reaches the running task of a root run shows its progress from here, and a child run goes under
		// the current step of its caller from here, also when it has no line of its own.
		await runtime.commit(async (tx) => {
			await addProgress(tx, root, [
				parent === null ? { kind: "start", run: runId } : { kind: "start", run: runId, parent },
			]);

			return undefined;
		}, context);

		if (worktree !== undefined)
			await ensureWorktree(worktree.repository, worktree.path, worktree.branch, worktree.start);

		const ran = await runScript(runtime, context, cwd, host, {
			runId,
			parent,
			root,
			runDir: input.runDir,
			bundle: input.bundle,
			session: input.parent,
			answer: input.answer,
			args: worktree === undefined ? input.args : { ...input.args, start: worktree.start },
			child: (key, name, args) => startChild(definition, runtime, context, { input, cwd }, key, name, args),
			restart: (key, ended) => restartChild(definition, runtime, context, key, ended),
		});

		const result = await named(input, ran, runtime.signal);

		// A waiting run keeps its sessions for the task that gets the answer.
		await endSessions(host, runtime, input, statusOf(result) !== "waiting", context);
		await notify(runtime, input, finishedOutcome(input, result), context);
		await runtime.commit(async (tx) => {
			await addProgress(tx, root, [{ kind: "end", run: runId, failed: false, at: Date.now() }]);

			return { status: "terminal", outcome: { status: "completed", result } };
		}, context);
	} catch (error) {
		// A closing store cancels the phase; it runs again when the run resumes.
		if (runtime.signal.aborted) throw error;
		// A thrown phase would end the task as faulted, so the phase commits the failure itself.
		const message = error instanceof Error ? error.message : String(error);
		await endSessions(host, runtime, input, false, context);
		await notify(runtime, input, { runId, status: "failed", error: message }, context);
		await runtime.commit(async (tx) => {
			await addProgress(tx, root, [{ kind: "end", run: runId, failed: true, at: Date.now() }]);

			return { status: "terminal", outcome: { status: "failed", error: { message } } };
		}, context);
	}
}

/** The kind and version of the task of every script run. A run saved by another version cannot resume. */
export const TASK = { name: "workflows.run", version: 17 } as const;

/** Whether the script task can continue the task `latest`. */
export function current<R>(
	latest: TaskRecord<JsonValue, JsonValue, R>,
): latest is TaskRecord<ScriptInput, JsonValue, R> {
	return latest.kind === TASK.name && latest.version === TASK.version;
}

/** The task of every script run, which runs its sessions on the children library of `host`. */
export function scriptTask(host: Host): ScriptTask {
	const definition: ScriptTask = defineTask<ScriptInput, Checkpoint, JsonValue>({
		...TASK,
		// No `migrate`: the store does not run a task of another version, and `resume` refuses it.
		initial: () => ({ phase: "run" }),
		phases: { run: (task, runtime, context) => runPhase(definition, task, runtime, context, host) },
		abort: async (task, runtime, context) => {
			const { runId, root } = task.input;
			await endSessions(host, runtime, task.input, false, context);
			await notify(runtime, task.input, { runId, status: "stopped" }, context);
			await runtime.commit(async (tx) => {
				await addProgress(tx, root, [{ kind: "end", run: runId, failed: true, at: Date.now() }]);

				return { status: "terminal", outcome: { status: "aborted" } };
			}, context);
		},
	});

	return definition;
}
