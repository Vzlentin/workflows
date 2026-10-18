import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { git, PASSING_JUDGE, progressOf, repository, sandbox, workflows } from "./support.ts";

let root: string;
let repo: string;
let start: string;

beforeEach(async () => {
	root = await sandbox();
	repo = join(root, "repo");
	start = await repository(repo);
});

afterEach(() => rm(root, { recursive: true, force: true }));

const runs = () => join(root, "state", "workflows", "runs");
const worktreeOf = (id: string | undefined) => join(runs(), id ?? "missing", "worktree");
const GOAL = "# Fix the README\n\nFix the typo, then thank the reader.\n";
const FIRST = "# Fix the README typo\n\nThe README says wrold.";
const SECOND = "# Add a thanks line\n\nEnd the README with Thanks.";
const FIXED = "# Demo\n\nHello world\n";
const THANKED = `${FIXED}Thanks.\n`;
const SHIP = ["plan", "challenge", "handoff", "implement", "review", "verdict", "judge"];
const ROUND = ["plan", "round 1: implement", "round 1: review", "judge"];

describe("workflows campaign", () => {
	it("ships two items as two commits on the campaign branch", async () => {
		const run = await workflows(["campaign", "--json", GOAL], {
			cwd: repo,
			script: { items: [FIRST], edits: [FIXED, THANKED], queues: [[SECOND], []] },
		});

		expect(run.code).toBe(0);
		const { result, report } = JSON.parse(run.stdout[1] ?? "");
		expect(run.stdout).toHaveLength(2);
		expect(run.stdout[0]).toBe(`run ${run.id}`);
		expect(report).toEqual([expect.stringMatching(/^done Fix the README in 2 items, [0-9a-f]+$/)]);
		expect(result.items[0].result).toMatchObject({
			...PASSING_JUDGE,
			memory: ["#1 planner 0: Handoff 1: one word changes.", "#2 implementer 1: Implement 1: README.md had wrold."],
		});
		const round = ROUND.map((line) => `  ✓ ${line}`);
		const items = ["✓ item 1/1: Fix the README typo", ...round, "✓ item 2/2: Add a thanks line", ...round];
		expect(progressOf(run.stderr)).toEqual(items);
		expect(run.model.calls.map((call) => call.kind)).toEqual(["split", ...SHIP, "requeue", ...SHIP, "requeue"]);
		const [split] = run.model.calls;
		expect(split?.prompt).toMatch(/^Split this goal into work items\.\n[\s\S]*\n\n## goal\n# Fix the README\n/);
		expect(split?.tools).toContain("respond");
		expect(run.model.calls[8]?.prompt).toContain(`## done\n${FIRST}\n\n## queue\n[]\n\nAnswer with respond:`);

		const worktree = worktreeOf(run.id);
		expect(git(worktree, "branch", "--show-current")).toBe(`campaign/${run.id}`);
		expect(git(worktree, "rev-parse", "HEAD~2")).toBe(start);
		const messages = git(worktree, "log", "--format=%B%x00", `${start}..HEAD`).split("\0").slice(0, 2);
		expect(messages.map((message) => message.trim().split("\n")[0])).toEqual([
			"Add a thanks line",
			"Fix the README typo",
		]);

		for (const message of messages) expect(message).toMatch(/\nRounds: 1\nJudge: 0\.83/);
		expect(report[0]).toContain(git(worktree, "rev-parse", "--short", "HEAD"));
		expect(await readFile(join(worktree, "README.md"), "utf8")).toBe(THANKED);
		expect(await readFile(join(runs(), run.id ?? "", "item-2", "round-1.patch"), "utf8")).toContain("+Thanks.");
		expect(existsSync(join(runs(), run.id ?? "", "round-1.patch"))).toBe(false);
		expect(git(repo, "rev-parse", "HEAD")).toBe(start);
		expect(git(repo, "branch", "--list", "ship/*")).toBe("");

		const shown = await workflows(["show", run.id ?? ""], { cwd: root });
		const children = result.items.map((item: { result: { runId: string } }) => item.result.runId);
		const lines = shown.stdout.map((line) => line.replace(/ {2}\d+s$/, ""));

		for (const [n, child] of children.entries()) {
			const at = lines.indexOf(`  ✓ run ship ${child}`);
			expect(lines[at - 3], child).toBe(
				`item ${n + 1}/${n + 1}: ${n === 0 ? "Fix the README typo" : "Add a thanks line"}`,
			);
			expect(lines.slice(at + 1, at + 4)).toEqual(["    plan", "      ✓ session planner", "      ✓ ask planner"]);
		}

		expect(lines.at(-1)).toBe(report[0]);
		const { calls } = JSON.parse((await workflows(["show", run.id ?? "", "--json"], { cwd: root })).stdout[0] ?? "");
		const shipped = calls.filter((call: { kind: string }) => call.kind === "run");
		expect(shipped.map((call: { label: string }) => call.label)).toEqual(
			children.map((child: string) => `ship ${child}`),
		);
		expect(shipped[0].calls[0]).toMatchObject({ kind: "session", label: "planner", phase: "plan", mark: "✓" });
		const { runId: _, ...first } = result.items[0].result;
		expect(shipped[0].result).toMatchObject({ runId: children[0], result: first });
		expect(shipped[0]).not.toHaveProperty("child");
	});

	it("stops at an item that is blocked", async () => {
		const run = await workflows(["campaign", GOAL], { cwd: repo, script: { items: [FIRST, SECOND], edits: [] } });

		expect(run.code).toBe(1);
		expect(run.stdout).toEqual([`run ${run.id}`, `stopped Fix the README at item 1: ${worktreeOf(run.id)}`]);
		expect(run.stderr).toEqual(["item 1/2: Fix the README typo", "  plan", "  round 1: implement"]);
		expect(run.model.calls.map((call) => call.kind)).toEqual(["split", "plan", "challenge", "handoff", "implement"]);
		expect(git(worktreeOf(run.id), "rev-parse", "HEAD")).toBe(start);
	});

	it("resumes in the second item and repeats no call of the first", async () => {
		const first = await workflows(["campaign", GOAL], {
			cwd: repo,
			script: { items: [FIRST], edits: [FIXED], queues: [[SECOND]], interruptAt: { kind: "plan", nth: 2 } },
		});

		expect(first.code).toBe(130);
		expect(first.model.calls.map((call) => call.kind)).toEqual(["split", ...SHIP, "requeue"]);

		const resumed = await workflows(["resume", first.id ?? "", "--json"], {
			cwd: root,
			script: { edits: [THANKED], queues: [[]] },
		});

		expect(resumed.code).toBe(0);
		expect(JSON.parse(resumed.stdout[1] ?? "").report).toEqual([
			expect.stringMatching(/^done Fix the README in 2 items, /),
		]);
		// The pending nested ship task restarts at the same time as the campaign script replays to it, so its first
		// steps can come before the item line. They move under the item line when it comes.
		const round = ROUND.map((line) => `  ✓ ${line}`);
		expect(progressOf(resumed.stderr)).toEqual(["✓ item 2/2: Add a thanks line", ...round]);
		expect(resumed.model.calls.map((call) => call.kind)).toEqual([...SHIP, "requeue"]);
		const worktree = worktreeOf(first.id);
		const reflog = git(worktree, "reflog", "--format=%gs").split("\n");
		expect(reflog.filter((line) => line === "commit: Fix the README typo")).toHaveLength(1);
		expect(git(worktree, "rev-list", "--count", `${start}..HEAD`)).toBe("2");
	});
});
