import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TASK } from "../src/run/version.ts";
import { git, repository, runsOf, sandbox, saveAs, storeOf, workflows, worktreeAt } from "./support.ts";

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
	const scripts = join(repo, ".workflows", "scripts");
	await mkdir(scripts, { recursive: true });
	await writeFile(join(scripts, "w.js"), 'export const meta = { worktree: true }\nreturn "done"');
	await writeFile(
		join(scripts, "slow.js"),
		'export const meta = { worktree: true }\nreturn await agent("Script: one")',
	);
	// A merged pull request comes from the branches feat/x and feat/y at the commit of the worktree, and from feat/old at another
	// commit.
	await fake(
		"gh",
		`echo "$@" >> "${root}/gh.log"
case "$*" in
*"--head feat/x "* | *"--head feat/y "*) echo "[{\\"headRefOid\\":\\"$(git rev-parse HEAD)\\"}]" ;;
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
	const worktree = worktreeAt(repo, id);
	git(worktree, "branch", "-m", "feat/x");

	return { id, worktree };
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
		expect(existsSync(worktreeAt(repo, other.id))).toBe(true);
		expect(existsSync(join(runsOf(root), id))).toBe(true);

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

	it("resumes and prunes a run whose saved worktree is in its run directory", async () => {
		const scripts = join(repo, ".workflows", "scripts");
		await writeFile(
			join(scripts, "gated.js"),
			`export const meta = { worktree: true }\nawait sh("test -f ${root}/go")\nreturn cwd`,
		);
		const failed = await workflows(["gated"], { cwd: repo });
		expect(failed.code).toBe(1);
		const id = failed.id ?? "";
		git(repo, "worktree", "remove", "--force", worktreeAt(repo, id));
		const runDir = join(runsOf(root), id);
		const worktree = join(runDir, "worktree");
		const database = new DatabaseSync(storeOf());
		database
			.prepare(
				`UPDATE tasks SET record = json_set(record, '$.input.worktree.path', ?) WHERE record ->> '$.kind' = 'workflows.run'`,
			)
			.run(worktree);
		database.close();
		await writeFile(join(root, "go"), "");

		const resumed = await workflows(["resume", id], { cwd: repo });
		expect([resumed.code, resumed.stdout.at(-1)]).toEqual([0, worktree]);
		git(worktree, "branch", "-m", "feat/x");

		const pruned = await workflows(["prune", "--yes"], { cwd: repo });
		expect([pruned.code, pruned.stdout]).toEqual([0, [`${id} feat/x ${worktree}`]]);
		expect(existsSync(worktree)).toBe(false);
		expect(existsSync(runDir)).toBe(true);
	});

	it("decides by the last task of this version when a later version saved the last task", async () => {
		const scripts = join(repo, ".workflows", "scripts");
		await writeFile(
			join(scripts, "gated.js"),
			`export const meta = { worktree: true }\nawait sh("test -f ${root}/go")`,
		);
		const failed = await workflows(["gated"], { cwd: repo });
		expect(failed.code).toBe(1);
		const id = failed.id ?? "";
		await writeFile(join(root, "go"), "");
		expect((await workflows(["resume", id], { cwd: repo })).code).toBe(0);
		const worktree = worktreeAt(repo, id);
		git(worktree, "branch", "-m", "feat/x");
		// The last task of the run ended, and a later version saved it; the failed task before it is of this version.
		const database = new DatabaseSync(storeOf());

		database
			.prepare(
				`UPDATE tasks SET record = json_set(record, '$.version', ?) WHERE id = (SELECT max(id) FROM tasks WHERE record ->> '$.kind' = 'workflows.run')`,
			)
			.run(TASK.version + 1);

		database.close();

		const pruned = await workflows(["prune", "--yes"], { cwd: repo });
		expect([pruned.code, pruned.stdout]).toEqual([0, [`${id} feat/x ${worktree}`]]);
		expect(existsSync(worktree)).toBe(false);
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
		const worktree = worktreeAt(repo, run.id);
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
		await rm(join(worktreeAt(repo, broken.id), ".git"));
		git(root, "init", "-q", "-b", "feat/x");
		const { id, worktree } = await mergedRun();

		const listed = await workflows(["prune"], { cwd: repo });
		expect([listed.code, listed.stdout]).toEqual([0, [`${id} feat/x ${worktree}`]]);

		const pruned = await workflows(["prune", "--yes"], { cwd: repo });
		expect([pruned.code, pruned.stdout]).toEqual([0, [`${id} feat/x ${worktree}`]]);
		expect(existsSync(worktree)).toBe(false);
		expect(existsSync(brokenRun)).toBe(true);
	});

	it("kills and removes the hc terminals of the run before its worktree", async () => {
		const { id, worktree } = await mergedRun();
		await fake(
			"hc",
			`echo "$@" >> "${root}/hc.log"
[ "$1" = ls ] && echo '{"terminals":[{"address":"t5"},{"address":"m1/t6"}],"hidden_finished":0}'
exit 0
`,
		);

		const pruned = await workflows(["prune", "--yes"], { cwd: repo });
		expect(pruned.code).toBe(0);
		expect((await readFile(join(root, "hc.log"), "utf8")).trim().split("\n")).toEqual([
			`ls --all --json --label herdr.space=${id}`,
			"kill t5",
			"rm t5",
			"kill m1/t6",
			"rm m1/t6",
		]);
		expect([existsSync(worktree), hasBranch("feat/x")]).toEqual([false, false]);
	});

	it("keeps the worktree, and exits 1, when hc fails", async () => {
		const { id, worktree } = await mergedRun();
		await fake("hc", 'echo "hc: no server" >&2\nexit 1\n');

		const pruned = await workflows(["prune", "--yes"], { cwd: repo });
		expect([pruned.code, pruned.stdout, pruned.stderr]).toEqual([
			1,
			[],
			[`workflows: cannot prune ${id}: hc: no server`],
		]);
		expect([existsSync(worktree), hasBranch("feat/x")]).toEqual([true, true]);
		expect(existsSync(join(runsOf(root), id, "pruning"))).toBe(false);
	});

	it("takes a run whose HEAD is in origin/main as merged, with no gh call", async () => {
		const merged = await workflows(["w"], { cwd: repo });
		const ahead = await workflows(["w"], { cwd: repo });
		expect([merged.code, ahead.code]).toEqual([0, 0]);
		const worktree = worktreeAt(repo, merged.id);
		const kept = worktreeAt(repo, ahead.id);
		git(worktree, "branch", "-m", "feat/z");
		git(kept, "branch", "-m", "feat/w");
		git(kept, "commit", "-q", "--allow-empty", "-m", "more");
		git(repo, "update-ref", "refs/remotes/origin/main", git(worktree, "rev-parse", "HEAD"));

		const pruned = await workflows(["prune", "--yes"], { cwd: repo });
		expect([pruned.code, pruned.stdout]).toEqual([0, [`${merged.id} feat/z ${worktree}`]]);
		expect([existsSync(worktree), existsSync(kept)]).toEqual([false, true]);
		expect((await readFile(join(root, "gh.log"), "utf8")).trim().split("\n")).toEqual([
			"pr list --head feat/w --state merged --json headRefOid",
		]);
	});

	it("prunes only the given runs, with no merge check", async () => {
		const other = await mergedRun();
		const run = await workflows(["w"], { cwd: repo });
		expect(run.code).toBe(0);
		const id = run.id ?? "";
		const worktree = worktreeAt(repo, id);
		git(worktree, "branch", "-m", "feat/z");

		const listed = await workflows(["prune", id], { cwd: repo });
		expect([listed.code, listed.stdout]).toEqual([0, [`${id} feat/z ${worktree}`]]);
		const pruned = await workflows(["prune", id, "--yes"], { cwd: repo });
		expect([pruned.code, pruned.stdout]).toEqual([0, [`${id} feat/z ${worktree}`]]);
		expect([existsSync(worktree), hasBranch("feat/z")]).toEqual([false, false]);
		expect(existsSync(other.worktree)).toBe(true);
		expect(existsSync(join(root, "gh.log"))).toBe(false);
	});

	it("removes nothing, and exits 1, when a given run is not an ended run of the project with a worktree", async () => {
		const { id, worktree } = await mergedRun();
		const slow = await workflows(["slow"], { cwd: repo, script: { interruptAt: { kind: "script", nth: 1 } } });
		expect(slow.code).toBe(130);

		for (const bad of [slow.id ?? "", "20990101T000000-00000000", "../x"]) {
			const pruned = await workflows(["prune", id, bad, "--yes"], { cwd: repo });
			expect([pruned.code, pruned.stdout, pruned.stderr]).toEqual([
				1,
				[],
				[`workflows: cannot prune ${bad}: not an ended run of this project with a worktree on a branch`],
			]);
		}

		expect([existsSync(worktree), existsSync(worktreeAt(repo, slow.id))]).toEqual([true, true]);
	});

	it("keeps a run that has not ended, also on a merged branch", async () => {
		const run = await workflows(["slow"], { cwd: repo, script: { interruptAt: { kind: "script", nth: 1 } } });
		expect(run.code).toBe(130);
		const worktree = worktreeAt(repo, run.id);
		git(worktree, "branch", "-m", "feat/x");

		const pruned = await workflows(["prune", "--yes"], { cwd: repo });
		expect([pruned.code, pruned.stdout]).toEqual([0, []]);
		expect(existsSync(worktree)).toBe(true);
	});

	it("finishes at the next prune the removal that stopped after the worktree, with no gh call", async () => {
		const { id, worktree } = await mergedRun();
		const real = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
		// The first `git branch -D` fails, as when prune stops after it removed the worktree.
		await fake(
			"git",
			`case "$*" in
*"branch -D "*) [ -e "${root}/failed" ] || { touch "${root}/failed"; exit 1; } ;;
esac
exec "${real}" "$@"
`,
		);

		const stopped = await workflows(["prune", "--yes"], { cwd: repo });
		expect([stopped.code, stopped.stdout]).toEqual([1, []]);
		expect(stopped.stderr[0]).toMatch(new RegExp(`^workflows: cannot prune ${id}: git branch failed`));
		expect([existsSync(worktree), hasBranch("feat/x")]).toEqual([false, true]);
		await rm(join(root, "gh.log"));

		const pruned = await workflows(["prune", "--yes"], { cwd: repo });
		expect([pruned.code, pruned.stdout]).toEqual([0, [`${id} feat/x ${worktree}`]]);
		expect(hasBranch("feat/x")).toBe(false);
		expect(existsSync(join(root, "gh.log"))).toBe(false);
		expect(existsSync(join(runsOf(root), id, "pruning"))).toBe(false);
	});

	it("reports a run whose removal fails, prunes the others, and exits 1", async () => {
		const dirty = await workflows(["w"], { cwd: repo });
		expect(dirty.code).toBe(0);
		const kept = worktreeAt(repo, dirty.id);
		git(kept, "branch", "-m", "feat/y");
		await writeFile(join(kept, "work.txt"), "more work\n");
		const { id, worktree } = await mergedRun();

		const pruned = await workflows(["prune", "--yes", "--json"], { cwd: repo });
		expect(pruned.code).toBe(1);
		expect(JSON.parse(pruned.stdout[0] ?? "")).toEqual([{ runId: id, branch: "feat/x", worktree }]);
		expect(pruned.stderr[0]).toMatch(new RegExp(`^workflows: cannot prune ${dirty.id}: git worktree failed`));
		expect([existsSync(worktree), hasBranch("feat/x")]).toEqual([false, false]);
		expect([existsSync(kept), hasBranch("feat/y")]).toEqual([true, true]);
		expect(existsSync(join(runsOf(root), dirty.id ?? "", "pruning"))).toBe(false);
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
