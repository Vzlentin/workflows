import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { LISTED } from "../src/cli/commands/list.ts";
import { reportedEvents } from "./labels-entry.ts";
import {
	fake,
	git,
	HOSTS,
	type HostKind,
	answerKey,
	hostAnswer,
	hostBranch,
	hostOrigin,
	hostPull,
	LABELS_ENTRY,
	repository,
	sandbox,
	setEntries,
	workflows,
	worktreeAt,
} from "./support.ts";

let root: string;
let repo: string;

beforeEach(async () => {
	root = await sandbox();
	repo = join(root, "repo");
	await repository(repo);
	const scripts = join(repo, ".workflows", "scripts");
	await mkdir(scripts, { recursive: true });
	// Each run commits a file of its own on its branch.
	await writeFile(
		join(scripts, "w.js"),
		'export const meta = { worktree: true }\nawait sh("pwd > work.txt && git add work.txt && git commit -q -m work")\nreturn "done"',
	);
});

afterEach(() => rm(root, { recursive: true, force: true }));

/** Runs `w` on the branch `branch`, serving `serves` when given, and gives its run ID. */
async function endedRun(branch = "feat/x", serves?: string): Promise<string> {
	const run = await workflows(["w", "--branch", branch, ...(serves === undefined ? [] : ["--serves", serves])], {
		cwd: repo,
	});

	expect(run.code).toBe(0);

	return run.id ?? "";
}

/** `list --json` in the repository: its exit code, its rows and its stderr. */
async function listed() {
	const list = await workflows(["list", "--json"], { cwd: repo });
	const rows = JSON.parse(list.stdout[0] ?? "null");
	expect(Value.Check(Type.Array(LISTED), rows)).toBe(true);

	return { code: list.code, rows, stderr: list.stderr };
}

/** The `change` of the row of the run `id` in a new `list --json`, which must exit 0 with no stderr. */
async function changeOf(id: string) {
	const { code, rows, stderr } = await listed();
	expect([code, stderr]).toEqual([0, []]);

	return rows.find((row: { runId: string }) => row.runId === id)?.change;
}

/** The kept files of the changes. */
async function keptFiles(): Promise<string[]> {
	const folder = join(root, "state", "workflows", "changes");

	return (await readdir(folder)).map((name) => join(folder, name));
}

/** Makes the kept files older than 60 s, so that the next `list --json` reads the Git host again. */
async function ageKept(): Promise<void> {
	const old = new Date(Date.now() - 61_000);

	for (const file of await keptFiles()) await utimes(file, old, old);
}

/** The lines of the log of the fake tool `tool`, or none. */
const logOf = (tool: string) =>
	readFile(join(root, `${tool}.log`), "utf8").then(
		(text) => text.trim().split("\n"),
		() => [],
	);

/** Makes the login of `gh` to github.com work or fail. */
async function ghLogin(works: boolean): Promise<void> {
	const args = ["auth", "token", "--hostname", "github.com"];
	const file = join(root, "gh", answerKey(args));
	await rm(works ? `${file}.fail` : file, { force: true });
	await hostAnswer(root, "gh", args, works ? { stdout: "gho_token\n" } : { fail: "gh: not logged in\n" });
}

/** Makes the newest pull request of `branch` on `kind` the open pull request 7, with `extra` over its JSON. */
async function openPull(kind: HostKind, extra: Parameters<typeof hostPull>[4], branch = "feat/x"): Promise<void> {
	await hostBranch(root, kind, branch, 7);
	await hostPull(root, kind, 7, { branch }, extra);
}

describe("list --json and the change on the Git host", () => {
	it("gives each state of the change of an ended run on GitHub", async () => {
		await hostOrigin(root, repo, "github");
		const id = await endedRun();
		const open = { state: "open", kind: "github", number: 7, url: "https://github.com/octo/demo/pull/7" };

		await hostBranch(root, "github", "feat/x", null);
		expect(await changeOf(id)).toEqual({ state: "local", conflict: false });

		const cases = [
			{ checks: [{ status: "IN_PROGRESS", conclusion: "" }], reviews: [], check: "running", requested: false },
			{ checks: [{ status: "COMPLETED", conclusion: "SUCCESS" }], reviews: [], check: "passed", requested: false },
			{ checks: [{ state: "FAILURE" }], reviews: [], check: "failed", requested: false },
			{ checks: [], reviews: [{ state: "CHANGES_REQUESTED" }], check: "none", requested: true },
		];

		for (const { checks, reviews, check, requested } of cases) {
			await ageKept();
			await openPull("github", { statusCheckRollup: checks, latestReviews: reviews });
			expect(await changeOf(id)).toEqual({ ...open, check, changesRequested: requested, conflict: false });
		}

		// main on origin gets another work.txt, so the branch now conflicts with origin/main.
		await writeFile(join(repo, "work.txt"), "other\n");
		git(repo, "add", "work.txt");
		git(repo, "commit", "-q", "-m", "other");
		git(repo, "push", "-q", "origin", "main");
		await ageKept();
		await openPull("github", {});
		expect(await changeOf(id)).toEqual({ ...open, check: "none", changesRequested: false, conflict: true });

		for (const state of ["merged", "closed"] as const) {
			await ageKept();
			await hostPull(root, "github", 7, { state, branch: "feat/x", mergeCommit: "m" });
			expect(await changeOf(id)).toEqual({ ...open, state });
		}
	});

	it("gives the merge request of an ended run on GitLab, with its pipeline and its review", async () => {
		await hostOrigin(root, repo, "gitlab");
		const id = await endedRun();
		await openPull("gitlab", { head_pipeline: { status: "success" }, detailed_merge_status: "requested_changes" });

		expect(await changeOf(id)).toEqual({
			state: "open",
			kind: "gitlab",
			number: 7,
			url: "https://gitlab.com/octo/demo/-/merge_requests/7",
			check: "passed",
			changesRequested: true,
			conflict: false,
		});
	});

	it("keeps the state 60 s: a second list makes no fetch and no Git host call", async () => {
		await hostOrigin(root, repo, "github");
		const id = await endedRun();
		await openPull("github", {});
		const real = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
		await fake(root, "git", `[ "$1" = fetch ] && echo fetch >> "${root}/fetch.log"\nexec "${real}" "$@"\n`);

		expect(await changeOf(id)).toMatchObject({ state: "open", check: "none" });
		const calls = (await logOf("gh")).length;
		expect(await logOf("fetch")).toEqual(["fetch"]);

		await openPull("github", { statusCheckRollup: [{ state: "SUCCESS" }] });
		expect(await changeOf(id)).toMatchObject({ state: "open", check: "none" });
		expect([(await logOf("gh")).length, await logOf("fetch")]).toEqual([calls, ["fetch"]]);

		await ageKept();
		expect(await changeOf(id)).toMatchObject({ state: "open", check: "passed" });
		expect([(await logOf("gh")).length, await logOf("fetch")]).toEqual([2 * calls, ["fetch", "fetch"]]);
	});

	it("still prints the rows when gh fails, with the kept state or none, and one warning", async () => {
		await hostOrigin(root, repo, "github");
		const first = await endedRun();
		const second = await endedRun("feat/y");
		// A second repository on the same Git host: its read after the first failure asks no Git host.
		const other = join(root, "other");
		git(root, "clone", "-q", repo, other);
		git(other, "remote", "set-url", "origin", HOSTS.github.url);
		await cp(join(repo, ".workflows"), join(other, ".workflows"), { recursive: true });
		const third = await workflows(["w", "--branch", "feat/z"], { cwd: other });
		expect(third.code).toBe(0);
		await ghLogin(false);

		const warning = expect.stringMatching(
			/^workflows: cannot read the state of the changes of .*\/(repo|other): gh is not logged in to github\.com/,
		);

		const failed = await listed();
		expect([failed.code, failed.stderr]).toEqual([0, [warning]]);
		expect(new Set(failed.rows.map((row: { runId: string }) => row.runId))).toEqual(new Set([third.id, second, first]));
		expect(failed.rows.map((row: { change?: unknown }) => row.change)).toEqual([undefined, undefined, undefined]);
		expect(await logOf("gh")).toHaveLength(1);

		await ghLogin(true);
		await hostBranch(root, "github", "feat/x", null);
		await hostBranch(root, "github", "feat/y", null);
		await hostBranch(root, "github", "feat/z", null);
		expect(await changeOf(first)).toEqual({ state: "local", conflict: false });

		await ageKept();
		await ghLogin(false);
		const stale = await listed();
		expect([stale.code, stale.stderr]).toEqual([0, [warning]]);
		expect(stale.rows.map((row: { change?: unknown }) => row.change)).toEqual([
			{ state: "local", conflict: false },
			{ state: "local", conflict: false },
			{ state: "local", conflict: false },
		]);
	});

	it("gives the change that it read and one warning when it cannot write the kept file", async () => {
		await hostOrigin(root, repo, "github");
		const id = await endedRun();
		await hostBranch(root, "github", "feat/x", null);
		// A file in the place of the folder of the kept files.
		await mkdir(join(root, "state", "workflows"), { recursive: true });
		await writeFile(join(root, "state", "workflows", "changes"), "");

		const { code, rows, stderr } = await listed();
		expect([code, stderr]).toEqual([
			0,
			[expect.stringMatching(/^workflows: cannot keep the state of the changes of .*\/repo: /)],
		]);
		expect(rows.find((row: { runId: string }) => row.runId === id)?.change).toEqual({
			state: "local",
			conflict: false,
		});
	});

	it("gives no change for a repository with no origin or one on no Git host, and none in the text lines", async () => {
		const id = await endedRun();
		expect(await changeOf(id)).toBeUndefined();

		git(repo, "remote", "add", "origin", HOSTS.github.url.replace("github.com", "example.com"));
		await ageKept();
		expect(await changeOf(id)).toBeUndefined();

		git(repo, "remote", "set-url", "origin", HOSTS.github.url);
		await rm(join(root, "state", "workflows", "changes"), { recursive: true });
		await rm(join(root, "gh.log"), { force: true });
		const text = await workflows(["list"], { cwd: repo });
		expect([text.code, text.stderr, await logOf("gh")]).toEqual([0, [], []]);
	});
});

describe("list --json and the merged changes", () => {
	beforeEach(() => setEntries({ labels: LABELS_ENTRY }));

	/**
	 * A run on feat/x that serves `serves`, whose branch origin's main merges by squash, and whose pull request 7 the Git
	 * host gives as merged with that commit and the head `head`, or the tip of the branch: its ID, its worktree and
	 * the squash commit.
	 */
	async function squashed(serves: string, head?: string) {
		await hostOrigin(root, repo, "github");
		const id = await endedRun("feat/x", serves);
		const tip = git(repo, "rev-parse", "feat/x");
		git(repo, "merge", "-q", "--squash", "feat/x");
		git(repo, "commit", "-q", "-m", "work (#7)");
		git(repo, "push", "-q", "origin", "main");
		const commit = git(repo, "rev-parse", "main");
		await hostBranch(root, "github", "feat/x", 7);
		await hostPull(root, "github", 7, { state: "merged", branch: "feat/x", head: head ?? tip, mergeCommit: commit });

		return { id, worktree: worktreeAt(repo, id), commit };
	}

	/** Whether the branch `branch` is in the repository. */
	const hasBranch = (branch: string) => git(repo, "branch", "--list", branch) !== "";

	it("sweeps a run whose pull request is merged by squash, and reports the merge commit", async () => {
		const { id, worktree, commit } = await squashed("item:1");

		const { code, rows, stderr } = await listed();
		expect([code, stderr]).toEqual([0, []]);
		const row = rows.find((found: { runId: string }) => found.runId === id);
		expect([row.swept, row.change]).toEqual(["landed", undefined]);
		expect([existsSync(worktree), hasBranch("feat/x")]).toEqual([false, false]);
		expect(await reportedEvents()).toEqual([{ labels: ["item:1"], refs: [`commit:${commit}`] }]);
	});

	it("keeps a run whose branch has a commit after the merged head", async () => {
		const { id, worktree } = await squashed("item:1");
		await writeFile(join(worktree, "more.txt"), "more\n");
		git(worktree, "add", "more.txt");
		git(worktree, "commit", "-q", "-m", "more");

		const { code, rows, stderr } = await listed();
		expect([code, stderr]).toEqual([0, []]);
		const row = rows.find((found: { runId: string }) => found.runId === id);
		expect([row.swept, row.change?.state]).toEqual([undefined, "merged"]);
		expect([existsSync(worktree), hasBranch("feat/x")]).toEqual([true, true]);
		expect(await reportedEvents()).toEqual([]);
	});

	it("keeps a merged run with one warning when the host refuses the report", async () => {
		const { id, worktree } = await squashed("item:98");

		const { code, rows, stderr } = await listed();
		expect([code, stderr]).toEqual([
			0,
			[expect.stringMatching(new RegExp(`^workflows: cannot sweep ${id}: .*item:98`))],
		]);
		const row = rows.find((found: { runId: string }) => found.runId === id);
		expect([row.swept, row.change?.state]).toEqual([undefined, "merged"]);
		expect([existsSync(worktree), hasBranch("feat/x")]).toEqual([true, true]);
	});
});
