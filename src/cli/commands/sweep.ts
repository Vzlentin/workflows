/**
 * `workflows sweep`: removes the worktrees of the ended runs whose branch is merged, or of the given runs, and the old
 * run directories that have no task.
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { resolveProject } from "@vzlentin/harness/projects";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { failure, git, gitSucceeds, run as runCommand } from "../../git.ts";
import { SWEEP_MARKER } from "../../launch/input.ts";
import { hasBranch, repositoryAt } from "../../launch/worktree.ts";
import { SWEPT } from "../../records/run.ts";
import { inputWorktree, reading, runTasks } from "../../records/store.ts";
import { endedStatus, type RunTask, taskOf } from "../../run/past.ts";
import { withUsage } from "../../workflow/find.ts";
import { runsDirectory, storeOf } from "../host.ts";
import type { Terminal } from "../main.ts";
import { SWEPT_FILE, savedBy, tasksOf, unstartedRuns } from "../saved.ts";

export const SWEEP = "workflows sweep [<run-id>...] [--yes] [--install-hook] [--json]";

/** The line of the post-merge hook that `sweep --install-hook` writes. */
const HOOK_LINE = "workflows sweep --yes >/dev/null 2>&1 &";

/** How old the `project` file of a run directory with no task must be before `sweep` removes the directory. */
const UNSTARTED_GRACE_MS = 60 * 60 * 1000;

/** What a marker holds: the branch, the repository and the worktree path of a run, and the word of its sweep. */
const MARKED = Type.Object({ branch: Type.String(), repository: Type.String(), path: Type.String(), swept: SWEPT });

/** A run that sweep removes, with the word that it writes to the `swept` file of the run. */
type Swept = { readonly runId: string } & Readonly<Static<typeof MARKED>>;

/** A run with a worktree on a branch: its branch, its repository and the path of its worktree. */
type Sweepable = Omit<Swept, "swept">;

/**
 * The output of `sweep --json`: the removed worktrees, each with its word, then the removed run directories that have
 * no task. Without `--yes`, the entries are what `--yes` would remove.
 */
export const SWEPT_RUNS = Type.Array(
	Type.Union([
		Type.Object(
			{ runId: Type.String(), swept: SWEPT, branch: Type.String(), worktree: Type.String() },
			{ additionalProperties: false },
		),
		Type.Object({ runId: Type.String(), directory: Type.String() }, { additionalProperties: false }),
	]),
);

/**
 * Prints the ended runs of the project of the current directory whose worktree is on a merged branch: its HEAD is in
 * `origin/main`, or GitHub merged a pull request at its HEAD. With `--yes`, it removes their worktrees and branches,
 * and writes `landed` to the `swept` file of each run. It also prints the run directories of the project whose run has
 * no task and whose `project` file is more than an hour old, and `--yes` removes them. With run IDs, it takes only
 * these runs, and each one must be an ended run of the project with a worktree on a branch; a merged one gets `landed`
 * and another one `dropped`. With `--install-hook`, it writes a post-merge hook that runs `sweep --yes`. It reads the
 * project store only, and runs every `gh` call before it removes anything. A run whose run directory has a marker,
 * which an interrupted `sweep --yes` left, is swept again with the word of the marker and no merge check when it has
 * ended. It refuses to run without a project store, keeps an old run directory with a Git clone that has commits on no
 * remote, and skips a run whose task started again before its removal. It exits 1 when the removal of a run failed,
 * after it tried the other runs.
 */
export async function sweep(args: readonly string[], terminal: Terminal, json: boolean): Promise<number> {
	const { values, positionals } = withUsage(
		() =>
			parseArgs({
				args: [...args],
				options: { yes: { type: "boolean" }, "install-hook": { type: "boolean" } },
				allowPositionals: true,
				strict: true,
			}),
		SWEEP,
	);

	if (values["install-hook"]) return installHook(terminal);
	const project = resolveProject(process.env, terminal.cwd);
	const store = storeOf(project);
	const runs = await reading(store, undefined, (opened) => runTasks(opened.store));

	if (runs === undefined) {
		throw new Error(
			`cannot sweep: the project store ${store} does not exist, so no run directory counts as unstarted; remove the run directories that you do not need from ${runsDirectory()} by hand`,
		);
	}

	const ended = new Map<string, RunTask>();

	for (const [id, tasks] of runs) {
		const task = endedTask(tasks);

		if (task !== undefined) ended.set(id, task);
	}

	const given = positionals.length > 0;
	const taken = given ? await givenRuns(positionals, ended) : await mergedRuns(ended);

	// A run directory gets its task within moments of its `project` file, so a younger one may be a run that starts.
	const unstarted = given ? [] : await unstartedRuns(project, runs);
	const stale = unstarted.filter(({ since }) => Date.now() - since > UNSTARTED_GRACE_MS);
	const line = ({ runId, swept, branch, path }: Swept) => `${runId} ${swept} ${branch} ${path}`;
	const removed: Swept[] = [];
	let failed = false;

	for (const found of taken) {
		if (values.yes) {
			// The run can have started a new task since the first read, such as during a `gh` call.
			if (endedTask(await tasksOf({ id: found.runId, project, store })) === undefined) {
				terminal.stderr(
					`workflows: skips ${found.runId}: its run has a task that has not ended; sweep it after the run ends`,
				);

				continue;
			}

			try {
				await removeWorktree(found);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				terminal.stderr(`workflows: cannot sweep ${found.runId}: ${message}`);
				failed = true;

				continue;
			}
		}

		removed.push(found);

		if (!json) terminal.stdout(line(found));
	}

	const unstartedShown: { runId: string; directory: string }[] = [];

	for (const { runId, directory } of stale) {
		if (await hasUnpushed(directory)) {
			terminal.stderr(
				`workflows: keeps ${directory}: it holds a Git clone with commits that are on no remote, or one that Git cannot read; push them, or remove the directory by hand`,
			);

			continue;
		}

		if (values.yes) await rm(directory, { recursive: true, force: true });
		unstartedShown.push({ runId, directory });

		if (!json) terminal.stdout(`${runId} unstarted ${directory}`);
	}

	if (json) {
		const worktrees = removed.map(({ runId, swept, branch, path }) => ({ runId, swept, branch, worktree: path }));
		const shown: Static<typeof SWEPT_RUNS> = [...worktrees, ...unstartedShown];
		terminal.stdout(JSON.stringify(shown));
	}

	return failed ? 1 : 0;
}

/**
 * Whether the run directory `directory` holds a Git clone, in `repository/`, with a commit that no remote branch
 * reaches, on a local branch or at the HEAD of one of its worktrees, or a clone that Git cannot read. A directory with
 * neither `repository/` nor `.worktrees/` holds no clone.
 */
async function hasUnpushed(directory: string): Promise<boolean> {
	const clone = join(directory, "repository");

	if (!existsSync(clone) && !existsSync(join(directory, ".worktrees"))) return false;

	try {
		const listed = await git(clone, "worktree", "list", "--porcelain");

		const heads = listed
			.split("\n")
			.filter((entry) => entry.startsWith("HEAD "))
			.map((entry) => entry.slice("HEAD ".length));

		return (await git(clone, "rev-list", "-n", "1", "--branches", ...heads, "--not", "--remotes")) !== "";
	} catch {
		return true;
	}
}

/** The last task of `tasks` when it has ended and a task of this version or of an earlier version saved it. */
function endedTask(tasks: readonly RunTask[]): RunTask | undefined {
	const task = taskOf(tasks);

	return task !== undefined && endedStatus(task) !== undefined && !savedBy(task).later ? task : undefined;
}

/**
 * The runs of `ended`, newest first, that have a marker, with its word, or that are sweepable on a merged branch, with
 * `landed`.
 */
async function mergedRuns(ended: ReadonlyMap<string, RunTask>): Promise<Swept[]> {
	const merged: Swept[] = [];

	for (const [id, task] of [...ended].sort(([a], [b]) => b.localeCompare(a))) {
		const found = await candidate(id, task, undefined);

		if (found !== undefined) merged.push(found);
	}

	return merged;
}

/**
 * The runs `ids`, in their order, each a root run of `ended` with a marker, with its word, or sweepable, with `landed`
 * when it is merged and `dropped` when it is not. It throws for the first ID that is neither, before anything is
 * removed.
 */
async function givenRuns(ids: readonly string[], ended: ReadonlyMap<string, RunTask>): Promise<Swept[]> {
	const found: Swept[] = [];

	for (const id of new Set(ids)) {
		const run = await candidate(id, ended.get(id), "dropped");

		if (run === undefined) {
			throw new Error(`cannot sweep ${id}: not an ended run of this project with a worktree on a branch`);
		}

		found.push(run);
	}

	return found;
}

/**
 * The run `id`, whose ended task is `task`, with the word of its marker when it has one. Otherwise it is the sweepable
 * run with `landed` when its branch is merged and `unmerged` when it is not, or undefined when it is not sweepable or
 * `unmerged` is undefined. A task of undefined gives undefined and reads no file, so an ID that is a path reads none.
 */
async function candidate(
	id: string,
	task: RunTask | undefined,
	unmerged: Static<typeof SWEPT> | undefined,
): Promise<Swept | undefined> {
	if (task === undefined) return undefined;
	const marked = await markedRun(id);

	if (marked !== undefined) return marked;
	const found = await sweepable(id, task);

	if (found === undefined) return undefined;
	const swept = (await isMerged(found)) ? "landed" : unmerged;

	return swept === undefined ? undefined : { ...found, swept };
}

/**
 * The run `id` that the marker of its run directory names, or undefined without a valid marker. A marker that a stop cut
 * while it was written comes before any removal, so the run is a candidate as any other run.
 */
async function markedRun(id: string): Promise<Swept | undefined> {
	let parsed: unknown;

	try {
		parsed = JSON.parse(await readFile(join(runsDirectory(), id, SWEEP_MARKER), "utf8"));
	} catch {
		return undefined;
	}

	return Value.Check(MARKED, parsed) ? { runId: id, ...parsed } : undefined;
}

/** The run `id`, whose task `task` has ended, when it has a run directory and a worktree on a branch. */
async function sweepable(id: string, task: RunTask): Promise<Sweepable | undefined> {
	if (!existsSync(join(runsDirectory(), id, "project"))) return undefined;
	const worktree = inputWorktree(task.input);

	if (worktree === undefined || (await repositoryAt(worktree.path)) === undefined) return undefined;
	const branch = await git(worktree.path, "branch", "--show-current");

	return branch === "" ? undefined : { runId: id, branch, repository: worktree.repository, path: worktree.path };
}

const MERGED = Type.Array(Type.Object({ headRefOid: Type.String() }));

/**
 * Whether the branch of `found` is merged: the commit that it is on now is in `origin/main`, or GitHub merged a pull
 * request from the branch at that commit. It calls `gh` only when the commit is not in `origin/main`. A branch name can
 * come back in a later run, so a merged pull request of an earlier commit does not count.
 */
async function isMerged({ branch, path }: Sweepable): Promise<boolean> {
	if (await gitSucceeds(path, "merge-base", "--is-ancestor", "HEAD", "origin/main")) return true;
	const argv = ["pr", "list", "--head", branch, "--state", "merged", "--json", "headRefOid"];
	const result = await runCommand("gh", argv, path);

	if (result.code !== 0) throw new Error(failure(["gh", ...argv], result));
	const parsed: unknown = JSON.parse(result.stdout);

	if (!Value.Check(MERGED, parsed)) throw new Error(`gh pr list printed no list: ${result.stdout}`);
	const head = await git(path, "rev-parse", "HEAD");

	return parsed.some(({ headRefOid }) => headRefOid === head);
}

/**
 * Removes the worktree of `found`, then its branch, and writes its word to the `swept` file of the run. It first writes
 * the marker, with the word, so a later `sweep` finishes the work when this one stops after the worktree removal. A
 * failed worktree removal drops the marker and writes no word, as the worktree stays and may get more work; a failed
 * branch removal keeps the marker.
 */
async function removeWorktree(found: Swept): Promise<void> {
	const { runId, branch, repository, path, swept } = found;
	const directory = join(runsDirectory(), runId);
	const marker = join(directory, SWEEP_MARKER);
	await writeFile(marker, `${JSON.stringify({ branch, repository, path, swept })}\n`);

	try {
		if ((await repositoryAt(path)) !== undefined) await git(repository, "worktree", "remove", path);
	} catch (error) {
		await rm(marker, { force: true });

		throw error;
	}

	if (await hasBranch(repository, branch)) {
		await git(repository, "branch", "-D", branch);
	}

	await writeFile(join(directory, SWEPT_FILE), `${swept}\n`);
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
