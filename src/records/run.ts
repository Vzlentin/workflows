/** The fields of a run that `list --json`, `show --json` and `show --agents --json` give, from its root tasks. */
import { ServesInput } from "@vzlentin/harness/protocol";
import { type Static, Type } from "typebox";
import { type RunTask, stateFields, taskOutcome } from "../run/past.ts";
import { runBranch } from "../run/result.ts";
import { current } from "../run/version.ts";
import { RUN_RESULT, RUN_STATE, waits } from "../tool.ts";

/**
 * What `sweep --yes` did with the worktree of a run: `landed` when its branch was merged, `dropped` when it was not
 * and the run was given by ID.
 */
export const SWEPT = Type.Union([Type.Literal("landed"), Type.Literal("dropped")]);

/**
 * The fields of a run with a task. `result` is the result of a run that is `done` or `waiting`, and `question` the
 * question of a waiting run. `branch` is
 * the branch of the run, from its result or its worktree, `startedAt` the time when its first task started, as an ISO
 * string, `serves` the todo or the parley that the run builds, when its start named one, `item` the absolute path of
 * the `.md` file that its positional text named, and `swept` the word that `sweep --yes` wrote when it removed the
 * worktree of the run.
 */
export const RUN_FIELDS = {
	runId: Type.String(),
	workflow: Type.String(),
	title: Type.String(),
	state: RUN_STATE,
	result: Type.Optional(RUN_RESULT),
	question: Type.Optional(Type.String()),
	branch: Type.Optional(Type.String()),
	startedAt: Type.Optional(Type.String()),
	serves: Type.Optional(ServesInput),
	item: Type.Optional(Type.String()),
	swept: Type.Optional(SWEPT),
};

/** The fields of a run that its root tasks give: all the run fields but its ID, workflow, title and sweep word. */
export type TaskFields = Omit<Static<Type.TObject<typeof RUN_FIELDS>>, "runId" | "workflow" | "title" | "swept">;

/**
 * The task fields of the run whose root tasks are `tasks`, oldest first, and whose commands go by its task `task`. A
 * task of another version gives only its state and its start: this version does not read its input or its result.
 */
export function taskFields(tasks: readonly RunTask[], task: RunTask): TaskFields {
	if (!current(task)) return withStart(stateFields(task), tasks);
	const { input } = task;
	const fields: TaskFields = stateFields(task);
	const outcome = taskOutcome(task);
	const value = outcome?.status === "completed" ? outcome.result : undefined;

	if (waits(value)) fields.question = value.question;
	const branch = runBranch(value, input.worktree);

	if (branch !== undefined) fields.branch = branch;
	withStart(fields, tasks);

	if (input.serves !== undefined) fields.serves = input.serves;

	if (input.item !== undefined) fields.item = input.item;

	return fields;
}

/** `fields` with `startedAt`, the start of the first of the root tasks `tasks`, when it has one. */
function withStart(fields: TaskFields, tasks: readonly RunTask[]): TaskFields {
	const started = tasks[0]?.startedAt;

	if (started !== undefined) fields.startedAt = new Date(started).toISOString();

	return fields;
}
