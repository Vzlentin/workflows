import { execFileSync } from "node:child_process";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { JsonValue } from "@earendil-works/chord/json";
import { Value } from "typebox/value";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { SHOWN } from "../src/cli/commands/show.ts";
import {
	branchPullRequest,
	createPullRequest,
	type GitHost,
	gitHostOf,
	hasConflict,
	isMerged,
	isOpenIssue,
	mergePullRequest,
	pullRequestOf,
	push,
} from "../src/githost.ts";
import { git, hostAnswer, repository, restoreEnvironment, sandbox, workflows } from "./support.ts";

let root: string;
let repo: string;

beforeEach(async () => {
	root = await sandbox();
	repo = join(root, "repo");
	await repository(repo);
});

afterEach(() => rm(root, { recursive: true, force: true }));

const GITHUB_FIELDS = "number,url,state,mergeCommit,statusCheckRollup,latestReviews";
const GITHUB = ["--repo", "github.com/octo/demo"];

/** Sets the URL of `origin` of the test repository, and returns its Git host. */
async function originAt(url: string): Promise<GitHost | null> {
	git(repo, "remote", "add", "origin", url);

	return gitHostOf(repo);
}

/** The Git host `github.com/octo/demo`, with a login of `gh`. */
async function github(): Promise<GitHost> {
	await hostAnswer(root, "gh", ["auth", "token", "--hostname", "github.com"], { stdout: "gho_token\n" });
	const host = await originAt("https://github.com/octo/demo.git");

	if (host === null) throw new Error("no Git host");

	return host;
}

/** The Git host `gitlab.com/group/demo`, with a login of `glab`. */
async function gitlab(): Promise<GitHost> {
	await hostAnswer(root, "glab", ["config", "get", "token", "--host", "gitlab.com"], { stdout: "glpat-token\n" });
	const host = await originAt("git@gitlab.com:group/demo.git");

	if (host === null) throw new Error("no Git host");

	return host;
}

/** Makes `gh pr view <number>` print the pull request `fields` over an open one with no check and no review. */
function githubPull(number: number, fields: Readonly<Record<string, JsonValue>> = {}): Promise<void> {
	const pull = {
		number,
		url: `https://github.com/octo/demo/pull/${number}`,
		state: "OPEN",
		mergeCommit: null,
		statusCheckRollup: [],
		latestReviews: [],
		...fields,
	};

	return hostAnswer(root, "gh", ["pr", "view", String(number), ...GITHUB, "--json", GITHUB_FIELDS], {
		stdout: JSON.stringify(pull),
	});
}

/** Makes the GitLab API print the merge request `fields` over an open one with no pipeline. */
function gitlabMerge(iid: number, fields: Readonly<Record<string, JsonValue>> = {}): Promise<void> {
	const merge = {
		iid,
		web_url: `https://gitlab.com/group/demo/-/merge_requests/${iid}`,
		state: "opened",
		sha: "head",
		merge_commit_sha: null,
		squash_commit_sha: null,
		detailed_merge_status: "mergeable",
		head_pipeline: null,
		...fields,
	};

	return hostAnswer(root, "glab", gitlabApi(`merge_requests/${iid}`), { stdout: JSON.stringify(merge) });
}

const gitlabApi = (resource: string) => ["api", "--hostname", "gitlab.com", `projects/group%2Fdemo/${resource}`];

const githubList = (branch: string) => [
	"pr",
	"list",
	...GITHUB,
	"--head",
	branch,
	"--state",
	"all",
	"--limit",
	"1",
	"--json",
	"number",
];

const log = async (tool: string) => (await readFile(join(root, `${tool}.log`), "utf8")).trim().split("\n");

describe("the Git host of a repository", () => {
	it("comes from the URL of origin, by name or by the login of a tool", async () => {
		expect(await gitHostOf(repo)).toBeNull();
		expect(await originAt("https://user@github.com/octo/demo.git")).toEqual({
			kind: "github",
			name: "github.com",
			path: "octo/demo",
			cwd: repo,
		});

		git(repo, "remote", "set-url", "origin", "git@gitlab.com:group/sub/demo.git");
		expect(await gitHostOf(repo)).toMatchObject({ kind: "gitlab", name: "gitlab.com", path: "group/sub/demo" });

		git(repo, "remote", "set-url", "origin", "ssh://git@git.example.com:2222/team/demo.git");
		expect(await gitHostOf(repo)).toBeNull();
		await hostAnswer(root, "glab", ["config", "get", "token", "--host", "git.example.com"], {
			stdout: "glpat-token\n",
		});
		expect(await gitHostOf(repo)).toMatchObject({ kind: "gitlab", name: "git.example.com", path: "team/demo" });

		for (const local of [join(root, "origin.git"), `file://${root}/origin.git`]) {
			git(repo, "remote", "set-url", "origin", local);
			expect(await gitHostOf(repo)).toBeNull();
		}
	});

	it("fails with one line that names the tool and the repository when the tool is not logged in or missing", async () => {
		const host = await originAt("https://github.com/octo/demo");
		await expect(pullRequestOf(host ?? fail(), 7)).rejects.toThrow(
			/^gh is not logged in to github\.com, so workflows cannot reach github\.com\/octo\/demo$/,
		);
		expect(await log("gh")).toEqual(["auth token --hostname github.com"]);

		const bin = join(root, "only-git");
		await mkdir(bin);
		const real = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
		await symlink(real, join(bin, "git"));
		git(repo, "remote", "set-url", "origin", "https://gitlab.com/group/demo");
		process.env.PATH = bin;

		try {
			const gitlab = await gitHostOf(repo);
			await expect(isOpenIssue(gitlab ?? fail(), 3)).rejects.toThrow(
				/^glab is not installed, so workflows cannot reach gitlab\.com\/group\/demo$/,
			);
		} finally {
			restoreEnvironment();
		}
	});
});

describe("a GitHub pull request", () => {
	it("is null for a branch with none, and the newest one of a branch, with its check and its review", async () => {
		const host = await github();
		await hostAnswer(root, "gh", githubList("lonely"), { stdout: "[]" });
		expect(await branchPullRequest(host, "lonely")).toBeNull();

		await hostAnswer(root, "gh", githubList("feature"), { stdout: '[{"number":7}]' });
		await githubPull(7, {
			statusCheckRollup: [
				{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" },
				{ __typename: "StatusContext", state: "PENDING" },
			],
			latestReviews: [{ state: "COMMENTED" }, { state: "CHANGES_REQUESTED" }],
		});

		expect(await branchPullRequest(host, "feature")).toEqual({
			kind: "github",
			number: 7,
			url: "https://github.com/octo/demo/pull/7",
			check: "running",
			changesRequested: true,
			state: "open",
		});
	});

	it("maps the checks to none, running, passed and failed, and a comment is not a change request", async () => {
		const host = await github();

		const cases = [
			{ checks: [], check: "none" },
			{ checks: [{ status: "IN_PROGRESS", conclusion: "" }], check: "running" },
			{
				checks: [
					{ status: "COMPLETED", conclusion: "SUCCESS" },
					{ status: "COMPLETED", conclusion: "SKIPPED" },
					{ state: "SUCCESS" },
				],
				check: "passed",
			},
			{ checks: [{ status: "QUEUED", conclusion: "" }, { state: "ERROR" }], check: "failed" },
			{ checks: [{ status: "COMPLETED", conclusion: "TIMED_OUT" }], check: "failed" },
		];

		for (const [index, { checks, check }] of cases.entries()) {
			await githubPull(index + 1, { statusCheckRollup: checks, latestReviews: [{ state: "COMMENTED" }] });
			expect(await pullRequestOf(host, index + 1)).toMatchObject({ check, changesRequested: false });
		}
	});

	it("gives the merge commit of a merged pull request, and closed for a closed one", async () => {
		const host = await github();
		await githubPull(7, { state: "MERGED", mergeCommit: { oid: "abc123" } });
		await githubPull(8, { state: "CLOSED" });

		expect(await pullRequestOf(host, 7)).toMatchObject({ state: "merged", mergeCommit: "abc123" });
		expect(await pullRequestOf(host, 8)).toEqual(expect.not.objectContaining({ mergeCommit: expect.anything() }));
		expect(await pullRequestOf(host, 8)).toMatchObject({ state: "closed" });
	});

	it("is created from a branch with a title and a body", async () => {
		const host = await github();
		const args = ["pr", "create", ...GITHUB, "--head", "feature", "--base", "main"];
		await hostAnswer(root, "gh", [...args, "--title", "Fix", "--body", "Body"], {
			stdout: "https://github.com/octo/demo/pull/9\n",
		});
		await githubPull(9);

		const pull = createPullRequest(host, { branch: "feature", base: "main", title: "Fix", body: "Body" });
		expect(await pull).toMatchObject({ number: 9, state: "open", check: "none" });
		expect((await log("gh")).filter((line) => line.startsWith("auth token"))).toHaveLength(1);
	});

	it("merges with the first allowed of rebase, merge commit and squash", async () => {
		const host = await github();
		const view = ["repo", "view", "github.com/octo/demo", "--json"];
		const allowed = { rebaseMergeAllowed: false, mergeCommitAllowed: true, squashMergeAllowed: true };
		await hostAnswer(root, "gh", [...view, "rebaseMergeAllowed,mergeCommitAllowed,squashMergeAllowed"], {
			stdout: JSON.stringify(allowed),
		});
		await hostAnswer(root, "gh", ["pr", "merge", "7", ...GITHUB, "--merge"], { stdout: "" });

		await mergePullRequest(host, 7);
		expect(await log("gh")).toEqual([
			"auth token --hostname github.com",
			"repo view github.com/octo/demo --json rebaseMergeAllowed,mergeCommitAllowed,squashMergeAllowed",
			"pr merge 7 --repo github.com/octo/demo --merge",
		]);
	});

	it("reads whether an issue is open, and a missing issue is not", async () => {
		const host = await github();
		const issue = (number: number) => ["issue", "view", String(number), ...GITHUB, "--json", "state"];
		await hostAnswer(root, "gh", issue(1), { stdout: '{"state":"OPEN"}' });
		await hostAnswer(root, "gh", issue(2), { stdout: '{"state":"CLOSED"}' });
		await hostAnswer(root, "gh", issue(3), {
			fail: "GraphQL: Could not resolve to an issue or pull request with the number of 3. (repository.issue)",
		});
		await hostAnswer(root, "gh", issue(4), { fail: "HTTP 502: Bad Gateway" });

		expect(await isOpenIssue(host, 1)).toBe(true);
		expect(await isOpenIssue(host, 2)).toBe(false);
		expect(await isOpenIssue(host, 3)).toBe(false);
		await expect(isOpenIssue(host, 4)).rejects.toThrow("gh issue failed: HTTP 502: Bad Gateway");
	});
});

describe("a GitLab merge request", () => {
	it("is the newest one of a branch, with its pipeline and its review", async () => {
		const host = await gitlab();
		const query = "order_by=created_at&sort=desc&per_page=1";
		await hostAnswer(root, "glab", gitlabApi(`merge_requests?source_branch=none&${query}`), { stdout: "[]" });
		await hostAnswer(root, "glab", gitlabApi(`merge_requests?source_branch=feature&${query}`), {
			stdout: '[{"iid":6}]',
		});
		await gitlabMerge(6, { head_pipeline: { status: "failed" }, detailed_merge_status: "requested_changes" });

		expect(await branchPullRequest(host, "none")).toBeNull();
		expect(await branchPullRequest(host, "feature")).toEqual({
			kind: "gitlab",
			number: 6,
			url: "https://gitlab.com/group/demo/-/merge_requests/6",
			check: "failed",
			changesRequested: true,
			state: "open",
		});
	});

	it("maps the pipeline to none, running, passed and failed, and the unresolved threads ask for changes", async () => {
		const host = await gitlab();

		const cases = [
			{ pipeline: null, check: "none", status: "mergeable", changes: false },
			{ pipeline: { status: "manual" }, check: "running", status: "ci_still_running", changes: false },
			{ pipeline: { status: "success" }, check: "passed", status: "discussions_not_resolved", changes: true },
			{ pipeline: { status: "canceled" }, check: "failed", status: "mergeable", changes: false },
		];

		for (const [index, { pipeline, check, status, changes }] of cases.entries()) {
			await gitlabMerge(index + 1, { head_pipeline: pipeline, detailed_merge_status: status });
			expect(await pullRequestOf(host, index + 1)).toMatchObject({ check, changesRequested: changes });
		}
	});

	it("gives the squash commit of a merge request merged by squash, and closed for a closed one", async () => {
		const host = await gitlab();
		await gitlabMerge(6, { state: "merged", squash_commit_sha: "squash1" });
		await gitlabMerge(7, { state: "merged", merge_commit_sha: "merge1", squash_commit_sha: "squash2" });
		await gitlabMerge(8, { state: "closed" });

		expect(await pullRequestOf(host, 6)).toMatchObject({ state: "merged", mergeCommit: "squash1" });
		expect(await pullRequestOf(host, 7)).toMatchObject({ state: "merged", mergeCommit: "merge1" });
		expect(await pullRequestOf(host, 8)).toMatchObject({ state: "closed" });
	});

	it("is created, merged now with the method of the project, and reads an issue", async () => {
		const host = await gitlab();
		const fields = ["source_branch=feature", "target_branch=main", "title=Fix", "description=Body"];

		const create = [
			...gitlabApi("merge_requests"),
			"--method",
			"POST",
			...fields.flatMap((field) => ["--raw-field", field]),
		];

		await hostAnswer(root, "glab", create, { stdout: '{"iid":6}' });
		await gitlabMerge(6);
		const merge = ["mr", "merge", "6", "--yes", "--auto-merge=false", "--repo", "https://gitlab.com/group/demo"];
		await hostAnswer(root, "glab", merge, { stdout: "" });
		await hostAnswer(root, "glab", gitlabApi("issues/1"), { stdout: '{"state":"opened"}' });
		await hostAnswer(root, "glab", gitlabApi("issues/2"), { fail: "glab: 404 Not Found (HTTP 404)" });

		const pull = createPullRequest(host, { branch: "feature", base: "main", title: "Fix", body: "Body" });
		expect(await pull).toMatchObject({ number: 6, state: "open" });
		await mergePullRequest(host, 6);
		expect((await log("glab")).at(-1)).toBe(merge.join(" "));
		expect(await isOpenIssue(host, 1)).toBe(true);
		expect(await isOpenIssue(host, 2)).toBe(false);
	});
});

describe("gitHost in a workflow script", () => {
	it("reads the pull request of a branch as a call that a resume replays", async () => {
		await github();
		await hostAnswer(root, "gh", githubList("feature"), { stdout: '[{"number":7}]' });
		await githubPull(7);
		await writeFile(join(repo, "x.js"), 'phase("read")\nreturn await gitHost.state("feature")');

		const run = await workflows(["x.js"], { cwd: repo });
		expect(run.code).toBe(0);
		expect(JSON.parse(run.stdout.at(-1) ?? "null")).toMatchObject({ number: 7, state: "open" });

		const shown = JSON.parse((await workflows(["show", run.id ?? "", "--json"], { cwd: repo })).stdout[0] ?? "");
		expect(Value.Check(SHOWN, shown)).toBe(true);
		expect(shown.calls.map((call: { kind: string; label: string }) => [call.kind, call.label])).toEqual([
			["gitHost", "state feature"],
		]);
	});

	it("fails a call with bad arguments, and a repository on no Git host", async () => {
		await writeFile(join(repo, "x.js"), 'return await gitHost.merge("7")');
		const bad = await workflows(["x.js"], { cwd: repo });
		expect(bad.code).toBe(1);
		expect(bad.stderr.join("\n")).toContain("gitHost got bad arguments: /0/number");

		await writeFile(join(repo, "x.js"), "return await gitHost.issue(3)");
		const none = await workflows(["x.js"], { cwd: repo });
		expect(none.code).toBe(1);
		expect(none.stderr.join("\n")).toContain("is on no Git host that gh or glab knows");
	});
});

describe("the Git checks of a branch", () => {
	/** Makes the branch `name` from `main` with one commit per file of `files`, and goes back to `main`. */
	async function branch(name: string, files: Readonly<Record<string, string>>): Promise<void> {
		git(repo, "switch", "-q", "-c", name, "main");

		for (const [file, text] of Object.entries(files)) {
			await writeFile(join(repo, file), text);
			git(repo, "add", file);
			git(repo, "commit", "-q", "-m", `change ${file}`);
		}

		git(repo, "switch", "-q", "main");
	}

	it("finds a conflict with the base, and no conflict", async () => {
		await branch("clash", { "README.md": "# Demo\n\nHello world\n" });
		await branch("clean", { "a.txt": "a\n" });
		await writeFile(join(repo, "README.md"), "# Demo\n\nHi\n");
		git(repo, "commit", "-q", "-am", "base change");

		expect(await hasConflict(repo, "main", "clash")).toBe(true);
		expect(await hasConflict(repo, "main", "clean")).toBe(false);
		expect(await isMerged(repo, "main", "clash")).toBe(false);
	});

	it("finds a branch merged by a squash of several commits, and a branch that is not merged", async () => {
		await branch("squashed", { "a.txt": "a\n", "b.txt": "b\n" });
		await branch("open", { "c.txt": "c\n" });
		git(repo, "merge", "-q", "--squash", "squashed");
		git(repo, "commit", "-q", "-m", "squash");
		await writeFile(join(repo, "d.txt"), "d\n");
		git(repo, "add", "d.txt");
		git(repo, "commit", "-q", "-m", "later");

		expect(await isMerged(repo, "main", "squashed")).toBe(true);
		expect(await isMerged(repo, "main", "open")).toBe(false);
		await expect(isMerged(repo, "main", "nothing")).rejects.toThrow(/^git merge-tree failed: /);
	});

	it("pushes a branch to origin", async () => {
		const origin = join(root, "origin.git");
		git(root, "init", "-q", "--bare", origin);
		git(repo, "remote", "add", "origin", origin);
		await branch("feature", { "a.txt": "a\n" });

		await push(repo, "feature");
		expect(git(origin, "rev-parse", "feature")).toBe(git(repo, "rev-parse", "feature"));
	});
});

function fail(): never {
	throw new Error("no Git host");
}
