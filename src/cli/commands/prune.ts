/** `workflows prune`: removes the worktrees of the ended runs whose branch GitHub merged. */
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { resolveProject } from "@vzlentin/harness/projects";
import { statePaths } from "@vzlentin/harness/protocol";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { failure, git, gitSucceeds, run as runCommand } from "../../git.ts";
import { removedByHerdr } from "../../herdr.ts";
import { repositoryAt, type Worktree } from "../../launch/worktree.ts";
import { inputWorktree, reading, runTasks } from "../../records/store.ts";
import { hasEnded, type RunTask, runStatus, taskOf } from "../../run/past.ts";
import { withUsage } from "../../workflow/find.ts";
import { runsDirectory, STORE_FILE } from "../host.ts";
import type { Terminal } from "../main.ts";
import { savedBy } from "../saved.ts";

export const PRUNE = "workflows prune [--yes] [--install-hook] [--json]";

/** The line of the post-merge hook that `prune --install-hook` writes. */
const HOOK_LINE = "workflows prune --yes >/dev/null 2>&1 &";

type Prunable = { readonly runId: string; readonly branch: string; readonly worktree: Worktree };

/**
 * Prints the ended runs of the project of the current directory whose worktree is on a branch that GitHub merged. With
 * `--yes`, it removes their worktrees and branches. With `--install-hook`, it writes a post-merge hook that runs
 * `prune --yes`. It reads the project store only, and runs every `gh` call before it removes anything.
 */
export async function prune(args: readonly string[], terminal: Terminal, json: boolean): Promise<number> {
	const { values } = withUsage(
		() =>
			parseArgs({
				args: [...args],
				options: { yes: { type: "boolean" }, "install-hook": { type: "boolean" } },
				strict: true,
			}),
		PRUNE,
	);

	if (values["install-hook"]) return installHook(terminal);
	const store = join(statePaths(await resolveProject(process.env, terminal.cwd)).dir, STORE_FILE);
	const runs = await reading(store, new Map<string, RunTask[]>(), runTasks);
	const merged: Prunable[] = [];

	for (const [id, tasks] of [...runs].sort(([a], [b]) => b.localeCompare(a))) {
		const found = await prunable(id, tasks);

		if (found !== undefined && (await isMerged(found))) merged.push(found);
	}

	const line = ({ runId, branch, worktree }: Prunable) => `${runId} ${branch} ${worktree.path}`;

	for (const found of merged) {
		if (values.yes) await removeWorktree(found);

		if (!json) terminal.stdout(line(found));
	}

	if (json)
		terminal.stdout(
			JSON.stringify(merged.map(({ runId, branch, worktree }) => ({ runId, branch, worktree: worktree.path }))),
		);

	return 0;
}

/**
 * The run `id` with `tasks` when it has a run directory, has ended, was saved by this or an earlier version, and has a
 * worktree on a branch.
 */
async function prunable(id: string, tasks: readonly RunTask[]): Promise<Prunable | undefined> {
	if (!existsSync(join(runsDirectory(), id, "project"))) return undefined;

	const task = taskOf(tasks);

	if (task === undefined || !hasEnded(runStatus(task)) || savedBy(task).later) return undefined;
	const worktree = inputWorktree(task.input);

	if (worktree === undefined || (await repositoryAt(worktree.path)) === undefined) return undefined;
	const branch = await git(worktree.path, "branch", "--show-current");

	return branch === "" ? undefined : { runId: id, branch, worktree };
}

const MERGED = Type.Array(Type.Object({ headRefOid: Type.String() }));

/**
 * Whether GitHub merged a pull request from the branch of `found` at the commit that the branch is on now. A branch name
 * can come back in a later run, so a merged pull request of an earlier commit does not count.
 */
async function isMerged({ branch, worktree }: Prunable): Promise<boolean> {
	const argv = ["pr", "list", "--head", branch, "--state", "merged", "--json", "headRefOid"];
	const result = await runCommand("gh", argv, worktree.path);

	if (result.code !== 0) throw new Error(failure(["gh", ...argv], result));
	const parsed: unknown = JSON.parse(result.stdout);

	if (!Value.Check(MERGED, parsed)) throw new Error(`gh pr list printed no list: ${result.stdout}`);
	const head = await git(worktree.path, "rev-parse", "HEAD");

	return parsed.some(({ headRefOid }) => headRefOid === head);
}

/** Removes the worktree of `found`, through herdr when a herdr workspace has it open, and then its branch. */
async function removeWorktree({ branch, worktree }: Prunable): Promise<void> {
	if (!(await removedByHerdr(worktree))) await git(worktree.repository, "worktree", "remove", worktree.path);

	if (await gitSucceeds(worktree.repository, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`)) {
		await git(worktree.repository, "branch", "-D", branch);
	}
}

/** Writes the post-merge hook of the repository of the current directory, unless a hook or a hooks path is set. */
async function installHook(terminal: Terminal): Promise<number> {
	const hooks = resolve(terminal.cwd, await git(terminal.cwd, "rev-parse", "--git-path", "hooks"));
	const add = `add this line to it: ${HOOK_LINE}`;

	if (await gitSucceeds(terminal.cwd, "config", "--get", "core.hooksPath")) {
		throw new Error(`core.hooksPath sets the hooks of this repository; ${add}`);
	}

	const file = join(hooks, "post-merge");

	if (existsSync(file)) throw new Error(`${file} exists; ${add}`);
	await mkdir(hooks, { recursive: true });
	await writeFile(file, `#!/bin/sh\n${HOOK_LINE}\n`, { mode: 0o755 });
	terminal.stdout(file);

	return 0;
}
