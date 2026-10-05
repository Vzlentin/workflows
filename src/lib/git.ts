/** Git and GitHub CLI commands, repository selection, and a run's worktree. */
import { execFile } from "node:child_process";
import { realpath, rm, stat } from "node:fs/promises";
import { resolve } from "node:path";

type Result = { readonly code: number; readonly stdout: string; readonly stderr: string };

function run(command: string, args: readonly string[], cwd: string): Promise<Result> {
	return new Promise((done, fail) => {
		execFile(command, args, { cwd, maxBuffer: 256 * 1024 * 1024 }, (error, stdout, stderr) => {
			if (error !== null && typeof error.code !== "number") fail(error);
			else done({ code: error === null ? 0 : (error.code as number), stdout, stderr });
		});
	});
}

/** The trimmed stdout of `git <args>` in `cwd`; throws with the command output when git fails. */
export async function git(cwd: string, ...args: string[]): Promise<string> {
	const result = await run("git", args, cwd);
	if (result.code !== 0) throw new Error(`git ${args[0]} failed: ${result.stdout}${result.stderr}`.trim());
	return result.stdout.replace(/\n$/, "");
}

/** Whether `git <args>` exits 0; any other exit is false. */
export async function gitSucceeds(cwd: string, ...args: string[]): Promise<boolean> {
	return (await run("git", args, cwd)).code === 0;
}

/** The top level of the Git repository at `path` itself, or undefined when `path` is not one. */
async function repositoryAt(path: string): Promise<string | undefined> {
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
 * A worktree at `path` on `branch`, created from `start` when the branch is new. Safe to repeat after an interruption
 * at any point: an existing worktree is kept, and a partial one is replaced. The repository's checkout stays untouched.
 */
export async function ensureWorktree(repository: string, path: string, branch: string, start: string): Promise<void> {
	if ((await repositoryAt(path)) !== undefined) return;
	await rm(path, { recursive: true, force: true });
	await git(repository, "worktree", "prune");
	const exists = await gitSucceeds(repository, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`);
	await git(repository, "worktree", "add", ...(exists ? [path, branch] : ["-b", branch, path, start]));
}
