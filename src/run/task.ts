/**
 * The task of every script run: its one phase, which runs the script, its outcome, the message that a background run
 * posts, and its abort.
 */
import type { Context, JsonValue } from "@earendil-works/chord";
import { type ConversationId, defineTask, type RunningTask } from "@earendil-works/pi-durable";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { herdrWorktree, typePickLoop } from "../herdr.ts";
import type { ScriptInput } from "../launch/input.ts";
import { branchOf, ensureWorktree, renameBranch } from "../launch/worktree.ts";
import { JSON_VALUE } from "./calls.ts";
import { addProgress } from "./progress.ts";
import { reportOf, statusOf } from "./result.ts";
import { runScript } from "./sandbox.ts";
import { endSessions } from "./sessions.ts";
import { type Checkpoint, current, type Host, type Runtime, type ScriptTask, TASK } from "./version.ts";

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
	return { runId: input.runId, status: "finished", result, report: reportOf(input, result).lines };
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

		if (worktree !== undefined) {
			const { repository, path, branch, start } = worktree;
			// In Herdr, Herdr creates the worktree first, so it shows in the sidebar; when Herdr fails, Git creates it.
			const create = input.herdr === true ? () => herdrWorktree(repository, path, branch, start) : undefined;
			const workspace = await ensureWorktree(repository, path, branch, start, create);

			// The workspace that Herdr opened on the worktree of a root run shows the agents of the run beside its steps.
			if (parent === null && workspace !== undefined) await typePickLoop(workspace, runId);
		}

		const ran = await runScript(runtime, context, cwd, host, {
			runId,
			parent,
			root,
			runDir: input.runDir,
			bundle: input.bundle,
			overlay: input.overlay,
			session: input.parent,
			answer: input.answer,
			args: worktree === undefined ? input.args : { ...input.args, start: worktree.start },
			herdr: input.herdr,
			definition,
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
