import { mkdir, realpath, rm, writeFile } from "node:fs/promises";
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
	it("judges the branch from its merge base with the fixed rubric, and asks for every finding in one pass", async () => {
		const run = await workflows(["judge", "--json", "--item", ITEM], { cwd: repo, script: { judge: PASSING_JUDGE } });

		expect(run.code).toBe(0);
		const { value: result, report } = JSON.parse(run.stdout[1] ?? "");
		expect(report).toEqual([`judge 0.83: ${ITEM}`, `  ${PASSING_JUDGE.findings[0]}`]);
		expect(result).toMatchObject({ status: "judged", score: 5 / 6, ...PASSING_JUDGE, divergence: "none" });
		expect(result.change).toEqual({ repository: await realpath(repo), branch: "feature" });
		expect(result).not.toHaveProperty("commit");
		expect(progressOf(run.stderr)).toEqual(["✓ judge", "  judge 0.83"]);
		expect(run.model.calls.map((call) => call.kind)).toEqual(["judge"]);
		const head = git(repo, "rev-parse", "HEAD");
		const prompt = run.model.find("judge")?.prompt;
		expect(prompt).toMatch(new RegExp(`## base\\n${start}\\n\\n## head\\n${head}$`));
		expect(prompt).toContain(
			"Check every question and every part of the work item before you answer, and list every finding in one pass, not only the first.",
		);
		expect(prompt).toContain(
			"A finding is a term of the work item that the change does not meet, or a rule that it breaks, with its file and line.",
		);
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

	it("gives the main checkout as the repository of the change of a linked worktree", async () => {
		git(repo, "checkout", "-q", "main");
		const linked = join(root, "linked");
		git(repo, "worktree", "add", "-q", linked, "feature");

		const run = await workflows(["judge", "--json"], { cwd: linked, script: { judge: PASSING_JUDGE } });

		expect(run.code).toBe(0);
		const { value: result } = JSON.parse(run.stdout[1] ?? "");
		expect(result.change).toEqual({ repository: await realpath(repo), branch: "feature" });

		// A bare branch that the linked worktree has checked out runs there.
		const there = await workflows(["judge", "--json", "feature"], { cwd: repo, script: { judge: PASSING_JUDGE } });

		expect(there.code).toBe(0);
		const named = JSON.parse(there.stdout[1] ?? "");
		expect(named.report.at(-1)).toBe(`worktree ${await realpath(linked)}`);
		expect(named.value.change).toEqual({ repository: await realpath(repo), branch: "feature" });

		// The engine gives the change of a child run in a worktree of its own from the linked worktree.
		git(linked, "checkout", "-qb", "other", "main");

		const child = await workflows(["judge", "--json", "main..feature"], {
			cwd: linked,
			script: { judge: PASSING_JUDGE },
		});

		expect(child.code).toBe(0);
		const { value, report } = JSON.parse(child.stdout[1] ?? "");
		expect(String(report.at(-1))).toMatch(/^worktree /);
		expect(value.change).toEqual({ repository: await realpath(repo), branch: "feature" });
	});

	it("judges a bare branch here, in a worktree of its own, then in the worktree that has it", async () => {
		const options = { cwd: repo, script: { judge: PASSING_JUDGE } };

		// The current branch runs here.
		const here = await workflows(["judge", "--json", "feature"], options);

		expect(here.code).toBe(0);
		const local = JSON.parse(here.stdout[1] ?? "");
		expect(local.report).toEqual(["judge 0.83: fix the typo", `  ${PASSING_JUDGE.findings[0]}`]);
		expect(local.value.change).toEqual({ repository: await realpath(repo), branch: "feature" });
		const head = git(repo, "rev-parse", "HEAD");
		expect(here.model.find("judge")?.prompt).toMatch(new RegExp(`## base\\n${start}\\n\\n## head\\n${head}$`));

		// A branch that no worktree has runs in a worktree of its own.
		git(repo, "checkout", "-q", "main");
		const own = await workflows(["judge", "--json", "feature"], options);

		expect(own.code).toBe(0);
		const path = String(JSON.parse(own.stdout[1] ?? "").report.at(-1)).slice("worktree ".length);
		expect(dirname(path)).toBe(dirname(worktreeAt(repo, own.id)));
		expect(git(path, "branch", "--show-current")).toBe("feature");

		// A branch that another worktree has checked out runs there.
		const there = await workflows(["judge", "--json", "feature"], options);

		expect(there.code).toBe(0);
		expect(JSON.parse(there.stdout[1] ?? "").report.at(-1)).toBe(`worktree ${path}`);
	});

	it("chains a judge on the branch of a change that has no worktree of its own", async () => {
		const scripts = join(repo, ".workflows", "scripts");
		await mkdir(scripts, { recursive: true });
		await writeFile(
			join(scripts, "caller.js"),
			[
				"export const meta = { exit: { judged: 0 } }",
				'const first = await run("judge", {})',
				'const again = await run("judge", { change: first.change.branch })',
				"return { ...again, first: first.change }",
			].join("\n"),
		);
		git(repo, "add", ".workflows");
		git(repo, "commit", "-qm", "caller");
		const run = await workflows(["caller", "--json"], { cwd: repo, script: { judge: PASSING_JUDGE } });

		expect(run.code).toBe(0);
		const { value, report } = JSON.parse(run.stdout[1] ?? "");
		expect(value.status).toBe("judged");
		expect(value.first).toEqual({ repository: await realpath(repo), branch: "feature" });
		expect(value.change).toEqual(value.first);
		expect(report.join("\n")).not.toContain("worktree ");
	});

	it("judges the change of the repository of --repo from another directory", async () => {
		const run = await workflows(["judge", "--json", "--repo", "repo", "--item", ITEM], {
			cwd: root,
			script: { judge: PASSING_JUDGE },
		});

		expect(run.code).toBe(0);
		const { value: result, report } = JSON.parse(run.stdout[1] ?? "");
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

	it("fails a change that does not end on a branch before any session", async () => {
		const head = git(repo, "rev-parse", "HEAD");
		const run = await workflows(["judge", `main..${head}`], { cwd: repo, script: { judge: PASSING_JUDGE } });

		expect(run.code).toBe(1);
		expect(run.stderr).toContain(`failed judge: the change ends on ${head}, which is not a branch`);
		expect(run.model.calls).toEqual([]);
	});

	it("fails when the judge does not answer, and judges again on resume", async () => {
		const run = await workflows(["judge", "--item", ITEM], { cwd: repo, script: { judge: "1 PASS" } });

		expect(run.code).toBe(1);
		expect(run.stderr.at(-2)).toBe(`failed ${ITEM}: the answer did not call respond`);

		const resumed = await workflows(["resume", run.id ?? ""], { cwd: repo });
		expect(resumed.code).toBe(0);
		expect(resumed.model.calls.map((call) => call.kind)).toEqual(["judge"]);
	});
});
