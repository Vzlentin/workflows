import { existsSync } from "node:fs";
import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { request } from "@vzlentin/harness/client";
import { type Request, StagedItem } from "@vzlentin/harness/protocol";
import { Value } from "typebox/value";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { fake, gateGit, git, hostModel, repository, sandbox, startHost, workflows, worktreeAt } from "./support.ts";

let root: string;
let repo: string;
let origin: string;

const SUBJECT = "feat: add the feature";
const GREEN = '[{"databaseId":1,"workflowName":"CI","status":"completed","conclusion":"success","url":"https://ci/1"}]';
const RED = '[{"databaseId":2,"workflowName":"CI","status":"completed","conclusion":"failure","url":"https://ci/2"}]';

/** Writes the CI runs that the fake `gh` gives for the branch and for `main`. */
async function ci(branch: string, main: string): Promise<void> {
	await writeFile(join(root, "ci-branch.json"), branch);
	await writeFile(join(root, "ci-main.json"), main);
}

beforeEach(async () => {
	root = await sandbox();
	repo = join(root, "repo");
	origin = join(root, "origin.git");
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
	// A campaign run that stops with no subject, so it gets no branch.
	await writeFile(
		join(scripts, "campaign.js"),
		'export const meta = { worktree: true, exit: { stopped: 0 } }\nreturn { status: "stopped" }',
	);
	git(repo, "add", ".workflows");
	git(repo, "commit", "-q", "-m", "add the scripts");
	git(root, "clone", "-q", "--bare", repo, origin);
	git(repo, "remote", "add", "origin", origin);
	git(repo, "fetch", "-q", "origin");
	await fake(
		root,
		"gh",
		`echo "$@" >> "${root}/gh.log"
[ "$1 $2" = "run list" ] || exit 1
case "$*" in
*"--branch main "*) cat "${root}/ci-main.json" ;;
*) cat "${root}/ci-branch.json" ;;
esac
`,
	);
	await ci(GREEN, GREEN);
});

afterEach(() => rm(root, { recursive: true, force: true }));

/** Sends the `item` request `sent`, an `add` or a `read`, to a new host of the sandbox, and gives the item. */
async function toHost(
	sent: Extract<Request, { type: "item"; action: "add" }> | Extract<Request, { type: "item"; action: "read" }>,
): Promise<StagedItem> {
	const host = await startHost();

	try {
		return Value.Parse(StagedItem, await request(sent, { start: false }));
	} finally {
		await host.close();
	}
}

/**
 * A completed ship run with a commit on its branch, which serves `serves` when given: its ID, its branch, and the full
 * and short head.
 */
async function shipped(serves?: string): Promise<{ id: string; branch: string; head: string; short: string }> {
	const run = await workflows(["ship", ...(serves === undefined ? [] : ["--serves", serves]), "--json"], { cwd: repo });
	expect(run.code).toBe(0);
	const { branch } = JSON.parse(run.stdout[1] ?? "{}").value;
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

/** `workflows land <id>` with a CI wait of 1 s, and its exit code and result. */
async function land(id: string) {
	const run = await workflows(["land", id, "--wait", "1", "--json"], { cwd: repo });

	return { code: run.code, result: JSON.parse(run.stdout[1] ?? "{}").value };
}

/** `main` in the main checkout and on `origin`. */
const mains = () => [git(repo, "rev-parse", "main"), git(origin, "rev-parse", "main")];

const ghLog = () => readFile(join(root, "gh.log"), "utf8").catch(() => "");

/** Expects the end state of a landing of `run`: `main` at its head on both sides, and its branch and worktree gone. */
function expectLanded(run: { id: string; branch: string; head: string }): void {
	expect(mains()).toEqual([run.head, run.head]);
	expect(git(repo, "branch", "--list", run.branch)).toBe("");
	expect(git(origin, "branch", "--list", run.branch)).toBe("");
	expect(git(repo, "branch", "-r", "--list", `origin/${run.branch}`)).toBe("");
	expect(existsSync(worktreeAt(repo, run.id))).toBe(false);
}

describe("workflows land", () => {
	it("lands a green branch on main, deletes the branch and sweeps the run", async () => {
		const run = await shipped();

		const landed = await land(run.id);
		expect(landed).toEqual({
			code: 0,
			result: {
				status: "landed",
				head: run.short,
				branch: run.branch,
				report: [`landed ${SUBJECT} ${run.short}, CI passed on the branch and on main`],
			},
		});
		expectLanded(run);
		expect(git(repo, "rev-list", "--count", "main")).toBe("3");
		const log = await ghLog();
		expect(log).toContain(`run list --commit ${run.head} --branch ${run.branch} `);
		expect(log).toContain(`run list --commit ${run.head} --branch main `);
	});

	it("refuses a red branch, and leaves main untouched on both sides", async () => {
		await ci(RED, GREEN);
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
		await ci("[]", GREEN);
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

	it("refuses at step 1 a run with no branch, and a run that is not a completed run", async () => {
		const stopped = await workflows(["campaign"], { cwd: repo });
		expect(stopped.code).toBe(0);

		const refused = await land(stopped.id ?? "");
		expect([refused.code, refused.result]).toEqual([
			1,
			{
				status: "refused",
				report: [`refused at step 1: the campaign run ${stopped.id} ended stopped and has no branch`],
			},
		]);

		const unknown = await land("nope");
		expect(unknown.result.report).toEqual([
			"refused at step 1: run nope has not ended or is not a run of ship, campaign or thermoloop",
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
				branch: "fix/x",
				report: [`landed fix: the thing ${short}, CI passed on the branch and on main`],
			},
		});
		expectLanded({ id, branch: "fix/x", head });
		expect(git(repo, "branch", "--show-current")).toBe("main");
	});

	it("refuses a thermoloop run that is not approved, and leaves main untouched", async () => {
		const stopped = await reviewed(["--rounds", "1"], { script: { verdicts: ["FIX"] } });
		expect(stopped.code).toBe(1);
		const before = mains();

		const refused = await land(stopped.id);
		expect([refused.code, refused.result.report]).toEqual([
			1,
			[`refused at step 1: the thermoloop run ${stopped.id} ended stopped, not approved`],
		]);
		expect(mains()).toEqual(before);
	});

	it("refuses a thermoloop run on main, and leaves main untouched", async () => {
		await writeFile(join(repo, "fix.txt"), "fix\n");
		git(repo, "add", "fix.txt");
		git(repo, "commit", "-q", "-m", "fix: the thing");
		const run = await workflows(["thermoloop", "--base", "HEAD~1", "--json"], { cwd: repo });
		expect(run.code).toBe(0);
		const before = mains();

		const refused = await land(run.id ?? "");
		expect([refused.code, refused.result.report]).toEqual([
			1,
			[`refused at step 1: the thermoloop run ${run.id} is on main`],
		]);
		expect(mains()).toEqual(before);
	});

	it("gives landed-red for a red main, names the failed run and reverts nothing", async () => {
		await ci(GREEN, RED);
		const run = await shipped();

		const red = await land(run.id);
		expect([red.code, red.result.status, red.result.report]).toEqual([
			1,
			"landed-red",
			[
				`landed-red ${SUBJECT} ${run.short}, CI passed on the branch; CI failed on main at ${run.short}: CI https://ci/2`,
			],
		]);
		expectLanded(run);
	});

	it("links the item of the run to the head and sets it to done", async () => {
		await toHost({ type: "item", action: "add", caller: "test", title: "Build it" });
		const run = await shipped("1");

		const landed = await land(run.id);
		expect([landed.code, landed.result.report]).toEqual([
			0,
			[`landed ${SUBJECT} ${run.short}, CI passed on the branch and on main`, "item 1 done"],
		]);
		expectLanded(run);
		const item = await toHost({ type: "item", action: "read", id: 1 });
		expect(item).toMatchObject({
			state: "done",
			edges: [
				{ from: `run:${run.id}`, kind: "serves", to: "item:1" },
				{ from: "item:1", kind: "landed", to: `commit:${run.head}` },
			],
		});
	});

	it("leaves open an item that a live agent serves, with the landed edge", async () => {
		await toHost({ type: "item", action: "add", caller: "test", title: "Build it" });
		const run = await shipped("1");
		const host = await startHost("main", hostModel().models);
		let landed;

		try {
			const spawn: Request = {
				type: "spawn",
				requestId: "serves-item",
				caller: "test",
				notify: false,
				provider: "anthropic",
				model: "claude-haiku-5",
				callerThinking: "medium",
				cwd: repo,
				prompt: "Build it",
				serves: { item: 1 },
			};

			await request(spawn, { start: false });
			const done = await workflows(["land", run.id, "--wait", "1", "--json"], { cwd: repo, host });
			landed = { code: done.code, result: JSON.parse(done.stdout[1] ?? "{}").value };
		} finally {
			await host.close();
		}

		expect(landed.code).toBe(0);
		expect(landed.result.report).toEqual([
			`landed ${SUBJECT} ${run.short}, CI passed on the branch and on main`,
			expect.stringMatching(/^item 1 stays open: .+ serves it$/),
		]);
		const item = await toHost({ type: "item", action: "read", id: 1 });
		expect(item).toMatchObject({
			state: "open",
			edges: expect.arrayContaining([
				{ from: "item:1", kind: "landed", to: `commit:${run.head}`, at: expect.any(Number), by: expect.any(String) },
			]),
		});
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
