/**
 * `workflows prune`: removes the worktrees of the ended runs whose branch GitHub merged, and the old run directories
 * that have no task.
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { resolveProject } from "@vzlentin/harness/projects";
import { statePaths } from "@vzlentin/harness/protocol";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { failure, git, gitSucceeds, run as runCommand } from "../../git.ts";
import { removedByHerdr } from "../../herdr.ts";
import { repositoryAt } from "../../launch/worktree.ts";
import { inputWorktree, reading, runTasks } from "../../records/store.ts";
import { hasEnded, type RunTask, runStatus, taskOf } from "../../run/past.ts";
import { withUsage } from "../../workflow/find.ts";
import { runsDirectory, STORE_FILE } from "../host.ts";
import type { Terminal } from "../main.ts";
import { savedBy, unstartedRuns } from "../saved.ts";

export const PRUNE = "workflows prune [--yes] [--install-hook] [--json]";

/** The line of the post-merge hook that `prune --install-hook` writes. */
const HOOK_LINE = "workflows prune --yes >/dev/null 2>&1 &";

/** How old the `project` file of a run directory with no task must be before `prune` removes the directory. */
const UNSTARTED_GRACE_MS = 60 * 60 * 1000;

/** The file of a run directory that names the worktree and branch that `prune --yes` removes, until both are gone. */
const MARKER = "pruning";

/** What a marker holds. */
const MARKED = Type.Object({ branch: Type.String(), repository: Type.String(), path: Type.String() });

/** A run that prune removes: its branch, its repository and the path of its worktree. */
type Prunable = {
	readonly runId: string;
	readonly branch: string;
	readonly repository: string;
	readonly path: string;
};

/**
 * Prints the ended runs of the project of the current directory whose worktree is on a branch that GitHub merged. With
 * `--yes`, it removes their worktrees and branches. It also prints the run directories of the project whose run has no
 * task and whose `project` file is more than an hour old, and `--yes` removes them. With `--install-hook`, it writes a
 * post-merge hook that runs `prune --yes`. It reads the project store only, and runs every `gh` call before it removes
 * anything. A run whose run directory has a marker, which an interrupted `prune --yes` left, is pruned again with no `gh`
 * call. It exits 1 when the removal of a run failed, after it tried the other runs.
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
	const project = await resolveProject(process.env, terminal.cwd);
	const store = join(statePaths(project).dir, STORE_FILE);
	const runs = await reading(store, new Map<string, RunTask[]>(), runTasks);
	const merged: Prunable[] = [];

	for (const [id, tasks] of [...runs].sort(([a], [b]) => b.localeCompare(a))) {
		const marked = await markedRun(id);

		if (marked !== undefined) {
			merged.push(marked);

			continue;
		}

		const found = await prunable(id, tasks);

		if (found !== undefined && (await isMerged(found))) merged.push(found);
	}

	// A run directory gets its task within moments of its `project` file, so a younger one may be a run that starts.
	const stale = (await unstartedRuns(project, runs)).filter(({ since }) => Date.now() - since > UNSTARTED_GRACE_MS);
	const line = ({ runId, branch, path }: Prunable) => `${runId} ${branch} ${path}`;
	const pruned: Prunable[] = [];
	let failed = false;

	for (const found of merged) {
		if (values.yes) {
			try {
				await removeWorktree(found);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				terminal.stderr(`workflows: cannot prune ${found.runId}: ${message}`);
				failed = true;

				continue;
			}
		}

		pruned.push(found);

		if (!json) terminal.stdout(line(found));
	}

	for (const { runId, directory } of stale) {
		if (values.yes) await rm(directory, { recursive: true, force: true });

		if (!json) terminal.stdout(`${runId} unstarted ${directory}`);
	}

	if (json) {
		const worktrees = pruned.map(({ runId, branch, path }) => ({ runId, branch, worktree: path }));
		terminal.stdout(JSON.stringify([...worktrees, ...stale.map(({ runId, directory }) => ({ runId, directory }))]));
	}

	return failed ? 1 : 0;
}

/**
 * The run `id` that the marker of its run directory names, or undefined without a valid marker. A marker that a stop cut
 * while it was written comes before any removal, so the run is a candidate as any other run.
 */
async function markedRun(id: string): Promise<Prunable | undefined> {
	let parsed: unknown;

	try {
		parsed = JSON.parse(await readFile(join(runsDirectory(), id, MARKER), "utf8"));
	} catch {
		return undefined;
	}

	return Value.Check(MARKED, parsed) ? { runId: id, ...parsed } : undefined;
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

	return branch === "" ? undefined : { runId: id, branch, repository: worktree.repository, path: worktree.path };
}

const MERGED = Type.Array(Type.Object({ headRefOid: Type.String() }));

/**
 * Whether GitHub merged a pull request from the branch of `found` at the commit that the branch is on now. A branch name
 * can come back in a later run, so a merged pull request of an earlier commit does not count.
 */
async function isMerged({ branch, path }: Prunable): Promise<boolean> {
	const argv = ["pr", "list", "--head", branch, "--state", "merged", "--json", "headRefOid"];
	const result = await runCommand("gh", argv, path);

	if (result.code !== 0) throw new Error(failure(["gh", ...argv], result));
	const parsed: unknown = JSON.parse(result.stdout);

	if (!Value.Check(MERGED, parsed)) throw new Error(`gh pr list printed no list: ${result.stdout}`);
	const head = await git(path, "rev-parse", "HEAD");

	return parsed.some(({ headRefOid }) => headRefOid === head);
}

/**
 * Removes the worktree of `found`, through herdr when a herdr workspace has it open, and then its branch. It first writes
 * the marker, so a later `prune` finishes the work when this one stops after the worktree removal. A failed worktree
 * removal drops the marker, as the worktree stays and may get more work; a failed branch removal keeps it.
 */
async function removeWorktree(found: Prunable): Promise<void> {
	const { runId, branch, repository, path } = found;
	const marker = join(runsDirectory(), runId, MARKER);
	await writeFile(marker, `${JSON.stringify({ branch, repository, path })}\n`);

	try {
		if ((await repositoryAt(path)) !== undefined && !(await removedByHerdr(path))) {
			await git(repository, "worktree", "remove", path);
		}
	} catch (error) {
		await rm(marker, { force: true });

		throw error;
	}

	if (await gitSucceeds(repository, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`)) {
		await git(repository, "branch", "-D", branch);
	}

	await rm(marker, { force: true });
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
