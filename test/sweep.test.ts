import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, realpath, rm, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { SHOWN } from "../src/cli/commands/show.ts";
import { SWEPT_RUNS } from "../src/cli/commands/sweep.ts";
import { ROW } from "../src/cli/saved.ts";
import { newRunId } from "../src/launch/input.ts";
import { TASK } from "../src/run/version.ts";
import {
	git,
	PROJECTS_ENTRY,
	repository,
	runsOf,
	sandbox,
	saveAs,
	setEntries,
	storeOf,
	toHost,
	workflows,
	worktreeAt,
} from "./support.ts";

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
	// gh is asked only in a repository with an origin.
	git(repo, "remote", "add", "origin", join(root, "origin.git"));
	const scripts = join(repo, ".workflows", "scripts");
	await mkdir(scripts, { recursive: true });
	// Each run commits, so its HEAD is not in the local main.
	await writeFile(
		join(scripts, "w.js"),
		'export const meta = { worktree: true }\nawait sh("git commit -q --allow-empty -m work")\nreturn "done"',
	);
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

/** An ended run of `w` whose worktree is on the branch `branch`, with its ID and worktree. */
async function mergedRun(branch = "feat/x"): Promise<{ id: string; worktree: string }> {
	const run = await workflows(["w", "--branch", branch], { cwd: repo });
	expect(run.code).toBe(0);
	const id = run.id ?? "";

	return { id, worktree: worktreeAt(repo, id) };
}

const hasBranch = (name: string) => git(repo, "branch", "--list", name) !== "";

/** A run directory of the project with no task, whose `project` file is 2 hours old. */
async function oldRunDirectory(): Promise<{ id: string; directory: string }> {
	const id = newRunId();
	const directory = join(runsOf(root), id);
	await mkdir(directory, { recursive: true });
	const file = join(directory, "project");
	await writeFile(file, "main\n");
	const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
	await utimes(file, old, old);

	return { id, directory };
}

/** Writes the script `gated` of `repo`: a run with a worktree that fails until the file `go` exists, then asks the agent. */
async function writeGated(): Promise<void> {
	await writeFile(
		join(repo, ".workflows", "scripts", "gated.js"),
		`export const meta = { worktree: true }\nawait sh("test -f ${root}/go")\nreturn await agent("Script: one")`,
	);
}

/** The word in the `swept` file of the run `id`, or undefined without the file. */
const sweptFile = (id: string | undefined) =>
	readFile(join(runsOf(root), id ?? "", "swept"), "utf8").catch(() => undefined);

/** The `swept` field of the run `id` in `list --json` and in `show --json`, after a check of both against their schema. */
async function sweptFields(id: string): Promise<unknown[]> {
	const listed: unknown = JSON.parse((await workflows(["list", "--json"], { cwd: repo })).stdout[0] ?? "");
	const shown: unknown = JSON.parse((await workflows(["show", id, "--json"], { cwd: repo })).stdout[0] ?? "");

	if (!Value.Check(Type.Array(ROW), listed) || !Value.Check(SHOWN, shown)) throw new Error("not a run of the schema");

	return [listed.find((row) => row.runId === id)?.swept, shown.swept];
}

/** Writes the marker of an interrupted `sweep --yes` in the run directory of `id`, for its worktree on feat/x. */
async function writeMarker(id: string, worktree: string, swept = "landed"): Promise<string> {
	const marker = join(runsOf(root), id, "sweeping");
	await writeFile(
		marker,
		`${JSON.stringify({ branch: "feat/x", repository: await realpath(repo), path: worktree, swept })}\n`,
	);

	return marker;
}

describe("workflows sweep", () => {
	it("lists the ended runs on a merged branch, and removes their worktree and branch with --yes", async () => {
		const other = await workflows(["w"], { cwd: repo });
		expect(other.code).toBe(0);
		const { id, worktree } = await mergedRun();

		const listed = await workflows(["sweep"], { cwd: repo });
		expect([listed.code, listed.stdout]).toEqual([0, [`${id} landed feat/x ${worktree}`]]);
		const json = await workflows(["sweep", "--json"], { cwd: repo });
		const entries: unknown = JSON.parse(json.stdout[0] ?? "");
		expect(entries).toEqual([{ runId: id, swept: "landed", branch: "feat/x", worktree }]);
		expect(Value.Check(SWEPT_RUNS, entries)).toBe(true);
		expect(existsSync(worktree)).toBe(true);
		expect(await sweptFile(id)).toBeUndefined();

		const swept = await workflows(["sweep", "--yes"], { cwd: repo });
		expect([swept.code, swept.stdout]).toEqual([0, [`${id} landed feat/x ${worktree}`]]);
		expect(existsSync(worktree)).toBe(false);
		expect(hasBranch("feat/x")).toBe(false);
		expect(existsSync(worktreeAt(repo, other.id))).toBe(true);
		expect(existsSync(join(runsOf(root), id))).toBe(true);
		expect(await sweptFile(id)).toBe("landed\n");
		expect(await sweptFields(id)).toEqual(["landed", "landed"]);

		const runs = await workflows(["list"], { cwd: repo });
		expect(runs.stdout).toContain(`${id} w done, exit 0 w`);
	});

	it("removes the worktree and branch of a run that an earlier version saved", async () => {
		const { id, worktree } = await mergedRun();
		saveAs(TASK.version - 1);
		const listed = await workflows(["list", "--json"], { cwd: repo });
		expect(JSON.parse(listed.stdout[0] ?? "")).toEqual([
			{
				runId: id,
				workflow: "w",
				title: "w",
				state: "earlier-version",
				startedAt: expect.any(String),
				repository: null,
				steps: [],
			},
		]);

		const swept = await workflows(["sweep", "--yes"], { cwd: repo });
		expect([swept.code, swept.stdout]).toEqual([0, [`${id} landed feat/x ${worktree}`]]);
		expect(existsSync(worktree)).toBe(false);
		expect(hasBranch("feat/x")).toBe(false);
	});

	it("resumes and sweeps a run whose saved worktree is in its run directory", async () => {
		const scripts = join(repo, ".workflows", "scripts");
		await writeFile(
			join(scripts, "gated.js"),
			`export const meta = { worktree: true }\nawait sh("test -f ${root}/go")\nawait sh("git commit -q --allow-empty -m work")\nreturn cwd`,
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

		const swept = await workflows(["sweep", "--yes"], { cwd: repo });
		expect([swept.code, swept.stdout]).toEqual([0, [`${id} landed feat/x ${worktree}`]]);
		expect(existsSync(worktree)).toBe(false);
		expect(existsSync(runDir)).toBe(true);
	});

	it("decides by the last task of this version when a later version saved the last task", async () => {
		const scripts = join(repo, ".workflows", "scripts");
		await writeFile(
			join(scripts, "gated.js"),
			`export const meta = { worktree: true }\nawait sh("test -f ${root}/go")\nawait sh("git commit -q --allow-empty -m work")`,
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

		const swept = await workflows(["sweep", "--yes"], { cwd: repo });
		expect([swept.code, swept.stdout]).toEqual([0, [`${id} landed feat/x ${worktree}`]]);
		expect(existsSync(worktree)).toBe(false);
	});

	it("keeps a run that a later version saved", async () => {
		const { worktree } = await mergedRun();
		saveAs(TASK.version + 1);

		const swept = await workflows(["sweep", "--yes"], { cwd: repo });
		expect([swept.code, swept.stdout]).toEqual([0, []]);
		expect(existsSync(worktree)).toBe(true);
		expect(hasBranch("feat/x")).toBe(true);
	});

	it("keeps a run whose branch name had a pull request merged at another commit", async () => {
		const run = await workflows(["w"], { cwd: repo });
		expect(run.code).toBe(0);
		const worktree = worktreeAt(repo, run.id);
		git(worktree, "branch", "-m", "feat/old");

		const swept = await workflows(["sweep", "--yes"], { cwd: repo });
		expect([swept.code, swept.stdout]).toEqual([0, []]);
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

		const listed = await workflows(["sweep"], { cwd: repo });
		expect([listed.code, listed.stdout]).toEqual([0, [`${id} landed feat/x ${worktree}`]]);

		const swept = await workflows(["sweep", "--yes"], { cwd: repo });
		expect([swept.code, swept.stdout]).toEqual([0, [`${id} landed feat/x ${worktree}`]]);
		expect(existsSync(worktree)).toBe(false);
		expect(existsSync(brokenRun)).toBe(true);
	});

	it("removes the worktree and the branch with no hc call", async () => {
		const { worktree } = await mergedRun();
		await fake("hc", `echo "$@" >> "${root}/hc.log"\nexit 0\n`);

		const swept = await workflows(["sweep", "--yes"], { cwd: repo });
		expect(swept.code).toBe(0);
		expect([existsSync(worktree), hasBranch("feat/x"), existsSync(join(root, "hc.log"))]).toEqual([
			false,
			false,
			false,
		]);
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

		const swept = await workflows(["sweep", "--yes"], { cwd: repo });
		expect([swept.code, swept.stdout]).toEqual([0, [`${merged.id} landed feat/z ${worktree}`]]);
		expect([existsSync(worktree), existsSync(kept)]).toEqual([false, true]);
		expect((await readFile(join(root, "gh.log"), "utf8")).trim().split("\n")).toEqual([
			"pr list --head feat/w --state merged --json headRefOid",
		]);
	});

	it("sweeps only the given runs, an unmerged one as dropped and a merged one as landed", async () => {
		const other = await mergedRun("feat/y");
		const kept = await mergedRun();
		const { id, worktree } = await mergedRun("feat/z");

		const listed = await workflows(["sweep", id], { cwd: repo });
		expect([listed.code, listed.stdout]).toEqual([0, [`${id} dropped feat/z ${worktree}`]]);
		expect(await sweptFile(id)).toBeUndefined();
		const swept = await workflows(["sweep", id, other.id, "--yes", "--json"], { cwd: repo });
		expect(swept.code).toBe(0);
		expect(JSON.parse(swept.stdout[0] ?? "")).toEqual([
			{ runId: id, swept: "dropped", branch: "feat/z", worktree },
			{ runId: other.id, swept: "landed", branch: "feat/y", worktree: other.worktree },
		]);
		expect([existsSync(worktree), hasBranch("feat/z"), existsSync(other.worktree)]).toEqual([false, false, false]);
		expect(existsSync(kept.worktree)).toBe(true);
		expect(await sweptFields(id)).toEqual(["dropped", "dropped"]);
		expect(await sweptFields(other.id)).toEqual(["landed", "landed"]);
		expect(await sweptFields(kept.id)).toEqual([undefined, undefined]);
		expect((await readFile(join(root, "gh.log"), "utf8")).trim().split("\n")).toEqual([
			"pr list --head feat/z --state merged --json headRefOid",
			"pr list --head feat/z --state merged --json headRefOid",
			"pr list --head feat/y --state merged --json headRefOid",
		]);
	});

	it("removes nothing, and exits 1, when a given argument is no run and no branch of this repository", async () => {
		const { id, worktree } = await mergedRun();
		const other = join(root, "other");
		await repository(other);
		await mkdir(join(other, ".workflows", "scripts"), { recursive: true });
		await writeFile(join(other, ".workflows", "scripts", "w.js"), "export const meta = { worktree: true }\nreturn 1");
		const elsewhere = await workflows(["w", "--branch", "feat/o"], { cwd: other });
		expect(elsewhere.code).toBe(0);

		for (const bad of [elsewhere.id ?? "", "feat/o", "20990101T000000-00000000", "../x"]) {
			const swept = await workflows(["sweep", id, bad, "--yes"], { cwd: repo });
			expect([swept.code, swept.stdout, swept.stderr]).toEqual([
				1,
				[],
				[`workflows: cannot sweep ${bad}: no run of this repository and no branch of that name`],
			]);
		}

		expect([existsSync(worktree), existsSync(worktreeAt(other, elsewhere.id))]).toEqual([true, true]);
	});

	it("removes nothing, and exits 1, when a run of a given branch has not ended", async () => {
		const { id, worktree } = await mergedRun();

		const slow = await workflows(["slow", "--branch", "feat/s"], {
			cwd: repo,
			script: { interruptAt: { kind: "script", nth: 1 } },
		});

		expect(slow.code).toBe(130);

		for (const bad of [slow.id ?? "", "feat/s"]) {
			const swept = await workflows(["sweep", id, bad, "--yes"], { cwd: repo });
			expect([swept.code, swept.stdout, swept.stderr]).toEqual([
				1,
				[],
				[`workflows: cannot sweep ${bad}: the run ${slow.id} on feat/s has not ended, or a later version saved it`],
			]);
		}

		expect([existsSync(worktree), existsSync(worktreeAt(repo, slow.id)), hasBranch("feat/s")]).toEqual([
			true,
			true,
			true,
		]);
	});

	it("removes nothing, and exits 1, when a given run has no branch, or its branch and worktree are gone", async () => {
		const { id, worktree } = await mergedRun();
		await writeFile(join(repo, ".workflows", "scripts", "plain.js"), 'return "done"');
		const plain = await workflows(["plain"], { cwd: repo });
		expect(plain.code).toBe(0);
		const gone = await mergedRun("feat/gone");
		git(repo, "worktree", "remove", gone.worktree);
		git(repo, "branch", "-D", "feat/gone");

		const refusals = [
			[plain.id ?? "", `workflows: cannot sweep ${plain.id}: the run has no branch`],
			[gone.id, `workflows: cannot sweep ${gone.id}: no worktree and no branch feat/gone`],
			["feat/gone", "workflows: cannot sweep feat/gone: no worktree and no branch feat/gone"],
		];

		for (const [bad, message] of refusals) {
			const swept = await workflows(["sweep", id, bad ?? "", "--yes"], { cwd: repo });
			expect([swept.code, swept.stdout, swept.stderr]).toEqual([1, [], [message]]);
		}

		expect([existsSync(worktree), hasBranch("feat/x"), await sweptFile(gone.id)]).toEqual([true, true, undefined]);
	});

	it("sweeps a given branch that no run has, with or without a worktree", async () => {
		const path = join(root, "hand");
		git(repo, "worktree", "add", "-q", "-b", "feat/hand", path);
		git(path, "commit", "-q", "--allow-empty", "-m", "hand");
		git(repo, "branch", "feat/bare");

		const swept = await workflows(["sweep", "feat/hand", "feat/bare", "feat/hand", "--yes"], { cwd: repo });
		expect([swept.code, swept.stdout, swept.stderr]).toEqual([
			0,
			[`- dropped feat/hand ${join(await realpath(root), "hand")}`, "- landed feat/bare -"],
			[],
		]);
		expect([existsSync(path), hasBranch("feat/hand"), hasBranch("feat/bare")]).toEqual([false, false, false]);

		git(repo, "branch", "feat/bare");
		const json = await workflows(["sweep", "feat/bare", "--json"], { cwd: repo });
		const entries: unknown = JSON.parse(json.stdout[0] ?? "");
		expect(entries).toEqual([{ swept: "landed", branch: "feat/bare" }]);
		expect(Value.Check(SWEPT_RUNS, entries)).toBe(true);
	});

	it("sweeps the branch of a stopped thermoloop by its run ID or by the branch, with its child run", async () => {
		const branch = "feature";

		for (const byId of [true, false]) {
			git(repo, "checkout", "-q", "-b", branch);
			await writeFile(join(repo, "README.md"), "# Demo\n\nHello world\n");
			git(repo, "commit", "-q", "-am", "fix the typo");
			git(repo, "checkout", "-q", "main");

			const run = await workflows(["thermoloop", "--item", "Fix the README typo", `main..${branch}`], {
				cwd: repo,
				script: { verdicts: ["FIX", "SHIP"], interruptAt: { kind: "implement", nth: 1 } },
			});

			expect(run.code).toBe(130);
			const id = run.id ?? "";
			const stopped = await workflows(["stop", id], { cwd: repo, script: { interruptAt: { kind: "script", nth: 1 } } });
			expect(stopped.code).toBe(0);

			const worktree = git(repo, "worktree", "list", "--porcelain")
				.split("\n")
				.filter((entry) => entry.startsWith("worktree "))
				.map((entry) => entry.slice("worktree ".length))
				.at(-1);

			expect(git(worktree ?? "", "branch", "--show-current")).toBe(branch);

			const swept = await workflows(["sweep", byId ? id : branch, "--yes", "--json"], { cwd: repo });
			expect(swept.code).toBe(0);
			const entries: unknown = JSON.parse(swept.stdout[0] ?? "");
			expect(Value.Check(SWEPT_RUNS, entries)).toBe(true);
			expect(entries).toEqual([
				{ runId: id, swept: "dropped", branch, worktree },
				{ runId: expect.any(String), swept: "dropped", branch, worktree },
			]);
			expect([existsSync(worktree ?? ""), hasBranch(branch)]).toEqual([false, false]);
			expect(await sweptFields(id)).toEqual(["dropped", "dropped"]);
		}
	});

	it("keeps the word of a swept run when a later branch of its name is swept", async () => {
		const old = await mergedRun();
		const first = await workflows(["sweep", "--yes"], { cwd: repo });
		expect([first.code, first.stdout]).toEqual([0, [`${old.id} landed feat/x ${old.worktree}`]]);

		// The new branch has a commit of its own and no worktree, so gh, in the main checkout, finds it not merged.
		const path = join(root, "again");
		git(repo, "worktree", "add", "-q", "-b", "feat/x", path);
		git(path, "commit", "-q", "--allow-empty", "-m", "again");
		git(repo, "worktree", "remove", path);

		const listed = await workflows(["sweep", "feat/x"], { cwd: repo });
		expect([listed.code, listed.stdout]).toEqual([0, ["- dropped feat/x -"]]);
		const swept = await workflows(["sweep", "feat/x", "--yes", "--json"], { cwd: repo });
		expect([swept.code, JSON.parse(swept.stdout[0] ?? "")]).toEqual([0, [{ swept: "dropped", branch: "feat/x" }]]);
		expect(hasBranch("feat/x")).toBe(false);
		expect(await sweptFields(old.id)).toEqual(["landed", "landed"]);
	});

	it("refuses the ID of a swept run and keeps a later branch of its name", async () => {
		const old = await mergedRun();
		const first = await workflows(["sweep", "--yes"], { cwd: repo });
		expect(first.code).toBe(0);

		const path = join(root, "again");
		git(repo, "worktree", "add", "-q", "-b", "feat/x", path);
		git(path, "commit", "-q", "--allow-empty", "-m", "again");

		const swept = await workflows(["sweep", old.id, "--yes"], { cwd: repo });
		expect([swept.code, swept.stdout]).toEqual([1, []]);
		expect(swept.stderr).toEqual([`workflows: cannot sweep ${old.id}: an earlier sweep swept its branch feat/x`]);
		expect([existsSync(path), hasBranch("feat/x")]).toEqual([true, true]);
		expect(await sweptFields(old.id)).toEqual(["landed", "landed"]);
	});

	it("keeps a run that has not ended, also on a merged branch", async () => {
		const run = await workflows(["slow"], { cwd: repo, script: { interruptAt: { kind: "script", nth: 1 } } });
		expect(run.code).toBe(130);
		const worktree = worktreeAt(repo, run.id);
		git(worktree, "branch", "-m", "feat/x");

		const swept = await workflows(["sweep", "--yes"], { cwd: repo });
		expect([swept.code, swept.stdout]).toEqual([0, []]);
		expect(existsSync(worktree)).toBe(true);
	});

	it("finishes at the next sweep the removal that stopped after the worktree, with no gh call", async () => {
		const { id, worktree } = await mergedRun();
		const real = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
		// The first `git branch -D` fails, as when sweep stops after it removed the worktree.
		await fake(
			"git",
			`case "$*" in
*"branch -D "*) [ -e "${root}/failed" ] || { touch "${root}/failed"; exit 1; } ;;
esac
exec "${real}" "$@"
`,
		);

		const stopped = await workflows(["sweep", "--yes"], { cwd: repo });
		expect([stopped.code, stopped.stdout]).toEqual([1, []]);
		expect(stopped.stderr[0]).toMatch(new RegExp(`^workflows: cannot sweep ${id}: git branch failed`));
		expect([existsSync(worktree), hasBranch("feat/x")]).toEqual([false, true]);
		await rm(join(root, "gh.log"));

		const swept = await workflows(["sweep", "--yes"], { cwd: repo });
		expect([swept.code, swept.stdout]).toEqual([0, [`${id} landed feat/x ${worktree}`]]);
		expect(hasBranch("feat/x")).toBe(false);
		expect(existsSync(join(root, "gh.log"))).toBe(false);
		expect(existsSync(join(runsOf(root), id, "sweeping"))).toBe(false);
		expect(await sweptFile(id)).toBe("landed\n");
	});

	it("takes the word of a marker, with no gh call", async () => {
		const { id, worktree } = await mergedRun();
		git(worktree, "branch", "-m", "feat/z");
		await writeMarker(id, worktree, "dropped");

		const swept = await workflows(["sweep", "--yes"], { cwd: repo });
		expect([swept.code, swept.stdout]).toEqual([0, [`${id} dropped feat/x ${worktree}`]]);
		expect([existsSync(worktree), await sweptFile(id), existsSync(join(root, "gh.log"))]).toEqual([
			false,
			"dropped\n",
			false,
		]);
	});

	it("reports a run whose removal fails, sweeps the others, and exits 1", async () => {
		const dirty = await workflows(["w"], { cwd: repo });
		expect(dirty.code).toBe(0);
		const kept = worktreeAt(repo, dirty.id);
		git(kept, "branch", "-m", "feat/y");
		await writeFile(join(kept, "work.txt"), "more work\n");
		const { id, worktree } = await mergedRun();

		const swept = await workflows(["sweep", "--yes", "--json"], { cwd: repo });
		expect(swept.code).toBe(1);
		expect(JSON.parse(swept.stdout[0] ?? "")).toEqual([{ runId: id, swept: "landed", branch: "feat/x", worktree }]);
		expect(swept.stderr[0]).toMatch(new RegExp(`^workflows: cannot sweep ${dirty.id}: git worktree failed`));
		expect([existsSync(worktree), hasBranch("feat/x")]).toEqual([false, false]);
		expect([existsSync(kept), hasBranch("feat/y")]).toEqual([true, true]);
		expect(existsSync(join(runsOf(root), dirty.id ?? "", "sweeping"))).toBe(false);
		expect([await sweptFile(dirty.id), await sweptFile(id)]).toEqual([undefined, "landed\n"]);
	});

	it("counts a branch as not merged, with one warning line, when gh fails", async () => {
		const { id, worktree } = await mergedRun();
		await fake("gh", 'echo "gh: not logged in" >&2\nexit 1\n');

		const swept = await workflows(["sweep", "--yes"], { cwd: repo });
		expect([swept.code, swept.stdout, swept.stderr.length]).toEqual([0, [], 1]);
		expect(swept.stderr[0]).toContain("workflows: cannot ask gh whether feat/x is merged, so it counts as not merged");
		expect(swept.stderr[0]).toContain("gh: not logged in");
		expect([existsSync(worktree), hasBranch("feat/x"), await sweptFile(id)]).toEqual([true, true, undefined]);

		const given = await workflows(["sweep", id, "--json"], { cwd: repo });
		expect([given.code, JSON.parse(given.stdout[0] ?? "")]).toEqual([
			0,
			[{ runId: id, swept: "dropped", branch: "feat/x", worktree }],
		]);
	});

	it("takes a run whose HEAD is in the local main as landed, with no origin and no gh call", async () => {
		git(repo, "remote", "remove", "origin");
		const { id, worktree } = await mergedRun();
		const kept = await workflows(["w"], { cwd: repo });
		expect(kept.code).toBe(0);
		git(worktreeAt(repo, kept.id), "commit", "-q", "--allow-empty", "-m", "more");
		git(repo, "merge", "-q", "--ff-only", "feat/x");

		const swept = await workflows(["sweep", "--yes"], { cwd: repo });
		expect([swept.code, swept.stdout, swept.stderr]).toEqual([0, [`${id} landed feat/x ${worktree}`], []]);
		expect([existsSync(worktree), existsSync(worktreeAt(repo, kept.id))]).toEqual([false, true]);
		expect(await sweptFile(id)).toBe("landed\n");
		expect(existsSync(join(root, "gh.log"))).toBe(false);
	});

	it("refuses, and removes nothing, when the project store does not exist", async () => {
		const { directory } = await oldRunDirectory();

		const swept = await workflows(["sweep", "--yes"], { cwd: repo });
		expect([swept.code, swept.stdout, swept.stderr]).toEqual([
			1,
			[],
			[
				`workflows: cannot sweep: the project store ${storeOf()} does not exist, so no run directory counts as unstarted; remove the run directories that you do not need from ${runsOf(root)} by hand`,
			],
		]);
		expect(existsSync(directory)).toBe(true);
	});

	it("keeps an unstarted run directory whose clone has commits on no remote", async () => {
		expect((await workflows(["w"], { cwd: repo })).code).toBe(0);
		const kept = await oldRunDirectory();
		const clean = await oldRunDirectory();
		git(root, "clone", "-q", repo, join(kept.directory, "repository"));
		git(join(kept.directory, "repository"), "commit", "-q", "--allow-empty", "-m", "local");
		git(root, "clone", "-q", repo, join(clean.directory, "repository"));

		const swept = await workflows(["sweep", "--yes", "--json"], { cwd: repo });
		expect([swept.code, swept.stderr]).toEqual([
			0,
			[
				`workflows: keeps ${kept.directory}: it holds a Git clone with commits that are on no remote, or one that Git cannot read; push them, or remove the directory by hand`,
			],
		]);
		expect(JSON.parse(swept.stdout[0] ?? "")).toEqual([{ runId: clean.id, directory: clean.directory }]);
		expect([existsSync(kept.directory), existsSync(clean.directory)]).toEqual([true, false]);
	});

	it("keeps a run with a marker that has not ended", async () => {
		const run = await workflows(["slow"], { cwd: repo, script: { interruptAt: { kind: "script", nth: 1 } } });
		expect(run.code).toBe(130);
		const worktree = worktreeAt(repo, run.id);
		git(worktree, "branch", "-m", "feat/x");
		await writeMarker(run.id ?? "", worktree);

		const swept = await workflows(["sweep", "--yes"], { cwd: repo });
		expect([swept.code, swept.stdout]).toEqual([0, []]);
		expect([existsSync(worktree), hasBranch("feat/x")]).toEqual([true, true]);
	});

	it("removes the marker of a run when a new task of the run starts", async () => {
		await writeGated();
		const failed = await workflows(["gated"], { cwd: repo });
		expect(failed.code).toBe(1);
		const id = failed.id ?? "";
		const marker = await writeMarker(id, worktreeAt(repo, id));
		await writeFile(join(root, "go"), "");

		expect((await workflows(["resume", id], { cwd: repo })).code).toBe(0);
		expect(existsSync(marker)).toBe(false);
	});

	it("skips a run whose new task started after sweep read the store", async () => {
		await writeGated();
		const failed = await workflows(["gated"], { cwd: repo });
		expect(failed.code).toBe(1);
		const id = failed.id ?? "";
		const worktree = worktreeAt(repo, id);
		git(worktree, "branch", "-m", "feat/x");
		git(worktree, "commit", "-q", "--allow-empty", "-m", "work");
		// gh waits at a gate, after the first read of the store and before any removal.
		await fake(
			"gh",
			`touch "${root}/reached"
while [ ! -f "${root}/open" ]; do [ -d "${root}" ] || exit 1; sleep 0.02; done
echo "[{\\"headRefOid\\":\\"$(git rev-parse HEAD)\\"}]"
`,
		);

		const pending = workflows(["sweep", "--yes"], { cwd: repo });

		while (!existsSync(join(root, "reached"))) await new Promise((resolve) => setTimeout(resolve, 10));
		await writeFile(join(root, "go"), "");
		const resumed = await workflows(["resume", id], { cwd: repo, script: { interruptAt: { kind: "script", nth: 1 } } });
		expect(resumed.code).toBe(130);
		await writeFile(join(root, "open"), "");

		const swept = await pending;
		expect([swept.code, swept.stdout, swept.stderr]).toEqual([
			0,
			[],
			[`workflows: skips ${id}: its run has a task that has not ended; sweep it after the run ends`],
		]);
		expect([existsSync(worktree), hasBranch("feat/x")]).toEqual([true, true]);
	});

	it("drops the given branch of a failed run with no commit, though main has its tip", async () => {
		await writeGated();
		const failed = await workflows(["gated", "--branch", "feat/n"], { cwd: repo });
		expect(failed.code).toBe(1);
		const id = failed.id ?? "";
		const worktree = worktreeAt(repo, id);

		const swept = await workflows(["sweep", id, "feat/n", "--yes"], { cwd: repo });
		expect([swept.code, swept.stdout, swept.stderr]).toEqual([0, [`${id} dropped feat/n ${worktree}`], []]);
		expect([existsSync(worktree), hasBranch("feat/n")]).toEqual([false, false]);
		expect(await sweptFile(id)).toBe("dropped\n");
	});

	it("installs a post-merge hook, and refuses to replace a hook or a hooks path", async () => {
		const line = "workflows sweep --yes >/dev/null 2>&1 &";
		const hook = join(repo, ".git", "hooks", "post-merge");

		const installed = await workflows(["sweep", "--install-hook"], { cwd: repo });
		expect([installed.code, installed.stdout]).toEqual([0, [hook]]);
		expect(await readFile(hook, "utf8")).toContain(line);
		expect((await stat(hook)).mode & 0o111).toBe(0o111);

		const again = await workflows(["sweep", "--install-hook"], { cwd: repo });
		expect(again.code).toBe(1);
		expect(again.stderr.join("\n")).toContain(line);

		await rm(hook);
		git(repo, "config", "core.hooksPath", "x");
		const refused = await workflows(["sweep", "--install-hook"], { cwd: repo });
		expect(refused.code).toBe(1);
		expect(refused.stderr.join("\n")).toContain(line);
		expect(existsSync(hook)).toBe(false);
		expect(existsSync(join(repo, "x"))).toBe(false);
	});
});

describe("workflows sweep and the item of a run", () => {
	beforeEach(() => setEntries({ projects: PROJECTS_ENTRY }));

	it("leaves open the item of a merged run", async () => {
		await toHost({ type: "item", action: "add", caller: "test", title: "Build it" });
		const run = await workflows(["w", "--branch", "feat/x", "--serves", "item:1"], { cwd: repo });
		expect(run.code).toBe(0);
		const id = run.id ?? "";
		const worktree = worktreeAt(repo, id);

		const swept = await workflows(["sweep", "--yes"], { cwd: repo });
		expect([swept.code, swept.stdout, swept.stderr]).toEqual([0, [`${id} landed feat/x ${worktree}`], []]);
		expect([existsSync(worktree), hasBranch("feat/x")]).toEqual([false, false]);
		const item = await toHost({ type: "item", action: "read", id: 1 });
		expect(item.state).toBe("open");
	});

	it("drops the branch of a failed run with no commit, and leaves its item open", async () => {
		await writeGated();
		await toHost({ type: "item", action: "add", caller: "test", title: "Build it" });
		const failed = await workflows(["gated", "--branch", "feat/n", "--serves", "item:1"], { cwd: repo });
		expect(failed.code).toBe(1);
		const id = failed.id ?? "";
		const worktree = worktreeAt(repo, id);

		const swept = await workflows(["sweep", "--yes"], { cwd: repo });
		expect([swept.code, swept.stdout, swept.stderr]).toEqual([0, [`${id} dropped feat/n ${worktree}`], []]);
		expect([existsSync(worktree), hasBranch("feat/n")]).toEqual([false, false]);
		expect(await sweptFile(id)).toBe("dropped\n");
		const item = await toHost({ type: "item", action: "read", id: 1 });
		expect(item.state).toBe("open");
	});
});
