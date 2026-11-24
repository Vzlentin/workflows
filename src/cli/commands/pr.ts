/**
 * `workflows pr <change>`: opens the pull request of a change on the Git host of its repository, or prints the open
 * one, with no model call.
 */
import { parseArgs } from "node:util";
import { resolveHost } from "@vzlentin/harness/hosts";
import { git } from "../../git.ts";
import {
	branchPullRequest,
	createPullRequest,
	type GitHost,
	isMerged,
	isOpenIssue,
	issueReference,
	push,
	requiredGitHost,
} from "../../githost.ts";
import { mainCheckout, startRef } from "../../launch/worktree.ts";
import { progressEvents, reading, runTasks } from "../../records/store.ts";
import { type ChangeRun, namedChange } from "../../run/change.ts";
import { type RunTask, taskOf } from "../../run/past.ts";
import { title as titleOf } from "../../run/result.ts";
import { current } from "../../run/version.ts";
import { UsageError, withUsage } from "../../workflow/find.ts";
import { storeOf } from "../host.ts";
import type { Terminal } from "../main.ts";

export const PR = "workflows pr <branch>|<run-id>";

/** The branch that every pull request of `pr` merges into. */
const BASE = "main";

/** A commit of the change: its subject and its trimmed body. */
type Commit = { readonly subject: string; readonly body: string };

/**
 * Opens the pull request of the change of `args` into `main` on the Git host of its repository, and prints its URL as
 * the last line. The change is a local branch of the main checkout of the current directory, or the ID of a completed
 * root run of the host of the current directory, whose `change` gives the repository and the branch. A branch with an
 * open pull request is pushed, and the URL of that pull request is printed. It refuses a branch whose newest pull
 * request is merged at its tip, a branch with no commit ahead of `main`, and a branch that `main` already has.
 */
export async function pr(args: readonly string[], terminal: Terminal): Promise<number> {
	const { positionals } = withUsage(
		() => parseArgs({ args: [...args], options: {}, allowPositionals: true, strict: true }),
		PR,
	);

	const [arg, ...rest] = positionals;

	if (arg === undefined || rest.length > 0) throw new UsageError("give one branch or run ID", PR);
	const { cwd } = terminal;
	const path = storeOf(resolveHost(process.env, cwd));
	const roots = await reading(path, new Map<string, readonly RunTask[]>(), ({ store }) => runTasks(store));
	const change = await namedChange(cwd, arg, roots);

	if (change === null) throw new Error(`${arg} is no branch of ${await mainCheckout(cwd)} and no completed run`);
	const { repository, branch, run } = change;
	const host = await requiredGitHost(repository);
	const base = await startRef(repository, BASE, (line) => terminal.stderr(`workflows: ${line}`));
	const found = await branchPullRequest(host, branch);

	if (found?.state === "open") {
		await push(repository, branch);
		terminal.stdout(found.url);

		return 0;
	}

	const tip = await git(repository, "rev-parse", "--verify", `refs/heads/${branch}^{commit}`);

	if (found?.state === "merged" && found.head === tip) throw new Error(`the branch ${branch} is merged: ${found.url}`);
	const [first, ...later] = await commitsOf(repository, base, branch);

	if (first === undefined) throw new Error(`the branch ${branch} has no commit ahead of ${BASE}`);

	if (await isMerged(repository, base, branch)) throw new Error(`the branch ${branch} is merged in ${BASE}`);
	const runTitle = run === null ? undefined : await titleOfRun(path, run.id, roots.get(run.id) ?? []);
	const { title, body } = await describe([first, ...later], run, runTitle, host);

	await push(repository, branch);
	const created = await createPullRequest(host, { branch, base: BASE, title, body });
	terminal.stdout(created.url);

	return 0;
}

/**
 * The title and the body of the pull request of the commits `commits` (at least one, oldest first) of the change that
 * `run` gives, or of a branch for null, where `runTitle` is the title of the run. The title is the subject of the one
 * commit, else the title of the run, else the subject of the first commit. The body is the body of the one commit or
 * the list of the subjects, the judge score of the run, and `Closes #<n>` for the first issue of `host` that the `item`
 * of the run names, when that issue is open.
 */
async function describe(
	commits: readonly [Commit, ...Commit[]],
	run: ChangeRun | null,
	runTitle: string | undefined,
	host: GitHost,
): Promise<{ title: string; body: string }> {
	const [first] = commits;
	const one = commits.length === 1 ? first : undefined;
	const score = run?.result.score;
	const item = run?.item ?? null;
	const issue = item === null ? undefined : issueReference(host, item);

	const body = [
		one?.body ?? commits.map((commit) => `- ${commit.subject}`).join("\n"),
		score === undefined ? "" : `judge ${score.toFixed(2)}`,
		issue !== undefined && (await isOpenIssue(host, issue)) ? `Closes #${issue}` : "",
	]
		.filter((part) => part !== "")
		.join("\n\n");

	return { title: one?.subject ?? runTitle ?? first.subject, body };
}

/**
 * The title of the run `id` with the tasks `tasks` in the host store `path`, as `list` gives it, when this version
 * saved it.
 */
async function titleOfRun(path: string, id: string, tasks: readonly RunTask[]): Promise<string | undefined> {
	const task = taskOf(tasks);

	if (task === undefined || !current(task)) return undefined;
	const { input } = task;

	return reading(path, undefined, async ({ store }) => titleOf(input, await progressEvents(store, id)));
}

/** The commits of `branch` that `base` does not have in `repository`, oldest first. */
async function commitsOf(repository: string, base: string, branch: string): Promise<Commit[]> {
	const log = await git(repository, "log", "--reverse", "--format=%s%x1f%b%x1e", `${base}..refs/heads/${branch}`);

	return log
		.split("\x1e")
		.filter((entry) => entry.trim() !== "")
		.map((entry) => {
			const [subject = "", body = ""] = entry.replace(/^\n/, "").split("\x1f");

			return { subject, body: body.trim() };
		});
}
