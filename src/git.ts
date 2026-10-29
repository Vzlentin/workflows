/** Git and GitHub CLI commands, repository selection, and a run's worktree. */
import { execFile } from "node:child_process";
import { realpath, rm, stat } from "node:fs/promises";
import { resolve } from "node:path";

export type Result = { readonly code: number; readonly stdout: string; readonly stderr: string };

/** The exit code and output of `command <args>` in `cwd`, with no shell. */
export function run(command: string, args: readonly string[], cwd: string, signal?: AbortSignal): Promise<Result> {
	return new Promise((done, fail) => {
		execFile(command, args, { cwd, signal, maxBuffer: 1 << 30 }, (error, stdout, stderr) => {
			// A string code, such as ENOENT, means that the command did not run.
			if (error === null) done({ code: 0, stdout, stderr });
			else if (Number.isInteger(error.code)) done({ code: Number(error.code), stdout, stderr });
			else fail(error);
		});
	});
}

/** The error text of the failed command `argv`: its first two words and its output. */
export function failure(argv: readonly string[], result: Result): string {
	return `${argv.slice(0, 2).join(" ")} failed: ${result.stdout}${result.stderr}`.trim();
}

/** The trimmed stdout of `git <args>` in `cwd`; throws with the command output when git fails. */
export async function git(cwd: string, ...args: string[]): Promise<string> {
	const result = await run("git", args, cwd);

	if (result.code !== 0) throw new Error(failure(["git", ...args], result));

	return result.stdout.replace(/\n$/, "");
}

/** Whether `git <args>` exits 0; any other exit is false. */
export async function gitSucceeds(cwd: string, ...args: string[]): Promise<boolean> {
	return (await run("git", args, cwd)).code === 0;
}

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

/**
 * A worktree at `path` on `branch`, created from `start` when the branch is new. Safe to repeat after an interruption
 * at any point: an existing worktree is kept, and a partial one is replaced. The repository's checkout stays untouched.
 * `create` makes the worktree first when it is given, and gives an ID, such as a workspace; Git makes it when `create`
 * left no repository at `path`. It gives the ID of `create` when its worktree is used, else undefined.
 */
export async function ensureWorktree(
	repository: string,
	path: string,
	branch: string,
	start: string,
	create?: () => Promise<string | undefined>,
): Promise<string | undefined> {
	if ((await repositoryAt(path)) !== undefined) return undefined;
	await rm(path, { recursive: true, force: true });
	await git(repository, "worktree", "prune");
	const created = await create?.();

	if ((await repositoryAt(path)) !== undefined) return created;
	const exists = await gitSucceeds(repository, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`);
	await git(repository, "worktree", "add", ...(exists ? [path, branch] : ["-b", branch, path, start]));

	return undefined;
}
