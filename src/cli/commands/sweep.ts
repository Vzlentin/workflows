/**
 * `workflows sweep`: removes the worktrees of the ended runs whose branch is merged or has no commit of the run, or the
 * given branches with their worktrees, and the old run directories that have no task. It reports the commit of each
 * merge to the host, also for the merged runs that `list --json` sweeps.
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { Client } from "@vzlentin/harness/client";
import { resolveHost } from "@vzlentin/harness/hosts";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { git, gitSucceeds } from "../../git.ts";
import { branchPullRequest, gitHostOf, isMerged } from "../../githost.ts";
import { hostFile, SWEEP_MARKER } from "../../launch/input.ts";
import { checkedOutAt, hasBranch, mainCheckout, repositoryAt } from "../../launch/worktree.ts";
import { RunBranches } from "../../records/branch.ts";
import { SWEPT } from "../../records/run.ts";
import { everyRun, inputWorktree, reading, runTasks } from "../../records/store.ts";
import { askerOf } from "../../run/asks.ts";
import { endedStatus, type RunTask, taskKey, taskOf } from "../../run/past.ts";
import { withUsage } from "../../workflow/find.ts";
import type { Merge } from "../changes.ts";
import { connectTo, runsDirectory, storeOf } from "../host.ts";
import type { Terminal } from "../main.ts";
import { SWEPT_FILE, savedBy, type Unstarted, unstartedRuns } from "../saved.ts";

export const SWEEP = "workflows sweep [<branch>|<run-id>...] [--yes] [--install-hook] [--json]";

/** The line of the post-merge hook that `sweep --install-hook` writes. */
const HOOK_LINE = "workflows sweep --yes >/dev/null 2>&1 &";

/** How old the host file of a run directory with no task must be before `sweep` removes the directory. */
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

/** The word of a branch, and the commit of its merge when the word is `landed` and Git or the Git host gave one. */
type Word = { readonly swept: "dropped" } | { readonly swept: "landed"; readonly commit: string };

/**
 * A branch that sweep removes, with its worktree when one has it, the IDs of its runs, in task ID order, and the word
 * that it writes to the `swept` file of each run: the word of its marker, with no commit, or the word of its merge
 * check, with the commit that it reports for the runs when it is `landed`. `subject` names it in an error: the run ID
 * without arguments, else the branch.
 */
type Swept = {
	readonly subject: string;
	readonly runIds: readonly string[];
	readonly branch: string;
	readonly repository: string;
	readonly path?: string;
} & ({ readonly marked: true; readonly swept: Static<typeof SWEPT> } | ({ readonly marked: false } & Word));

/** The commit that landed the branch `branch`, with its tip `tip`, in `cwd`, or undefined when it is not landed. */
type Landed = (branch: string, tip: string, cwd: string) => Promise<string | undefined>;

/**
 * The reports of one command: the first report connects to the host, which it starts when none runs, and `close`
 * ends that connection.
 */
export type Reports = {
	readonly report: (runIds: readonly string[], commit: string) => Promise<void>;
	readonly close: () => void;
};

/** An entry of `sweep --json` for a run of a removed branch. */
const SWEPT_ENTRY = Type.Object(
	{
		runId: Type.Optional(Type.String()),
		swept: SWEPT,
		branch: Type.String(),
		worktree: Type.Optional(Type.String()),
	},
	{ additionalProperties: false },
);

type Entry = Static<typeof SWEPT_ENTRY>;

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
 * Prints the ended runs of the host of the current directory whose worktree is on a merged branch: the Git host merged
 * a pull request at its tip, its tip is in `origin/main` or in the local `main`, or one of them has its changes; the
 * first failed Git host call prints a line to stderr, lets Git alone check the branch, and stops the Git host calls. A
 * branch whose tip is the saved start of every one of its runs has no commit of the runs: it is not merged and gets
 * `dropped`, and the sweep without arguments takes it too. With `--yes`, it removes their worktrees and branches, and
 * writes the word to the `swept` file of each run. It also prints the run directories of the host whose run has no task
 * and whose host file is more than an hour old, and `--yes` removes them. With arguments, it takes only the branches
 * that they give: a run ID gives the branch of the run in the repository that the run recorded, from any directory of
 * the host, and another argument is a branch of the main checkout of the current directory. Each branch gets the
 * worktree that has it, when one has, and the runs that have it; a merged one gets `landed` and another one `dropped`,
 * and each of its runs gets the word. It checks every argument before it removes anything. With `--install-hook`, it
 * writes a post-merge hook that runs `sweep --yes`. It reads the host store, and makes every Git host call before it
 * removes anything. With `--yes`, before it removes a `landed` branch, it reports the commit of the merge for each root
 * run of the branch: the merge commit of its pull request, the tip, or the commit of the base that has its changes. The
 * first report connects to the host and starts it when none runs, and a failed report keeps the branch. A branch with a
 * marker, which an interrupted `sweep --yes` left in a run directory, is swept again with the word of the marker and no
 * merge check when its runs have ended. Without arguments, it refuses to run without a host store. It keeps an old run
 * directory with a Git clone that has commits on no remote, and skips a branch whose run started a task again before
 * its removal. It exits 1 when a report or a removal failed, after it tried the other branches.
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
	const host = resolveHost(process.env, terminal.cwd);
	const store = storeOf(host);
	const asking: Asking = { warn: (line: string) => terminal.stderr(`workflows: ${line}`), failed: false };
	const landed: Landed = (branch, tip, cwd) => landedCommit(branch, tip, cwd, asking);

	const { taken, stale } =
		positionals.length > 0
			? { taken: await givenBranches(positionals, store, terminal.cwd, landed), stale: [] }
			: await mergedSweep(host, store, landed);

	const removed: Swept[] = [];
	let failed = false;
	const reports = reportsTo(terminal, host);

	try {
		for (const found of taken) {
			if (values.yes) {
				let running: string | undefined;

				try {
					running = await sweepFound(found, store, reports);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					terminal.stderr(`workflows: cannot sweep ${found.subject}: ${message}`);
					failed = true;

					continue;
				}

				if (running !== undefined) {
					terminal.stderr(
						`workflows: skips ${running}: its run has a task that has not ended; sweep it after the run ends`,
					);

					continue;
				}
			}

			removed.push(found);

			if (!json) for (const entry of entries(found)) terminal.stdout(line(entry));
		}
	} finally {
		reports.close();
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
		const shown: Static<typeof SWEPT_RUNS> = [...removed.flatMap((found) => entries(found)), ...unstartedShown];

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

/** The output entries of `found`: one for each of its runs, or one with no run ID when it has no run. */
function entries({ runIds, swept, branch, path }: Swept): Entry[] {
	const worktree = path === undefined ? {} : { worktree: path };

	if (runIds.length === 0) return [{ swept, branch, ...worktree }];

	return runIds.map((runId) => ({ runId, swept, branch, ...worktree }));
}

/** The text line of an entry of `entries`, with `-` for a run ID or a worktree that it does not have. */
function line(entry: Entry): string {
	return `${entry.runId ?? "-"} ${entry.swept} ${entry.branch} ${entry.worktree ?? "-"}`;
}

/**
 * The warnings of one sweep, and whether a Git host call of the sweep failed: after a failure, the sweep asks no Git
 * host again, so a missing login gives one warning and not one per branch.
 */
type Asking = { readonly warn: (line: string) => void; failed: boolean };

/**
 * The word of the branch `branch` in `cwd`, whose runs saved the worktree starts `starts`: `dropped` when its runs made no
 * commit on it, that is `starts` is not empty and each start is the tip of the branch, else `landed` with the commit of
 * `landed` when the branch is landed, else undefined. A run with no saved start counts as a run with a commit.
 */
async function mergeWord(
	branch: string,
	cwd: string,
	starts: readonly (string | undefined)[],
	landed: Landed,
): Promise<Word | undefined> {
	const head = await git(cwd, "rev-parse", `refs/heads/${branch}`);

	if (starts.length > 0 && starts.every((start) => start === head)) return { swept: "dropped" };
	const commit = await landed(branch, head, cwd);

	return commit === undefined ? undefined : { swept: "landed", commit };
}

/**
 * The ended runs of the host store `store` of the host `host` that `mergedRuns` takes, and its run directories
 * with no task whose host file is older than the grace. It throws when the store does not exist.
 */
async function mergedSweep(
	host: string,
	store: string,
	landed: Landed,
): Promise<{ taken: Swept[]; stale: Unstarted[] }> {
	const runs = await reading(store, undefined, (opened) => runTasks(opened.store));

	if (runs === undefined) {
		throw new Error(
			`cannot sweep: the host store ${store} does not exist, so no run directory counts as unstarted; remove the run directories that you do not need from ${runsDirectory()} by hand`,
		);
	}

	const ended = new Map<string, RunTask>();

	for (const [id, tasks] of runs) {
		const task = endedTask(tasks);

		if (task !== undefined) ended.set(id, task);
	}

	const taken = await mergedRuns(ended, landed);
	// A run directory gets its task within moments of its host file, so a younger one may be a run that starts.
	const unstarted = await unstartedRuns(host, runs);

	return { taken, stale: unstarted.filter(({ since }) => Date.now() - since > UNSTARTED_GRACE_MS) };
}

/**
 * The runs of `ended`, newest first, that have a marker, with its word, or that are sweepable and get a word from
 * `mergeWord`: `dropped` on a branch with no commit of the run, `landed` on a merged branch.
 */
async function mergedRuns(ended: ReadonlyMap<string, RunTask>, landed: Landed): Promise<Swept[]> {
	const merged: Swept[] = [];

	for (const [id, task] of [...ended].sort(([a], [b]) => b.localeCompare(a))) {
		const found = await candidate(id, task, landed);

		if (found !== undefined) merged.push(found);
	}

	return merged;
}

/**
 * The run `id`, whose task `task` has ended, with the word of its marker when it has one. Otherwise, when it is
 * sweepable, it is the run with the word of `mergeWord` for its branch, its saved start and `landed`, else undefined.
 */
async function candidate(id: string, task: RunTask, landed: Landed): Promise<Swept | undefined> {
	const marked = await marker(id);

	if (marked !== undefined) return { subject: id, runIds: [id], marked: true, ...marked };
	const found = await sweepable(id, task);

	if (found === undefined) return undefined;

	const word = await mergeWord(found.branch, found.path, [inputWorktree(task.input)?.start], landed);

	return word === undefined ? undefined : { subject: id, runIds: [id], marked: false, ...found, ...word };
}

/**
 * The branches of the arguments `args`, in their order and each once per repository, with the runs of each branch, as
 * the host store `store` has them; a branch needs no store. An argument is a run ID, which gives the branch of the run
 * in the repository that the run recorded, or a branch of the main checkout of `cwd`. Only a branch argument reads the
 * main checkout of `cwd`. A branch has the word of a marker in a run directory of its runs. Otherwise it is `dropped`
 * when its runs made no commit on it, that is it has runs and each saved start of them is its tip, else `landed` when
 * it is merged, else `dropped`. It throws for the first argument that it cannot sweep, before anything is removed.
 */
async function givenBranches(args: readonly string[], store: string, cwd: string, landed: Landed): Promise<Swept[]> {
	const runs = await reading(store, new Map<string, RunTask[]>(), (opened) => everyRun(opened.store));
	const branches = new RunBranches(runs);
	const found: Swept[] = [];

	for (const arg of args) {
		const { repository, branch } = await branchOfArgument(arg, branches, cwd);

		if (found.some((taken) => taken.repository === repository && taken.branch === branch)) continue;
		const runIds = await unsweptRuns(branches, repository, branch);
		const running = runIds.find((id) => endedTask(runs.get(id) ?? []) === undefined);

		if (running !== undefined) {
			throw new Error(
				`cannot sweep ${arg}: the run ${running} on ${branch} has not ended, or a later version saved it`,
			);
		}

		found.push(await givenBranch(arg, branch, runIds, runs, repository, landed));
	}

	return found;
}

/**
 * The repository and the branch of the argument `arg`: the recorded repository and branch of the run `arg` when no
 * sweep has swept it, else `arg` as a branch of the main checkout of `cwd`, when it is a branch
 * there or the branch of one of its runs that no sweep has swept.
 */
async function branchOfArgument(
	arg: string,
	branches: RunBranches,
	cwd: string,
): Promise<{ readonly repository: string; readonly branch: string }> {
	if (branches.has(arg)) {
		const change = await branches.changeOf(arg);

		if (change === undefined) throw new Error(`cannot sweep ${arg}: the run has no branch`);

		if (wasSwept(arg)) throw new Error(`cannot sweep ${arg}: an earlier sweep swept its branch ${change.branch}`);

		return { repository: change.repository, branch: change.branch };
	}

	const repository = await mainCheckout(cwd);

	if ((await hasBranch(repository, arg)) || (await unsweptRuns(branches, repository, arg)).length > 0) {
		return { repository, branch: arg };
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
 * runs that have a run directory, whose tasks are in `runs`. A marker on the branch in one of these gives the word and
 * the worktree path. Otherwise the worktree is the one that has the branch checked out, and the word is the word of
 * `mergeWord` for the saved starts of these runs, else `dropped`.
 */
async function givenBranch(
	arg: string,
	branch: string,
	runIds: readonly string[],
	runs: ReadonlyMap<string, readonly RunTask[]>,
	repository: string,
	landed: Landed,
): Promise<Swept> {
	const kept = runIds.filter((id) => existsSync(join(runsDirectory(), id)));

	for (const id of kept) {
		const marked = await marker(id);

		if (marked?.branch === branch) return { subject: branch, runIds: kept, marked: true, ...marked };
	}

	const path = await checkedOutAt(repository, branch);

	if (path === undefined && !(await hasBranch(repository, branch))) {
		throw new Error(`cannot sweep ${arg}: no worktree and no branch ${branch}`);
	}

	const starts = kept.map((id) => {
		const task = taskOf(runs.get(id) ?? []);

		return task === undefined ? undefined : inputWorktree(task.input)?.start;
	});

	const word = (await mergeWord(branch, path ?? repository, starts, landed)) ?? { swept: "dropped" };

	const found: Swept = { subject: branch, runIds: kept, marked: false, branch, repository, ...word };

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
	if (!existsSync(hostFile(join(runsDirectory(), id)))) return undefined;
	const worktree = inputWorktree(task.input);

	if (worktree === undefined || (await repositoryAt(worktree.path)) === undefined) return undefined;
	const branch = await git(worktree.path, "branch", "--show-current");

	return branch === "" ? undefined : { branch, repository: worktree.repository, path: worktree.path };
}

/**
 * The commit that landed the branch `branch`, with its tip `tip`, as the Git host and Git see it in `cwd`, or undefined
 * when it is not landed: the merge commit of the newest pull request of the branch when it is merged with that tip as
 * its head, else the tip when it is in `origin/main` or in the local `main`, else the commit of the first of them that
 * already has its changes, as after a merge by squash or rebase. It makes no Git host call for an origin on no Git
 * host. The first failure of a Git host call gives `asking.warn` one line with the reason, and Git alone decides; the
 * sweep then asks no Git host again. A branch name can come back in a later run, so a merged pull request of an
 * earlier commit does not count.
 */
async function landedCommit(branch: string, tip: string, cwd: string, asking: Asking): Promise<string | undefined> {
	const merged = await hostMergeCommit(branch, tip, cwd, asking);

	if (merged !== undefined) return merged;
	const ref = `refs/heads/${branch}`;
	const bases = ["refs/remotes/origin/main", "refs/heads/main"];

	for (const base of bases) if (await gitSucceeds(cwd, "merge-base", "--is-ancestor", ref, base)) return tip;

	for (const base of bases) {
		if (
			(await gitSucceeds(cwd, "rev-parse", "--verify", "--quiet", `${base}^{commit}`)) &&
			(await isMerged(cwd, base, ref))
		) {
			return git(cwd, "rev-parse", base);
		}
	}

	return undefined;
}

/**
 * The merge commit of the newest pull request of the branch `branch` on the Git host of the origin of `cwd`, when it is
 * merged with the tip `tip` as its head, else undefined. After a failed Git host call of the sweep, it asks nothing.
 */
async function hostMergeCommit(branch: string, tip: string, cwd: string, asking: Asking): Promise<string | undefined> {
	if (asking.failed) return undefined;

	try {
		const host = await gitHostOf(cwd);

		if (host === null) return undefined;
		const pull = await branchPullRequest(host, branch);

		return pull?.state === "merged" && pull.head === tip ? pull.mergeCommit : undefined;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		asking.failed = true;
		asking.warn(`cannot ask the Git host whether ${branch} is merged, so only Git checks it: ${message}`);

		return undefined;
	}
}

/**
 * The reports of the commits of swept runs to the host `host`. Each report goes for the task of the first `start` key
 * of a run, with the run as its caller, so the labels of the run get the commit. The first one connects through
 * `terminal`, and starts the host when none runs.
 */
export function reportsTo(terminal: Terminal, host: string): Reports {
	let client: Client | undefined;

	return {
		report: async (runIds, commit) => {
			client ??= await connectTo(terminal, host, true);

			for (const id of runIds) {
				await client.request({ type: "report", key: taskKey(id, 1), refs: [`commit:${commit}`], caller: askerOf(id) });
			}
		},
		close: () => client?.close(),
	};
}

/**
 * Sweeps `found` as `sweep --yes` does, through the host store `store`, or gives the ID of one of its runs whose task
 * has not ended, as a run can have started a new task since the first read, such as during a Git host call. It reads
 * the store again, reports the commit of `found` through `reports` for each of its root runs, when it has one, since
 * only a root run has the task key of a report, then removes its worktree and branch. It throws when the report or the
 * removal fails; a failed report removes nothing, so a later sweep tries again.
 */
async function sweepFound(found: Swept, store: string, reports: Reports): Promise<string | undefined> {
	const now = await reading(
		store,
		{ runs: new Map<string, RunTask[]>(), roots: new Set<string>() },
		async (opened) => ({
			runs: await everyRun(opened.store),
			roots: new Set((await runTasks(opened.store)).keys()),
		}),
	);

	const running = found.runIds.find((id) => endedTask(now.runs.get(id) ?? []) === undefined);

	if (running !== undefined) return running;
	const roots = found.runIds.filter((id) => now.roots.has(id));

	if (!found.marked && found.swept === "landed" && roots.length > 0) await reports.report(roots, found.commit);
	await removeWorktree(found);

	return undefined;
}

/**
 * Sweeps the run `id` of the host store `store` as `sweep <id> --yes` does, when the Git host merged its branch with
 * `merge`, and gives the word of the sweep, or undefined when it swept nothing. It takes only a run whose task has
 * ended. A run with a marker is swept with the word of the marker, which can be `dropped`. Else it sweeps the run as
 * `landed`, with the merge commit as the commit to report, only when the branch of the run is the branch of `merge`,
 * the head of the merge is its tip, and the run made a commit on it. It throws when the report or the removal fails.
 */
export async function sweepMerged(
	id: string,
	merge: Merge,
	store: string,
	reports: Reports,
): Promise<Static<typeof SWEPT> | undefined> {
	const tasks = await reading(store, undefined, async (opened) => (await runTasks(opened.store)).get(id));
	const task = endedTask(tasks ?? []);

	if (task === undefined) return undefined;

	const found = await candidate(id, task, async (branch, tip) =>
		branch === merge.branch && merge.head === tip ? merge.commit : undefined,
	);

	if (found === undefined || (!found.marked && found.swept !== "landed")) return undefined;

	return (await sweepFound(found, store, reports)) === undefined ? found.swept : undefined;
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
