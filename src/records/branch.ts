/**
 * The branch of a saved run and the saved runs of a branch, read from the tasks of every run, root and child, of a
 * host store.
 */
import { Value } from "typebox/value";
import { mainCheckout } from "../launch/worktree.ts";
import { type RunTask, taskOf, taskOutcome } from "../run/past.ts";
import { RESULT_OBJECT } from "../run/result.ts";
import { inputWorktree } from "./store.ts";

/** A branch, and the repository that has it, as a run saved them. */
export type RunChange = { readonly repository: string; readonly branch: string };

/**
 * The branches of the runs `runs`, the tasks of each run by run ID in task ID order, as `everyRun` gives them. The
 * repository of a change is the main checkout of the saved repository; the main checkout of each path is read once.
 */
export class RunBranches {
	readonly #runs: ReadonlyMap<string, readonly RunTask[]>;
	readonly #children = new Map<string, string[]>();
	readonly #checkouts = new Map<string, Promise<string | undefined>>();

	constructor(runs: ReadonlyMap<string, readonly RunTask[]>) {
		this.#runs = runs;
		const runOfTask = new Map<number, string>();

		for (const [id, tasks] of runs) for (const task of tasks) runOfTask.set(task.id, id);

		for (const [id, tasks] of runs) {
			for (const task of tasks) {
				const parent = task.owner === undefined ? undefined : runOfTask.get(task.owner);

				if (parent === undefined || parent === id) continue;
				const children = this.#children.get(parent) ?? [];

				if (!children.includes(id)) this.#children.set(parent, [...children, id]);
			}
		}
	}

	/** Whether the run `id` is one of the runs. */
	has(id: string): boolean {
		return this.#runs.has(id);
	}

	/**
	 * The change of the run `id`: the `change` of its result, else the worktree of its input, else the worktree of its
	 * newest direct child run that has one. Undefined when it has none, or when Git cannot read the repository.
	 */
	async changeOf(id: string): Promise<RunChange | undefined> {
		const change = this.#ownChanges(id)[0] ?? this.#childChange(id);

		if (change === undefined) return undefined;
		const repository = await this.#checkout(change.repository);

		return repository === undefined ? undefined : { repository, branch: change.branch };
	}

	/**
	 * The IDs of the runs of `branch` in the main checkout `repository`, in task ID order. A run has the branch when the
	 * `change` of its result or the worktree of its input is on it, or, when it has neither, the worktree of its newest
	 * direct child run, as a run that works through a child run.
	 */
	async runsOf(repository: string, branch: string): Promise<string[]> {
		const found: string[] = [];

		for (const id of this.#runs.keys()) {
			const own = this.#ownChanges(id);
			const changes = own.length > 0 ? own : [this.#childChange(id)];

			for (const change of changes) {
				if (change?.branch === branch && (await this.#checkout(change.repository)) === repository) {
					found.push(id);
					break;
				}
			}
		}

		return found;
	}

	/** The `change` of the result of the run `id`, then the worktree of its input, those that it has. */
	#ownChanges(id: string): RunChange[] {
		const task = taskOf(this.#runs.get(id) ?? []);

		if (task === undefined) return [];
		const outcome = taskOutcome(task);
		const value = outcome?.status === "completed" ? outcome.result : undefined;
		const change = Value.Check(RESULT_OBJECT, value) ? value.change : undefined;
		const worktree = inputWorktree(task.input);

		return [change, worktree].flatMap((found) =>
			found === undefined ? [] : [{ repository: found.repository, branch: found.branch }],
		);
	}

	/** The worktree of the input of the newest direct child run of the run `id` that has one. */
	#childChange(id: string): RunChange | undefined {
		for (const child of (this.#children.get(id) ?? []).toReversed()) {
			const task = taskOf(this.#runs.get(child) ?? []);
			const worktree = task === undefined ? undefined : inputWorktree(task.input);

			if (worktree !== undefined) return { repository: worktree.repository, branch: worktree.branch };
		}

		return undefined;
	}

	/** The main checkout of the repository at `path`, or undefined when Git cannot read it. */
	#checkout(path: string): Promise<string | undefined> {
		let checkout = this.#checkouts.get(path);

		if (checkout === undefined) {
			checkout = mainCheckout(path).catch(() => undefined);
			this.#checkouts.set(path, checkout);
		}

		return checkout;
	}
}
