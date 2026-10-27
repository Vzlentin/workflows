import { existsSync } from "node:fs";
import { chmod, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	COMMIT,
	type Commit,
	conversationOf,
	git,
	PASSING_JUDGE,
	progressOf,
	repository,
	sandbox,
	statusesOf,
	untimed,
	workflows,
	worktreeAt,
} from "./support.ts";

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
const worktreeOf = (id: string | undefined) => worktreeAt(repo, id);
const GOAL = "# Fix the README\n\nFix the typo, then thank the reader.\n";
const FIRST = "# Fix the README typo\n\nThe README says wrold.";
const SECOND = "# Add a thanks line\n\nEnd the README with Thanks.";
const FIXED = "# Demo\n\nHello world\n";
const THANKED = `${FIXED}Thanks.\n`;
const THIRD = "# Thank the reader\n\nEnd the README with Thanks.";

const SHIP = ["research", "plan", "challenge", "handoff", "implement", "review", "verdict", "judge", "commit"];

const THANKS: Commit = {
	subject: "docs: thank the reader",
	body: "The README ends with Thanks.",
};

/** The step lines of an item that ships in one round, under its item line: `stat` after implement, then the judge. */
function itemSteps(stat: string, subject: string) {
	return [
		"  ✓ research",
		"  ✓ plan",
		"  ✓ implement",
		`    ${stat}`,
		"  ✓ round 1/3: review",
		"    SHIP",
		"  ✓ judge",
		"    judge 0.83",
		expect.stringMatching(new RegExp(`^ {2}commit [0-9a-f]+ ${subject}$`)),
	];
}

/** The report line of the finding of the campaign judge, from `PASSING_JUDGE`. */
const FINDING = "  finding 4 FAIL README.md:3 adds a line the work item does not need";

/** The steps of the judge of a campaign that is done. */
const JUDGE_STEPS = ["✓ all 2 items", "  ✓ judge", "    judge 0.83"];

/** The report line of a shipped item with the commit `subject`. */
const itemLine = (subject: string) => expect.stringMatching(new RegExp(`^ {2}[0-9a-f]+ ${subject}, judge 0\\.83$`));

// Each test runs a whole campaign, and some resume it: on CI one takes about 5 s.
describe("workflows campaign", { timeout: 30_000 }, () => {
	it("gives judgeError and no judge when the campaign judge fails", async () => {
		const failing = "1 PASS\n2 PASS";

		const run = await workflows(["campaign", "--json", GOAL], {
			cwd: repo,
			script: { items: [[FIRST]], edits: [FIXED], commit: [COMMIT], judge: [PASSING_JUDGE, failing, failing, failing] },
		});

		expect(run.code).toBe(0);
		const { result, report } = JSON.parse(run.stdout[1] ?? "");
		expect(report[0]).toMatch(/^done Fix the README in 1 item, judge failed, [0-9a-f]+$/);
		expect(result.judgeError).toBe("the answer did not call respond");
		expect(result).not.toHaveProperty("judge");
	});

	it("ships two items as two commits on the campaign branch", async () => {
		const run = await workflows(["campaign", "--json", GOAL], {
			cwd: repo,
			script: { items: [[FIRST, SECOND]], edits: [FIXED, THANKED], commit: [COMMIT, THANKS] },
		});

		expect(run.code).toBe(0);
		const { result, report } = JSON.parse(run.stdout[1] ?? "");
		expect(run.stdout).toHaveLength(2);
		expect(run.stdout[0]).toBe(`run ${run.id}`);
		expect(report).toEqual([
			expect.stringMatching(/^done Fix the README in 2 items, judge 0\.83, [0-9a-f]+$/),
			itemLine(COMMIT.subject),
			itemLine(THANKS.subject),
			FINDING,
			"branch docs/readme",
		]);
		expect(result).toMatchObject({ subject: "docs: readme", branch: "docs/readme" });
		expect(result.judge).toEqual({ score: 5 / 6, findings: PASSING_JUDGE.findings });
		expect(result).not.toHaveProperty("judgeError");
		expect(result.items[0].result).toMatchObject({
			status: "shipped",
			findings: PASSING_JUDGE.findings,
			memory: [
				"#0 item 1 planner: Handoff 1: one word changes.",
				"#1 item 1 implementer r1: Implement 1: README.md had wrold.",
			],
		});
		// The items share the memory of the campaign.
		expect(run.model.find("plan", 1)?.prompt).toMatch(
			/^## memory\n#0 item 1 planner: Handoff 1: [^\n]*\n#1 item 1 implementer r1: [^\n]*\n\nPlan this change\./,
		);
		expect(progressOf(run.stderr)).toEqual([
			"✓ split",
			"  2 items",
			"✓ item 1/2: Fix the README typo",
			...itemSteps("+1 -1 in 1 file", COMMIT.subject),
			"✓ item 2/2: Add a thanks line",
			...itemSteps("+1 -0 in 1 file", THANKS.subject),
			...JUDGE_STEPS,
		]);
		// The end of an item's ship run and the step of the next item come in either order, so the bare item steps
		// between them are left out.
		const statuses = statusesOf(run.stderr).filter((status) => !/^item \d\/\d: [^›]+$/.test(status));
		const one = "item 1/2: Fix the README typo";
		const two = "item 2/2: Add a thanks line";
		expect(statuses.filter((status, i) => status !== statuses[i - 1])).toEqual([
			"split",
			`${one} › research`,
			`${one} › plan`,
			`${one} › implement`,
			`${one} › round 1/3: review`,
			`${one} › judge`,
			`${two} › research`,
			`${two} › plan`,
			`${two} › implement`,
			`${two} › round 1/3: review`,
			`${two} › judge`,
			"all 2 items",
			"all 2 items › judge",
			"all 2 items",
			"-",
		]);
		expect(run.model.calls.map((call) => call.kind)).toEqual(["split", ...SHIP, ...SHIP, "judge"]);
		expect(run.model.calls.at(-1)?.prompt).toMatch(new RegExp(`## item\\n${GOAL.trim()}\\n\\n## base\\n${start}\\n`));
		const [split] = run.model.calls;
		expect(split?.prompt).toMatch(/^Split this goal into work items\.\n[\s\S]*\n\n## goal\n# Fix the README\n/);
		expect(split?.prompt).not.toContain("## answer");
		expect(split?.tools).toContain("respond");
		expect(run.model.find("commit")?.prompt).not.toContain("branch");

		const worktree = worktreeOf(run.id);
		expect(git(worktree, "branch", "--show-current")).toBe("docs/readme");
		expect(git(worktree, "rev-parse", "HEAD~2")).toBe(start);
		const messages = git(worktree, "log", "--format=%B%x00", `${start}..HEAD`).split("\0").slice(0, 2);
		expect(messages.map((message) => message.trim())).toEqual(
			[THANKS, COMMIT].map(({ subject, body }) => `${subject}\n\n${body}`),
		);
		expect(report[0]).toContain(git(worktree, "rev-parse", "--short", "HEAD"));
		expect(await readFile(join(worktree, "README.md"), "utf8")).toBe(THANKED);
		expect(await readFile(join(runs(), run.id ?? "", "item-2", "round-1.patch"), "utf8")).toContain("+Thanks.");
		expect(existsSync(join(runs(), run.id ?? "", "round-1.patch"))).toBe(false);
		expect(git(repo, "rev-parse", "HEAD")).toBe(start);
		expect(git(repo, "branch", "--format=%(refname:short)")).toBe("docs/readme\nmain");

		const steps = await workflows(["show", run.id ?? ""], { cwd: root });
		expect(steps.stdout.slice(1).map(untimed)).toEqual([...progressOf(run.stderr), ...report]);
		const shown = await workflows(["show", run.id ?? "", "--calls"], { cwd: root });
		const children = result.items.map((item: { result: { runId: string } }) => item.result.runId);
		const lines = shown.stdout.map((line) => untimed(line));

		const researchers: (number | undefined)[] = [];

		for (const [n, child] of children.entries()) {
			const at = lines.indexOf(`  ✓ run ship ${child}`);
			const item = n === 0 ? "Fix the README typo" : "Add a thanks line";
			expect(lines[at - 3], child).toBe(`item ${n + 1}/2: ${item}`);
			researchers.push(await conversationOf(new RegExp(`Research the codebase[\\s\\S]*${item}`)));
			expect(lines.slice(at + 1, at + 5)).toEqual([
				expect.stringMatching(/^ {6}✓ run rpi \S+$/),
				"        research",
				`          ✓ session researcher conversation ${researchers[n]}`,
				"          ✓ ask researcher",
			]);
		}

		expect(lines.slice(-report.length)).toEqual(report);
		const { calls } = JSON.parse((await workflows(["show", run.id ?? "", "--json"], { cwd: root })).stdout[0] ?? "");
		const ran = calls.filter((call: { kind: string }) => call.kind === "run");
		expect(ran.map((call: { label: string }) => call.label)).toEqual([
			...children.map((child: string) => `ship ${child}`),
			expect.stringMatching(/^judge \S+$/),
		]);
		const shipped = ran.slice(0, -1);
		expect(shipped[0].calls[0]).toMatchObject({ kind: "run", label: expect.stringMatching(/^rpi \S+$/) });
		expect(shipped[0].calls[0].calls[0]).toMatchObject({
			kind: "session",
			label: `researcher conversation ${researchers[0]}`,
			phase: "research",
			mark: "✓",
			conversation: researchers[0],
		});
		const { runId: _, ...first } = result.items[0].result;
		expect(shipped[0].result).toMatchObject({ runId: children[0], result: first });
		expect(shipped[0]).not.toHaveProperty("child");
	});

	it("resets to the start commit after a judge score of 0, and stops on the answer stop", async () => {
		const judge = { answers: ["FAIL", ...Array(7).fill("PASS")], findings: ["1 FAIL: the typo stays."] };

		const run = await workflows(["campaign", GOAL], {
			cwd: repo,
			script: { items: [[FIRST, SECOND]], edits: [FIXED], judge },
		});

		expect(run.code).toBe(3);
		const patch = join(runs(), run.id ?? "", "item-1", "round-1.patch");
		expect(run.stdout).toEqual([
			`run ${run.id}`,
			[
				"Rundown 1: the item failed.",
				"Suggestions:\n- Split the item.",
				"Proposed items:",
				`Patch of the failed item: ${patch}`,
				"How should the campaign continue? Answer stop, or nothing, to end it.",
			].join("\n\n"),
		]);
		const worktree = worktreeOf(run.id);
		expect(git(worktree, "rev-parse", "HEAD")).toBe(start);
		expect(existsSync(patch)).toBe(true);
		expect(run.model.calls.map((call) => call.kind)).toEqual(["split", ...SHIP, "rundown"]);
		const rundown = run.model.find("rundown")?.prompt;
		expect(rundown).toContain("## status\nshipped with judge score 0");
		expect(rundown).toContain("## findings\n1 FAIL");
		expect(rundown).toContain(`## remaining\n${JSON.stringify([SECOND])}`);
		expect(rundown).toMatch(
			/\n## memory\n#0 item 1 planner: [^\n]*\n#1 item 1 implementer r1: [^\n]*\n#2 campaign: item 1 failed and was reset: its notes describe code that is gone\n/,
		);
		expect(rundown).toContain(`## patch\n${patch}`);

		const stopped = await workflows(["resume", run.id ?? "", "--answer", " Stop "], { cwd: root });
		expect(stopped.code).toBe(1);
		expect(stopped.stdout).toEqual([
			`run ${run.id}`,
			`stopped Fix the README at item 1: ${worktree}`,
			"Rundown 1: the item failed.",
		]);
		expect(stopped.model.calls).toEqual([]);
		expect(git(worktree, "branch", "--show-current")).toBe(`campaign/${run.id}`);
		const json = await workflows(["resume", run.id ?? "", "--json"], { cwd: root });
		const result = JSON.parse(json.stdout[1] ?? "").result;
		expect(result.rundown).toBe("Rundown 1: the item failed.");
		git(worktree, "apply", "--index", patch);
		expect(git(worktree, "write-tree")).toBe(git(worktree, "rev-parse", `${result.items[0].result.head}^{tree}`));
	});

	it("resets to the last shipped commit after a stopped item, and goes on with the answer", async () => {
		const run = await workflows(["campaign", "--rounds", "1", GOAL], {
			cwd: repo,
			script: { items: [[FIRST, SECOND]], edits: [FIXED, THANKED], verdicts: ["SHIP", "FIX"] },
		});

		expect(run.code).toBe(3);
		const worktree = worktreeOf(run.id);
		expect(git(worktree, "rev-parse", "HEAD~1")).toBe(start);
		expect(await readFile(join(worktree, "README.md"), "utf8")).toBe(FIXED);
		expect(await readFile(join(runs(), run.id ?? "", "item-2", "round-1.patch"), "utf8")).toContain("+Thanks.");
		const rundown = run.model.find("rundown")?.prompt;
		expect(rundown).toContain("## handoff\nHandoff 2:");
		expect(rundown).toContain(
			`## shipped\n${JSON.stringify([{ item: FIRST, commit: git(worktree, "rev-parse", "--short", "HEAD") }])}`,
		);

		const resumed = await workflows(["resume", run.id ?? "", "--answer", "Thank the reader in one line", "--json"], {
			cwd: root,
			script: { items: [[THIRD]], edits: [THANKED], commit: THANKS },
		});

		expect(resumed.code).toBe(0);
		expect(resumed.model.calls.map((call) => call.kind)).toEqual(["split", ...SHIP, "judge"]);
		const split = resumed.model.find("split")?.prompt;
		expect(split).toContain("## rundown\nRundown 1");
		expect(split).toContain("## answer\nThank the reader in one line");
		expect(progressOf(resumed.stderr)).toEqual(expect.arrayContaining(["✓ split", "✓ item 3/3: Thank the reader"]));
		expect(JSON.parse(resumed.stdout[1] ?? "").report).toEqual([
			expect.stringMatching(/^done Fix the README in 2 items, judge 0\.83, [0-9a-f]+$/),
			itemLine(COMMIT.subject),
			itemLine(THANKS.subject),
			FINDING,
			"branch docs/readme",
		]);
		expect(git(worktree, "rev-parse", "HEAD~2")).toBe(start);
	});

	it("resumes in the second item and repeats no call of the first", async () => {
		const first = await workflows(["campaign", GOAL], {
			cwd: repo,
			script: { items: [[FIRST, SECOND]], edits: [FIXED], interruptAt: { kind: "research", nth: 2 } },
		});

		expect(first.code).toBe(130);
		expect(first.model.calls.map((call) => call.kind)).toEqual(["split", ...SHIP]);

		const resumed = await workflows(["resume", first.id ?? "", "--json"], {
			cwd: root,
			script: { edits: [THANKED], commit: THANKS },
		});

		expect(resumed.code).toBe(0);
		expect(JSON.parse(resumed.stdout[1] ?? "").report).toEqual([
			expect.stringMatching(/^done Fix the README in 2 items, judge 0\.83, [0-9a-f]+$/),
			itemLine(COMMIT.subject),
			itemLine(THANKS.subject),
			FINDING,
			"branch docs/readme",
		]);
		// The pending nested ship task restarts at the same time as the campaign script replays to it, so its first
		// steps can come before the item line. They move under the item line when it comes.
		expect(progressOf(resumed.stderr)).toEqual([
			"✓ item 2/2: Add a thanks line",
			...itemSteps("+1 -0 in 1 file", THANKS.subject),
			...JUDGE_STEPS,
		]);
		expect(resumed.model.calls.map((call) => call.kind)).toEqual([...SHIP, "judge"]);
		const worktree = worktreeOf(first.id);
		const reflog = git(worktree, "reflog", "--format=%gs").split("\n");
		expect(reflog.filter((line) => line === `commit: ${COMMIT.subject}`)).toHaveLength(1);
		expect(git(worktree, "rev-list", "--count", `${start}..HEAD`)).toBe("2");
	});

	it("renames the campaign branch with a suffix when the name of the split subject exists", async () => {
		git(repo, "branch", "docs/readme");

		const run = await workflows(["campaign", "--json", GOAL], {
			cwd: repo,
			script: { items: [[FIRST]], edits: [FIXED] },
		});

		expect(run.code).toBe(0);
		const { result, report } = JSON.parse(run.stdout[1] ?? "");
		expect(result.branch).toBe("docs/readme-2");
		expect(report).toEqual([expect.any(String), itemLine(COMMIT.subject), FINDING, "branch docs/readme-2"]);
		expect(git(worktreeOf(run.id), "branch", "--show-current")).toBe("docs/readme-2");
		expect(git(repo, "rev-parse", "docs/readme")).toBe(start);
	});

	it("keeps the campaign branch when the name of the split subject conflicts with an existing branch", async () => {
		git(repo, "branch", "docs");

		const run = await workflows(["campaign", GOAL], {
			cwd: repo,
			script: { items: [[FIRST]], edits: [FIXED] },
		});

		expect(run.code).toBe(0);
		expect(run.stdout).toEqual([
			`run ${run.id}`,
			expect.stringMatching(/^done Fix the README in 1 item, judge 0\.83, [0-9a-f]+$/),
			itemLine(COMMIT.subject),
			FINDING,
			`branch docs/readme is in conflict with an existing branch; kept campaign/${run.id}`,
		]);
		expect(git(worktreeOf(run.id), "branch", "--show-current")).toBe(`campaign/${run.id}`);
	});

	it("runs the rename step again on resume after the rename was done", async () => {
		const hook = join(repo, ".git", "hooks", "reference-transaction");
		const gate = join(root, "gate");
		// The rename moves the branch, then points HEAD at it: the gate stops after the HEAD update.
		await writeFile(
			hook,
			`#!/bin/sh
refs=$(cat)
[ "$1" = committed ] || exit 0
case "$refs" in *refs/heads/docs/readme*) ;; *) exit 0 ;; esac
touch "${gate}.reached"
while [ ! -f "${gate}.open" ]; do sleep 0.02; done
`,
		);
		await chmod(hook, 0o755);
		const interrupt = new AbortController();

		const pending = workflows(["campaign", GOAL], {
			cwd: repo,
			interrupt,
			script: { items: [[FIRST]], edits: [FIXED] },
		});

		while (!existsSync(`${gate}.reached`)) await new Promise((resolve) => setTimeout(resolve, 10));
		interrupt.abort();
		const first = await pending;
		await writeFile(`${gate}.open`, "");
		expect(first.code).toBe(130);
		const worktree = worktreeOf(first.id);
		expect(git(worktree, "branch", "--show-current")).toBe("docs/readme");

		await rm(hook);
		const resumed = await workflows(["resume", first.id ?? ""], { cwd: repo });
		expect(resumed.code).toBe(0);
		expect(resumed.model.calls).toEqual([]);
		expect(resumed.stdout).toEqual([
			`run ${first.id}`,
			expect.stringMatching(/^done Fix the README in 1 item, judge 0\.83, [0-9a-f]+$/),
			itemLine(COMMIT.subject),
			FINDING,
			"branch docs/readme",
		]);
		expect(git(worktree, "branch", "--show-current")).toBe("docs/readme");
		expect(git(repo, "branch", "--format=%(refname:short)")).toBe("docs/readme\nmain");
	});
});
