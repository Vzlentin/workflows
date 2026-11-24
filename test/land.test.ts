import { existsSync } from "node:fs";
import { mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { request } from "@vzlentin/harness/client";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { reportedEvents } from "./labels-entry.ts";
import {
	fake,
	gateGit,
	git,
	HOSTS,
	type HostKind,
	hostOrigin,
	LABELS_ENTRY,
	repository,
	sandbox,
	setEntries,
	startHost,
	workflows,
	worktreeAt,
} from "./support.ts";

let root: string;
let repo: string;
let origin: string;

const SUBJECT = "feat: add the feature";

/** The CI of a commit in the fakes: a passed run, a failed run, or no run. */
type Ci = "green" | "red" | "none";

/** The CI runs that the tool of `kind` prints for `ci`. */
function ciJson(kind: HostKind, ci: Ci): string {
	if (ci === "none") return "[]";
	const passed = ci === "green";

	return JSON.stringify(
		kind === "github"
			? [
					{
						workflowName: "CI",
						status: "completed",
						conclusion: passed ? "success" : "failure",
						url: `https://ci/${passed ? 1 : 2}`,
					},
				]
			: [{ id: passed ? 1 : 2, status: passed ? "success" : "failed", web_url: `https://ci/${passed ? 1 : 2}` }],
	);
}

/** The name of the failed CI run of `kind`. */
const RED_NAME = { github: "CI https://ci/2", gitlab: "pipeline 2 https://ci/2" } as const;

/** Writes the CI runs that the fakes give for the branch and for `main`. */
async function ci(branch: Ci, main: Ci): Promise<void> {
	for (const kind of ["github", "gitlab"] as const) {
		await writeFile(join(root, `ci-branch.${kind}.json`), ciJson(kind, branch));
		await writeFile(join(root, `ci-main.${kind}.json`), ciJson(kind, main));
	}
}

/** Puts `origin` of the main checkout on the Git host `kind`; both hosts serve the same bare repository. */
function originOn(kind: HostKind): void {
	git(repo, "remote", "set-url", "origin", HOSTS[kind].url);
}

beforeEach(async () => {
	root = await sandbox();
	repo = join(root, "repo");
	await repository(repo);
	const scripts = join(repo, ".workflows", "scripts");
	await mkdir(scripts, { recursive: true });
	// A ship run that commits on the branch of its worktree, which the engine names from its subject.
	await writeFile(
		join(scripts, "ship.js"),
		`export const meta = { worktree: true, exit: { shipped: 0 } }
await sh("echo feature > feature.txt && git add feature.txt && git commit -q -m '${SUBJECT}'")
return { status: "shipped", subject: "${SUBJECT}" }`,
	);
	// A campaign run that stops with no subject, so it keeps the branch of its worktree.
	await writeFile(
		join(scripts, "campaign.js"),
		'export const meta = { worktree: true, exit: { stopped: 0 } }\nreturn { status: "stopped" }',
	);
	git(repo, "add", ".workflows");
	git(repo, "commit", "-q", "-m", "add the scripts");
	origin = await hostOrigin(root, repo, "github");
	await symlink(join(root, "github"), join(root, "gitlab"));
	// The pull request 7 comes from the branch `feature`.
	await fake(
		root,
		"gh",
		`echo "$@" >> "${root}/gh.log"
case "$*" in
"auth token --hostname github.com") echo gho_token ;;
"pr view 7 --repo github.com/octo/demo --json "*) echo '${pullJson("github")}' ;;
"run list "*"--branch main "*) cat "${root}/ci-main.github.json" ;;
"run list "*) cat "${root}/ci-branch.github.json" ;;
*) exit 1 ;;
esac
`,
	);
	await fake(
		root,
		"glab",
		`echo "$@" >> "${root}/glab.log"
case "$*" in
"config get token --host gitlab.com") echo glpat-token ;;
"api --hostname gitlab.com projects/octo%2Fdemo/merge_requests/7") echo '${pullJson("gitlab")}' ;;
*"/pipelines?"*"&ref=main") cat "${root}/ci-main.gitlab.json" ;;
*"/pipelines?"*) cat "${root}/ci-branch.gitlab.json" ;;
*) exit 1 ;;
esac
`,
	);
	await ci("green", "green");
});

/** The JSON of the open pull request 7 of the branch `feature` that the tool of `kind` prints. */
function pullJson(kind: HostKind): string {
	return kind === "github"
		? JSON.stringify({
				number: 7,
				url: "https://github.com/octo/demo/pull/7",
				state: "OPEN",
				mergeCommit: null,
				statusCheckRollup: [],
				latestReviews: [],
				title: SUBJECT,
				body: "",
				headRefName: "feature",
				baseRefName: "main",
				headRefOid: "0".repeat(40),
				isCrossRepository: false,
			})
		: JSON.stringify({
				iid: 7,
				web_url: "https://gitlab.com/octo/demo/-/merge_requests/7",
				state: "opened",
				sha: "0".repeat(40),
				title: SUBJECT,
				description: "",
				source_branch: "feature",
				target_branch: "main",
				source_project_id: 1,
				target_project_id: 1,
			});
}

afterEach(() => rm(root, { recursive: true, force: true }));

/**
 * A completed ship run with a commit on its branch, which serves `serves` when given: its ID, its branch, and the full
 * and short head.
 */
async function shipped(serves?: string): Promise<{ id: string; branch: string; head: string; short: string }> {
	const run = await workflows(["ship", ...(serves === undefined ? [] : ["--serves", serves]), "--json"], { cwd: repo });
	expect(run.code).toBe(0);
	const { change } = JSON.parse(run.stdout[1] ?? "{}").value;
	expect(change.repository).toBe(await realpath(repo));
	const { branch } = change;
	const head = git(repo, "rev-parse", branch);

	return { id: run.id ?? "", branch, head, short: git(repo, "rev-parse", "--short", head) };
}

/**
 * A thermoloop run with `argv` and `options` from the main checkout on `fix/x`, after a commit `fix: the thing` there:
 * its ID, its exit code, and the full and short head.
 */
async function reviewed(
	argv: string[],
	options: Omit<Parameters<typeof workflows>[1], "cwd"> = {},
): Promise<{ id: string; code: number; head: string; short: string }> {
	git(repo, "checkout", "-qb", "fix/x");
	await writeFile(join(repo, "fix.txt"), "fix\n");
	git(repo, "add", "fix.txt");
	git(repo, "commit", "-q", "-m", "fix: the thing");
	const head = git(repo, "rev-parse", "HEAD");
	const run = await workflows(["thermoloop", ...argv], { ...options, cwd: repo });

	return { id: run.id ?? "", code: run.code, head, short: git(repo, "rev-parse", "--short", head) };
}

/** `workflows land <change>` with a CI wait of 1 s, and its exit code and result. */
async function land(change: string) {
	const run = await workflows(["land", change, "--wait", "1", "--json"], { cwd: repo });

	return { code: run.code, result: JSON.parse(run.stdout[1] ?? "{}").value };
}

/** `main` in the main checkout and on `origin`. */
const mains = () => [git(repo, "rev-parse", "main"), git(origin, "rev-parse", "main")];

const ghLog = (tool = "gh") => readFile(join(root, `${tool}.log`), "utf8").catch(() => "");

/** Expects the end state of a landing of `run`: `main` at its head on both sides, and its branch and worktree gone. */
function expectLanded(run: { id: string; branch: string; head: string }): void {
	expect(mains()).toEqual([run.head, run.head]);
	expect(git(repo, "branch", "--list", run.branch)).toBe("");
	expect(git(origin, "branch", "--list", run.branch)).toBe("");
	expect(git(repo, "branch", "-r", "--list", `origin/${run.branch}`)).toBe("");
	expect(existsSync(worktreeAt(repo, run.id))).toBe(false);
}

describe("workflows land", () => {
	it.each(["github", "gitlab"] as const)(
		"lands a green branch on main, deletes the branch and sweeps the run on %s",
		async (kind) => {
			originOn(kind);
			const run = await shipped();

			const landed = await land(run.id);
			expect(landed).toEqual({
				code: 0,
				result: {
					status: "landed",
					head: run.short,
					change: { repository: await realpath(repo), branch: run.branch },
					report: [`landed ${SUBJECT} ${run.short}, CI passed on the branch and on main`],
				},
			});
			expectLanded(run);
			expect(git(repo, "rev-list", "--count", "main")).toBe("3");
			const log = await ghLog(HOSTS[kind].tool);
			const listed = kind === "github" ? "run list --repo github.com/octo/demo --commit " : "/pipelines?sha=";
			const branch = kind === "github" ? ` --branch ${run.branch} ` : `&ref=${encodeURIComponent(run.branch)}`;
			expect(log).toContain(`${listed}${run.head}${branch}`);
			expect(log).toContain(`${listed}${run.head}${kind === "github" ? " --branch main " : "&ref=main\n"}`);
			expect(await ghLog(kind === "github" ? "glab" : "gh")).toBe("");
			const rows = JSON.parse((await workflows(["list", "--json"], { cwd: repo })).stdout[0] ?? "");
			expect(rows.find((row: { runId: string }) => row.runId === run.id)?.swept).toBe("landed");
		},
	);

	it("lands a branch made by hand in a linked worktree, and removes the worktree", async () => {
		const path = join(root, "feature-tree");
		git(repo, "worktree", "add", "-q", "-b", "feature", path);
		await writeFile(join(path, "feature.txt"), "feature\n");
		git(path, "add", "feature.txt");
		git(path, "commit", "-q", "-m", SUBJECT);
		const head = git(path, "rev-parse", "HEAD");
		const short = git(path, "rev-parse", "--short", "HEAD");

		const landed = await land("feature");
		expect(landed).toEqual({
			code: 0,
			result: {
				status: "landed",
				head: short,
				change: { repository: await realpath(repo), branch: "feature" },
				report: [`landed ${SUBJECT} ${short}, CI passed on the branch and on main`],
			},
		});
		expect(mains()).toEqual([head, head]);
		expect(git(repo, "branch", "--list", "feature")).toBe("");
		expect(git(origin, "branch", "--list", "feature")).toBe("");
		expect(git(repo, "branch", "-r", "--list", "origin/feature")).toBe("");
		expect(existsSync(path)).toBe(false);
	});

	it.each(["github", "gitlab"] as const)("lands the head branch of a PR number on %s", async (kind) => {
		originOn(kind);
		git(repo, "branch", "feature");
		git(repo, "checkout", "-q", "feature");
		await writeFile(join(repo, "feature.txt"), "feature\n");
		git(repo, "add", "feature.txt");
		git(repo, "commit", "-q", "-m", SUBJECT);
		git(repo, "checkout", "-q", "main");
		const head = git(repo, "rev-parse", "feature");
		const short = git(repo, "rev-parse", "--short", "feature");

		const landed = await land("7");
		expect([landed.code, landed.result.change, landed.result.report]).toEqual([
			0,
			{ repository: await realpath(repo), branch: "feature" },
			[`landed ${SUBJECT} ${short}, CI passed on the branch and on main`],
		]);
		expect(mains()).toEqual([head, head]);
		expect(git(repo, "branch", "--list", "feature")).toBe("");
	});

	it("refuses a red branch, and leaves main untouched on both sides", async () => {
		await ci("red", "green");
		const run = await shipped();
		const before = mains();

		const refused = await land(run.id);
		expect([refused.code, refused.result.status, refused.result.report]).toEqual([
			1,
			"refused",
			[`refused at step 4: CI failed on ${run.branch} at ${run.short}: CI https://ci/2`],
		]);
		expect(mains()).toEqual(before);
		expect(await ghLog()).not.toContain("--branch main ");
		expect(existsSync(worktreeAt(repo, run.id))).toBe(true);
	});

	it("refuses a branch with no CI run after the wait", async () => {
		await ci("none", "green");
		const run = await shipped();
		const before = mains();

		const refused = await land(run.id);
		expect([refused.code, refused.result.report]).toEqual([
			1,
			[`refused at step 4: no CI run for ${run.short} on ${run.branch} after 1 s`],
		]);
		expect(mains()).toEqual(before);
	});

	it("refuses a main checkout with uncommitted changes", async () => {
		const run = await shipped();
		await writeFile(join(repo, "README.md"), "changed\n");

		const refused = await land(run.id);
		expect([refused.code, refused.result.report]).toEqual([
			1,
			[`refused at step 2: the main checkout ${await realpath(repo)} has uncommitted changes`],
		]);
		expect(await ghLog()).toBe("");
	});

	it("refuses a main checkout behind origin/main", async () => {
		const run = await shipped();
		const other = join(root, "other");
		git(root, "clone", "-q", origin, other);
		await writeFile(join(other, "other.txt"), "other\n");
		git(other, "add", "other.txt");
		git(other, "commit", "-q", "-m", "other");
		git(other, "push", "-q", "origin", "main");
		const local = git(repo, "rev-parse", "--short", "main");
		const remote = git(origin, "rev-parse", "--short", "main");

		const refused = await land(run.id);
		expect([refused.code, refused.result.report]).toEqual([
			1,
			[`refused at step 2: main ${local} differs from origin/main ${remote}`],
		]);
		expect(git(origin, "branch", "--list", run.branch)).toBe("");
	});

	it("refuses a branch that is not a fast-forward of main", async () => {
		const run = await shipped();
		await writeFile(join(repo, "other.txt"), "other\n");
		git(repo, "add", "other.txt");
		git(repo, "commit", "-q", "-m", "other");
		git(repo, "push", "-q", "origin", "main");
		const before = mains();

		const refused = await land(run.id);
		expect([refused.code, refused.result.report]).toEqual([
			1,
			[`refused at step 2: ${run.branch} is not a fast-forward of main`],
		]);
		expect(mains()).toEqual(before);
	});

	it("lands a stopped campaign run, and refuses a change that is not there", async () => {
		const stopped = await workflows(["campaign"], { cwd: repo });
		expect(stopped.code).toBe(0);
		const branch = `campaign/${stopped.id}`;

		const worktree = git(repo, "worktree", "list", "--porcelain")
			.split("\n")
			.filter((line) => line.startsWith("worktree "))
			.at(-1)
			?.slice("worktree ".length);

		await writeFile(join(worktree ?? "", "campaign.txt"), "campaign\n");
		git(worktree ?? "", "add", "campaign.txt");
		git(worktree ?? "", "commit", "-q", "-m", SUBJECT);
		const head = git(repo, "rev-parse", branch);

		const landed = await land(stopped.id ?? "");
		expect([landed.code, landed.result.status, landed.result.change]).toEqual([
			0,
			"landed",
			{ repository: await realpath(repo), branch },
		]);
		expectLanded({ id: stopped.id ?? "", branch, head });

		const unknown = await land("nope");
		expect(unknown.result.report).toEqual([
			`refused at step 1: nope is no PR number, no branch of ${await realpath(repo)} and no completed run`,
		]);
	});

	it("lands an approved thermoloop run from the main checkout on its branch, and deletes the branch", async () => {
		const { id, code, head, short } = await reviewed(["--json"]);
		expect(code).toBe(0);

		const landed = await land(id);
		expect(landed).toEqual({
			code: 0,
			result: {
				status: "landed",
				head: short,
				change: { repository: await realpath(repo), branch: "fix/x" },
				report: [`landed fix: the thing ${short}, CI passed on the branch and on main`],
			},
		});
		expectLanded({ id, branch: "fix/x", head });
		expect(git(repo, "branch", "--show-current")).toBe("main");
	});

	it("refuses a thermoloop run on main, and leaves main untouched", async () => {
		await writeFile(join(repo, "fix.txt"), "fix\n");
		git(repo, "add", "fix.txt");
		git(repo, "commit", "-q", "-m", "fix: the thing");
		const run = await workflows(["thermoloop", "--base", "HEAD~1", "--json"], { cwd: repo });
		expect(run.code).toBe(0);
		const before = mains();

		const refused = await land(run.id ?? "");
		expect([refused.code, refused.result.report]).toEqual([1, ["refused at step 1: the branch is main"]]);
		expect(mains()).toEqual(before);
	});

	it.each(["github", "gitlab"] as const)(
		"gives landed-red for a red main on %s, names the failed run and reverts nothing",
		async (kind) => {
			originOn(kind);
			await ci("green", "red");
			const run = await shipped();

			const red = await land(run.id);
			expect([red.code, red.result.status, red.result.report]).toEqual([
				1,
				"landed-red",
				[
					`landed-red ${SUBJECT} ${run.short}, CI passed on the branch; CI failed on main at ${run.short}: ${RED_NAME[kind]}`,
				],
			]);
			expectLanded(run);
		},
	);

	it("reports the head for the run, with the labels of the run", async () => {
		await setEntries({ labels: LABELS_ENTRY });
		const run = await shipped("item:1");

		const landed = await land(run.id);
		expect([landed.code, landed.result.report]).toEqual([
			0,
			[`landed ${SUBJECT} ${run.short}, CI passed on the branch and on main`],
		]);
		expectLanded(run);
		// Step 7 reports the head, and the sweep of step 9 reports it again; the task keeps it once.
		const event = { labels: ["item:1"], refs: [`commit:${run.head}`] };
		expect(await reportedEvents()).toEqual([event, event]);
		const host = await startHost();

		try {
			const task = await request({ type: "task", key: `wf:${run.id}#1` }, { start: false });
			expect(task?.refs).toEqual([`commit:${run.head}`]);
		} finally {
			await host.close();
		}
	});

	it("finishes on resume a landing that stopped after the push of main", async () => {
		const run = await shipped();
		const gate = await gateGit(root, `-C ${await realpath(repo)} push -q origin ${run.head}:refs/heads/main`);
		const interrupt = new AbortController();
		const pending = workflows(["land", run.id, "--wait", "1"], { cwd: repo, interrupt });

		await gate.reached();
		interrupt.abort();
		const first = await pending;
		await gate.open();
		expect(first.code).toBe(130);
		expect(git(origin, "rev-parse", "main")).toBe(run.head);
		expect(git(repo, "rev-parse", "main")).not.toBe(run.head);

		const resumed = await workflows(["resume", first.id ?? ""], { cwd: repo });
		expect([resumed.code, resumed.stdout.slice(1)]).toEqual([
			0,
			[`landed ${SUBJECT} ${run.short}, CI passed on the branch and on main`],
		]);
		expectLanded(run);
	});
});
