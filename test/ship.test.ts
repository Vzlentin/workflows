import { existsSync } from "node:fs";
import { chmod, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { git, PASSING_JUDGE, repository, sandbox, workflows } from "./support.ts";

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
const progress = /^(plan|judge|round \d: (implement|review))$/;
const FIXED = "# Demo\n\nHello world\n";
const SHIPPED = /^shipped Fix the README typo in (\d) rounds, judge ([\d.]+|failed), [0-9a-f]+$/;

describe("workflows ship", () => {
	it("ships a work item file in two rounds and keeps the checkout", async () => {
		await writeFile(join(repo, "AGENTS.md"), "Run the demo checks.\n");
		git(repo, "add", "AGENTS.md");
		git(repo, "commit", "-qm", "agents");
		start = git(repo, "rev-parse", "HEAD");
		await mkdir(join(root, "agent", "skills", "demo"), { recursive: true });
		await writeFile(
			join(root, "agent", "skills", "demo", "SKILL.md"),
			"---\nname: demo\ndescription: Use for demo work.\n---\nDemo.\n",
		);
		await writeFile(join(repo, "item.md"), "# Fix the README typo\n\nThe README says wrold.\n");
		await writeFile(join(repo, "notes.txt"), "local edit\n");
		git(repo, "add", "notes.txt");
		await writeFile(join(repo, "README.md"), "# Demo\n\nHello wrold\nunstaged\n");

		const run = await workflows(["ship", "item.md"], {
			cwd: repo,
			script: { edits: [FIXED, `${FIXED}Thanks.\n`], verdicts: ["FIX", "SHIP"] },
		});

		expect(run.stderr).toEqual([
			"plan",
			"round 1: implement",
			"round 1: review",
			"round 2: implement",
			"round 2: review",
			"judge",
		]);
		expect(run.code).toBe(0);
		expect(run.stdout).toEqual([`run ${run.id}`, expect.stringMatching(SHIPPED)]);
		expect(run.stdout[1]).toContain("in 2 rounds, judge 0.83,");
		const worktree = worktreeOf(run.id);
		expect(git(worktree, "rev-parse", "HEAD^")).toBe(start);
		expect(git(worktree, "branch", "--show-current")).toBe(`ship/${run.id}`);
		expect(git(worktree, "log", "-1", "--format=%B")).toBe(
			[
				"Fix the README typo",
				"# Fix the README typo\n\nThe README says wrold.",
				"4 FAIL README.md:3 adds a line the work item does not need",
				"Rounds: 2\nJudge: 0.83",
			].join("\n\n"),
		);
		expect(run.stdout[1]).toContain(git(worktree, "rev-parse", "--short", "HEAD"));
		expect(await readFile(join(worktree, "README.md"), "utf8")).toBe(`${FIXED}Thanks.\n`);

		expect(git(repo, "branch", "--show-current")).toBe("main");
		expect(git(repo, "rev-parse", "HEAD")).toBe(start);
		expect(git(repo, "status", "--porcelain")).toBe(" M README.md\nA  notes.txt\n?? item.md");

		const calls = run.model.calls;
		expect(calls.map((call) => call.kind)).toEqual([
			"plan",
			"challenge",
			"handoff",
			"implement",
			"review",
			"verdict",
			"handoff",
			"implement",
			"review",
			"verdict",
			"judge",
		]);
		const readOnly = ["read", "grep", "find", "ls"];
		for (const call of calls) {
			expect(call.thinking).toBe("medium");
			expect(call.model).toBe("claude-opus-5-5");
			const tools = { implement: [...readOnly, "write", "edit", "bash"], judge: [...readOnly, "bash"] };
			expect(call.tools).toEqual(tools[call.kind as keyof typeof tools] ?? readOnly);
			expect(call.sections.cwd).toBe(`<cwd>\n${worktree}\n</cwd>`);
			expect(call.sections.project_context).toContain("Run the demo checks.");
			expect(call.sections.skills).toContain("<name>demo</name>");
		}
		const [plan, , , implement, review, verdict, handoff] = calls;
		expect(plan?.prompt).toMatch(
			/^Plan this change\.\n[\s\S]*ambiguity\.\n\n## item\n# Fix the README typo\n\nThe README says wrold\.$/,
		);
		expect(implement?.prompt).toMatch(
			/AGENTS\.md`\.\n\nReport what changed and what is unfinished\.\n\n## plan\nHandoff 1: /,
		);
		const patch = join(runs(), run.id ?? "", "round-1.patch");
		expect(review?.prompt).toContain(`\n\n## change\n${patch}\n\n## reply\nI fixed the typo in README.md.`);
		expect(await readFile(patch, "utf8")).toContain("-Hello wrold\n+Hello world\n");
		expect(verdict?.prompt).toMatch(/\n\nEnd with one line: SHIP if nothing needs to change, FIX otherwise\.$/);
		expect(handoff?.prompt).toMatch(/^Write a handoff document[\s\S]*information\.$/);
		expect(calls[7]?.prompt).toMatch(/## plan\nHandoff 2: /);
		expect(calls[8]?.prompt).toContain(
			`## change\n${patch.replace("round-1", "round-2")}\n${patch.replace("round-1", "round-2-fix")}\n`,
		);
		expect(calls[10]?.prompt).toMatch(new RegExp(`## base\\n${start}\\n\\n## head\\n[0-9a-f]{40}$`));
	});

	it("blocks a round that changes nothing", async () => {
		const run = await workflows(["ship", "Fix the README typo"], { cwd: repo, script: { edits: [] } });

		expect(run.code).toBe(1);
		expect(run.stdout).toEqual([
			`run ${run.id}`,
			`blocked Fix the README typo after 1 rounds: ${worktreeOf(run.id)}`,
			"I found nothing to change.",
		]);
		expect(run.model.calls.map((call) => call.kind)).toEqual(["plan", "challenge", "handoff", "implement"]);
		expect(git(repo, "branch", "--list", `ship/${run.id}`)).toContain(`ship/${run.id}`);
		expect(git(worktreeOf(run.id), "rev-parse", "HEAD")).toBe(start);
	});

	it("stops at the round limit and keeps the implementer's own commits", async () => {
		const run = await workflows(["ship", "--rounds", "2", "Fix the README typo"], {
			cwd: repo,
			script: { edits: [FIXED, `${FIXED}More.\n`], verdicts: ["FIX", "FIX"], commits: true },
		});

		expect(run.code).toBe(1);
		expect(run.stdout).toEqual([`run ${run.id}`, `stopped Fix the README typo after 2 rounds: ${worktreeOf(run.id)}`]);
		expect(run.model.calls.map((call) => call.kind)).toEqual([
			...["plan", "challenge", "handoff"],
			...["implement", "review", "verdict", "handoff"],
			...["implement", "review", "verdict"],
		]);
		expect(git(worktreeOf(run.id), "log", "--format=%s")).toBe("implementer 2\nimplementer 1\ninitial");
		expect(run.model.calls[4]?.prompt).toContain("round-1.patch");
		expect(await readFile(join(runs(), run.id ?? "", "round-2-fix.patch"), "utf8")).toContain("+More.");
	});

	it("retries a failed Git step on resume", async () => {
		const hook = join(repo, ".git", "hooks", "pre-commit");
		await writeFile(hook, "#!/bin/sh\necho 'lint failed' >&2\nexit 1\n");
		await chmod(hook, 0o755);

		const run = await workflows(["ship", "Fix the README typo"], { cwd: repo, script: { edits: [FIXED] } });
		const failed = [
			"failed Fix the README typo: git commit failed: lint failed",
			`continue with: workflows ship resume ${run.id}`,
		];
		expect(run.code).toBe(1);
		expect(run.stdout).toEqual([`run ${run.id}`]);
		expect(run.stderr.slice(-2)).toEqual(failed);

		const again = await workflows(["ship", "resume", run.id ?? ""], { cwd: repo });
		expect([again.code, again.stderr, again.model.calls]).toEqual([1, failed, []]);

		await rm(hook);
		const resumed = await workflows(["ship", "resume", run.id ?? ""], { cwd: repo });
		expect(resumed.code).toBe(0);
		expect(resumed.stdout[1]).toMatch(SHIPPED);
		expect(resumed.model.calls.map((call) => call.kind)).toEqual(["review", "verdict", "judge"]);
	});

	it("sends a failed turn again on resume, with Pi's retry settings", async () => {
		const run = await workflows(["ship", "Fix the README typo"], {
			cwd: repo,
			script: { edits: [FIXED], failAt: { kind: "challenge", nth: 1 } },
		});
		expect(run.code).toBe(1);
		expect(run.stderr.at(-2)).toMatch(/^failed Fix the README typo: The challenge turn was not answered: model_error/);
		expect(run.model.calls.map((call) => call.kind)).toEqual(["plan"]);

		const resumed = await workflows(["resume", run.id ?? ""], { cwd: root, script: { edits: [FIXED] } });
		expect(resumed.code).toBe(0);
		expect(resumed.stdout).toEqual([`run ${run.id}`, expect.stringMatching(SHIPPED)]);
		expect(resumed.model.calls.map((call) => call.kind)).toEqual([
			...["challenge", "handoff", "implement", "review", "verdict", "judge"],
		]);
	});

	it("clones a GitHub repository through gh and ships without a judge score when the judge fails", async () => {
		const remote = join(root, "github", "octocat", "calibre");
		await repository(remote);
		git(remote, "checkout", "-qb", "develop");
		await writeFile(join(remote, "CHANGES.md"), "develop\n");
		git(remote, "add", "CHANGES.md");
		git(remote, "commit", "-qm", "develop");
		const develop = git(remote, "rev-parse", "HEAD");
		git(remote, "checkout", "-q", "main");

		const run = await workflows(["ship", "--repo", "calibre", "--base", "develop", "Fix the README typo"], {
			cwd: root,
			script: { edits: [FIXED], judge: "1 PASS\n2 PASS" },
		});

		expect(run.code).toBe(0);
		expect(await readFile(join(root, "gh.log"), "utf8")).toBe(
			`repo clone calibre ${join(runs(), run.id ?? "", "repository")}\n`,
		);
		expect(run.stdout[1]).toMatch(SHIPPED);
		expect(run.stdout[1]).toContain("judge failed,");
		expect(run.stderr.filter((line) => !progress.test(line))).toEqual([
			expect.stringMatching(/^judge failed on Fix the README typo: judge reply has no answer to 3, 4, 5, 6, 7, 8:/),
		]);
		const worktree = worktreeOf(run.id);
		expect(git(worktree, "rev-parse", "HEAD^")).toBe(develop);
		expect(git(worktree, "log", "-1", "--format=%B")).toBe("Fix the README typo\n\nFix the README typo\n\nRounds: 1");
		expect(git(remote, "branch", "--list", "ship/*")).toBe("");

		const owned = await workflows(["ship", "--repo", "octocat/calibre", "Fix the README typo"], {
			cwd: root,
			script: { edits: [FIXED], judge: PASSING_JUDGE },
		});
		expect(owned.code).toBe(0);
		expect(git(worktreeOf(owned.id), "rev-parse", "HEAD^")).toBe(git(remote, "rev-parse", "main"));
	});

	it("uses a relative local repository and a piped work item", async () => {
		const run = await workflows(["ship", "--repo", "repo"], {
			cwd: root,
			stdin: "Fix the README typo\n",
			script: { edits: [FIXED] },
		});

		expect(run.code).toBe(0);
		expect(existsSync(join(root, "gh.log"))).toBe(false);
		expect(git(repo, "branch", "--list", `ship/${run.id}`)).toContain(`ship/${run.id}`);
		expect(git(worktreeOf(run.id), "rev-parse", "HEAD^")).toBe(start);
	});

	it("rejects bad input before a run starts", async () => {
		const cases: [string[], string, number, string?][] = [
			[["ship", "  \n"], "workflows: the work item is empty", 1],
			[["ship"], "workflows: the work item is empty", 1, "\n\n"],
			[["ship"], "workflows: missing work item", 2],
			[["ship", "missing.md"], `workflows: cannot read work item ${join(repo, "missing.md")}`, 1],
			[["ship", "--rounds", "0", "Fix it"], "workflows: --rounds must be a positive integer", 2],
			[["ship", "Fix", "it"], "workflows: give the work item as one argument", 2],
			[["ship", "--pi", "pi", "Fix it"], "workflows: Unknown option '--pi'", 2],
			[["ship", "resume", "/tmp/run"], "workflows: /tmp/run is not a run ID", 2],
			[["ship", "resume", "nothing"], `workflows: no run nothing in ${runs()}`, 1],
			[["resume", "nothing"], `workflows: no run nothing in ${runs()}`, 1],
			[["campaign", "goal.md"], "workflows: unknown command campaign", 2],
		];
		for (const [argv, error, code, stdin] of cases) {
			const run = await workflows(argv, { cwd: repo, ...(stdin === undefined ? {} : { stdin }) });
			expect([run.code, run.stderr[0]], argv.join(" ")).toEqual([code, expect.stringContaining(error)]);
		}
		const outside = await workflows(["ship", "Fix it"], { cwd: root });
		expect(outside.stderr[0]).toBe(`workflows: ${root} is not in a Git repository`);
		const missing = await workflows(["ship", "--repo", "nowhere", "Fix it"], { cwd: root });
		expect(missing.stderr[0]).toMatch(/^workflows: gh repo clone nowhere failed: GraphQL: Could not resolve/);
		expect(missing.code).toBe(1);
		expect(existsSync(runs()) ? await readdir(runs()) : []).toEqual([]);
	});
});

describe("workflows ship resume", () => {
	it("continues a turn interrupted by Ctrl+C from the saved inputs", async () => {
		await writeFile(join(repo, "item.md"), "# Fix the README typo\n");
		const first = await workflows(["ship", "--rounds", "2", "item.md"], {
			cwd: repo,
			script: { interruptAt: { kind: "implement", nth: 1 } },
		});
		expect(first.code).toBe(130);
		expect(first.stderr.at(-1)).toBe(`interrupted; continue with: workflows ship resume ${first.id}`);
		expect(first.model.calls.map((call) => call.kind)).toEqual(["plan", "challenge", "handoff"]);

		await writeFile(join(repo, "item.md"), "# Something else\n");
		await writeFile(join(repo, "README.md"), "changed on main\n");
		git(repo, "commit", "-qam", "later");

		const resumed = await workflows(["ship", "resume", first.id ?? ""], {
			cwd: root,
			script: { edits: [FIXED] },
		});
		expect(resumed.code).toBe(0);
		expect(resumed.stdout).toEqual([`run ${first.id}`, expect.stringMatching(SHIPPED)]);
		expect(resumed.stderr).toEqual(["round 1: implement", "round 1: review", "judge"]);
		expect(resumed.model.calls.map((call) => call.kind)).toEqual(["implement", "review", "verdict", "judge"]);
		expect(resumed.model.calls[0]?.prompt).toContain("## plan\nHandoff 1: ");
		const worktree = worktreeOf(first.id);
		expect(git(worktree, "rev-parse", "HEAD^")).toBe(start);
		expect(git(worktree, "log", "-1", "--format=%B")).toMatch(/^Fix the README typo\n\n# Fix the README typo\n\n/);
		expect(git(repo, "branch", "--list", "ship/*").split("\n")).toHaveLength(1);
		expect(git(repo, "worktree", "list").split("\n")).toHaveLength(2);

		const again = await workflows(["ship", "resume", first.id ?? ""], { cwd: root });
		expect(again.code).toBe(0);
		expect(again.stdout).toEqual(resumed.stdout);
		expect(again.model.calls).toEqual([]);
	});

	it("continues a Git step interrupted between the implement and review sessions", async () => {
		const hook = join(repo, ".git", "hooks", "pre-commit");
		const gate = join(root, "gate");
		await writeFile(hook, `#!/bin/sh\ntouch "${gate}.reached"\nwhile [ ! -f "${gate}.open" ]; do sleep 0.02; done\n`);
		await chmod(hook, 0o755);
		const interrupt = new AbortController();
		const pending = workflows(["ship", "Fix the README typo"], {
			cwd: repo,
			interrupt,
			script: { edits: [FIXED], verdicts: ["SHIP"] },
		});
		while (!existsSync(`${gate}.reached`)) await new Promise((resolve) => setTimeout(resolve, 10));
		interrupt.abort();
		await writeFile(`${gate}.open`, "");
		const first = await pending;
		expect(first.code).toBe(130);
		expect(first.model.calls.map((call) => call.kind)).toEqual(["plan", "challenge", "handoff", "implement"]);
		expect(git(worktreeOf(first.id), "log", "--format=%s")).toBe("round 1\ninitial");

		const resumed = await workflows(["ship", "resume", first.id ?? ""], { cwd: repo });
		expect(resumed.code).toBe(0);
		expect(resumed.model.calls.map((call) => call.kind)).toEqual(["review", "verdict", "judge"]);
		expect(resumed.model.calls[0]?.prompt).toContain("## reply\nI fixed the typo in README.md.");
		expect(git(worktreeOf(first.id), "log", "--format=%s")).toBe("Fix the README typo\ninitial");
	});
});
