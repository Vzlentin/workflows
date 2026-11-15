/**
 * The task of every script run: its one phase, which runs the script, its outcome, the message that a background run
 * posts, and its abort.
 */
import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { Context } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord/json";
import { type ConversationId, defineTask, type RunningTask } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { PRUNE_MARKER, readProject, type ScriptInput } from "../launch/input.ts";
import { branchOf, ensureWorktree, type Renamed, renameBranch } from "../launch/worktree.ts";
import { outcomeText, waits } from "../tool.ts";
import { firstTask, outcomeFrom, scanTasks, type TaskEnd } from "./past.ts";
import { addProgress } from "./progress.ts";
import { runScript } from "./sandbox.ts";
import { checkServes } from "./serves.ts";
import { endSessions } from "./sessions.ts";
import { type Checkpoint, current, type Host, type Runtime, type ScriptTask, TASK } from "./version.ts";

/**
 * Posts the outcome of the run `input`, whose task ends with `outcome`, as a message to the conversation `input.parent` when the run started with `notify`. Its request ID
 * has the task ID, so a rerun of the phase posts once, and a later task of the run posts again. A failed post does not
 * change the outcome of the run, but a closing host rethrows it, so the task stays pending and posts after the restart.
 */
async function notify(
	runtime: Runtime,
	input: ScriptInput,
	outcome: NonNullable<TaskEnd["outcome"]>,
	context: Context,
): Promise<void> {
	const { notify: wanted, parent } = input;

	// A Pi session ID is a UUID, and only a host conversation has a number.
	if (!wanted || parent === undefined || !/^\d+$/.test(parent)) return;
	const ended = outcomeFrom(input, outcome);

	try {
		// SAFETY: a conversation ID is a number, and `parent` is the number of the conversation of the `workflow` call.
		const conversation = await runtime.conversation(Number(parent) as ConversationId, context);

		await conversation?.submit(
			{
				type: "input",
				whenBusy: "followUp",
				content: outcomeText(ended),
				entry: { kind: "workflows.result", data: { runId: input.runId, state: ended.state } },
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
 * Ends the sessions of the run `input` as `endSessions` does. A failure to end them does not change the outcome of the
 * run: the host reports it. A closing host rethrows it, so the phase runs again after the restart.
 */
async function closeSessions(
	host: Host,
	runtime: Runtime,
	input: ScriptInput,
	completed: boolean,
	context: Context,
): Promise<void> {
	try {
		await endSessions(host, runtime, input, completed, context);
	} catch (error) {
		if (runtime.signal.aborted) throw error;
		runtime.report(error);
	}
}

const NAMED = Type.Object({ subject: Type.String(), report: Type.Optional(Type.Array(Type.String())) });

/**
 * `result` of a run with a worktree of its own, with the branch that the worktree ends on. A result with a `subject`
 * gets `branch` and the report line `branch <name>`. A worktree that `renames` its branch renames it to the name of
 * `subject`; another worktree, such as one of `--branch`, keeps its branch. Safe to repeat: a repeat finds the
 * worktree on the new branch.
 */
async function named(input: ScriptInput, result: JsonValue, signal: AbortSignal): Promise<JsonValue> {
	const { worktree } = input;

	if (worktree === undefined || !Value.Check(NAMED, result)) return result;
	const wanted = branchOf(result.subject);
	const from = worktree.branch;

	const renamed: Renamed =
		wanted === "" || worktree.renames !== true
			? { kind: "on", branch: from }
			: await renameBranch(worktree.path, from, wanted, signal);

	const { branch, line } = branchLine(renamed, from);

	return { ...result, branch, report: [...(result.report ?? []), line] };
}

/** The branch that a run ends on, and its report line. */
type BranchEnd = { readonly branch: string; readonly line: string };

/** The branch that a run ends on after `renamed`, and its report line, where `from` is the branch before the rename. */
function branchLine(renamed: Renamed, from: string): BranchEnd {
	switch (renamed.kind) {
		case "on":
			return { branch: renamed.branch, line: `branch ${renamed.branch}` };

		case "detached":
			return { branch: from, line: `the worktree is on a detached HEAD; kept ${from}` };

		case "refused":
			return { branch: from, line: `branch ${renamed.name} is in conflict with an existing branch; kept ${from}` };

		case "raced":
			return { branch: from, line: `branch ${renamed.name} was created during the rename; kept ${from}` };
	}
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
	const owner = task.owner === undefined ? undefined : await runtime.getTask(task.owner, context);
	const parent = owner !== undefined && current(owner) ? owner.input.runId : null;

	try {
		// A command that reaches the running task of a root run shows its progress from here, and a child run goes under
		// the current step of its caller from here, also when it has no line of its own.
		await runtime.commit(async (tx) => {
			await addProgress(tx, root, [
				parent === null ? { kind: "start", run: runId } : { kind: "start", run: runId, parent },
			]);

			return undefined;
		}, context);

		// Each task of a root run checks what it serves, so a resume after the end of the todo or the parley fails.
		if (task.owner === undefined && input.serves !== undefined) {
			await checkServes(await readProject(input.runDir), runId, input.serves, context.abortSignal);
		}

		// A new task of the run cancels the removal that an interrupted `prune --yes` left.
		await rm(join(input.runDir, PRUNE_MARKER), { force: true });

		if (worktree !== undefined) {
			// A rerun of the first task is still the first task, which may make the branch again.
			const first = firstTask(await scanTasks(runtime, context), runId)?.id === runtime.taskId;
			await ensureWorktree(runId, worktree, first);
		}

		const ran = await runScript(runtime, context, cwd, host, {
			runId,
			parent,
			root,
			runDir: input.runDir,
			bundle: input.bundle,
			agents: input.agents,
			serves: input.serves,
			overlay: input.overlay,
			session: input.parent,
			args: worktree === undefined ? input.args : { ...input.args, start: worktree.start },
			definition,
		});

		const result = await named(input, ran, runtime.signal);

		// A waiting run keeps its sessions for the task that gets the answer.
		await closeSessions(host, runtime, input, !waits(result), context);
		await notify(runtime, input, { status: "completed", result }, context);
		await runtime.commit(async (tx) => {
			await addProgress(tx, root, [{ kind: "end", run: runId, failed: false, at: Date.now() }]);

			return { status: "terminal", outcome: { status: "completed", result } };
		}, context);
	} catch (error) {
		// A closing store cancels the phase; it runs again when the run resumes.
		if (runtime.signal.aborted) throw error;
		// A thrown phase would end the task as faulted, so the phase commits the failure itself.
		const message = error instanceof Error ? error.message : String(error);
		await closeSessions(host, runtime, input, false, context);
		await notify(runtime, input, { status: "failed", error: { message } }, context);
		await runtime.commit(async (tx) => {
			await addProgress(tx, root, [{ kind: "end", run: runId, failed: true, at: Date.now() }]);

			return { status: "terminal", outcome: { status: "failed", error: { message } } };
		}, context);
	}
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
			await closeSessions(host, runtime, task.input, false, context);
			await notify(runtime, task.input, { status: "aborted" }, context);
			await runtime.commit(async (tx) => {
				await addProgress(tx, root, [{ kind: "end", run: runId, failed: false, aborted: true, at: Date.now() }]);

				return { status: "terminal", outcome: { status: "aborted" } };
			}, context);
		},
	});

	return definition;
}
