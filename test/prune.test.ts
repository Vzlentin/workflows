import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TASK } from "../src/task.ts";
import { git, repository, runsOf, sandbox, storeOf, workflows } from "./support.ts";

let root: string;
let repo: string;

/** Writes the executable `bin/<name>` of the sandbox. */
async function fake(name: string, body: string): Promise<void> {
	const file = join(root, "bin", name);
	await writeFile(file, `#!/bin/sh\n${body}`);
	await chmod(file, 0o755);
}

beforeEach(async () => {
	root = await sandbox();
	repo = join(root, "repo");
	await repository(repo);
	const scripts = join(repo, ".workflows", "workflows");
	await mkdir(scripts, { recursive: true });
	await writeFile(join(scripts, "w.js"), 'export const meta = { worktree: true }\nreturn "done"');
	await writeFile(
		join(scripts, "slow.js"),
		'export const meta = { worktree: true }\nreturn await agent("Script: one")',
	);
	// A merged pull request comes from the branch feat/x at the commit of the worktree, and from feat/old at another
	// commit.
	await fake(
		"gh",
		`echo "$@" >> "${root}/gh.log"
case "$*" in
*"--head feat/x "*) echo "[{\\"headRefOid\\":\\"$(git rev-parse HEAD)\\"}]" ;;
*"--head feat/old "*) echo '[{"headRefOid":"0000000000000000000000000000000000000000"}]' ;;
*) echo '[]' ;;
esac
`,
	);
});

afterEach(() => rm(root, { recursive: true, force: true }));

/** An ended run of `w` whose worktree is on the branch feat/x, with its ID and worktree. */
async function mergedRun(): Promise<{ id: string; worktree: string }> {
	const run = await workflows(["w"], { cwd: repo });
	expect(run.code).toBe(0);
	const id = run.id ?? "";
	const worktree = join(runsOf(root), id, "worktree");
	git(worktree, "branch", "-m", "feat/x");

	return { id, worktree };
}

/** Marks the run task of the store as saved by `version`, with its input wrapped as `{ input }` when `wrap` is set. */
function saveAs(version: number, wrap: boolean): void {
	const database = new DatabaseSync(storeOf());
	const input = wrap ? ", '$.input', json_object('input', record -> '$.input')" : "";
	database
		.prepare(
			`UPDATE tasks SET record = json_set(record, '$.version', ?${input}) WHERE record ->> '$.kind' = 'workflows.run'`,
		)
		.run(version);
	database.close();
}

const hasBranch = (name: string) => git(repo, "branch", "--list", name) !== "";

describe("workflows prune", () => {
	it("lists the ended runs on a merged branch, and removes their worktree and branch with --yes", async () => {
		const other = await workflows(["w"], { cwd: repo });
		expect(other.code).toBe(0);
		const { id, worktree } = await mergedRun();

		const listed = await workflows(["prune"], { cwd: repo });
		expect([listed.code, listed.stdout]).toEqual([0, [`${id} feat/x ${worktree}`]]);
		const json = await workflows(["prune", "--json"], { cwd: repo });
		expect(JSON.parse(json.stdout[0] ?? "")).toEqual([{ runId: id, branch: "feat/x", worktree }]);
		expect(existsSync(worktree)).toBe(true);

		const pruned = await workflows(["prune", "--yes"], { cwd: repo });
		expect([pruned.code, pruned.stdout]).toEqual([0, [`${id} feat/x ${worktree}`]]);
		expect(existsSync(worktree)).toBe(false);
		expect(hasBranch("feat/x")).toBe(false);
		expect(existsSync(join(runsOf(root), other.id ?? "", "worktree"))).toBe(true);

		const runs = await workflows(["list"], { cwd: repo });
		expect(runs.stdout).toContain(`${id} w done w`);
	});

	it("removes the worktree and branch of a run that an earlier version saved", async () => {
		const { id, worktree } = await mergedRun();
		saveAs(TASK.version - 1, true);
		const listed = await workflows(["list", "--json"], { cwd: repo });
		expect(JSON.parse(listed.stdout[0] ?? "")).toEqual([
			{ runId: id, workflow: "w", title: "w", status: "done", repository: await realpath(repo) },
		]);

		const pruned = await workflows(["prune", "--yes"], { cwd: repo });
		expect([pruned.code, pruned.stdout]).toEqual([0, [`${id} feat/x ${worktree}`]]);
		expect(existsSync(worktree)).toBe(false);
		expect(hasBranch("feat/x")).toBe(false);
	});

	it("keeps a run that a later version saved", async () => {
		const { worktree } = await mergedRun();
		saveAs(TASK.version + 1, false);

		const pruned = await workflows(["prune", "--yes"], { cwd: repo });
		expect([pruned.code, pruned.stdout]).toEqual([0, []]);
		expect(existsSync(worktree)).toBe(true);
		expect(hasBranch("feat/x")).toBe(true);
	});

	it("keeps a run whose branch name had a pull request merged at another commit", async () => {
		const run = await workflows(["w"], { cwd: repo });
		expect(run.code).toBe(0);
		const worktree = join(runsOf(root), run.id ?? "", "worktree");
		git(worktree, "branch", "-m", "feat/old");

		const pruned = await workflows(["prune", "--yes"], { cwd: repo });
		expect([pruned.code, pruned.stdout]).toEqual([0, []]);
		expect(existsSync(worktree)).toBe(true);
		expect(hasBranch("feat/old")).toBe(true);
	});

	it("skips a run whose worktree Git no longer knows", async () => {
		const broken = await workflows(["w"], { cwd: repo });
		expect(broken.code).toBe(0);
		const brokenRun = join(runsOf(root), broken.id ?? "");
		await rm(join(brokenRun, "worktree", ".git"));
		git(root, "init", "-q", "-b", "feat/x");
		const { id, worktree } = await mergedRun();

		const listed = await workflows(["prune"], { cwd: repo });
		expect([listed.code, listed.stdout]).toEqual([0, [`${id} feat/x ${worktree}`]]);

		const pruned = await workflows(["prune", "--yes"], { cwd: repo });
		expect([pruned.code, pruned.stdout]).toEqual([0, [`${id} feat/x ${worktree}`]]);
		expect(existsSync(worktree)).toBe(false);
		expect(existsSync(brokenRun)).toBe(true);
	});

	it("removes a worktree through the herdr workspace that has it open", async () => {
		const { worktree } = await mergedRun();
		process.env.HERDR_ENV = "1";
		const path = await realpath(worktree);
		const listed = JSON.stringify({ result: { worktrees: [{ path, open_workspace_id: "w1" }] } });
		await fake(
			"herdr",
			`case "$2" in
list) echo '${listed}' ;;
remove) echo "$@" >> "${root}/herdr.log"; exec git -C "${repo}" worktree remove "${worktree}" ;;
esac
`,
		);

		const pruned = await workflows(["prune", "--yes"], { cwd: repo });
		expect(pruned.code).toBe(0);
		expect(await readFile(join(root, "herdr.log"), "utf8")).toContain("--workspace w1");
		expect(existsSync(worktree)).toBe(false);
		expect(hasBranch("feat/x")).toBe(false);
	});

	it("keeps a run that has not ended, also on a merged branch", async () => {
		const run = await workflows(["slow"], { cwd: repo, script: { interruptAt: { kind: "script", nth: 1 } } });
		expect(run.code).toBe(130);
		const worktree = join(runsOf(root), run.id ?? "", "worktree");
		git(worktree, "branch", "-m", "feat/x");

		const pruned = await workflows(["prune", "--yes"], { cwd: repo });
		expect([pruned.code, pruned.stdout]).toEqual([0, []]);
		expect(existsSync(worktree)).toBe(true);
	});

	it("removes nothing when gh fails", async () => {
		const { worktree } = await mergedRun();
		await fake("gh", 'echo "gh: not logged in" >&2\nexit 1\n');

		const pruned = await workflows(["prune", "--yes"], { cwd: repo });
		expect(pruned.code).toBe(1);
		expect(pruned.stderr.join("\n")).toContain("gh: not logged in");
		expect(existsSync(worktree)).toBe(true);
	});

	it("installs a post-merge hook, and refuses to replace a hook or a hooks path", async () => {
		const line = "workflows prune --yes >/dev/null 2>&1 &";
		const hook = join(repo, ".git", "hooks", "post-merge");

		const installed = await workflows(["prune", "--install-hook"], { cwd: repo });
		expect([installed.code, installed.stdout]).toEqual([0, [hook]]);
		expect(await readFile(hook, "utf8")).toContain(line);
		expect((await stat(hook)).mode & 0o111).toBe(0o111);

		const again = await workflows(["prune", "--install-hook"], { cwd: repo });
		expect(again.code).toBe(1);
		expect(again.stderr.join("\n")).toContain(line);

		await rm(hook);
		git(repo, "config", "core.hooksPath", "x");
		const refused = await workflows(["prune", "--install-hook"], { cwd: repo });
		expect(refused.code).toBe(1);
		expect(refused.stderr.join("\n")).toContain(line);
		expect(existsSync(hook)).toBe(false);
		expect(existsSync(join(repo, "x"))).toBe(false);
	});
});
