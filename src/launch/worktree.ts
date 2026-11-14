/** The repository and worktree of a run: repository selection, the run's worktree and the name of its branch. */
import { realpath, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { git, gitSucceeds, run } from "../git.ts";
import { UsageError } from "../workflow/find.ts";

/** The worktree of a run: its repository, the commit it starts from, its branch and its path. */
export type Worktree = {
	readonly repository: string;
	readonly start: string;
	readonly branch: string;
	readonly path: string;
};

/** The top level of the Git repository at `path` itself, or undefined when `path` is not one. */
export async function repositoryAt(path: string): Promise<string | undefined> {
	const directory = await stat(path).then(
		(found) => found.isDirectory(),
		() => false,
	);

	if (!directory) return undefined;
	const top = await run("git", ["rev-parse", "--show-toplevel"], path);

	if (top.code !== 0) return undefined;
	const root = await realpath(top.stdout.trim());

	return root === (await realpath(path)) ? root : undefined;
}

export type Repository = { readonly path: string; readonly start: string };

/**
 * The repository a ship runs on and its base commit. Without `repo`, the repository containing `cwd`. With `repo`,
 * the local repository at that path, resolved from `cwd`; otherwise `gh repo clone <repo>` into `clone`, based on the
 * cloned `origin/<base>`.
 */
export async function selectRepository(
	cwd: string,
	repo: string | undefined,
	base: string,
	clone: string,
): Promise<Repository> {
	if (repo === undefined) {
		const top = await run("git", ["rev-parse", "--show-toplevel"], cwd);

		if (top.code !== 0) throw new Error(`${cwd} is not in a Git repository`);
		const path = top.stdout.trim();

		return { path, start: await commitOf(path, base) };
	}

	const local = await repositoryAt(resolve(cwd, repo));

	if (local !== undefined) return { path: local, start: await commitOf(local, base) };
	const cloned = await run("gh", ["repo", "clone", repo, clone], cwd);

	if (cloned.code !== 0) throw new Error(`gh repo clone ${repo} failed: ${cloned.stdout}${cloned.stderr}`.trim());

	return { path: clone, start: await commitOf(clone, `refs/remotes/origin/${base}`) };
}

/** Whether `branch` is a branch of the repository at `cwd`. */
export function hasBranch(cwd: string, branch: string): Promise<boolean> {
	return gitSucceeds(cwd, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`);
}

async function commitOf(repository: string, ref: string): Promise<string> {
	return git(repository, "rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`);
}

/**
 * The selected repository and its start commit, and the worktree path of the run `id` on the new branch `args.branch`,
 * or `<scriptName>/<id>`. The worktree is `.worktrees/<repository name>/<id>` next to the repository. `cwd` and `clone`
 * are as in `selectRepository`.
 */
export async function prepareWorktree(
	scriptName: string,
	args: { readonly repo: string | undefined; readonly base: string; readonly branch: string | undefined },
	id: string,
	cwd: string,
	clone: string,
): Promise<Worktree> {
	const repository = await selectRepository(cwd, args.repo, args.base, clone);
	const { branch = `${scriptName}/${id}` } = args;

	if (!(await gitSucceeds(repository.path, "check-ref-format", "--branch", branch))) {
		throw new UsageError(`--branch ${branch} is not a valid branch name`);
	}

	if (await hasBranch(repository.path, branch)) {
		throw new UsageError(`--branch ${branch} exists`);
	}

	return { repository: repository.path, start: repository.start, branch, path: worktreePath(repository.path, id) };
}

/**
 * The worktree of the child run `id` of the script `name` on the existing branch `branch` of the repository of `cwd`,
 * at `.worktrees/<repository name>/<id>` next to the repository, as `prepareWorktree` places it. Its `start` is the
 * caller's `start`, the commit that the change on the branch starts from.
 */
export async function checkoutWorktree(
	name: string,
	branch: string,
	start: string,
	id: string,
	cwd: string,
): Promise<Worktree> {
	const repository = await git(cwd, "rev-parse", "--show-toplevel");

	if (!(await hasBranch(repository, branch))) {
		throw new Error(`run ${name}: no branch ${branch}`);
	}

	return { repository, start, branch, path: worktreePath(repository, id) };
}

/** The worktree path of the run `id`: `.worktrees/<repository name>/<id>` next to the repository. */
function worktreePath(repository: string, id: string): string {
	return join(dirname(repository), ".worktrees", basename(repository), id);
}

/**
 * The branch name of the commit subject `subject`: `feat(pi): Show the runs` gives `feat/show-the-runs`. The words
 * after the type keep at most 48 characters, cut at a word end. Empty when the subject has no letter or digit.
 */
export function branchOf(subject: string): string {
	const conventional = /^([a-z]+)(?:\([^)]*\))?!?:(.*)$/i.exec(subject.trim());
	const words = (conventional?.[2] ?? subject).toLowerCase().match(/[a-z0-9]+/g) ?? [];
	let slug = "";

	for (const word of words) {
		const next = slug === "" ? word : `${slug}-${word}`;

		if (next.length > 48 && slug !== "") break;
		slug = next.slice(0, 48);
	}

	if (slug === "") return "";

	return conventional?.[1] === undefined ? slug : `${conventional[1].toLowerCase()}/${slug}`;
}

/**
 * How `renameBranch` ended: the worktree is `on` the branch `branch`, it is on a `detached` HEAD, Git `refused` the
 * name `name`, such as `feat/x` while a branch `feat` exists, or a branch `name` was created during the rename
 * (`raced`).
 */
export type Renamed =
	| { readonly kind: "on"; readonly branch: string }
	| { readonly kind: "detached" }
	| { readonly kind: "refused"; readonly name: string }
	| { readonly kind: "raced"; readonly name: string };

/**
 * Renames the branch `from` of the worktree at `path` to `to`, or to `to-2`, `to-3`... when `to` exists, and gives the
 * branch that the worktree is on. A worktree that is on another branch keeps it, so a repeat after the rename gives
 * the new name. `signal` stops the Git commands, which `git` and `gitSucceeds` cannot do.
 */
export async function renameBranch(path: string, from: string, to: string, signal: AbortSignal): Promise<Renamed> {
	const succeeds = async (...args: string[]) => (await run("git", args, path, signal)).code === 0;
	const exists = (name: string) => succeeds("show-ref", "--verify", "--quiet", `refs/heads/${name}`);
	const current = (await run("git", ["branch", "--show-current"], path, signal)).stdout.trim();

	if (current === "") return { kind: "detached" };

	if (current !== from) return { kind: "on", branch: current };
	let name = to;

	for (let n = 2; await exists(name); n++) name = `${to}-${n}`;

	if (await succeeds("branch", "-m", name)) return { kind: "on", branch: name };

	return (await exists(name)) ? { kind: "raced", name } : { kind: "refused", name };
}

/** A worktree that `repository` lists: its path, and the branch that it has checked out. */
type Registered = { readonly path: string; readonly branch: string | undefined };

/** The worktrees that `repository` lists, from `git worktree list --porcelain`, whose entries blank lines separate. */
async function registered(repository: string): Promise<Registered[]> {
	const list = await git(repository, "worktree", "list", "--porcelain");

	return list.split("\n\n").flatMap((entry) => {
		const lines = entry.split("\n");
		const path = lines.find((line) => line.startsWith("worktree "))?.slice("worktree ".length);
		const branch = lines.find((line) => line.startsWith("branch refs/heads/"))?.slice("branch refs/heads/".length);

		return path === undefined ? [] : [{ path, branch }];
	});
}

/** The realpath of the Git common directory of the repository or worktree at `path`. */
async function commonDir(path: string): Promise<string> {
	return realpath(resolve(path, await git(path, "rev-parse", "--git-common-dir")));
}

/** Whether the reflog of the branch `current` at `path` records its rename from `from`. */
async function renamedFrom(path: string, from: string, current: string): Promise<boolean> {
	const log = await run("git", ["log", "-g", "--format=%gs", `refs/heads/${current}`, "--"], path);

	return (
		log.code === 0 && log.stdout.split("\n").includes(`Branch: renamed refs/heads/${from} to refs/heads/${current}`)
	);
}

/**
 * Checks the worktree of the run `runId`, and does not change it. It gives whether the folder exists. It throws when
 * the folder exists but is not a worktree of the run's repository, when the worktree is on another branch than the
 * run's branch or the name that the run renamed it to, and when the folder and the branch are both missing in a task
 * that is not the `first` task of the run: only the first task makes the branch.
 */
export async function checkWorktree(runId: string, worktree: Worktree, first: boolean): Promise<boolean> {
	const { repository, path, branch, start } = worktree;

	const found = await stat(path).then(
		() => true,
		() => false,
	);

	if (found) {
		const readable =
			(await repositoryAt(path)) !== undefined && (await commonDir(path)) === (await commonDir(repository));

		if (!readable) {
			throw new Error(
				`run ${runId}: ${path} exists, but Git cannot read it as a worktree of ${repository}: move or repair the folder, then resume`,
			);
		}

		const current = await git(path, "branch", "--show-current");

		if (current === branch) return true;

		if (current !== "" && !(await hasBranch(path, branch)) && (await renamedFrom(path, branch, current))) return true;

		throw new Error(
			`run ${runId}: the worktree ${path} is on ${current === "" ? "a detached HEAD" : current}, not on ${branch}: check out ${branch} in it, then resume`,
		);
	}

	if (!first && !(await hasBranch(repository, branch))) {
		throw new Error(
			`run ${runId}: branch ${branch} does not exist, and only the first task of a run makes it from ${start}: restore the branch, then resume`,
		);
	}

	return false;
}

/**
 * The worktree of the run `runId`, after `checkWorktree`. Safe to repeat after an interruption at any point. An
 * existing worktree is kept. When the folder is missing, it removes the stale registration of its path, then adds the
 * worktree on the run's branch, and makes the branch from `start` only in the `first` task of the run. The repository's
 * checkout stays untouched. It throws when another worktree has the branch checked out.
 */
export async function ensureWorktree(runId: string, worktree: Worktree, first: boolean): Promise<void> {
	if (await checkWorktree(runId, worktree, first)) return;
	const { repository, path, branch, start } = worktree;

	for (const entry of await registered(repository)) {
		if (entry.path === path) await git(repository, "worktree", "remove", "--force", path);
		else if (entry.branch === branch) throw new Error(`branch ${branch} is checked out at ${entry.path}`);
	}

	const exists = await hasBranch(repository, branch);
	await git(repository, "worktree", "add", ...(exists ? [path, branch] : ["-b", branch, path, start]));
}
