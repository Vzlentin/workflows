/** The repository and worktree of a run: repository selection, the run's worktree and the name of its branch. */
import { realpath, rm, stat } from "node:fs/promises";
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

	if (await gitSucceeds(repository.path, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`)) {
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

	if (!(await gitSucceeds(repository, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`))) {
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
 * Renames the branch `from` of the worktree at `path` to `to`, or to `to-2`, `to-3`... when `to` exists, and returns
 * the branch that the worktree is on. A worktree that is not on `from` keeps its branch, so a repeat after the rename
 * returns the new name. Undefined when Git refuses the name, such as `feat/x` while a branch `feat` exists. `signal`
 * stops the Git commands, which `git` and `gitSucceeds` cannot do.
 */
export async function renameBranch(
	path: string,
	from: string,
	to: string,
	signal: AbortSignal,
): Promise<string | undefined> {
	const succeeds = async (...args: string[]) => (await run("git", args, path, signal)).code === 0;
	const current = (await run("git", ["branch", "--show-current"], path, signal)).stdout.trim();

	if (current !== from) return current;
	let name = to;

	for (let n = 2; await succeeds("show-ref", "--verify", "--quiet", `refs/heads/${name}`); n++) name = `${to}-${n}`;

	return (await succeeds("branch", "-m", name)) ? name : undefined;
}

/** Removes the folder at `path` and the registrations of worktrees whose folder is gone. */
async function clearWorktree(repository: string, path: string): Promise<void> {
	await rm(path, { recursive: true, force: true });
	await git(repository, "worktree", "prune");
}

/** What makes a worktree before Git does, such as Herdr: `make` gives an ID, such as a workspace, and `close` closes it. */
export type WorktreeMaker = {
	readonly make: () => Promise<string | undefined>;
	readonly close: (id: string) => Promise<void>;
};

/** The path of the worktree of `repository` that has `branch` checked out, or undefined when none has it. */
async function checkedOutAt(repository: string, branch: string): Promise<string | undefined> {
	let path: string | undefined;

	for (const line of (await git(repository, "worktree", "list", "--porcelain")).split("\n")) {
		if (line.startsWith("worktree ")) path = line.slice("worktree ".length);
		else if (line === `branch refs/heads/${branch}`) return path;
	}

	return undefined;
}

/**
 * A worktree at `path` on `branch`, created from `start` when the branch is new. Safe to repeat after an interruption
 * at any point: an existing worktree is kept, and each attempt starts from a clean path, with no folder and no stale
 * registration. The repository's checkout stays untouched. It throws when another worktree has `branch` checked out.
 * `maker` makes the worktree first when it is given; when it left no repository at `path`, `maker.close` closes what it
 * opened, and Git makes the worktree. It gives the ID of `maker` when its worktree is used, else undefined.
 */
export async function ensureWorktree(
	repository: string,
	path: string,
	branch: string,
	start: string,
	maker?: WorktreeMaker,
): Promise<string | undefined> {
	if ((await repositoryAt(path)) !== undefined) return undefined;
	await clearWorktree(repository, path);
	const holder = await checkedOutAt(repository, branch);

	if (holder !== undefined) throw new Error(`branch ${branch} is checked out at ${holder}`);

	if (maker !== undefined) {
		const made = await maker.make();

		if ((await repositoryAt(path)) !== undefined) return made;

		if (made !== undefined) await maker.close(made);
		await clearWorktree(repository, path);
	}

	const exists = await gitSucceeds(repository, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`);
	await git(repository, "worktree", "add", ...(exists ? [path, branch] : ["-b", branch, path, start]));

	return undefined;
}
