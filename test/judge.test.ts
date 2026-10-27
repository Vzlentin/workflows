import { rm, writeFile } from "node:fs/promises";
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
	git(repo, "checkout", "-qb", "feature");
	await writeFile(join(repo, "README.md"), "# Demo\n\nHello world\n");
	git(repo, "commit", "-qam", "fix the typo");
});

afterEach(() => rm(root, { recursive: true, force: true }));

const ITEM = "Fix the README typo";

describe("workflows judge", () => {
	it("judges the branch from its merge base with the fixed rubric", async () => {
		const run = await workflows(["judge", "--json", ITEM], { cwd: repo, script: { judge: PASSING_JUDGE } });

		expect(run.code).toBe(0);
		const { result, report } = JSON.parse(run.stdout[1] ?? "");
		expect(report).toEqual([`judge 0.83: ${ITEM}`, `  ${PASSING_JUDGE.findings[0]}`]);
		expect(result).toMatchObject({ status: "judged", score: 5 / 6, ...PASSING_JUDGE });
		expect(result).not.toHaveProperty("commit");
		expect(progressOf(run.stderr)).toEqual(["✓ judge", "  judge 0.83"]);
		expect(run.model.calls.map((call) => call.kind)).toEqual(["judge"]);
		const head = git(repo, "rev-parse", "HEAD");
		expect(run.model.find("judge")?.prompt).toMatch(new RegExp(`## base\\n${start}\\n\\n## head\\n${head}$`));
	});

	it("refuses a checkout with changes", async () => {
		await writeFile(join(repo, "README.md"), "local edit\n");
		const run = await workflows(["judge", ITEM], { cwd: repo });

		expect(run.code).toBe(1);
		expect(run.stderr).toContain(
			`failed ${ITEM}: the checkout has changes that are not committed; commit or stash them first`,
		);
		expect(run.model.calls).toEqual([]);
	});

	it("exits 1 when the judge does not answer", async () => {
		const run = await workflows(["judge", ITEM], { cwd: repo, script: { judge: "1 PASS" } });

		expect(run.code).toBe(1);
		expect(run.stdout.slice(1)).toEqual([`judge failed on ${ITEM}: the answer did not call respond`]);
	});
});
