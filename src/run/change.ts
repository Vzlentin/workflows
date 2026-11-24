/**
 * The change that an argument of `land` or `pr` names: a local branch of the main checkout, or a completed root run
 * whose result has a `change`.
 */
import type { Static } from "typebox";
import { Value } from "typebox/value";
import { hasBranch, mainCheckout } from "../launch/worktree.ts";
import { completedRun, type RunTask } from "./past.ts";
import { RESULT_OBJECT } from "./result.ts";

/**
 * The completed root run that gives a change: its ID, its `item` arg when that is a string, else null, and its result
 * object.
 */
export type ChangeRun = {
	readonly id: string;
	readonly item: string | null;
	readonly result: Static<typeof RESULT_OBJECT>;
};

/** A change: its repository, its branch, and the run that gives it, or null for a branch. */
export type NamedChange = { readonly repository: string; readonly branch: string; readonly run: ChangeRun | null };

/**
 * The change that `arg` names from `cwd`: a branch of the main checkout of `cwd` gives itself in that checkout, and
 * the ID of a completed root run of `roots` (the root tasks by run ID, as `rootRuns` gives them) gives the `change` of
 * its result. Null when `arg` is neither. Throws `the run <arg> has no change` for a completed run whose result has no
 * change, or a change with no branch.
 */
export async function namedChange(
	cwd: string,
	arg: string,
	roots: ReadonlyMap<string, readonly RunTask[]>,
): Promise<NamedChange | null> {
	const repository = await mainCheckout(cwd);

	if (await hasBranch(repository, arg)) return { repository, branch: arg, run: null };
	const run = completedRun(roots, arg);

	if (run === undefined) return null;
	const result = Value.Check(RESULT_OBJECT, run.result) ? run.result : undefined;
	const change = result?.change;

	// A run on a detached HEAD, or saved by an older version, has no `change`.
	if (result === undefined || change === undefined || change.branch === "") {
		throw new Error(`the run ${arg} has no change`);
	}

	return { repository: change.repository, branch: change.branch, run: { id: arg, item: run.item, result } };
}
