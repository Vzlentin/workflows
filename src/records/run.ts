/** The fields of a run that `list --json`, `show --json` and `show --agents --json` give, from its root tasks. */
import { ServesInput } from "@vzlentin/harness/protocol";
import { type Static, Type } from "typebox";
import { type RunTask, savedInput, stateFields, taskOutcome } from "../run/past.ts";
import { runBranch } from "../run/result.ts";
import { current } from "../run/version.ts";
import { RUN_RESULT, RUN_STATE, waits } from "../tool.ts";
import { inputWorktree } from "./store.ts";

/**
 * What `sweep --yes` did with the worktree of a run: `landed` when its branch was merged, `dropped` when it was not
 * and the run was given by ID.
 */
export const SWEPT = Type.Union([Type.Literal("landed"), Type.Literal("dropped")]);

/**
 * The fields of a run with a task. `result` is the result of a run that is `done` or `waiting`, and `question` the
 * question of a waiting run. `resumable` is true for a task of this version, which `resume` can continue. `branch` is
 * the branch of the run, from its result or its worktree, `startedAt` the time when its first task started, as an ISO
 * string, `serves` the todo or the parley that the run builds, when its start named one, and `swept` the word that
 * `sweep --yes` wrote when it removed the worktree of the run.
 */
export const RUN_FIELDS = {
	runId: Type.String(),
	workflow: Type.String(),
	title: Type.String(),
	state: RUN_STATE,
	result: Type.Optional(RUN_RESULT),
	question: Type.Optional(Type.String()),
	resumable: Type.Boolean(),
	branch: Type.Optional(Type.String()),
	startedAt: Type.Optional(Type.String()),
	serves: Type.Optional(ServesInput),
	swept: Type.Optional(SWEPT),
};

/** The fields of a run that its root tasks give: all the run fields but its ID, workflow, title and sweep word. */
export type TaskFields = Omit<Static<Type.TObject<typeof RUN_FIELDS>>, "runId" | "workflow" | "title" | "swept">;

const SERVES = Type.Object({ serves: ServesInput });

/** The task fields of the run whose root tasks are `tasks`, oldest first, and whose commands go by its task `task`. */
export function taskFields(tasks: readonly RunTask[], task: RunTask): TaskFields {
	const fields: TaskFields = { ...stateFields(task), resumable: current(task) };
	const outcome = taskOutcome(task);
	const value = outcome?.status === "completed" ? outcome.result : undefined;

	if (waits(value)) fields.question = value.question;
	const branch = runBranch(value, inputWorktree(task.input));

	if (branch !== undefined) fields.branch = branch;
	const started = tasks[0]?.startedAt;

	if (started !== undefined) fields.startedAt = new Date(started).toISOString();
	const serves = savedInput(SERVES, task.input)?.serves;

	if (serves !== undefined) fields.serves = serves;

	return fields;
}
