/**
 * The Git host of a repository, from the URL of its `origin`: its pull requests (on GitLab, merge requests), its CI
 * runs and its issues, through a GitHub back end (`gh`) and a GitLab back end (`glab`), and the clone of a GitHub
 * repository. It is the only module that runs `gh` or `glab`. The `gitHost` calls of a script and `sweep` use it. Next
 * to it, the checks that need only Git: a conflict of a branch with its base, a branch that its base already has, and
 * the push of a branch.
 */
import { setTimeout as sleep } from "node:timers/promises";
import { type Static, type TSchema, Type } from "typebox";
import { Value } from "typebox/value";
import { failure, git, type Result, run } from "./git.ts";

/** The time between two reads of the CI runs of a commit. */
const CI_POLL_MS = 15_000;

/** The most time that one command of the tool of a Git host takes before it fails. */
const TIMEOUT_MS = 60_000;

/** The kind of a Git host, which names its tool: `gh` for `github`, `glab` for `gitlab`. */
export type GitHostKind = "github" | "gitlab";

/** The Git host of the repository `cwd`: its kind, its host name, and the path of the repository on it. */
export type GitHost = {
	readonly kind: GitHostKind;
	readonly name: string;
	readonly path: string;
	readonly cwd: string;
};

/** The state of the check of a pull request: no check, a check that runs, or a check that passed or failed. */
export type Check = "none" | "running" | "passed" | "failed";

/**
 * A pull request: the kind of its Git host, its number, its URL, its title and body, its head branch, the base branch
 * that it merges into, its head commit (null when the Git host no longer knows it), whether it comes from another
 * repository, the ref of its head on `origin`, its check, whether a review asks for changes, and its state. Only a
 * merged pull request has a merge commit: the commit that the Git host reports for the merge.
 */
export type PullRequest = {
	readonly kind: GitHostKind;
	readonly number: number;
	readonly url: string;
	readonly title: string;
	readonly body: string;
	readonly branch: string;
	readonly base: string;
	readonly head: string | null;
	readonly fork: boolean;
	readonly ref: string;
	readonly check: Check;
	readonly changesRequested: boolean;
} & ({ readonly state: "open" | "closed" } | { readonly state: "merged"; readonly mergeCommit: string });

/** What `createPullRequest` needs: the branch, the base branch that it merges into, a title and a body. */
export type NewPullRequest = {
	readonly branch: string;
	readonly base: string;
	readonly title: string;
	readonly body: string;
};

/** A CI run of a commit: its name, its URL, and its state. */
export type CiRun = { readonly name: string; readonly url: string; readonly state: Exclude<Check, "none"> };

/** What a Git host does through its tool. Each function runs after the check of the login. */
type Backend = {
	/** The arguments that make the tool print its token for the host `name`. */
	readonly login: (name: string) => readonly string[];
	readonly create: (host: GitHost, pull: NewPullRequest, signal: AbortSignal | undefined) => Promise<PullRequest>;
	readonly byNumber: (host: GitHost, number: number, signal: AbortSignal | undefined) => Promise<PullRequest>;
	readonly byBranch: (host: GitHost, branch: string, signal: AbortSignal | undefined) => Promise<PullRequest | null>;
	readonly merge: (host: GitHost, number: number, signal: AbortSignal | undefined) => Promise<void>;
	readonly issue: (host: GitHost, number: number, signal: AbortSignal | undefined) => Promise<boolean>;
	readonly ci: (host: GitHost, commit: string, branch: string, signal: AbortSignal | undefined) => Promise<CiRun[]>;
};

const TOOL = { github: "gh", gitlab: "glab" } as const satisfies Record<GitHostKind, string>;

const GITHUB: Backend = {
	login: (name) => ["auth", "token", "--hostname", name],
	create: githubCreate,
	byNumber: githubPullRequest,
	byBranch: githubBranch,
	merge: githubMerge,
	issue: (host, number, signal) =>
		openIssue(host, ["issue", "view", String(number), "--repo", repositoryOf(host), "--json", "state"], "OPEN", signal),
	ci: githubCi,
};

const GITLAB: Backend = {
	login: (name) => ["config", "get", "token", "--host", name],
	create: gitlabCreate,
	byNumber: gitlabPullRequest,
	byBranch: gitlabBranch,
	merge: gitlabMerge,
	issue: (host, number, signal) => openIssue(host, api(host, `issues/${number}`), "opened", signal),
	ci: gitlabCi,
};

const BACKENDS: Readonly<Record<GitHostKind, Backend>> = { github: GITHUB, gitlab: GITLAB };

/** The Git hosts that their name gives, with no question to a tool. */
const KNOWN = new Map<string, GitHostKind>([
	["github.com", "github"],
	["gitlab.com", "gitlab"],
]);

/**
 * The host name and the repository path of the remote URL `url`, or null for a local path or a `file://` URL. It reads
 * `git@<host>:<path>` and `<scheme>://[<user>@]<host>[:<port>]/<path>`, without a `.git` end.
 */
export function remoteOf(url: string): { readonly name: string; readonly path: string } | null {
	const match =
		/^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]+@)?(?<name>[^:/]+)(?::\d*)?\/(?<path>.+)$/i.exec(url) ??
		/^(?:[^@/]+@)?(?<name>[^:/]+):(?!\/)(?<path>.+)$/.exec(url);

	const { name, path } = match?.groups ?? {};

	if (name === undefined || path === undefined || url.startsWith("file:")) return null;
	const trimmed = path.replace(/\/+$/, "").replace(/\.git$/, "");

	return trimmed === "" ? null : { name: name.toLowerCase(), path: trimmed };
}

/**
 * The Git host of the repository `cwd`, from the URL of its `origin`: `github.com` and `gitlab.com` by name, another
 * host when `gh` or `glab` has a login for it, in that order. Null when the repository has no `origin`, when the URL is
 * a local path, and when no tool knows the host.
 */
export async function gitHostOf(cwd: string, signal?: AbortSignal): Promise<GitHost | null> {
	const origin = await run("git", ["remote", "get-url", "origin"], cwd, signal);
	const remote = origin.code === 0 ? remoteOf(origin.stdout.trim()) : null;

	if (remote === null) return null;
	const known = KNOWN.get(remote.name);

	if (known !== undefined) return { kind: known, ...remote, cwd };

	for (const kind of ["github", "gitlab"] as const) {
		const host = { kind, ...remote, cwd };

		if ((await login(host, signal)) === "in") return host;
	}

	return null;
}

/** Whether the tool of `host` is logged in to it, or is missing. */
async function login(host: GitHost, signal: AbortSignal | undefined): Promise<"in" | "out" | "missing"> {
	let result: Result;

	try {
		result = await bounded(host, BACKENDS[host.kind].login(host.name), signal);
	} catch (error) {
		// ENOENT: the tool is not on `PATH`.
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return "missing";

		throw error;
	}

	return result.code === 0 && result.stdout.trim() !== "" ? "in" : "out";
}

/**
 * The back end of `host`, after a check that its tool is there and logged in to the host. A missing tool and a tool
 * with no login fail with one line that names the tool and the repository.
 */
async function backendOf(host: GitHost, signal: AbortSignal | undefined): Promise<Backend> {
	const tool = TOOL[host.kind];

	switch (await login(host, signal)) {
		case "missing":
			throw new Error(`${tool} is not installed, so workflows cannot reach ${repositoryOf(host)}`);
		case "out":
			throw new Error(`${tool} is not logged in to ${host.name}, so workflows cannot reach ${repositoryOf(host)}`);
		case "in":
			return BACKENDS[host.kind];
	}
}

/** `<host name>/<path>`, which names the repository in an error. */
function repositoryOf(host: GitHost): string {
	return `${host.name}/${host.path}`;
}

/** The result of the tool of `host` with `args`, which fails when it runs more than `TIMEOUT_MS`. */
async function bounded(host: GitHost, args: readonly string[], signal: AbortSignal | undefined): Promise<Result> {
	const timeout = AbortSignal.timeout(TIMEOUT_MS);
	const tool = TOOL[host.kind];

	try {
		return await run(tool, args, host.cwd, signal === undefined ? timeout : AbortSignal.any([timeout, signal]));
	} catch (error) {
		if (timeout.aborted && signal?.aborted !== true) {
			throw new Error(
				`${tool} ${args.slice(0, 2).join(" ")} took more than ${TIMEOUT_MS / 1000} s for ${repositoryOf(host)}`,
			);
		}

		throw error;
	}
}

/** The stdout of the tool of `host` with `args`; it throws with the output when the tool fails. */
async function output(host: GitHost, args: readonly string[], signal: AbortSignal | undefined): Promise<string> {
	const result = await bounded(host, args, signal);

	if (result.code !== 0) throw new Error(failure([TOOL[host.kind], ...args], result));

	return result.stdout;
}

/** The JSON that the tool of `host` prints for `args`, which must match `schema`. */
async function json<T extends TSchema>(
	host: GitHost,
	args: readonly string[],
	schema: T,
	signal: AbortSignal | undefined,
): Promise<Static<T>> {
	return parse(host, args, schema, await output(host, args, signal));
}

/** The JSON `text` that the tool of `host` printed for `args`, which must match `schema`. */
function parse<T extends TSchema>(host: GitHost, args: readonly string[], schema: T, text: string): Static<T> {
	let parsed: unknown;

	try {
		parsed = JSON.parse(text);
	} catch {
		parsed = undefined;
	}

	if (!Value.Check(schema, parsed)) {
		throw new Error(`${TOOL[host.kind]} ${args.slice(0, 2).join(" ")} printed an unexpected answer: ${text.trim()}`);
	}

	return parsed;
}

/** Creates the pull request of `pull.branch` into `pull.base` on `host`, and returns its state. */
export async function createPullRequest(
	host: GitHost,
	pull: NewPullRequest,
	signal?: AbortSignal,
): Promise<PullRequest> {
	return (await backendOf(host, signal)).create(host, pull, signal);
}

/** The pull request `number` of `host`. */
export async function pullRequestOf(host: GitHost, number: number, signal?: AbortSignal): Promise<PullRequest> {
	return (await backendOf(host, signal)).byNumber(host, number, signal);
}

/** The newest pull request of the branch `branch` on `host`, or null when the branch has none. */
export async function branchPullRequest(
	host: GitHost,
	branch: string,
	signal?: AbortSignal,
): Promise<PullRequest | null> {
	return (await backendOf(host, signal)).byBranch(host, branch, signal);
}

/**
 * Merges the pull request `number` of `host` now, with the merge method of the repository: on GitHub the first allowed
 * of rebase, merge commit and squash, on GitLab the method of the project. `pullRequestOf` gives the merge commit.
 */
export async function mergePullRequest(host: GitHost, number: number, signal?: AbortSignal): Promise<void> {
	await (await backendOf(host, signal)).merge(host, number, signal);
}

/** Whether `#<number>` is an open issue of `host`. An issue that the host does not have is not open. */
export async function isOpenIssue(host: GitHost, number: number, signal?: AbortSignal): Promise<boolean> {
	return (await backendOf(host, signal)).issue(host, number, signal);
}

/**
 * The CI runs of `commit` on `branch` of `host`. It reads them every 15 s until the list is not empty and no run is
 * running, or until `wait` seconds have passed, and returns the last list.
 */
export async function ciRuns(
	host: GitHost,
	commit: string,
	branch: string,
	wait: number,
	signal?: AbortSignal,
): Promise<CiRun[]> {
	const backend = await backendOf(host, signal);
	const end = Date.now() + wait * 1000;

	for (;;) {
		const runs = await backend.ci(host, commit, branch, signal);
		const left = end - Date.now();

		if ((runs.length > 0 && runs.every((run) => run.state !== "running")) || left <= 0) return runs;
		await sleep(Math.min(left, CI_POLL_MS), undefined, { signal });
	}
}

/**
 * Clones the GitHub repository `repo` (`owner/name`, or a name of the user) into `dir`, from `cwd`, with `gh repo
 * clone`. It has no time limit, as a clone of a big repository takes long. It throws with the output of the tool.
 */
export async function cloneRepository(repo: string, dir: string, cwd: string): Promise<void> {
	const cloned = await run(TOOL.github, ["repo", "clone", repo, dir], cwd);

	if (cloned.code !== 0) {
		throw new Error(`${TOOL.github} repo clone ${repo} failed: ${cloned.stdout}${cloned.stderr}`.trim());
	}
}

/**
 * Whether the issue that the tool of `host` prints for `args` has the state `open`. An issue that the host does not
 * have is not open.
 */
async function openIssue(
	host: GitHost,
	args: readonly string[],
	open: string,
	signal: AbortSignal | undefined,
): Promise<boolean> {
	const result = await bounded(host, args, signal);

	if (result.code !== 0) {
		if (/could not resolve to an issue|404 not found/i.test(`${result.stdout}${result.stderr}`)) return false;

		throw new Error(failure([TOOL[host.kind], ...args], result));
	}

	return parse(host, args, ISSUE, result.stdout).state === open;
}

/**
 * Whether `branch` has a conflict with `base` in the repository `cwd`: `git merge-tree --write-tree` exits 1. It reads
 * only the local refs and changes no file.
 */
export async function hasConflict(cwd: string, base: string, branch: string): Promise<boolean> {
	return (await mergeTree(cwd, base, branch)) === null;
}

/**
 * Whether `base` already has the changes of `branch` in the repository `cwd`, also after a merge by squash or rebase:
 * the merge of `branch` into `base` has no conflict and gives the tree of `base`.
 */
export async function isMerged(cwd: string, base: string, branch: string): Promise<boolean> {
	const tree = await mergeTree(cwd, base, branch);

	return tree !== null && tree === (await git(cwd, "rev-parse", `${base}^{tree}`));
}

/**
 * The tree of the merge of `branch` into `base` in `cwd`, or null when it has a conflict. Git exits 1 also for a ref
 * that it cannot read, but then it prints no tree.
 */
async function mergeTree(cwd: string, base: string, branch: string): Promise<string | null> {
	const args = ["merge-tree", "--write-tree", base, branch];
	const result = await run("git", args, cwd);
	const tree = /^[0-9a-f]{40,64}$/.exec(result.stdout.split("\n", 1)[0] ?? "")?.[0];

	if (tree === undefined || result.code > 1) throw new Error(failure(["git", ...args], result));

	return result.code === 1 ? null : tree;
}

/** Pushes `branch` of the repository `cwd` to the branch of the same name on `origin`. */
export async function push(cwd: string, branch: string): Promise<void> {
	await git(cwd, "push", "origin", `refs/heads/${branch}:refs/heads/${branch}`);
}

const NUMBERS = Type.Array(Type.Object({ number: Type.Integer() }));
const IID = Type.Object({ iid: Type.Integer() });
const ISSUE = Type.Object({ state: Type.String() });

const MERGE_METHODS = Type.Object({
	rebaseMergeAllowed: Type.Boolean(),
	mergeCommitAllowed: Type.Boolean(),
	squashMergeAllowed: Type.Boolean(),
});

/** A check of a GitHub pull request: a check run with a status and a conclusion, or a commit status with a state. */
const GITHUB_CHECK = Type.Object({
	status: Type.Optional(Type.String()),
	conclusion: Type.Optional(Type.String()),
	state: Type.Optional(Type.String()),
});

const GITHUB_PULL = Type.Object({
	number: Type.Integer(),
	url: Type.String(),
	state: Type.Union([Type.Literal("OPEN"), Type.Literal("CLOSED"), Type.Literal("MERGED")]),
	mergeCommit: Type.Union([Type.Object({ oid: Type.String() }), Type.Null()]),
	statusCheckRollup: Type.Array(GITHUB_CHECK),
	latestReviews: Type.Array(Type.Object({ state: Type.String() })),
	title: Type.String(),
	body: Type.String(),
	headRefName: Type.String(),
	baseRefName: Type.String(),
	headRefOid: Type.String(),
	isCrossRepository: Type.Boolean(),
});

const GITHUB_FIELDS =
	"number,url,state,mergeCommit,statusCheckRollup,latestReviews,title,body,headRefName,baseRefName,headRefOid,isCrossRepository";

const GITHUB_RUNS = Type.Array(
	Type.Object({
		workflowName: Type.String(),
		url: Type.String(),
		status: Type.String(),
		conclusion: Type.String(),
	}),
);

/**
 * The conclusions and states of a GitHub check that passed and that failed; any other is a check that runs. A completed
 * CI run passes when its conclusion, in upper case, is in the first set.
 */
const GITHUB_PASSED = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);
const GITHUB_FAILED = new Set(["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE"]);

/** Creates the GitHub pull request of `pull.branch` into `pull.base` on `host`, and returns its state. */
async function githubCreate(
	host: GitHost,
	pull: NewPullRequest,
	signal: AbortSignal | undefined,
): Promise<PullRequest> {
	const args = ["pr", "create", "--repo", repositoryOf(host), "--head", pull.branch, "--base", pull.base];
	const url = (await output(host, [...args, "--title", pull.title, "--body", pull.body], signal)).trim();
	const number = /\/pull\/(\d+)$/.exec(url)?.[1];

	if (number === undefined) throw new Error(`gh pr create printed no pull request URL: ${url}`);

	return githubPullRequest(host, Number(number), signal);
}

/** The newest GitHub pull request of the branch `branch` on `host`, or null when the branch has none. */
async function githubBranch(
	host: GitHost,
	branch: string,
	signal: AbortSignal | undefined,
): Promise<PullRequest | null> {
	const args = ["pr", "list", "--repo", repositoryOf(host), "--head", branch, "--state", "all"];
	const [found] = await json(host, [...args, "--limit", "1", "--json", "number"], NUMBERS, signal);

	return found === undefined ? null : githubPullRequest(host, found.number, signal);
}

/** Merges the GitHub pull request `number` of `host` with the first allowed of rebase, merge commit and squash. */
async function githubMerge(host: GitHost, number: number, signal: AbortSignal | undefined): Promise<void> {
	const repository = repositoryOf(host);
	const fields = "rebaseMergeAllowed,mergeCommitAllowed,squashMergeAllowed";
	const allowed = await json(host, ["repo", "view", repository, "--json", fields], MERGE_METHODS, signal);

	const method = allowed.rebaseMergeAllowed
		? "--rebase"
		: allowed.mergeCommitAllowed
			? "--merge"
			: allowed.squashMergeAllowed
				? "--squash"
				: undefined;

	if (method === undefined) throw new Error(`${repository} allows no merge method`);
	await output(host, ["pr", "merge", String(number), "--repo", repository, method], signal);
}

/** The GitHub pull request `number` of `host`. */
async function githubPullRequest(host: GitHost, number: number, signal: AbortSignal | undefined): Promise<PullRequest> {
	const args = ["pr", "view", String(number), "--repo", repositoryOf(host), "--json", GITHUB_FIELDS];
	const pull = await json(host, args, GITHUB_PULL, signal);

	const fields = {
		kind: "github" as const,
		number: pull.number,
		url: pull.url,
		title: pull.title,
		body: pull.body,
		branch: pull.headRefName,
		base: pull.baseRefName,
		head: pull.headRefOid,
		fork: pull.isCrossRepository,
		ref: `refs/pull/${pull.number}/head`,
		check: githubCheck(pull.statusCheckRollup),
		changesRequested: pull.latestReviews.some((review) => review.state === "CHANGES_REQUESTED"),
	};

	if (pull.state !== "MERGED") return { ...fields, state: pull.state === "OPEN" ? "open" : "closed" };

	if (pull.mergeCommit === null) throw new Error(`gh pr view printed no merge commit for the merged ${pull.url}`);

	return { ...fields, state: "merged", mergeCommit: pull.mergeCommit.oid };
}

/** The GitHub CI runs of `commit` on `branch` of `host`. */
async function githubCi(
	host: GitHost,
	commit: string,
	branch: string,
	signal: AbortSignal | undefined,
): Promise<CiRun[]> {
	const args = ["run", "list", "--repo", repositoryOf(host), "--commit", commit, "--branch", branch];
	const runs = await json(host, [...args, "--json", "workflowName,url,status,conclusion"], GITHUB_RUNS, signal);

	return runs.map((run) => ({
		name: run.workflowName,
		url: run.url,
		state:
			run.status !== "completed" ? "running" : GITHUB_PASSED.has(run.conclusion.toUpperCase()) ? "passed" : "failed",
	}));
}

/** The check of the GitHub checks `checks`: a failed one wins, then one that runs. */
function githubCheck(checks: readonly Static<typeof GITHUB_CHECK>[]): Check {
	if (checks.length === 0) return "none";

	const states = checks.map(
		({ status, conclusion, state }) => state ?? (status === "COMPLETED" ? conclusion : undefined) ?? "PENDING",
	);

	if (states.some((state) => GITHUB_FAILED.has(state))) return "failed";

	return states.every((state) => GITHUB_PASSED.has(state)) ? "passed" : "running";
}

const GITLAB_MERGE_REQUEST = Type.Object({
	iid: Type.Integer(),
	web_url: Type.String(),
	state: Type.String(),
	sha: Type.Union([Type.String(), Type.Null()]),
	merge_commit_sha: Type.Optional(Type.Union([Type.String(), Type.Null()])),
	squash_commit_sha: Type.Optional(Type.Union([Type.String(), Type.Null()])),
	detailed_merge_status: Type.Optional(Type.String()),
	head_pipeline: Type.Optional(Type.Union([Type.Object({ status: Type.String() }), Type.Null()])),
	title: Type.String(),
	description: Type.Union([Type.String(), Type.Null()]),
	source_branch: Type.String(),
	target_branch: Type.String(),
	source_project_id: Type.Integer(),
	target_project_id: Type.Integer(),
});

const GITLAB_PIPELINES = Type.Array(Type.Object({ id: Type.Integer(), status: Type.String(), web_url: Type.String() }));

/** The `detailed_merge_status` values of a GitLab merge request that say that a review asks for changes. */
const GITLAB_CHANGES = new Set(["requested_changes", "discussions_not_resolved"]);

/** The `glab api` arguments of the request `<resource>` of the project of `host`. */
function api(host: GitHost, resource: string): string[] {
	return ["api", "--hostname", host.name, `projects/${encodeURIComponent(host.path)}/${resource}`];
}

/** Creates the GitLab merge request of `pull.branch` into `pull.base` on `host`, and returns its state. */
async function gitlabCreate(
	host: GitHost,
	pull: NewPullRequest,
	signal: AbortSignal | undefined,
): Promise<PullRequest> {
	const fields = {
		source_branch: pull.branch,
		target_branch: pull.base,
		title: pull.title,
		description: pull.body,
	};

	const args = Object.entries(fields).flatMap(([name, value]) => ["--raw-field", `${name}=${value}`]);
	const created = await json(host, [...api(host, "merge_requests"), "--method", "POST", ...args], IID, signal);

	return gitlabPullRequest(host, created.iid, signal);
}

/** The newest GitLab merge request of the branch `branch` on `host`, or null when the branch has none. */
async function gitlabBranch(
	host: GitHost,
	branch: string,
	signal: AbortSignal | undefined,
): Promise<PullRequest | null> {
	const query = `source_branch=${encodeURIComponent(branch)}&order_by=created_at&sort=desc&per_page=1`;
	const [found] = await json(host, api(host, `merge_requests?${query}`), Type.Array(IID), signal);

	return found === undefined ? null : gitlabPullRequest(host, found.iid, signal);
}

/** Merges the GitLab merge request `number` of `host` now, with the merge method of the project. */
async function gitlabMerge(host: GitHost, number: number, signal: AbortSignal | undefined): Promise<void> {
	const url = `https://${repositoryOf(host)}`;
	await output(host, ["mr", "merge", String(number), "--yes", "--auto-merge=false", "--repo", url], signal);
}

/** The GitLab merge request `number` of `host`. */
async function gitlabPullRequest(host: GitHost, number: number, signal: AbortSignal | undefined): Promise<PullRequest> {
	const merge = await json(host, api(host, `merge_requests/${number}`), GITLAB_MERGE_REQUEST, signal);

	const fields = {
		kind: "gitlab" as const,
		number: merge.iid,
		url: merge.web_url,
		title: merge.title,
		body: merge.description ?? "",
		branch: merge.source_branch,
		base: merge.target_branch,
		head: merge.sha,
		fork: merge.source_project_id !== merge.target_project_id,
		ref: `refs/merge-requests/${merge.iid}/head`,
		check: gitlabCheck(merge.head_pipeline?.status),
		changesRequested: GITLAB_CHANGES.has(merge.detailed_merge_status ?? ""),
	};

	if (merge.state !== "merged") return { ...fields, state: merge.state === "closed" ? "closed" : "open" };
	const commit = merge.merge_commit_sha ?? merge.squash_commit_sha ?? merge.sha;

	if (commit === null) throw new Error(`glab api printed no merge commit for the merged ${merge.web_url}`);

	return { ...fields, state: "merged", mergeCommit: commit };
}

/** The GitLab pipelines of `commit` on `branch` of `host`, as CI runs. */
async function gitlabCi(
	host: GitHost,
	commit: string,
	branch: string,
	signal: AbortSignal | undefined,
): Promise<CiRun[]> {
	const query = `sha=${encodeURIComponent(commit)}&ref=${encodeURIComponent(branch)}`;
	const pipelines = await json(host, api(host, `pipelines?${query}`), GITLAB_PIPELINES, signal);

	return pipelines.map((pipeline) => {
		const check = gitlabCheck(pipeline.status);

		return {
			name: `pipeline ${pipeline.id}`,
			url: pipeline.web_url,
			state: check === "passed" || check === "failed" ? check : "running",
		};
	});
}

/** The check of the GitLab pipeline status `status`; a status that is not final is a check that runs. */
function gitlabCheck(status: string | undefined): Check {
	switch (status) {
		case undefined:
			return "none";
		case "success":
		case "skipped":
			return "passed";
		case "failed":
		case "canceled":
			return "failed";
		default:
			return "running";
	}
}
