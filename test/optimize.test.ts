import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { git, repository, sandbox, type Verdict, workflows } from "./support.ts";

let root: string;
let start: string;

beforeEach(async () => {
	root = await sandbox();
	start = await repository(join(root, "repo"));
});

afterEach(() => rm(root, { recursive: true, force: true }));

const FIXED = "# Demo\n\nHello world\n";

/** A judge verdict that passes the first `passes` questions. */
const passing = (passes: number): Verdict => ({
	answers: Array.from({ length: 8 }, (_, index) => (index < passes ? "PASS" : "FAIL")),
	findings: ["4 FAIL README.md:3 is wrong"],
});

async function promptsHash(): Promise<string> {
	const folder = fileURLToPath(new URL("../prompts/", import.meta.url));
	const hash = createHash("sha256");

	for (const file of (await readdir(folder)).sort()) hash.update(file).update(await readFile(join(folder, file)));

	return hash.digest("hex");
}

describe("workflows optimize", () => {
	// Each of the six ship runs is three child runs of its own.
	it("evaluates the baseline and one candidate per trial in ship child runs, and resumes a failed one", {
		timeout: 30_000,
	}, async () => {
		const items = join(root, "items");
		await mkdir(items);

		for (const name of ["First", "Second", "Third"]) {
			await writeFile(
				join(items, `${name.toLowerCase()}.md`),
				`---\nrepo: ../repo\nstart: "${start}"\n---\n# ${name} item\n\nFix the README.\n`,
			);
		}

		const before = await promptsHash();

		const first = await workflows(["optimize", "--workflow", "ship", "--items", "items", "--trials", "2"], {
			cwd: root,
			script: {
				edits: Array(4).fill(FIXED),
				judge: [passing(6), passing(6), passing(6), passing(8)],
				failAt: { kind: "plan", nth: 5 },
			},
		});

		expect(first.code).toBe(1);
		expect(first.stderr.slice(-2)).toEqual([
			expect.stringMatching(/^failed optimize: child run \S+ failed: /),
			`continue with: workflows resume ${first.id}`,
		]);
		const reflect = first.model.calls.filter((call) => call.kind === "reflect");
		expect(reflect).toHaveLength(1);
		expect(reflect[0]?.prompt).toMatch(/^Improve this prompt[\s\S]*\n\n## prompt\nreview\n[\s\S]*\n\n## records\n\[\n/);

		const resumed = await workflows(["resume", first.id ?? ""], {
			cwd: root,
			script: { edits: [FIXED, FIXED], judge: [passing(8), passing(7)] },
		});

		const directory = join(root, "state", "workflows", "runs", first.id ?? "");
		const diff = join(directory, "prompts.diff");
		expect(resumed.code).toBe(0);
		expect(resumed.stdout).toEqual([`run ${first.id}`, `optimized ship: baseline 0.75, best 0.96, ${diff}`]);
		expect(resumed.model.count("reflect")).toBe(0);
		expect(resumed.model.count("plan")).toBe(2);
		expect(resumed.model.calls.find((call) => call.kind === "review")?.prompt).toContain("\nImproved prompt 1.\n");
		const text = await readFile(diff, "utf8");
		expect(text).toMatch(
			/^first: baseline 0\.75, best 1\.00\nsecond: baseline 0\.75, best 1\.00\nthird: baseline 0\.75, best 0\.88\ndiff --git baseline\/review\.md best\/review\.md\n/,
		);
		expect(text).toContain("\n+Improved prompt 1.\n");
		expect((await readdir(join(directory, "best"))).sort()).toEqual(["challenge.md", "handoff.md", "review.md"]);
		expect(await readFile(join(directory, "best", "review.md"), "utf8")).toMatch(/\nImproved prompt 1\.\n$/);
		expect(git(join(root, "repo"), "branch", "--format=%(refname:short)")).toBe("main");
		expect(git(join(root, "repo"), "worktree", "list", "--porcelain").split("\n\n")).toHaveLength(1);
		expect(await promptsHash()).toBe(before);
	});
});
