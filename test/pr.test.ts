import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import {
	answerKey,
	branchArgs,
	git,
	gitlabApi,
	HOSTS,
	type HostKind,
	hostAnswer,
	hostBranch,
	hostOrigin,
	hostPull,
	repository,
	sandbox,
	workflows,
} from "./support.ts";

let root: string;
let repo: string;

const SUBJECT = "feat: add the feature";

beforeEach(async () => {
	root = await sandbox();
	repo = join(root, "repo");
	await repository(repo);
	const scripts = join(repo, ".workflows", "scripts");
	await mkdir(scripts, { recursive: true });
	// A ship run with one commit and a judge score; the engine names its branch from its subject.
	await writeFile(
		join(scripts, "ship.js"),
		`export const meta = {
	worktree: true,
	args: { item: { type: "text", positional: true, label: "work item", required: true } },
	exit: { shipped: 0 },
}
await sh("echo feature > feature.txt && git add feature.txt && git commit -q -m '${SUBJECT}' -m 'Why it helps.'")
return { status: "shipped", subject: "${SUBJECT}", score: 0.9 }`,
	);
	// A campaign run with two commits and a title, which keeps the branch of its worktree.
	await writeFile(
		join(scripts, "campaign.js"),
		`export const meta = { worktree: true, exit: { stopped: 0 } }
title("Campaign title")
await sh("echo one > one.txt && git add one.txt && git commit -q -m 'feat: one'")
await sh("echo two > two.txt && git add two.txt && git commit -q -m 'feat: two'")
return { status: "stopped" }`,
	);
	git(repo, "add", ".workflows");
	git(repo, "commit", "-q", "-m", "add the scripts");
});

afterEach(() => rm(root, { recursive: true, force: true }));

/** The log of the fake tool of `kind`. */
const toolLog = (kind: HostKind) => readFile(join(root, `${HOSTS[kind].tool}.log`), "utf8").catch(() => "");

/** The URL of the pull request `number` of the test repository on `kind`. */
const pullUrl = (kind: HostKind, number: number) =>
	kind === "github"
		? `https://github.com/octo/demo/pull/${number}`
		: `https://gitlab.com/octo/demo/-/merge_requests/${number}`;

/** The arguments of the creation of the pull request of `branch` into `main` with `title` and `body` on `kind`. */
function createArgs(kind: HostKind, branch: string, title: string, body: string): string[] {
	if (kind === "github") {
		return ["pr", "create", "--repo", "github.com/octo/demo", "--head", branch, "--base", "main"].concat([
			"--title",
			title,
			"--body",
			body,
		]);
	}

	const fields = [`source_branch=${branch}`, "target_branch=main", `title=${title}`, `description=${body}`];

	return [...gitlabApi("merge_requests"), "--method", "POST", ...fields.flatMap((field) => ["--raw-field", field])];
}

/**
 * Makes the fake tool of `kind` create the pull request 9 of `branch` with `title` and `body`, and gives the arguments
 * that the tool must get. The answer key is cut at 200 characters, so the test checks the arguments in the log.
 */
async function created(kind: HostKind, branch: string, title: string, body: string): Promise<string> {
	const args = createArgs(kind, branch, title, body);
	await hostAnswer(root, HOSTS[kind].tool, args, {
		stdout: kind === "github" ? `${pullUrl(kind, 9)}\n` : '{"iid":9}',
	});
	await hostPull(root, kind, 9, { branch, title, body });

	return args.join(" ");
}

/** The arguments of the read of the issue `number` of the test repository on `kind`. */
const issueArgs = (kind: HostKind, number: number) =>
	kind === "github"
		? ["issue", "view", String(number), "--repo", "github.com/octo/demo", "--json", "state"]
		: gitlabApi(`issues/${number}`);

/** Makes the fake tool of `kind` give the issue `number` as open, closed, or missing. */
function issue(kind: HostKind, number: number, state: "open" | "closed" | "missing"): Promise<void> {
	const { tool } = HOSTS[kind];

	if (state === "missing") {
		const fail =
			kind === "github"
				? `GraphQL: Could not resolve to an issue or pull request with the number of ${number}.`
				: "glab: 404 Not Found (HTTP 404)";

		return hostAnswer(root, tool, issueArgs(kind, number), { fail });
	}

	const word = kind === "github" ? state.toUpperCase() : state === "open" ? "opened" : "closed";

	return hostAnswer(root, tool, issueArgs(kind, number), { stdout: JSON.stringify({ state: word }) });
}

/** A completed run of `argv` from the repository: its ID and the branch of its change. */
async function completed(argv: string[]): Promise<{ id: string; branch: string }> {
	const run = await workflows([...argv, "--json"], { cwd: repo });
	expect(run.code).toBe(0);
	const { change } = JSON.parse(run.stdout[1] ?? "{}").value;

	return { id: run.id ?? "", branch: change.branch };
}

const pr = (change: string) => workflows(["pr", change], { cwd: repo });

describe.each(["github", "gitlab"] as const)("workflows pr on %s", (kind) => {
	beforeEach(async () => {
		await hostOrigin(root, repo, kind);
	});

	it("opens the pull request of a ship run with its body, its score and the open issue of its item", async () => {
		const run = await completed(["ship", "Fix the typo, see #3"]);
		await hostBranch(root, kind, run.branch, null);
		await issue(kind, 3, "open");
		const args = await created(kind, run.branch, SUBJECT, "Why it helps.\n\njudge 0.90\n\nCloses #3");

		const opened = await pr(run.id);
		expect([opened.code, opened.stderr]).toEqual([0, []]);
		expect(opened.stdout.at(-1)).toBe(pullUrl(kind, 9));
		expect(await toolLog(kind)).toContain(args);
		const origin = join(root, kind, HOSTS[kind].path);
		expect(git(origin, "rev-parse", run.branch)).toBe(git(repo, "rev-parse", run.branch));
	});

	it.each([
		["closed", "#4"],
		["missing", "https://HOST/octo/demo/issues/4"],
	] as const)("has no Closes line for a %s issue", async (state, reference) => {
		const url =
			kind === "github"
				? reference.replace("HOST", "github.com")
				: reference.replace("HOST/octo/demo", "gitlab.com/octo/demo/-");

		const run = await completed(["ship", `Fix the typo, see ${url}`]);
		await hostBranch(root, kind, run.branch, null);
		await issue(kind, 4, state);
		const args = await created(kind, run.branch, SUBJECT, "Why it helps.\n\njudge 0.90");

		const opened = await pr(run.id);
		expect([opened.code, opened.stderr]).toEqual([0, []]);
		const log = await toolLog(kind);
		expect(log).toContain(issueArgs(kind, 4).join(" "));
		expect(log).toContain(args);
		expect(log).not.toContain("Closes");
	});

	it("titles the pull request of a campaign run with the run title and lists its commits", async () => {
		const run = await completed(["campaign"]);
		await hostBranch(root, kind, run.branch, null);
		const args = await created(kind, run.branch, "Campaign title", "- feat: one\n- feat: two");

		const opened = await pr(run.id);
		expect([opened.code, opened.stderr]).toEqual([0, []]);
		expect(opened.stdout.at(-1)).toBe(pullUrl(kind, 9));
		expect(await toolLog(kind)).toContain(args);
	});

	it("opens the pull request of a bare branch with the subject of its first commit", async () => {
		await commits("feature", ["feat: first", "feat: second"]);
		await hostBranch(root, kind, "feature", null);
		const args = await created(kind, "feature", "feat: first", "- feat: first\n- feat: second");

		const opened = await pr("feature");
		expect([opened.code, opened.stderr]).toEqual([0, []]);
		expect(opened.stdout.at(-1)).toBe(pullUrl(kind, 9));
		expect(await toolLog(kind)).toContain(args);
	});

	it("pushes a branch with an open pull request and prints its URL", async () => {
		const tip = await commits("feature", ["feat: first"]);
		await hostBranch(root, kind, "feature", 5);
		await hostPull(root, kind, 5, { branch: "feature" });

		const opened = await pr("feature");
		expect([opened.code, opened.stdout, opened.stderr]).toEqual([0, [pullUrl(kind, 5)], []]);
		expect(git(join(root, kind, HOSTS[kind].path), "rev-parse", "feature")).toBe(tip);
		expect(await toolLog(kind)).not.toMatch(/pr create|--method POST/);
	});

	it("refuses a branch whose pull request is merged at its tip", async () => {
		const tip = await commits("feature", ["feat: first"]);
		await hostBranch(root, kind, "feature", 5);
		await hostPull(root, kind, 5, { branch: "feature", state: "merged", head: tip, mergeCommit: "m" });

		const refused = await pr("feature");
		expect([refused.code, refused.stderr]).toEqual([
			1,
			[`workflows: the branch feature is merged: ${pullUrl(kind, 5)}`],
		]);
		expect(git(join(root, kind, HOSTS[kind].path), "branch", "--list", "feature")).toBe("");
	});

	it("refuses a branch that main already has", async () => {
		await commits("feature", ["feat: first"]);
		git(repo, "checkout", "-q", "feature", "--", "first.txt");
		git(repo, "commit", "-q", "-m", "feat: first, squashed");
		git(repo, "push", "-q", "origin", "main");
		await hostBranch(root, kind, "feature", null);

		const refused = await pr("feature");
		expect([refused.code, refused.stderr]).toEqual([1, ["workflows: the branch feature is merged in main"]]);
	});

	it("refuses a branch with no commit ahead of main", async () => {
		git(repo, "branch", "empty", "main");
		await hostBranch(root, kind, "empty", null);

		const refused = await pr("empty");
		expect([refused.code, refused.stderr]).toEqual([1, ["workflows: the branch empty has no commit ahead of main"]]);
	});

	it("pushes nothing when the tool is not logged in", async () => {
		await commits("feature", ["feat: first"]);

		const login =
			kind === "github"
				? ["auth", "token", "--hostname", "github.com"]
				: ["config", "get", "token", "--host", "gitlab.com"];

		await rm(join(root, HOSTS[kind].tool, answerKey(login)));

		const refused = await pr("feature");
		const host = kind === "github" ? "github.com" : "gitlab.com";

		expect([refused.code, refused.stderr]).toEqual([
			1,
			[`workflows: ${HOSTS[kind].tool} is not logged in to ${host}, so workflows cannot reach ${host}/octo/demo`],
		]);

		expect(git(join(root, kind, HOSTS[kind].path), "branch", "--list", "feature")).toBe("");
		expect(await toolLog(kind)).not.toContain(branchArgs(kind, "feature").join(" "));
	});
});

/**
 * Makes the branch `name` from `main` in the repository, with one commit for each subject, each of which writes a file
 * named from the first word after `feat: `, and gives its tip.
 */
async function commits(name: string, subjects: readonly string[]): Promise<string> {
	git(repo, "checkout", "-qb", name, "main");

	for (const subject of subjects) {
		const file = `${subject.replace(/^feat: /, "").split(" ")[0]}.txt`;
		await writeFile(join(repo, file), `${subject}\n`);
		git(repo, "add", file);
		git(repo, "commit", "-q", "-m", subject);
	}

	git(repo, "checkout", "-q", "main");

	return git(repo, "rev-parse", name);
}
