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
	untimed,
	workflows,
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
const worktreeOf = (id: string | undefined) => join(runs(), id ?? "missing", "worktree");
const GOAL = "# Fix the README\n\nFix the typo, then thank the reader.\n";
const FIRST = "# Fix the README typo\n\nThe README says wrold.";
const SECOND = "# Add a thanks line\n\nEnd the README with Thanks.";
const FIXED = "# Demo\n\nHello world\n";
const THANKED = `${FIXED}Thanks.\n`;
const THIRD = "# Thank the reader\n\nEnd the README with Thanks.";

const QUESTION = [
	"Rundown 1: the item failed.",
	"Suggestions:\n- Split the item.",
	"Proposed queue:",
	"How should the campaign continue? Answer stop, or nothing, to end it.",
].join("\n\n");

const SHIP = ["research", "plan", "challenge", "handoff", "implement", "review", "verdict", "judge", "commit"];

const THANKS: Commit = {
	branch: "docs/thanks",
	subject: "docs: thank the reader",
	body: "The README ends with Thanks.",
};

/** The step lines of an item that ships in one round, under its item line: `stat` after implement, then the judge. */
function itemSteps(stat: string, subject: string) {
	return [
		"  ✓ research",
		"  ✓ plan",
		"  ✓ round 1: implement",
		`    ${stat}`,
		"  ✓ round 1: review",
		"    SHIP",
		"  ✓ judge",
		expect.stringMatching(new RegExp(`^ {4}judge 0\\.83: [0-9a-f]+ ${subject}$`)),
	];
}

/** The report line of a shipped item with the commit `subject`. */
const itemLine = (subject: string) => expect.stringMatching(new RegExp(`^ {2}[0-9a-f]+ ${subject}, judge 0\\.83$`));

describe("workflows campaign", () => {
	it("ships two items as two commits on the campaign branch", async () => {
		const run = await workflows(["campaign", "--json", GOAL], {
			cwd: repo,
			script: { items: [FIRST], edits: [FIXED, THANKED], queues: [[SECOND], []], commit: [COMMIT, THANKS] },
		});

		expect(run.code).toBe(0);
		const { result, report } = JSON.parse(run.stdout[1] ?? "");
		expect(run.stdout).toHaveLength(2);
		expect(run.stdout[0]).toBe(`run ${run.id}`);
		expect(report).toEqual([
			expect.stringMatching(/^done Fix the README in 2 items, [0-9a-f]+ on docs\/readme$/),
			itemLine(COMMIT.subject),
			itemLine(THANKS.subject),
		]);
		expect(result.branch).toBe("docs/readme");
		expect(result.items[0].result).toMatchObject({
			...PASSING_JUDGE,
			memory: ["#1 planner 0: Handoff 1: one word changes.", "#2 implementer 1: Implement 1: README.md had wrold."],
		});
		expect(progressOf(run.stderr)).toEqual([
			"✓ split",
			"  1 item",
			"✓ item 1/1: Fix the README typo",
			...itemSteps("+1 -1 in 1 file", COMMIT.subject),
			"  queue: 1 item",
			"✓ item 2/2: Add a thanks line",
			...itemSteps("+1 -0 in 1 file", THANKS.subject),
			"  queue: empty",
		]);
		expect(run.model.calls.map((call) => call.kind)).toEqual([
			"split",
			...SHIP,
			"requeue",
			...SHIP,
			"requeue",
			"branch",
		]);
		const [split] = run.model.calls;
		expect(split?.prompt).toMatch(/^Split this goal into work items\.\n[\s\S]*\n\n## goal\n# Fix the README\n/);
		expect(split?.tools).toContain("respond");
		expect(run.model.find("requeue")?.prompt).toContain(`## done\n${FIRST}\n\n## queue\n[]\n\nAnswer with respond:`);
		expect(run.model.find("branch")?.prompt).toContain(
			`## goal\n${GOAL}\n## commits\n${COMMIT.subject}\n${THANKS.subject}`,
		);

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
		const lines = shown.stdout.map((line) => line.replace(/ {2}\d+s$/, ""));

		const researchers: (number | undefined)[] = [];

		for (const [n, child] of children.entries()) {
			const at = lines.indexOf(`  ✓ run ship ${child}`);
			const item = n === 0 ? "Fix the README typo" : "Add a thanks line";
			expect(lines[at - 3], child).toBe(`item ${n + 1}/${n + 1}: ${item}`);
			researchers.push(await conversationOf(new RegExp(`Research the codebase[\\s\\S]*${item}`)));
			expect(lines.slice(at + 1, at + 4)).toEqual([
				"    research",
				`      ✓ session researcher conversation ${researchers[n]}`,
				"      ✓ ask researcher",
			]);
		}

		expect(lines.slice(-3)).toEqual(report);
		const { calls } = JSON.parse((await workflows(["show", run.id ?? "", "--json"], { cwd: root })).stdout[0] ?? "");
		const shipped = calls.filter((call: { kind: string }) => call.kind === "run");
		expect(shipped.map((call: { label: string }) => call.label)).toEqual(
			children.map((child: string) => `ship ${child}`),
		);
		expect(shipped[0].calls[0]).toMatchObject({
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
			script: { items: [FIRST, SECOND], edits: [FIXED], judge },
		});

		expect(run.code).toBe(3);
		expect(run.stdout).toEqual([`run ${run.id}`, QUESTION]);
		const worktree = worktreeOf(run.id);
		expect(git(worktree, "rev-parse", "HEAD")).toBe(start);
		expect(existsSync(join(runs(), run.id ?? "", "item-1", "round-1.patch"))).toBe(true);
		expect(run.model.calls.map((call) => call.kind)).toEqual(["split", ...SHIP, "rundown"]);
		const rundown = run.model.find("rundown")?.prompt;
		expect(rundown).toContain("## status\nshipped with judge score 0");
		expect(rundown).toContain("## findings\n1 FAIL");
		expect(rundown).toContain(`## queue\n${JSON.stringify([SECOND])}`);

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
		expect(JSON.parse(json.stdout[1] ?? "").result.rundown).toBe("Rundown 1: the item failed.");
	});

	it("resets to the last shipped commit after a stopped item, and goes on with the answer", async () => {
		const run = await workflows(["campaign", "--rounds", "1", GOAL], {
			cwd: repo,
			script: { items: [FIRST], queues: [[SECOND]], edits: [FIXED, THANKED], verdicts: ["SHIP", "FIX"] },
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
			script: { items: [THIRD], edits: [THANKED], queues: [[]], commit: THANKS },
		});

		expect(resumed.code).toBe(0);
		expect(resumed.model.calls.map((call) => call.kind)).toEqual(["split", ...SHIP, "requeue", "branch"]);
		const split = resumed.model.find("split")?.prompt;
		expect(split).toContain("## rundown\nRundown 1");
		expect(split).toContain("## answer\nThank the reader in one line");
		expect(progressOf(resumed.stderr)).toContain("✓ item 3/3: Thank the reader");
		expect(JSON.parse(resumed.stdout[1] ?? "").report).toEqual([
			expect.stringMatching(/^done Fix the README in 2 items, [0-9a-f]+ on docs\/readme$/),
			itemLine(COMMIT.subject),
			itemLine(THANKS.subject),
		]);
		expect(git(worktree, "rev-parse", "HEAD~2")).toBe(start);
	});

	it("resumes in the second item and repeats no call of the first", async () => {
		const first = await workflows(["campaign", GOAL], {
			cwd: repo,
			script: { items: [FIRST], edits: [FIXED], queues: [[SECOND]], interruptAt: { kind: "research", nth: 2 } },
		});

		expect(first.code).toBe(130);
		expect(first.model.calls.map((call) => call.kind)).toEqual(["split", ...SHIP, "requeue"]);

		const resumed = await workflows(["resume", first.id ?? "", "--json"], {
			cwd: root,
			script: { edits: [THANKED], queues: [[]], commit: THANKS },
		});

		expect(resumed.code).toBe(0);
		expect(JSON.parse(resumed.stdout[1] ?? "").report).toEqual([
			expect.stringMatching(/^done Fix the README in 2 items, [0-9a-f]+ on docs\/readme$/),
			itemLine(COMMIT.subject),
			itemLine(THANKS.subject),
		]);
		// The pending nested ship task restarts at the same time as the campaign script replays to it, so its first
		// steps can come before the item line. They move under the item line when it comes.
		expect(progressOf(resumed.stderr)).toEqual([
			"✓ item 2/2: Add a thanks line",
			...itemSteps("+1 -0 in 1 file", THANKS.subject),
			"  queue: empty",
		]);
		expect(resumed.model.calls.map((call) => call.kind)).toEqual([...SHIP, "requeue", "branch"]);
		const worktree = worktreeOf(first.id);
		const reflog = git(worktree, "reflog", "--format=%gs").split("\n");
		expect(reflog.filter((line) => line === `commit: ${COMMIT.subject}`)).toHaveLength(1);
		expect(git(worktree, "rev-list", "--count", `${start}..HEAD`)).toBe("2");
	});

	it("renames the campaign branch with a suffix when the planner name exists", async () => {
		git(repo, "branch", "docs/readme");

		const run = await workflows(["campaign", "--json", GOAL], {
			cwd: repo,
			script: { items: [FIRST], edits: [FIXED] },
		});

		expect(run.code).toBe(0);
		const { result, report } = JSON.parse(run.stdout[1] ?? "");
		expect(result.branch).toBe("docs/readme-2");
		expect(report).toEqual([expect.stringMatching(/ on docs\/readme-2$/), itemLine(COMMIT.subject)]);
		expect(git(worktreeOf(run.id), "branch", "--show-current")).toBe("docs/readme-2");
		expect(git(repo, "rev-parse", "docs/readme")).toBe(start);
	});

	it("keeps the campaign branch when the planner name is not valid", async () => {
		const run = await workflows(["campaign", GOAL], {
			cwd: repo,
			script: { items: [FIRST], edits: [FIXED], branch: "bad..name" },
		});

		expect(run.code).toBe(0);
		expect(run.stdout).toEqual([
			`run ${run.id}`,
			expect.stringMatching(new RegExp(`^done Fix the README in 1 item, [0-9a-f]+ on campaign/${run.id}$`)),
			`branch bad..name is not a valid branch name; kept campaign/${run.id}`,
			itemLine(COMMIT.subject),
		]);
		expect(git(worktreeOf(run.id), "branch", "--show-current")).toBe(`campaign/${run.id}`);
	});

	it("keeps the campaign branch when the branch turn fails", async () => {
		const run = await workflows(["campaign", GOAL], {
			cwd: repo,
			script: { items: [FIRST], edits: [FIXED], failAt: { kind: "branch", nth: 1 } },
		});

		expect(run.code).toBe(0);
		expect(run.stdout).toEqual([
			`run ${run.id}`,
			expect.stringMatching(new RegExp(` on campaign/${run.id}$`)),
			itemLine(COMMIT.subject),
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
			script: { items: [FIRST], edits: [FIXED] },
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
		expect(resumed.stdout).toEqual([`run ${first.id}`, expect.stringMatching(/ on docs\/readme$/)]);
		expect(git(worktree, "branch", "--show-current")).toBe("docs/readme");
		expect(git(repo, "branch", "--format=%(refname:short)")).toBe("docs/readme\nmain");
	});
});
