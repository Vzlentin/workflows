import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type Call,
	childTasks,
	type Edit,
	git,
	inputsOf,
	LESSON,
	LESSON_LINE,
	LESSONED,
	overlayOf,
	repository,
	runsOf,
	type Script,
	sandbox,
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

const FIXED = "# Demo\n\nHello world\n";
const CANDIDATE = "# Demo\n\nHello, world\n";
const MARK = "INV: check every word.";
const KEPT = "kept -> prompts/review.md -> run x: 4 FAIL README.md:3";

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

/** The rows of the run memory of the run directory `directory`, without the `#<k> <date>` start and the padding. */
async function rows(directory: string) {
	const log = await readFile(join(directory, "memory", "LOG.txt"), "utf8");

	return log.split("\n").flatMap((line) => (line === "" ? [] : [line.trimEnd().replace(/^#\d+ \S+ /, "")]));
}

/** The files of the `best/` folder of the run directory `directory`, with their texts, by relative path. */
async function bestOf(directory: string) {
	const folder = join(directory, "best");
	const files = (await readdir(folder, { recursive: true, withFileTypes: true })).filter((entry) => entry.isFile());

	return Object.fromEntries(
		await Promise.all(
			files.map(async (entry) => {
				const path = join(entry.parentPath, entry.name);

				return [path.slice(folder.length + 1), await readFile(path, "utf8")];
			}),
		),
	);
}

const GOAL =
	"Propose prompt, profile, skill and AGENTS.md edits from ship runs, and keep them when a blind judge prefers their diffs.";

/** The harvest prompts of the optimize run itself: their work item is the goal of optimize. */
const goalHarvests = (calls: readonly Call[]) =>
	calls.filter(({ kind, prompt }) => kind === "harvest" && prompt.includes(`## item\n${GOAL}`));

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
		const typos = ".agents/skills/typos/SKILL.md";
		const revised = "---\nname: typos\ndescription: Fix typos word by word\n---\nRead every word twice.\n";

		const first = await workflows(["optimize", "ship"], {
			cwd: repo,
			script: {
				edits: Array(4).fill(CANDIDATE),
				inv: INV,
				dom: [
					{ path: typos, text: "---\nname: typos\ndescription: Typos\n---\nRead.\n", moment: "run x: wrold" },
					{ path: ".pi/skills/extra/SKILL.md", text: "---\nname: extra\n---\n", moment: "run z" },
				],
				compose: {
					overlay: [...INV.map(({ path, text }) => ({ path, text })), { path: typos, text: revised }],
					notes: [
						{ verdict: "kept", edit: "prompts/review.md", moment: "run x: 4 FAIL README.md:3" },
						{ verdict: "revised", edit: typos, moment: "run x: wrold" },
						{ verdict: "dropped", edit: ".pi/skills/extra/SKILL.md", moment: "run z" },
					],
				},
				select: ["Hello, world", "Hello, world", "Hello, world", "Hello world"],
				lessons: [LESSON],
			},
		});

		const directory = join(runsOf(root), first.id ?? "");
		// The items come newest first, by run ID: run IDs made in the same second do not sort by creation time.
		const subjects = new Map(saved.map(({ runId }, index) => [runId, `Fix the README typo ${index + 1}`]));

		const newest = saved
			.map(({ runId }) => runId)
			.sort()
			.reverse();

		expect(await rows(directory)).toEqual(
			newest.map(
				(runId, index) =>
					`item ${subjects.get(runId)}: files prompts/review.md, ${typos}, verdict ${["win", "win", "win", "loss"][index]}, confounded yes`,
			),
		);
		expect(goalHarvests(first.model.calls)).toEqual([]);
		expect(first.stdout.filter((line) => line.startsWith("  lesson"))).toEqual([]);
		const diff = join(directory, "overlay.diff");
		expect(first.code).toBe(0);
		expect(first.stdout.at(-1)).toBe(`optimized ship: 3/4 wins, promoted, ${diff}`);
		const notes = [KEPT, `revised -> ${typos} -> run x: wrold`, "dropped -> .pi/skills/extra/SKILL.md -> run z"];
		expect(first.stdout.slice(1, 4)).toEqual(notes);
		expect(await readFile(join(directory, "notes.txt"), "utf8")).toBe(`${notes.join("\n")}\n`);

		const overlays = (await inputsOf(first.id)).flatMap((input) =>
			input.overlay === undefined ? [] : [input.overlay],
		);

		expect(overlays.length).toBeGreaterThan(0);

		for (const overlay of overlays) expect(overlay).toEqual({ [typos]: revised });
		// The compose prompt also holds the review text, as JSON, so the pattern needs its line breaks.
		const files = await overlayOf(/this change\.\n\nINV: check every word/);
		expect(files).toMatchObject({ files: {} });
		// SAFETY: the match above checks that the harness.overlay doc has a `files` object of paths to texts.
		const entries = Object.entries((files as { files: Record<string, string> }).files);
		expect(entries.filter(([key]) => key.endsWith(`/${typos}`)).map(([, text]) => text)).toEqual([revised]);
		expect(await readFile(join(directory, "best", typos), "utf8")).toBe(`${revised}\n`);
		await expect(readFile(join(directory, "baseline", typos), "utf8")).rejects.toThrow();
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
		expect(text).toContain("\n+name: typos\n");
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
			KEPT,
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
			KEPT,
			`${gone.runId}: win`,
			`${stopped.runId}: win`,
			"fewer than 4 items: nothing promoted",
		]);
		expect(run.stdout.at(-1)).toMatch(/^optimized ship: 2\/2 wins, not promoted, /);
	}, 60_000);

	it("harvests the lessons of a one-file overlay, and resumes an interrupted run to the same result", async () => {
		const saved = [];

		for (const n of [1, 2]) saved.push(await ship(`Fix the README typo ${n}`));
		expect(saved.map((run) => run.code)).toEqual([0, 0]);
		const argv = ["optimize", "ship", "--runs", saved.map(({ runId }) => runId).join(","), "--json"];
		const script = { edits: Array(2).fill(CANDIDATE), inv: INV, lessons: [LESSON] };
		const whole = await workflows(argv, { cwd: repo, script: { ...script, select: ["Hello, world", "Hello world"] } });
		expect(whole.code).toBe(0);
		const U = JSON.parse(whole.stdout[1] ?? "{}");
		expect(U.result.lessons).toEqual([LESSONED]);
		expect(U.report.at(-1)).toBe(LESSON_LINE);
		const harvests = goalHarvests(whole.model.calls);
		expect(harvests).toHaveLength(1);

		for (const [index, verdict] of ["win", "loss"].entries()) {
			const row = `item Fix the README typo ${index + 1}: files prompts/review.md, verdict ${verdict}, confounded no`;
			expect(harvests[0]?.prompt).toContain(row);
		}

		const cut = await workflows(argv, {
			cwd: repo,
			script: { ...script, select: ["Hello, world"], interruptAt: { kind: "select", nth: 2 } },
		});

		expect(cut.code).toBe(130);
		// The interrupted select prompt never got an answer, so it is not among the recorded calls.
		expect(cut.model.count("select")).toBe(1);

		const resumed = await workflows(["resume", cut.id ?? "", "--json"], {
			cwd: repo,
			script: { ...script, select: ["Hello world"] },
		});

		expect(resumed.code).toBe(0);

		// The JSON output of a run with its run directory replaced by `<run>`.
		const placed = (json: string | undefined, id: string | undefined) =>
			JSON.parse((json ?? "{}").replaceAll(join(runsOf(root), id ?? ""), "<run>"));

		const R = placed(resumed.stdout[1], cut.id);

		expect(R).toEqual({ ...placed(whole.stdout[1], whole.id), runId: R.runId });
		expect([...labels(cut.model.calls), ...labels(resumed.model.calls)]).toEqual(labels(whole.model.calls));
		expect(await bestOf(join(runsOf(root), cut.id ?? ""))).toEqual(await bestOf(join(runsOf(root), whole.id ?? "")));
		expect((await childTasks(cut.id ?? "")).length).toBe((await childTasks(whole.id ?? "")).length);
		expect(resumed.model.count("research")).toBe(0);
	}, 120_000);

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
			KEPT,
			"kept -> agents/researcher.md -> run y",
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

	it("validates the candidate against the skills and AGENTS.md of the start, and ships no invalid one", async () => {
		const always = "Use the demo skill for each README change.";
		const demo = ".agents/skills/demo/SKILL.md";
		await writeFile(join(repo, "AGENTS.md"), `${always}\n`);
		await mkdir(join(repo, ".agents", "skills", "demo"), { recursive: true });
		await writeFile(join(repo, demo), "---\nname: demo\ndescription: The demo skill\n---\nDemo.\n");
		git(repo, "add", "AGENTS.md", demo);
		git(repo, "commit", "-q", "-m", "skills");
		const saved = await ship("Fix the README typo");
		expect(saved.code).toBe(0);
		const longer = `${always} Read every word.`;

		const cases: readonly (readonly [readonly string[], Edit, string])[] = [
			[
				[],
				{ path: ".agents/skills/new/SKILL.md", text: "---\nname: new\n---\nNew.\n", moment: "run x" },
				"invalid candidate: .agents/skills/new/SKILL.md has no description",
			],
			[
				[],
				{ path: demo, text: null, moment: "run x" },
				`invalid candidate: ${demo} removes the skill demo that AGENTS.md names`,
			],
			[
				[],
				{ path: "AGENTS.md", text: `${longer}\n`, moment: "run x" },
				`invalid candidate: AGENTS.md has ${longer.length} characters, over the ${always.length} cap`,
			],
			[
				["--always-on-max", "10"],
				{ path: "AGENTS.md", text: "Use demo.\nBe brief.\n", moment: "run x" },
				"invalid candidate: AGENTS.md has 19 characters, over the 10 cap",
			],
		];

		for (const [argv, edit, reason] of cases) {
			const run = await workflows(["optimize", "ship", ...argv], {
				cwd: repo,
				script: { inv: INV, dom: [edit], lessons: [LESSON] },
			});

			const diff = join(runsOf(root), run.id ?? "", "overlay.diff");
			expect(run.code, reason).toBe(0);

			expect(run.stdout.slice(1)).toEqual([
				KEPT,
				`kept -> ${edit.path} -> run x`,
				reason,
				"fewer than 4 items: nothing promoted",
				`optimized ship: 0/1 wins, not promoted, ${diff}`,
			]);
			expect(run.model.count("research")).toBe(0);
			expect(run.model.count("select")).toBe(0);
			expect(run.model.count("harvest")).toBe(0);
			expect(await childTasks(run.id ?? "")).toEqual([]);
			expect(await readFile(diff, "utf8")).toContain(`${reason}\n`);
		}

		const errors: readonly (readonly [Omit<Script, "interrupt">, string])[] = [
			[
				{ inv: INV, dom: [{ path: "prompts/review.md", text: "x", moment: "y" }] },
				"failed optimize: dom edit prompts/review.md is not a skill or AGENTS.md path",
			],
			[
				{ inv: INV, dom: [{ path: ".agents/skills/../SKILL.md", text: "x", moment: "y" }] },
				"failed optimize: dom edit .agents/skills/../SKILL.md is not a skill or AGENTS.md path",
			],
			[
				{ inv: INV, compose: { overlay: [{ path: "README.md", text: "x" }], notes: [] } },
				"failed optimize: compose overlay README.md has no inv or dom edit",
			],
		];

		for (const [script, error] of errors) {
			const failed = await workflows(["optimize", "ship"], { cwd: repo, script });
			expect([failed.code, failed.stderr.at(-2)], error).toEqual([1, error]);
		}
	}, 60_000);
});
