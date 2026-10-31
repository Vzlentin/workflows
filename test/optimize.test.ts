import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Call, type Edit, git, repository, runsOf, type Script, sandbox, workflows } from "./support.ts";

let root: string;
let repo: string;
let start: string;

beforeEach(async () => {
	root = await sandbox();
	repo = join(root, "repo");
	start = await repository(repo);
});

afterEach(() => rm(root, { recursive: true, force: true }));

const FIXED = "# Demo\n\nHello world\n";
const CANDIDATE = "# Demo\n\nHello, world\n";
const MARK = "INV: check every word.";

// The faux model gives the review kind to a prompt that starts with the review template's first words.
const INV: readonly Edit[] = [
	{
		path: "prompts/review.md",
		text: `Perform a deep code quality audit of this change.\n\n${MARK}\n$@\n`,
		moment: "run x: 4 FAIL README.md:3",
	},
];

/** The hash of the package's `prompts/` and `agents/` folders. */
async function promptsHash(): Promise<string> {
	const hash = createHash("sha256");

	for (const name of ["prompts", "agents"]) {
		const folder = fileURLToPath(new URL(`../workflows/${name}/`, import.meta.url));

		for (const file of (await readdir(folder)).sort()) hash.update(file).update(await readFile(join(folder, file)));
	}

	return hash.digest("hex");
}

/** A ship run of `item` in the repository with `script`, and its run ID and result. */
async function ship(
	item: string,
	argv: readonly string[] = [],
	script: Omit<Script, "interrupt"> = { edits: [FIXED] },
) {
	const run = await workflows(["ship", "--json", ...argv, item], { cwd: repo, script });

	return { code: run.code, runId: run.id ?? "", result: JSON.parse(run.stdout[1] ?? "{}").result };
}

const reviews = (calls: readonly Call[], marked: boolean) =>
	calls.filter((call) => call.kind === "review" && call.prompt.includes(MARK) === marked).length;

/** The label of the candidate's diff in each select prompt. */
const labels = (calls: readonly Call[]) =>
	calls.flatMap(({ kind, prompt }) =>
		kind === "select" ? [prompt.slice(0, prompt.indexOf("\n## B\n")).includes("Hello, world") ? "A" : "B"] : [],
	);

describe("workflows optimize", () => {
	it("keeps saved baselines, ships an INV overlay, and promotes it on 3 blind wins of 4", async () => {
		const saved = [];

		for (const n of [1, 2, 3, 4]) saved.push(await ship(`Fix the README typo ${n}`));
		expect(saved.map((run) => run.code)).toEqual([0, 0, 0, 0]);

		const branches = git(repo, "branch", "--format=%(refname:short)");
		const worktrees = git(repo, "worktree", "list", "--porcelain");
		const before = await promptsHash();

		const first = await workflows(["optimize", "ship"], {
			cwd: repo,
			script: {
				edits: Array(4).fill(CANDIDATE),
				inv: INV,
				select: ["Hello, world", "Hello, world", "Hello, world", "Hello world"],
			},
		});

		const directory = join(runsOf(root), first.id ?? "");
		const diff = join(directory, "overlay.diff");
		expect(first.code).toBe(0);
		expect(first.stdout.at(-1)).toBe(`optimized ship: 3/4 wins, promoted, ${diff}`);
		expect(first.model.count("research")).toBe(4);
		expect(reviews(first.model.calls, true)).toBe(4);
		expect(reviews(first.model.calls, false)).toBe(0);
		const inv = first.model.find("inv")?.prompt ?? "";

		for (const { runId } of saved) expect(inv).toContain(runId);
		expect(inv).toContain("Implement 1: README.md had wrold.");
		expect(inv).toContain("4 FAIL README.md:3 adds a line the work item does not need");
		const selects = first.model.calls.filter((call) => call.kind === "select");
		expect(selects).toHaveLength(4);

		for (const { prompt } of selects) {
			expect(prompt).not.toContain("INV:");
			expect(prompt).not.toContain("## memory");
			expect(prompt).toContain("+Hello, world");
			expect(prompt).toContain("+Hello world");
		}

		expect(await readFile(join(directory, "best", "prompts", "review.md"), "utf8")).toContain(MARK);
		expect(await readFile(join(directory, "baseline", "prompts", "review.md"), "utf8")).not.toContain(MARK);
		const text = await readFile(diff, "utf8");
		expect(text).toContain(`\n+${MARK}\n`);
		expect(text).toContain("edit prompts/review.md: run x: 4 FAIL README.md:3\n");
		expect(await promptsHash()).toBe(before);
		expect(git(repo, "branch", "--format=%(refname:short)")).toBe(branches);
		expect(git(repo, "worktree", "list", "--porcelain")).toBe(worktrees);

		const second = await workflows(["optimize", "ship"], {
			cwd: repo,
			script: {
				edits: Array(4).fill(CANDIDATE),
				inv: INV,
				select: ["Hello, world", "tie", "Hello, world", "Hello world"],
			},
		});

		const other = join(runsOf(root), second.id ?? "");
		expect(second.code).toBe(0);

		const order = saved
			.map(({ runId }) => runId)
			.sort()
			.reverse();

		expect(second.stdout.slice(1)).toEqual([
			...order.map((runId, index) => `${runId}: ${["win", "tie", "win", "loss"][index]}`),
			`optimized ship: 2/4 wins, not promoted, ${join(other, "overlay.diff")}`,
		]);
		expect(labels(second.model.calls)).toEqual(labels(first.model.calls));
		expect(await readFile(join(other, "best", "prompts", "review.md"), "utf8")).not.toContain(MARK);
	}, 120_000);

	it("runs a baseline again when its head is gone or it did not ship", async () => {
		const gone = await ship("Fix the README typo");
		expect(gone.code).toBe(0);
		git(repo, "worktree", "remove", "--force", gone.result.worktree);

		const branch = git(repo, "branch", "--format=%(refname:short)")
			.split("\n")
			.find((name) => name !== "main");

		git(repo, "branch", "-D", branch ?? "");
		git(repo, "reflog", "expire", "--expire=now", "--all");
		git(repo, "gc", "-q", "--prune=now");
		expect(() => git(repo, "rev-parse", "-q", "--verify", `${gone.result.head}^{commit}`)).toThrow();

		const stopped = await ship("Fix the README typo again", ["--rounds", "1"], { edits: [FIXED], verdicts: ["FIX"] });
		expect([stopped.code, stopped.result.status]).toEqual([1, "stopped"]);

		const run = await workflows(["optimize", "ship", "--runs", `${gone.runId}, ${stopped.runId}`], {
			cwd: repo,
			script: { edits: [FIXED, FIXED, CANDIDATE, CANDIDATE], inv: INV, select: ["Hello, world", "Hello, world"] },
		});

		expect(run.code).toBe(0);
		expect(reviews(run.model.calls, false)).toBe(2);
		expect(reviews(run.model.calls, true)).toBe(2);
		expect(run.stdout.slice(1, -1)).toEqual([
			`${gone.runId}: win`,
			`${stopped.runId}: win`,
			"fewer than 4 items: nothing promoted",
		]);
		expect(run.stdout.at(-1)).toMatch(/^optimized ship: 2\/2 wins, not promoted, /);
	}, 60_000);

	it("ships the baselines of an items folder with the profiles of the bundle, and keeps the errors of its arguments", async () => {
		const items = join(root, "items");
		await mkdir(items);
		const researcher = await readFile(new URL("../workflows/agents/researcher.md", import.meta.url), "utf8");
		const body = researcher.slice(researcher.indexOf("\n---\n", 4) + 5).trim();
		const profile = (thinking: string) => `---\nmodel: anthropic/claude-opus-5-5\nthinking: ${thinking}\n---\n${body}`;
		const edits: readonly Edit[] = [...INV, { path: "agents/researcher.md", text: profile("high"), moment: "run y" }];

		for (const name of ["First", "Second", "Third", "Fourth"]) {
			await writeFile(
				join(items, `${name.toLowerCase()}.md`),
				`---\nrepo: ../repo\nstart: "${start}"\n---\n# ${name} item\n\nFix the README.\n`,
			);
		}

		const run = await workflows(["optimize", "--workflow", "ship", "--items", "items"], {
			cwd: root,
			script: {
				edits: [...Array(4).fill(FIXED), ...Array(4).fill(CANDIDATE)],
				inv: edits,
				select: Array(3).fill("Hello, world"),
			},
		});

		const directory = join(runsOf(root), run.id ?? "");
		const diff = join(directory, "overlay.diff");
		expect(run.code).toBe(0);

		const research = run.model.calls.flatMap(({ kind, thinking }) => (kind === "research" ? [thinking] : []));

		expect(research.toSorted()).toEqual([...Array(4).fill("high"), ...Array(4).fill("medium")]);
		expect(reviews(run.model.calls, true)).toBe(4);
		expect(run.stdout.slice(1)).toEqual([
			"first: win",
			"fourth: win",
			"second: win",
			"third: tie",
			`optimized ship: 3/4 wins, promoted, ${diff}`,
		]);

		const overlayText = await readFile(diff, "utf8");
		expect(overlayText).toContain("diff --git baseline/agents/researcher.md best/agents/researcher.md\n");
		expect(overlayText).toContain("\n-thinking: medium\n");
		expect(overlayText).toContain("\n+thinking: high\n");
		expect(overlayText).toContain("edit agents/researcher.md: run y\n");
		const written = (folder: string) => readFile(join(directory, folder, "agents", "researcher.md"), "utf8");
		expect(await written("baseline")).toBe(`${profile("medium")}\n`);
		expect(await written("best")).toBe(`${profile("high")}\n`);
		expect(git(repo, "branch", "--format=%(refname:short)")).toBe("main");

		// The baselines of an items folder run again with new run IDs, and the order of the diffs stays the same.
		const again = await workflows(["optimize", "ship", "--items", "items"], {
			cwd: root,
			script: { edits: [...Array(4).fill(FIXED), ...Array(4).fill(CANDIDATE)], inv: INV },
		});

		expect(again.code).toBe(0);
		expect(labels(again.model.calls)).toHaveLength(4);
		expect(labels(again.model.calls)).toEqual(labels(run.model.calls));

		const cases: readonly (readonly [readonly string[], string, Omit<Script, "interrupt">?])[] = [
			[["optimize", "--workflow", "judge", "--items", "items"], "failed optimize: optimize takes ship only, not judge"],
			[["optimize", "ship", "--items", "items", "--runs", "x"], "failed optimize: give --items or --runs, not both"],
			[["optimize", "ship"], "failed optimize: optimize found no completed ship run"],
			[
				["optimize", "ship", "--items", "items"],
				"failed optimize: inv edit prompts/inv.md is not a baseline path",
				{ edits: Array(4).fill(FIXED), inv: [{ path: "prompts/inv.md", text: "x", moment: "y" }] },
			],
		];

		for (const [argv, error, script] of cases) {
			const failed = await workflows(argv, script === undefined ? { cwd: root } : { cwd: root, script });
			expect([failed.code, failed.stderr.at(-2)], argv.join(" ")).toEqual([1, error]);
		}
	}, 120_000);
});
