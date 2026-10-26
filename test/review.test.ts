import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { git, PASSING_JUDGE, progressOf, repository, sandbox, statusesOf, workflows } from "./support.ts";

let root: string;
let repo: string;
let start: string;

beforeEach(async () => {
	root = await sandbox();
	repo = join(root, "repo");
	start = await repository(repo);
	git(repo, "checkout", "-qb", "feature");
	await writeFile(join(repo, "README.md"), "# Demo\n\nHello world\n");
	git(repo, "commit", "-qam", "fix the typo");
});

afterEach(() => rm(root, { recursive: true, force: true }));

const ITEM = "Fix the README typo";
const THANKED = "# Demo\n\nHello world\nThanks.\n";

describe("workflows review", () => {
	it("reviews the branch from its merge base, and commits the fix of each round on it", async () => {
		const head = git(repo, "rev-parse", "HEAD");

		const run = await workflows(["review", "--json", ITEM], {
			cwd: repo,
			script: { edits: [THANKED], verdicts: ["FIX", "SHIP"] },
		});

		expect(run.code).toBe(0);
		const { result, report } = JSON.parse(run.stdout[1] ?? "");
		expect(report).toEqual([`approved ${ITEM} in 2 rounds, ${git(repo, "rev-parse", "--short", "HEAD")}`]);
		expect(result).toMatchObject({
			status: "approved",
			rounds: 2,
			memory: ["#1 reviewer 1: Handoff 1: one word changes.", "#2 implementer 2: Implement 1: README.md had wrold."],
		});
		expect(progressOf(run.stderr)).toEqual([
			"✓ round 1: review",
			"  FIX",
			"✓ round 2: implement",
			"  +1 -0 in 1 file",
			"✓ round 2: review",
			"  SHIP",
		]);
		expect(statusesOf(run.stderr)).toEqual([
			"-",
			"round 1/3: review",
			"round 2/3: implement",
			"round 2/3: review",
			"-",
		]);
		expect(run.model.calls.map((call) => call.kind)).toEqual([
			"review",
			"verdict",
			"handoff",
			"implement",
			"review",
			"verdict",
		]);

		// The first round reviews the commits of the branch, with no plan and no reply.
		const patch = join(root, "state", "workflows", "runs", run.id ?? "", "round-1.patch");
		expect(run.model.find("review")?.prompt).toMatch(new RegExp(`## item\\n${ITEM}\\n\\n## change\\n${patch}$`));
		expect(await readFile(patch, "utf8")).toContain("+Hello world\n");
		expect(run.model.find("implement")?.prompt).toContain("## plan\nHandoff 1: ");

		expect(git(repo, "branch", "--show-current")).toBe("feature");
		expect(git(repo, "log", "--format=%s", `${start}..HEAD`)).toBe("round 2\nfix the typo");
		expect(git(repo, "rev-parse", "HEAD^")).toBe(head);
		expect(await readFile(join(repo, "README.md"), "utf8")).toBe(THANKED);
	});

	it("stops after --rounds rounds with exit 1, and refuses a checkout with changes or a branch with no change", async () => {
		const stopped = await workflows(["review", "--rounds", "1", ITEM], { cwd: repo, script: { verdicts: ["FIX"] } });
		expect([stopped.code, stopped.stdout.slice(1)]).toEqual([1, [`stopped ${ITEM} after 1 rounds`]]);

		await writeFile(join(repo, "README.md"), "local edit\n");
		const dirty = await workflows(["review", ITEM], { cwd: repo });
		expect(dirty.code).toBe(1);
		expect(dirty.stderr).toContain(
			`failed ${ITEM}: the checkout has changes that are not committed; commit or stash them before the review`,
		);

		git(repo, "checkout", "-q", "--", "README.md");
		git(repo, "checkout", "-q", "main");
		const empty = await workflows(["review", ITEM], { cwd: repo });
		expect(empty.code).toBe(1);
		expect(empty.stderr).toContain(`failed ${ITEM}: no change from main to review`);
		expect(empty.model.calls).toEqual([]);
	});
});

describe("workflows judge", () => {
	it("judges the branch from its merge base with the fixed rubric", async () => {
		const run = await workflows(["judge", "--json", ITEM], { cwd: repo, script: { judge: PASSING_JUDGE } });

		expect(run.code).toBe(0);
		const { result, report } = JSON.parse(run.stdout[1] ?? "");
		expect(report).toEqual([`judge 0.83: ${ITEM}`, `  ${PASSING_JUDGE.findings[0]}`]);
		expect(result).toMatchObject({ status: "judged", score: 5 / 6, ...PASSING_JUDGE });
		expect(result).not.toHaveProperty("commit");
		expect(run.model.calls.map((call) => call.kind)).toEqual(["judge"]);
		const head = git(repo, "rev-parse", "HEAD");
		expect(run.model.find("judge")?.prompt).toMatch(new RegExp(`## base\\n${start}\\n\\n## head\\n${head}$`));
	});

	it("exits 1 when the judge does not answer", async () => {
		const run = await workflows(["judge", ITEM], { cwd: repo, script: { judge: "1 PASS" } });

		expect(run.code).toBe(1);
		expect(run.stdout.slice(1)).toEqual([`judge failed on ${ITEM}: the answer did not call respond`]);
	});
});

describe("workflows rpi", () => {
	it("researches, plans and implements a work item in one commit on its own branch", async () => {
		const run = await workflows(["rpi", "--json", ITEM], { cwd: repo, script: { edits: [THANKED] } });

		expect(run.code).toBe(0);
		const { result, report } = JSON.parse(run.stdout[1] ?? "");
		const worktree = join(root, "state", "workflows", "runs", run.id ?? "", "worktree");
		const head = git(worktree, "rev-parse", "--short", "HEAD");
		expect(report).toEqual([`implemented ${ITEM}, ${head}`]);
		expect(git(worktree, "branch", "--show-current")).toBe(`rpi/${run.id}`);
		expect(result).toMatchObject({ status: "implemented", head, reply: "I fixed the typo in README.md." });
		expect(result.memory).toEqual([
			"#1 planner 0: Handoff 1: one word changes.",
			"#2 implementer 1: Implement 1: README.md had wrold.",
		]);
		expect(progressOf(run.stderr)).toEqual(["✓ research", "✓ plan", "✓ implement", "  +2 -1 in 1 file"]);
		expect(run.model.calls.map((call) => call.kind)).toEqual(["research", "plan", "challenge", "handoff", "implement"]);
		expect(git(worktree, "log", "--format=%s", `${start}..HEAD`)).toBe(ITEM);
		expect(git(repo, "branch", "--show-current")).toBe("feature");
	});
});
