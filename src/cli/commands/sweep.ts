/**
 * `workflows sweep`: removes the worktrees of the ended runs whose branch is merged, or the given branches with their
 * worktrees, and the old run directories that have no task.
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { resolveProject } from "@vzlentin/harness/projects";
import { ServesInput } from "@vzlentin/harness/protocol";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { failure, git, gitSucceeds, run as runCommand } from "../../git.ts";
import { SWEEP_MARKER } from "../../launch/input.ts";
import { checkedOutAt, hasBranch, mainCheckout, repositoryAt } from "../../launch/worktree.ts";
import { RunBranches } from "../../records/branch.ts";
import { SWEPT } from "../../records/run.ts";
import { everyRun, inputWorktree, reading, runTasks } from "../../records/store.ts";
import { endedStatus, type RunTask, taskOf } from "../../run/past.ts";
import { type Closed, closeItem, type HarnessArgs, runRequest } from "../../run/serves.ts";
import { withUsage } from "../../workflow/find.ts";
import { runsDirectory, storeOf } from "../host.ts";
import type { Terminal } from "../main.ts";
import { SWEPT_FILE, savedBy, type Unstarted, unstartedRuns } from "../saved.ts";

export const SWEEP = "workflows sweep [<branch>|<run-id>...] [--yes] [--install-hook] [--json]";

/** The line of the post-merge hook that `sweep --install-hook` writes. */
const HOOK_LINE = "workflows sweep --yes >/dev/null 2>&1 &";

/** How old the `project` file of a run directory with no task must be before `sweep` removes the directory. */
const UNSTARTED_GRACE_MS = 60 * 60 * 1000;

/**
 * What a marker holds: a branch, its repository, the path of the worktree that had the branch when there was one, and
 * the word of its sweep.
 */
const MARKED = Type.Object({
	branch: Type.String(),
	repository: Type.String(),
	path: Type.Optional(Type.String()),
	swept: SWEPT,
});

/**
 * A branch that sweep removes, with its worktree when one has it, the IDs of its runs, in task ID order, and the word
 * that it writes to the `swept` file of each run. `subject` names it in an error: the run ID without arguments, else
 * the branch.
 */
type Swept = { readonly subject: string; readonly runIds: readonly string[] } & Readonly<Static<typeof MARKED>>;

/**
 * An entry of `sweep --json` for a run of a removed branch. `item` is the item that the run serves, with its state after
 * the sweep closed it; it is absent when the sweep did not close an item for the run.
 */
const SWEPT_ENTRY = Type.Object(
	{
		runId: Type.Optional(Type.String()),
		swept: SWEPT,
		branch: Type.String(),
		worktree: Type.Optional(Type.String()),
		item: Type.Optional(
			Type.Object(
				{ id: Type.Integer({ minimum: 1 }), state: Type.Union([Type.Literal("done"), Type.Literal("open")]) },
				{ additionalProperties: false },
			),
		),
	},
	{ additionalProperties: false },
);

type Entry = Static<typeof SWEPT_ENTRY>;

/** The item that the sweep closed for a run, with what `closeItem` did. */
type ClosedItem = { readonly id: number } & Closed;

const SERVES = Type.Object({ serves: ServesInput });

/**
 * The output of `sweep --json`: one entry for each run of each removed branch, with its word, or one entry with no run
 * ID for a branch that no run has, then the removed run directories that have no task. `worktree` is absent when no
 * worktree had the branch. Without `--yes`, the entries are what `--yes` would remove.
 */
export const SWEPT_RUNS = Type.Array(
	Type.Union([
		SWEPT_ENTRY,
		Type.Object({ runId: Type.String(), directory: Type.String() }, { additionalProperties: false }),
	]),
);

/**
 * Prints the ended runs of the project of the current directory whose worktree is on a merged branch: its tip is in
 * the local `main` or in `origin/main`, or GitHub merged a pull request at its tip; a failed `gh` call prints a line to
 * stderr and counts the branch as not merged. With `--yes`, it removes their worktrees and branches, and writes
 * `landed` to the `swept` file of each run. It also prints the run directories of the project whose run has no task and
 * whose `project` file is more than an hour old, and `--yes` removes them. With arguments, it takes only the branches
 * that they give in the main checkout of the current directory: a run ID gives the branch of the run, another argument
 * is a branch. Each branch gets the worktree that has it, when one has, and the runs that have it; a merged one gets
 * `landed` and another one `dropped`, and each of its runs gets the word. It checks every argument before it removes
 * anything. With `--yes`, before it removes a `landed` branch, it closes each item that a run of the branch serves, as
 * `land` does, at the tip of the branch, through the host of the project, which it never starts; a failed close prints
 * a line to stderr and does not stop the sweep. With `--install-hook`, it writes a post-merge hook that runs `sweep
 * --yes`. It reads the project store and asks the host only for these closes, and runs every `gh` call before it
 * removes anything. A branch with a marker, which an interrupted `sweep --yes` left in a run directory, is swept again
 * with the word of the marker and no merge check when its runs have ended. Without arguments, it refuses to run
 * without a project store. It keeps an old run directory with a Git clone that has commits on no remote, and skips a
 * branch whose run started a task again before its removal. It exits 1 when a
 * removal failed, after it tried the other branches.
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
	const warn = (line: string) => terminal.stderr(`workflows: ${line}`);

	const { taken, stale } =
		positionals.length > 0
			? { taken: await givenBranches(positionals, store, terminal.cwd, warn), stale: [] }
			: await mergedSweep(project, store, warn);

	const removed: { found: Swept; closed: ReadonlyMap<string, ClosedItem> }[] = [];
	let failed = false;

	for (const found of taken) {
		let closed: ReadonlyMap<string, ClosedItem> = new Map();

		if (values.yes) {
			// A run can have started a new task since the first read, such as during a `gh` call.
			const now = await reading(store, new Map<string, RunTask[]>(), (opened) => everyRun(opened.store));
			const running = found.runIds.find((id) => endedTask(now.get(id) ?? []) === undefined);

			if (running !== undefined) {
				terminal.stderr(
					`workflows: skips ${running}: its run has a task that has not ended; sweep it after the run ends`,
				);

				continue;
			}

			closed = await closeItems(project, found, now, terminal);

			try {
				await removeWorktree(found);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				terminal.stderr(`workflows: cannot sweep ${found.subject}: ${message}`);
				failed = true;

				continue;
			}
		}

		removed.push({ found, closed });

		if (!json) for (const entry of entries(found, closed)) terminal.stdout(line(entry, closed));
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
		const shown: Static<typeof SWEPT_RUNS> = [
			...removed.flatMap(({ found, closed }) => entries(found, closed)),
			...unstartedShown,
		];

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
 * The output entries of `found`: one for each of its runs, or one with no run ID when it has no run. A run of `closed`
 * gets its item.
 */
function entries({ runIds, swept, branch, path }: Swept, closed: ReadonlyMap<string, ClosedItem>): Entry[] {
	const worktree = path === undefined ? {} : { worktree: path };

	if (runIds.length === 0) return [{ swept, branch, ...worktree }];

	return runIds.map((runId) => {
		const item = closed.get(runId);

		return item === undefined
			? { runId, swept, branch, ...worktree }
			: { runId, swept, branch, ...worktree, item: { id: item.id, state: item.state } };
	});
}

/**
 * The text line of an entry of `entries`, with `-` for a run ID or a worktree that it does not have, and the line of the
 * item that `closed` has for its run at the end.
 */
function line(entry: Entry, closed: ReadonlyMap<string, ClosedItem>): string {
	const item = entry.runId === undefined ? undefined : closed.get(entry.runId);
	const shown = `${entry.runId ?? "-"} ${entry.swept} ${entry.branch} ${entry.worktree ?? "-"}`;

	return item === undefined ? shown : `${shown} ${item.line}`;
}

/**
 * Closes, as `land` does, each item that the runs of `found` serve, as their tasks in `runs` give it, when `found` is
 * `landed` and its branch still exists: once for each item, at the tip of the branch, in the name of the first run in
 * task ID order that serves it. It sends the requests to the host of `project` and never starts one. A failed close
 * prints a line to the stderr of `terminal`. Returns the closed items by the run that closed them.
 */
async function closeItems(
	project: string,
	found: Swept,
	runs: ReadonlyMap<string, readonly RunTask[]>,
	terminal: Terminal,
): Promise<Map<string, ClosedItem>> {
	const closed = new Map<string, ClosedItem>();

	// A branch that is gone was removed by an earlier sweep, which closed its items.
	if (found.swept !== "landed" || !(await hasBranch(found.repository, found.branch))) return closed;
	const head = await git(found.repository, "rev-parse", `refs/heads/${found.branch}`);
	const done = new Set<number>();

	for (const runId of found.runIds) {
		const input = endedTask(runs.get(runId) ?? [])?.input;

		if (!Value.Check(SERVES, input) || !("item" in input.serves) || done.has(input.serves.item)) continue;
		const id = input.serves.item;
		done.add(id);

		try {
			const send = (sent: HarnessArgs) => runRequest(project, runId, sent);
			closed.set(runId, { id, ...(await closeItem(send, id, head)) });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			terminal.stderr(`workflows: cannot close item ${id} of ${runId}: ${message}`);
		}
	}

	return closed;
}

/**
 * The ended runs of the project store `store` of the project `project` that `mergedRuns` takes, and its run directories
 * with no task whose `project` file is older than the grace. It throws when the store does not exist.
 */
async function mergedSweep(
	project: string,
	store: string,
	warn: (line: string) => void,
): Promise<{ taken: Swept[]; stale: Unstarted[] }> {
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

	const taken = await mergedRuns(ended, warn);
	// A run directory gets its task within moments of its `project` file, so a younger one may be a run that starts.
	const unstarted = await unstartedRuns(project, runs);

	return { taken, stale: unstarted.filter(({ since }) => Date.now() - since > UNSTARTED_GRACE_MS) };
}

/**
 * The runs of `ended`, newest first, that have a marker, with its word, or that are sweepable on a merged branch, with
 * `landed`.
 */
async function mergedRuns(ended: ReadonlyMap<string, RunTask>, warn: (line: string) => void): Promise<Swept[]> {
	const merged: Swept[] = [];

	for (const [id, task] of [...ended].sort(([a], [b]) => b.localeCompare(a))) {
		const found = await candidate(id, task, warn);

		if (found !== undefined) merged.push(found);
	}

	return merged;
}

/**
 * The run `id`, whose task `task` has ended, with the word of its marker when it has one. Otherwise it is the run with
 * `landed` when it is sweepable and its branch is merged, else undefined.
 */
async function candidate(id: string, task: RunTask, warn: (line: string) => void): Promise<Swept | undefined> {
	const marked = await marker(id);

	if (marked !== undefined) return { subject: id, runIds: [id], ...marked };
	const found = await sweepable(id, task);

	if (found === undefined || !(await isMerged(found.branch, found.path, warn))) return undefined;

	return { subject: id, runIds: [id], ...found, swept: "landed" };
}

/**
 * The branches of the arguments `args`, in their order and each once, with the runs of each branch in the main checkout
 * of `cwd`, as the project store `store` has them; a branch needs no store. An argument is a run ID of that repository,
 * which gives the branch of the run, or a branch. A branch is `landed` when it is merged, else `dropped`, or has the
 * word of a marker in a run directory of its runs. It throws for the first argument that it cannot sweep, before
 * anything is removed.
 */
async function givenBranches(
	args: readonly string[],
	store: string,
	cwd: string,
	warn: (line: string) => void,
): Promise<Swept[]> {
	const runs = await reading(store, new Map<string, RunTask[]>(), (opened) => everyRun(opened.store));
	const repository = await mainCheckout(cwd);
	const branches = new RunBranches(runs);
	const found: Swept[] = [];

	for (const arg of args) {
		const branch = await branchOfArgument(arg, branches, repository);

		if (found.some((taken) => taken.branch === branch)) continue;
		const runIds = await unsweptRuns(branches, repository, branch);
		const running = runIds.find((id) => endedTask(runs.get(id) ?? []) === undefined);

		if (running !== undefined) {
			throw new Error(
				`cannot sweep ${arg}: the run ${running} on ${branch} has not ended, or a later version saved it`,
			);
		}

		found.push(await givenBranch(arg, branch, runIds, repository, warn));
	}

	return found;
}

/**
 * The branch of the argument `arg` in the main checkout `repository`: the branch of the run `arg` when it is a run of
 * that repository and no sweep has swept it, else `arg` when it is a branch there or the branch of one of its runs that
 * no sweep has swept.
 */
async function branchOfArgument(arg: string, branches: RunBranches, repository: string): Promise<string> {
	if (branches.has(arg)) {
		const change = await branches.changeOf(arg);

		if (change === undefined) throw new Error(`cannot sweep ${arg}: the run has no branch`);

		if (change.repository === repository) {
			if (wasSwept(arg)) throw new Error(`cannot sweep ${arg}: an earlier sweep swept its branch ${change.branch}`);

			return change.branch;
		}
	} else if ((await hasBranch(repository, arg)) || (await unsweptRuns(branches, repository, arg)).length > 0) {
		return arg;
	}

	throw new Error(`cannot sweep ${arg}: no run of this repository and no branch of that name`);
}

/**
 * The runs of `branches` on `branch` in the main checkout `repository`, less the runs that a sweep has swept: a run
 * with a `swept` file and no marker lost its branch, so a later branch of that name is not its branch.
 */
async function unsweptRuns(branches: RunBranches, repository: string, branch: string): Promise<string[]> {
	return (await branches.runsOf(repository, branch)).filter((id) => !wasSwept(id));
}

/**
 * Whether a sweep has swept the run `id`: its run directory has a `swept` file and no marker. A run that still has a
 * marker is not swept, so an interrupted sweep can finish.
 */
function wasSwept(id: string): boolean {
	const directory = join(runsDirectory(), id);

	return existsSync(join(directory, SWEPT_FILE)) && !existsSync(join(directory, SWEEP_MARKER));
}

/**
 * The branch `branch` of the argument `arg` in the main checkout `repository`, whose ended runs are `runIds`, with the
 * runs that have a run directory. A marker on the branch in one of these gives the word and the worktree path. Otherwise
 * the worktree is the one that has the branch checked out, and the word comes from the merge test.
 */
async function givenBranch(
	arg: string,
	branch: string,
	runIds: readonly string[],
	repository: string,
	warn: (line: string) => void,
): Promise<Swept> {
	const kept = runIds.filter((id) => existsSync(join(runsDirectory(), id)));

	for (const id of kept) {
		const marked = await marker(id);

		if (marked?.branch === branch) return { subject: branch, runIds: kept, ...marked };
	}

	const path = await checkedOutAt(repository, branch);

	if (path === undefined && !(await hasBranch(repository, branch))) {
		throw new Error(`cannot sweep ${arg}: no worktree and no branch ${branch}`);
	}

	const swept = (await isMerged(branch, path ?? repository, warn)) ? "landed" : "dropped";

	const found: Swept = { subject: branch, runIds: kept, branch, repository, swept };

	return path === undefined ? found : { ...found, path };
}

/**
 * The marker of the run directory of the run `id`, or undefined without a valid marker. A marker that a stop cut
 * while it was written comes before any removal, so the run is a candidate as any other run.
 */
async function marker(id: string): Promise<Static<typeof MARKED> | undefined> {
	let parsed: unknown;

	try {
		parsed = JSON.parse(await readFile(join(runsDirectory(), id, SWEEP_MARKER), "utf8"));
	} catch {
		return undefined;
	}

	return Value.Check(MARKED, parsed) ? parsed : undefined;
}

/**
 * The branch, the repository and the worktree path of the root run `id`, whose task `task` has ended, when it has a run
 * directory and its worktree is on a branch.
 */
async function sweepable(
	id: string,
	task: RunTask,
): Promise<{ branch: string; repository: string; path: string } | undefined> {
	if (!existsSync(join(runsDirectory(), id, "project"))) return undefined;
	const worktree = inputWorktree(task.input);

	if (worktree === undefined || (await repositoryAt(worktree.path)) === undefined) return undefined;
	const branch = await git(worktree.path, "branch", "--show-current");

	return branch === "" ? undefined : { branch, repository: worktree.repository, path: worktree.path };
}

const MERGED = Type.Array(Type.Object({ headRefOid: Type.String() }));

/**
 * Whether the branch `branch` is merged, as Git and `gh` see it in `cwd`: the commit that it is on now is in the local
 * `main`, or in `origin/main`, or GitHub merged a pull request from the branch at that commit. It calls `gh` only when
 * Git finds the commit in neither `main` and the repository has an `origin`. When `gh` fails, the branch counts as not
 * merged and `warn` gets one line with the reason. A branch name can come back in a later run, so a merged pull request
 * of an earlier commit does not count.
 */
async function isMerged(branch: string, cwd: string, warn: (line: string) => void): Promise<boolean> {
	const ref = `refs/heads/${branch}`;

	if (await gitSucceeds(cwd, "merge-base", "--is-ancestor", ref, "refs/heads/main")) return true;

	if (await gitSucceeds(cwd, "merge-base", "--is-ancestor", ref, "origin/main")) return true;

	if (!(await gitSucceeds(cwd, "remote", "get-url", "origin"))) return false;
	const head = await git(cwd, "rev-parse", ref);
	let merged: Static<typeof MERGED>;

	try {
		merged = await mergedPullRequests(branch, cwd);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		warn(`cannot ask gh whether ${branch} is merged, so it counts as not merged: ${message}`);

		return false;
	}

	return merged.some(({ headRefOid }) => headRefOid === head);
}

/**
 * The merged pull requests from `branch` that `gh pr list` prints in `path`. It throws when `gh` is missing, fails or
 * prints no list.
 */
async function mergedPullRequests(branch: string, path: string): Promise<Static<typeof MERGED>> {
	const argv = ["pr", "list", "--head", branch, "--state", "merged", "--json", "headRefOid"];
	const result = await runCommand("gh", argv, path);

	if (result.code !== 0) throw new Error(failure(["gh", ...argv], result));
	const parsed: unknown = JSON.parse(result.stdout);

	if (!Value.Check(MERGED, parsed)) throw new Error(`gh pr list printed no list: ${result.stdout}`);

	return parsed;
}

/**
 * Removes the worktree of `found` when one has its branch, then the branch, and writes its word to the `swept` file of
 * each of its runs. It first writes the marker, with the word, in the run directory of each run, so a later `sweep`
 * finishes the work when this one stops after the worktree removal. A failed worktree removal drops the markers and
 * writes no word, as the worktree stays and may get more work; a failed branch removal keeps the markers.
 */
async function removeWorktree(found: Swept): Promise<void> {
	const { runIds, branch, repository, path, swept } = found;
	const directories = runIds.map((id) => join(runsDirectory(), id));
	const markers = directories.map((directory) => join(directory, SWEEP_MARKER));

	const marked: Static<typeof MARKED> =
		path === undefined ? { branch, repository, swept } : { branch, repository, path, swept };

	const dropMarkers = () => Promise.all(markers.map((file) => rm(file, { force: true })));

	for (const file of markers) await writeFile(file, `${JSON.stringify(marked)}\n`);

	try {
		if (path !== undefined && (await repositoryAt(path)) !== undefined) {
			await git(repository, "worktree", "remove", path);
		}
	} catch (error) {
		await dropMarkers();

		throw error;
	}

	if (await hasBranch(repository, branch)) {
		await git(repository, "branch", "-D", branch);
	}

	for (const directory of directories) await writeFile(join(directory, SWEPT_FILE), `${swept}\n`);
	await dropMarkers();
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
