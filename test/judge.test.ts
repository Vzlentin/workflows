import { realpath, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { git, PASSING_JUDGE, progressOf, repository, sandbox, workflows, worktreeAt } from "./support.ts";

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
		const run = await workflows(["judge", "--json", "--item", ITEM], { cwd: repo, script: { judge: PASSING_JUDGE } });

		expect(run.code).toBe(0);
		const { result, report } = JSON.parse(run.stdout[1] ?? "");
		expect(report).toEqual([`judge 0.83: ${ITEM}`, `  ${PASSING_JUDGE.findings[0]}`]);
		expect(result).toMatchObject({ status: "judged", score: 5 / 6, ...PASSING_JUDGE, divergence: "none" });
		expect(result).not.toHaveProperty("commit");
		expect(progressOf(run.stderr)).toEqual(["✓ judge", "  judge 0.83"]);
		expect(run.model.calls.map((call) => call.kind)).toEqual(["judge"]);
		const head = git(repo, "rev-parse", "HEAD");
		expect(run.model.find("judge")?.prompt).toMatch(new RegExp(`## base\\n${start}\\n\\n## head\\n${head}$`));
	});

	it("says that it does not judge the changes that are not committed, and commits nothing", async () => {
		await writeFile(join(repo, "README.md"), "local edit\n");
		const head = git(repo, "rev-parse", "HEAD");
		const run = await workflows(["judge", "--json"], { cwd: repo, script: { judge: PASSING_JUDGE } });

		expect(run.code).toBe(0);
		expect(JSON.parse(run.stdout[1] ?? "").report).toEqual([
			"judge 0.83: fix the typo",
			`  ${PASSING_JUDGE.findings[0]}`,
			"uncommitted changes are not judged",
		]);
		expect(progressOf(run.stderr)).toEqual(["✓ judge", "  uncommitted changes are not judged", "  judge 0.83"]);
		expect(run.model.find("judge")?.prompt).toMatch(new RegExp(`## base\\n${start}\\n\\n## head\\n${head}$`));
		expect(git(repo, "rev-parse", "HEAD")).toBe(head);
		expect(git(repo, "status", "--porcelain")).toBe(" M README.md");
	});

	it("judges the change of the repository of --repo from another directory", async () => {
		const run = await workflows(["judge", "--json", "--repo", "repo", "--item", ITEM], {
			cwd: root,
			script: { judge: PASSING_JUDGE },
		});

		expect(run.code).toBe(0);
		const { result, report } = JSON.parse(run.stdout[1] ?? "");
		expect(report).toEqual([`judge 0.83: ${ITEM}`, `  ${PASSING_JUDGE.findings[0]}`]);
		expect(result).toMatchObject({ status: "judged", score: 5 / 6 });
		expect(progressOf(run.stderr)).toEqual(["✓ judge", "  judge 0.83"]);
		const judge = run.model.find("judge");
		const head = git(repo, "rev-parse", "HEAD");
		expect(judge?.prompt).toMatch(new RegExp(`## base\\n${start}\\n\\n## head\\n${head}$`));
		expect(judge?.sections.cwd).toBe(`<cwd>\n${await realpath(repo)}\n</cwd>`);
	});

	it("judges a branch of the repository of --repo that no worktree has in a worktree of its own", async () => {
		git(repo, "checkout", "-q", "main");

		const run = await workflows(["judge", "--json", "--repo", "repo", "main..feature"], {
			cwd: root,
			script: { judge: PASSING_JUDGE },
		});

		expect(run.code).toBe(0);
		const { report } = JSON.parse(run.stdout[1] ?? "");
		const path = String(report.at(-1)).slice("worktree ".length);
		expect(report).toEqual(["judge 0.83: fix the typo", `  ${PASSING_JUDGE.findings[0]}`, `worktree ${path}`]);
		expect(dirname(path)).toBe(dirname(worktreeAt(repo, run.id)));
		expect(git(path, "branch", "--show-current")).toBe("feature");
	});

	it("refuses a --repo that is not the top level of a Git repository before the run starts", async () => {
		const run = await workflows(["judge", "--repo", "nowhere", "--item", ITEM], { cwd: root });

		expect([run.code, run.stderr[0]]).toEqual([
			2,
			"workflows: --repo nowhere is not the top level of a Git repository",
		]);
		expect(run.stderr[1]).toContain("usage: workflows judge ");
		expect(run.stdout).toEqual([]);
		expect(run.model.calls).toEqual([]);

		const help = await workflows(["judge", "--help"], { cwd: root });
		expect(help.stdout[0]).toContain(" [--base <value>] [--repo <repository>] [--prompts <folder>] ");
	});

	it("exits 1 when the judge does not answer", async () => {
		const run = await workflows(["judge", "--item", ITEM], { cwd: repo, script: { judge: "1 PASS" } });

		expect(run.code).toBe(1);
		expect(run.stdout.slice(1)).toEqual([`judge failed on ${ITEM}: the answer did not call respond`]);
	});
});
