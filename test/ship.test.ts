import { existsSync } from "node:fs";
import { chmod, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { createRegistry, defineExtension, defineTask, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { newRunId } from "../src/run.ts";
import { TASK } from "../src/task.ts";
import {
	FakeModel,
	git,
	lockHolder,
	PASSING_JUDGE,
	progressOf,
	repository,
	sandbox,
	type Verdict,
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

/**
 * The ID of a new run that holds one pending task of `kind` at `version` with `input`, as a run that an earlier version
 * saved.
 */
async function saveRun(kind: string, version: number, input: object = { input: {} }): Promise<string> {
	const id = newRunId();
	const directory = join(runs(), id);
	await mkdir(directory, { recursive: true });
	const task = defineTask<object, { phase: string }, null>({
		name: kind,
		version,
		initial: () => ({ phase: "run" }),
		phases: { run: async () => {} },
		abort: async () => {},
	});
	const registry = createRegistry();
	registry.install(defineExtension({ name: "workflows", tasks: [task] }));
	const models = new FakeModel({ interrupt: new AbortController() }).models;
	const storage = await openNodeSqliteStorage(join(directory, "durable.sqlite"));
	const harness = await Harness.open(storage, { models, registry }, BACKGROUND_CONTEXT);
	try {
		const conversation = await harness.root(BACKGROUND_CONTEXT);
		await conversation.commit(
			(tx) => tx.createTask(task, input, { ownership: { kind: "conversation" } }),
			BACKGROUND_CONTEXT,
		);
	} finally {
		await harness.close(BACKGROUND_CONTEXT);
	}
	return id;
}
/**
 * Installs a Pi package with one `piDurable` entry that returns `extensions`, a JavaScript expression of `durable`, and
 * writes a marker file when it closes. Returns the path of the marker.
 */
async function closingPackage(extensions: string): Promise<string> {
	const pkg = join(root, "closing-package");
	const marker = join(root, "closing.closed");
	await mkdir(pkg);
	await writeFile(
		join(pkg, "package.json"),
		JSON.stringify({ name: "closing", type: "module", piDurable: { extensions: ["./index.ts"] } }),
	);
	await writeFile(
		join(pkg, "index.ts"),
		`import { writeFileSync } from "node:fs";
export default function ({ durable }) {
	return { extensions: ${extensions}, close: async () => writeFileSync(${JSON.stringify(marker)}, "") };
}
`,
	);
	await writeFile(join(root, "agent", "settings.json"), JSON.stringify({ retry: { enabled: false }, packages: [pkg] }));
	return marker;
}
const worktreeOf = (id: string | undefined) => join(runs(), id ?? "missing", "worktree");
const progress = /^(plan|judge|round \d: (implement|review))$/;
const FIXED = "# Demo\n\nHello world\n";
const SHIPPED = /^shipped Fix the README typo in (\d) rounds, judge ([\d.]+|failed), [0-9a-f]+$/;
const TOOLS = ["read", "grep", "find", "ls", "write", "edit", "bash"];
const answers = (kind: string) => (["verdict", "judge", "implement", "handoff"].includes(kind) ? ["respond"] : []);
const NOTES = [
	"#1 planner 0: Handoff 1: one word changes.",
	"#2 implementer 1: Implement 1: README.md had wrold.",
	"#3 reviewer 1: Handoff 2: one word changes.",
	"#4 implementer 2: Implement 2: README.md had wrold.",
];
/** The run memory of the first `n` notes of the fake model, as the start of a prompt. */
const memory = (n: number) => `## memory\n${NOTES.slice(0, n).join("\n")}\n\n`;

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

		const run = await workflows(["ship", "--json", "item.md"], {
			cwd: repo,
			script: {
				edits: [FIXED, `${FIXED}Thanks.\n`],
				verdicts: ["FIX", "SHIP"],
				judge: { ...PASSING_JUDGE, status: "blocked", extra: "x" } as Verdict,
			},
		});

		expect(progressOf(run.stderr)).toEqual([
			"✓ plan",
			"✓ round 1: implement",
			"✓ round 1: review",
			"✓ round 2: implement",
			"✓ round 2: review",
			"✓ judge",
		]);
		expect(JSON.parse(run.stderr[0] ?? "")).toEqual({ progress: ["◉ plan"] });
		expect(run.code).toBe(0);
		const { result, report } = JSON.parse(run.stdout[1] ?? "");
		expect(run.stdout).toHaveLength(2);
		expect(run.stdout[0]).toBe(`run ${run.id}`);
		expect(report).toEqual([expect.stringMatching(SHIPPED)]);
		expect(report[0]).toContain("in 2 rounds, judge 0.83,");
		expect(result).toMatchObject({ ...PASSING_JUDGE, status: "shipped", memory: NOTES });
		expect(result).not.toHaveProperty("extra");
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
		expect(report[0]).toContain(git(worktree, "rev-parse", "--short", "HEAD"));
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
		for (const call of calls) {
			expect(call.thinking).toBe("medium");
			expect(call.model).toBe("claude-opus-5-5");
			expect(call.tools).toEqual([...TOOLS, ...answers(call.kind)]);
			expect(call.sections.cwd).toBe(`<cwd>\n${worktree}\n</cwd>`);
			expect(call.sections.project_context).toContain("Run the demo checks.");
			expect(call.sections.skills).toContain("<name>demo</name>");
		}
		const [plan, challenge, planned, implement, review, verdict, handoff] = calls;
		for (const call of [plan, challenge, planned]) expect(call?.prompt).not.toContain("## memory");
		expect(implement?.prompt.startsWith(`${memory(1)}Implement this plan`)).toBe(true);
		for (const call of [review, verdict, handoff]) expect(call?.prompt.startsWith(memory(2))).toBe(true);
		expect(calls[7]?.prompt.startsWith(`${memory(3)}Implement this plan`)).toBe(true);
		for (const call of [calls[8], calls[9]]) expect(call?.prompt.startsWith(memory(4))).toBe(true);
		expect(calls[10]?.prompt.startsWith("## Vocabulary")).toBe(true);
		expect(plan?.prompt).toMatch(
			/^Plan this change\.\n[\s\S]*ambiguity\.\n\n## item\n# Fix the README typo\n\nThe README says wrold\.$/,
		);
		expect(implement?.prompt).toMatch(
			/AGENTS\.md`\.\n\nReport what changed and what is unfinished\.\n\n## plan\nHandoff 1: /,
		);
		const patch = join(runs(), run.id ?? "", "round-1.patch");
		expect(review?.prompt).toContain(`\n\n## change\n${patch}\n\n## reply\nI fixed the typo in README.md.`);
		expect(await readFile(patch, "utf8")).toContain("-Hello wrold\n+Hello world\n");
		expect(verdict?.prompt).toMatch(/\n\nAnswer with respond: SHIP if nothing needs to change, FIX otherwise\.$/);
		expect(verdict?.prompt).toContain("\n\nA reversal of a memory note");
		expect(challenge?.prompt).not.toContain("A reversal of a memory note");
		expect(planned?.prompt).toMatch(
			/^Write a handoff document[\s\S]*information\.\n\nWhen you are done, answer with respond: text /,
		);
		expect(handoff?.prompt).toMatch(/\n\nWrite a handoff document[\s\S]*the findings that you cut and why\./);
		expect(calls[7]?.prompt).toMatch(/## plan\nHandoff 2: /);
		expect(calls[8]?.prompt).toContain(
			`## change\n${patch.replace("round-1", "round-2")}\n${patch.replace("round-1", "round-2-fix")}\n`,
		);
		expect(calls[10]?.prompt).toMatch(new RegExp(`## base\\n${start}\\n\\n## head\\n[0-9a-f]{40}$`));
	});

	it("gives every session the tools of the piDurable entries in Pi's packages and closes them", async () => {
		const pkg = join(root, "probe-package");
		await mkdir(pkg);
		await writeFile(
			join(pkg, "package.json"),
			JSON.stringify({ name: "probe", type: "module", piDurable: { extensions: ["./a.ts", "./b.ts"] } }),
		);
		await writeFile(
			join(pkg, "a.ts"),
			`import { appendFileSync, writeFileSync } from "node:fs";
export default function ({ durable, ai, events }) {
	const probe = durable.defineTool({
		name: "probe",
		description: "Probe",
		parameters: ai.Type.Object({}),
		replay: "safe",
		execute: async (_args, api) => {
			appendFileSync(${JSON.stringify(join(root, "probe.log"))}, api.conversationId + "\\n");
			events.emit("probe", api.conversationId);
			return { output: [{ type: "text", text: "ok" }] };
		},
	});
	return {
		extensions: [durable.defineExtension({ name: "probe-a", tools: [probe] })],
		close: async () => writeFileSync(${JSON.stringify(join(root, "a.closed"))}, ""),
	};
}
`,
		);
		await writeFile(
			join(pkg, "b.ts"),
			`import { appendFileSync, writeFileSync } from "node:fs";
export default function ({ events }) {
	events.on("probe", (id) => appendFileSync(${JSON.stringify(join(root, "events.log"))}, id + "\\n"));
	return { extensions: [], close: async () => writeFileSync(${JSON.stringify(join(root, "b.closed"))}, "") };
}
`,
		);
		await writeFile(
			join(root, "agent", "settings.json"),
			JSON.stringify({ retry: { enabled: false }, packages: [pkg] }),
		);
		const untrusted = join(root, "untrusted-package");
		await mkdir(untrusted);
		await writeFile(
			join(untrusted, "package.json"),
			JSON.stringify({ name: "untrusted", type: "module", piDurable: { extensions: ["./index.ts"] } }),
		);
		await writeFile(join(untrusted, "index.ts"), 'throw new Error("untrusted package loaded");\n');
		await mkdir(join(repo, ".pi"));
		await writeFile(join(repo, ".pi", "settings.json"), JSON.stringify({ packages: [untrusted] }));

		const run = await workflows(["ship", "Fix the README typo"], {
			cwd: repo,
			script: { edits: [FIXED], probe: true },
		});

		expect(run.code).toBe(0);
		expect(run.model.calls.map((call) => call.kind)).toEqual([
			...["plan", "challenge", "handoff", "implement", "review", "verdict", "judge"],
		]);
		for (const call of run.model.calls) expect(call.tools).toEqual([...TOOLS, "probe", ...answers(call.kind)]);
		const probed = (await readFile(join(root, "probe.log"), "utf8")).trim().split("\n");
		expect(probed).toHaveLength(4);
		expect(new Set(probed).size).toBe(4);
		expect((await readFile(join(root, "events.log"), "utf8")).trim().split("\n")).toEqual(probed);
		expect(existsSync(join(root, "a.closed")) && existsSync(join(root, "b.closed"))).toBe(true);
		expect(run.model.results.slice(0, 2)).toEqual(["ok", expect.stringContaining("README.md")]);
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

	it("prints one JSON outcome line with --json, at the start and at resume", async () => {
		const run = await workflows(["ship", "--json", "Fix the README typo"], {
			cwd: repo,
			script: { edits: [], interruptAt: { kind: "implement", nth: 1 } },
		});
		expect(run.code).toBe(130);
		expect(run.stdout).toEqual([`run ${run.id}`, JSON.stringify({ runId: run.id, status: "interrupted" })]);

		const resumed = await workflows(["resume", run.id ?? "", "--json"], { cwd: repo, script: { edits: [] } });
		const result = { status: "blocked", rounds: 1, reply: "I found nothing to change.", memory: NOTES.slice(0, 2) };
		expect(resumed.code).toBe(1);
		const report = [`blocked Fix the README typo after 1 rounds: ${worktreeOf(run.id)}`, result.reply];
		expect(resumed.stdout).toEqual([
			`run ${run.id}`,
			JSON.stringify({ runId: run.id, status: "finished", result: { ...result, report }, report }),
		]);

		const item = await workflows(["ship", "--", "--json"], { cwd: repo, script: { edits: [] } });
		expect(item.stdout.slice(1, 2)).toEqual([expect.stringMatching(/^blocked --json after 1 rounds: /)]);
	});

	it("stops at the round limit and keeps the implementer's own commits", async () => {
		const run = await workflows(["ship", "--json", "--rounds", "2", "Fix the README typo"], {
			cwd: repo,
			script: { edits: [FIXED, `${FIXED}More.\n`], verdicts: ["FIX", "FIX"], commits: true },
		});

		expect(run.code).toBe(1);
		const { result, report } = JSON.parse(run.stdout[1] ?? "");
		expect(run.stdout).toHaveLength(2);
		expect(run.stdout[0]).toBe(`run ${run.id}`);
		expect(report).toEqual([`stopped Fix the README typo after 2 rounds: ${worktreeOf(run.id)}`]);
		expect(result.memory).toEqual(NOTES);
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
			`continue with: workflows resume ${run.id}`,
		];
		expect(run.code).toBe(1);
		expect(run.stdout).toEqual([`run ${run.id}`]);
		expect(run.stderr.slice(-2)).toEqual(failed);

		const again = await workflows(["resume", run.id ?? ""], { cwd: repo });
		expect([again.code, again.stderr, again.model.calls]).toEqual([1, ["round 1: implement", ...failed], []]);

		await rm(hook);
		const resumed = await workflows(["resume", run.id ?? ""], { cwd: repo });
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
		expect(run.stderr.at(-2)).toMatch(/^failed Fix the README typo: The \S+ turn was not answered: model_error/);
		expect(run.model.calls.map((call) => call.kind)).toEqual(["plan"]);

		const resumed = await workflows(["resume", run.id ?? ""], { cwd: root, script: { edits: [FIXED] } });
		expect(resumed.code).toBe(0);
		expect(resumed.stdout).toEqual([`run ${run.id}`, expect.stringMatching(SHIPPED)]);
		expect(resumed.model.calls.map((call) => call.kind)).toEqual([
			...["challenge", "handoff", "implement", "review", "verdict", "judge"],
		]);
	});

	it("reads the retry settings of the project only when Pi trusts it", async () => {
		await mkdir(join(repo, ".pi"));
		await writeFile(join(repo, ".pi", "settings.json"), JSON.stringify({ retry: { enabled: true, baseDelayMs: 1 } }));
		const script = { edits: [FIXED], failAt: { kind: "challenge", nth: 1 } } as const;

		const untrusted = await workflows(["ship", "Fix the README typo"], { cwd: repo, script });
		expect(untrusted.code).toBe(1);
		expect(untrusted.model.calls.map((call) => call.kind)).toEqual(["plan"]);

		new ProjectTrustStore(join(root, "agent")).set(repo, true);
		const trusted = await workflows(["ship", "Fix the README typo"], { cwd: repo, script });
		expect(trusted.code).toBe(0);
		expect(trusted.stdout[1]).toMatch(SHIPPED);
	});

	it("closes the package entries and keeps the run when the resume of a failed run cannot create its task", async () => {
		const run = await workflows(["ship", "Fix the README typo"], {
			cwd: repo,
			script: { edits: [FIXED], failAt: { kind: "challenge", nth: 1 } },
		});
		expect(run.code).toBe(1);
		const marker = await closingPackage("[]");
		const directory = join(runs(), run.id ?? "");
		// The store opens, and the insert of the new task fails.
		const database = new DatabaseSync(join(directory, "durable.sqlite"));
		database.exec("CREATE TRIGGER refuse BEFORE INSERT ON tasks BEGIN SELECT RAISE(ABORT, 'no new task'); END");
		database.close();

		const resumed = await workflows(["resume", run.id ?? ""], { cwd: repo, script: { edits: [FIXED] } });

		expect([resumed.code, resumed.stdout, resumed.stderr.at(-1)]).toEqual([1, [], "workflows: no new task"]);
		expect(existsSync(marker)).toBe(true);
		expect(existsSync(join(directory, "durable.sqlite"))).toBe(true);
	});

	it("closes the package entries and removes the run directory when the store cannot open", async () => {
		const marker = await closingPackage(`[
		durable.defineExtension({
			name: "closing",
			tasks: [
				durable.defineTask({
					name: "workflows.run",
					version: 1,
					initial: () => ({ phase: "run" }),
					phases: { run: async () => {} },
					abort: async () => {},
				}),
			],
		}),
	]`);

		const run = await workflows(["ship", "Fix the README typo"], { cwd: repo, script: { edits: [FIXED] } });

		expect(run.code).toBe(1);
		expect(run.stderr).toEqual([expect.stringContaining("workflows.run")]);
		expect(existsSync(marker)).toBe(true);
		expect(existsSync(runs()) ? await readdir(runs()) : []).toEqual([]);
	});

	it("closes the loaded package entries when a later package entry fails to load", async () => {
		const marker = await closingPackage("[]");
		const failing = join(root, "failing-package");
		await mkdir(failing);
		await writeFile(
			join(failing, "package.json"),
			JSON.stringify({ name: "failing", type: "module", piDurable: { extensions: ["./index.ts"] } }),
		);
		await writeFile(join(failing, "index.ts"), `export default function () {\n\tthrow new Error("no entry");\n}\n`);
		await writeFile(
			join(root, "agent", "settings.json"),
			JSON.stringify({ retry: { enabled: false }, packages: [join(root, "closing-package"), failing] }),
		);

		const run = await workflows(["ship", "Fix the README typo"], { cwd: repo, script: { edits: [FIXED] } });

		expect([run.code, run.stderr]).toEqual([1, ["workflows: no entry"]]);
		expect(existsSync(marker)).toBe(true);
		expect(existsSync(runs()) ? await readdir(runs()) : []).toEqual([]);
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
			"  judge failed on Fix the README typo: the answer did not call respond",
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

	it("replaces package prompts with the prompts of a --prompts folder", async () => {
		await mkdir(join(root, "prompts"));
		await writeFile(join(root, "prompts", "plan.md"), "---\ndescription: x\n---\nPlan this change. MARKER\n\n$@\n");

		const run = await workflows(["ship", "--prompts", "prompts", "--repo", "repo", "Fix the README typo"], {
			cwd: root,
			script: { edits: [FIXED] },
		});

		expect(run.code).toBe(0);
		expect(run.model.calls[0]?.prompt).toMatch(/^Plan this change\. MARKER\n\n## item\nFix the README typo$/);
		expect(run.model.calls[1]?.prompt).toMatch(/^Challenge the plan/);
	});

	it("uses the profiles and prompts of the project folder", async () => {
		const project = join(repo, ".workflows");
		await mkdir(join(project, "agents"), { recursive: true });
		await mkdir(join(project, "prompts"));
		await writeFile(
			join(project, "agents", "planner.md"),
			"---\nmodel: anthropic/claude-opus-5-5\nthinking: high\n---\nProject planner.\n",
		);
		await writeFile(join(project, "prompts", "plan.md"), "---\ndescription: x\n---\nPlan this change. PROJECT\n\n$@\n");

		const run = await workflows(["ship", "Fix the README typo"], { cwd: repo, script: { edits: [FIXED] } });

		expect(run.code).toBe(0);
		const [plan] = run.model.calls;
		expect([plan?.kind, plan?.thinking]).toEqual(["plan", "high"]);
		expect(plan?.sections.instructions).toContain("Project planner.");
		expect(plan?.prompt).toMatch(/^Plan this change\. PROJECT\n\n## item\nFix the README typo$/);
	});

	it("runs ship.js from another script in a new worktree, and leaves the checkout of the caller unchanged", async () => {
		const scripts = join(repo, ".workflows", "workflows");
		await mkdir(scripts, { recursive: true });
		await writeFile(join(scripts, "caller.js"), 'return await run("ship", { item: "Fix the README typo", repo: "." })');
		git(repo, "add", ".workflows");
		git(repo, "commit", "-qm", "caller");
		start = git(repo, "rev-parse", "HEAD");
		const run = await workflows(["caller", "--json"], { cwd: repo, script: { edits: [FIXED] } });

		expect(run.code).toBe(0);
		const { result } = JSON.parse(run.stdout[1] ?? "");
		expect(result).toMatchObject({ status: "shipped", rounds: 1, runId: expect.any(String) });
		expect(git(worktreeOf(result.runId), "branch", "--show-current")).toBe(`ship/${result.runId}`);
		expect(git(worktreeOf(result.runId), "rev-parse", "HEAD~1")).toBe(start);
		expect(git(repo, "rev-parse", "HEAD")).toBe(start);
		expect(git(repo, "status", "--porcelain")).toBe("");
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
			[["ship", "--prompts", "none", "Fix it"], `workflows: no prompts folder ${join(repo, "none")}`, 1],
			[["ship", "--prompts=.", "Fix it"], `workflows: ${repo}/README.md replaces no prompt of the package`, 1],
			[["resume", "/tmp/run"], "workflows: /tmp/run is not a run ID", 2],
			[["resume", "nothing"], `workflows: no run nothing in ${runs()}`, 1],
			[["nope", "goal.md"], "workflows: unknown command nope", 2],
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

describe("workflows show", () => {
	it("prints the phases and calls of a finished ship run, and the same tree as JSON", async () => {
		const run = await workflows(["ship", "--repo", ".", "Fix the README typo"], {
			cwd: repo,
			script: { edits: [FIXED] },
		});
		expect(run.code).toBe(0);
		const id = run.id ?? "";
		const shown = await workflows(["show", id], { cwd: root });
		expect([shown.code, shown.stderr]).toEqual([0, []]);
		const call = (line: string) => expect.stringMatching(new RegExp(`^  ✓ ${line}  \\d+s$`));
		const asks = (profile: string, n: number) => [call(`session ${profile}`), ...Array(n).fill(call(`ask ${profile}`))];
		expect(shown.stdout).toEqual([
			`run ${id} ship shipped Fix the README typo`,
			"plan",
			...asks("planner", 3),
			"round 1: implement",
			...asks("implementer", 1),
			call("sh git add -A"),
			call(`ok git diff --cached --quiet ${start}`),
			call("ok git diff --cached --quiet"),
			call("sh git commit --allow-empty -m round 1"),
			// The command is cut at 80 characters.
			call("sh git diff --binary --output=.{53}"),
			"round 1: review",
			...asks("reviewer", 2),
			call("sh git rev-parse HEAD"),
			"judge",
			...asks("judge", 1),
			call(`sh sh -c git reset -q --soft "\\$1" && git commit -q -m "\\$2" squash ${start.slice(0, 17)}`),
			call("sh git rev-parse --short HEAD"),
			expect.stringMatching(SHIPPED),
		]);

		const json = await workflows(["show", id, "--json"], { cwd: root });
		expect([json.code, json.stdout.length]).toEqual([0, 1]);
		const tree = JSON.parse(json.stdout[0] ?? "");
		const time = expect.stringMatching(/^\d{4}-\d\d-\d\dT[\d:.]+Z$/);
		expect(tree).toMatchObject({
			runId: id,
			workflow: "ship",
			title: "Fix the README typo",
			status: "shipped",
			report: [shown.stdout.at(-1)],
		});
		expect(tree.calls).toHaveLength(shown.stdout.length - 6);
		expect(tree.calls[0]).toEqual({
			kind: "session",
			label: "planner",
			phase: "plan",
			args: { profile: "planner" },
			mark: "✓",
			startedAt: time,
			endedAt: time,
			result: expect.any(Number),
		});
		expect(tree.calls[1]).toMatchObject({ kind: "ask", label: "planner", result: "Problem: README.md says wrold." });
		expect(tree.calls[6]).toMatchObject({ kind: "sh", label: "git add -A", phase: "round 1: implement" });
		expect(tree.calls[6].args).toEqual({ cmd: ["git", "add", "-A"], check: true });
	});
});

describe("workflows resume of ship runs", () => {
	it("refuses and does not list a run that the earlier ship or run command saved", async () => {
		const ship = await saveRun("workflows.ship", TASK.version);
		// The script task owns the task kind of the earlier `run` command, so only its version can be earlier.
		const run = await saveRun("workflows.run", TASK.version - 1);
		// A script task of an earlier version names its workflow in its input.
		const script = await saveRun("workflows.run", TASK.version - 1, { name: "ship" });
		// Some earlier versions wrapped the input as `{ input }`.
		const wrapped = await saveRun("workflows.run", TASK.version - 1, { input: { name: "campaign" } });
		// A script task of a later version is refused too.
		const later = await saveRun("workflows.run", TASK.version + 1, { name: "ship" });

		for (const [id, name, word] of [
			[ship, "ship", "an earlier"],
			[run, "run", "an earlier"],
			[script, "ship", "an earlier"],
			[wrapped, "campaign", "an earlier"],
			[later, "ship", "a later"],
		] as const) {
			const resumed = await workflows(["resume", id], { cwd: repo });
			expect([resumed.code, resumed.stdout, resumed.stderr]).toEqual([
				1,
				[],
				[`workflows: run ${id} was saved by ${word} version of ${name} and cannot resume`],
			]);
			const shown = await workflows(["show", id, "--json"], { cwd: repo });
			expect([shown.code, shown.stdout, shown.stderr]).toEqual([
				1,
				[],
				[`workflows: run ${id} was saved by ${word} version of ${name} and cannot be shown`],
			]);
			const saved = await workflows(["save", id, "x"], { cwd: repo });
			expect([saved.code, saved.stdout, saved.stderr]).toEqual([
				1,
				[],
				[`workflows: run ${id} was saved by ${word} version of ${name} and cannot be saved`],
			]);
		}
		const listed = await workflows(["list"], { cwd: repo });
		expect(listed.stdout).toEqual([]);
		const unknown = await workflows(["show", "20990101T000000-00000000"], { cwd: repo });
		expect([unknown.code, unknown.stdout, unknown.stderr]).toEqual([
			1,
			[],
			[`workflows: no run 20990101T000000-00000000 in ${runs()}`],
		]);
	});

	it("refuses a run that a live process runs, and does not open its store", async () => {
		const id = await saveRun("workflows.run", TASK.version, { name: "ship" });
		const holder = await lockHolder(join(runs(), id));
		const marker = await closingPackage("[]");

		try {
			const resumed = await workflows(["resume", id], { cwd: repo });
			expect([resumed.code, resumed.stdout, resumed.stderr]).toEqual([1, [], [`workflows: run ${id} is running`]]);
			expect(existsSync(marker)).toBe(false);
		} finally {
			holder.kill();
		}
	});

	it("continues a turn interrupted by Ctrl+C from the saved inputs", async () => {
		await writeFile(join(repo, "item.md"), "# Fix the README typo\n");
		const first = await workflows(["ship", "--rounds", "2", "item.md"], {
			cwd: repo,
			script: { interruptAt: { kind: "implement", nth: 1 } },
		});
		expect(first.code).toBe(130);
		expect(first.stderr.at(-1)).toBe(`interrupted; continue with: workflows resume ${first.id}`);
		expect(first.model.calls.map((call) => call.kind)).toEqual(["plan", "challenge", "handoff"]);

		await writeFile(join(repo, "item.md"), "# Something else\n");
		await writeFile(join(repo, "README.md"), "changed on main\n");
		git(repo, "commit", "-qam", "later");

		const resumed = await workflows(["resume", first.id ?? ""], {
			cwd: root,
			script: { edits: [FIXED] },
		});
		expect(resumed.code).toBe(0);
		expect(resumed.stdout).toEqual([`run ${first.id}`, expect.stringMatching(SHIPPED)]);
		expect(resumed.stderr).toEqual(["round 1: implement", "round 1: review", "judge"]);
		expect(resumed.model.calls.map((call) => call.kind)).toEqual(["implement", "review", "verdict", "judge"]);
		expect(resumed.model.calls[0]?.prompt).toContain("## plan\nHandoff 1: ");
		expect(resumed.model.calls[0]?.prompt.startsWith(`${memory(1)}Implement this plan`)).toBe(true);
		const worktree = worktreeOf(first.id);
		expect(git(worktree, "rev-parse", "HEAD^")).toBe(start);
		expect(git(worktree, "log", "-1", "--format=%B")).toMatch(/^Fix the README typo\n\n# Fix the README typo\n\n/);
		expect(git(repo, "branch", "--list", "ship/*").split("\n")).toHaveLength(1);
		expect(git(repo, "worktree", "list").split("\n")).toHaveLength(2);

		const again = await workflows(["resume", first.id ?? ""], { cwd: root });
		expect(again.code).toBe(0);
		expect(again.stdout).toEqual(resumed.stdout);
		expect(again.model.calls).toEqual([]);
	});

	it("lists finished and unfinished runs without continuing them", async () => {
		const shipped = await workflows(["ship", "Fix the README typo"], { cwd: repo, script: { edits: [FIXED] } });
		expect(shipped.code).toBe(0);
		const stopped = await workflows(["ship", "# Second item"], {
			cwd: repo,
			script: { interruptAt: { kind: "implement", nth: 1 } },
		});
		expect(stopped.code).toBe(130);

		const listed = await workflows(["list", "--json"], { cwd: root });
		expect(listed.code).toBe(0);
		expect(listed.stdout).toHaveLength(1);
		const runs = JSON.parse(listed.stdout[0] ?? "") as { runId: string }[];
		expect(runs).toEqual(
			[
				{ runId: shipped.id, workflow: "ship", title: "Fix the README typo", status: "shipped" },
				{ runId: stopped.id, workflow: "ship", title: "Second item", status: "unfinished" },
			].sort((a, b) => (b.runId ?? "").localeCompare(a.runId ?? "")),
		);
		const text = await workflows(["list"], { cwd: root });
		expect(text.stdout).toEqual(runs.map((run) => expect.stringMatching(new RegExp(`^${run.runId} ship `))));
		expect(text.stdout).toContain(`${shipped.id} ship shipped Fix the README typo`);

		const resumed = await workflows(["resume", stopped.id ?? ""], { cwd: root, script: { edits: [FIXED] } });
		expect(resumed.code).toBe(0);
		expect(resumed.model.calls.map((call) => call.kind)).toEqual(["implement", "review", "verdict", "judge"]);
	});

	it("prints the phase of a session that a later turn interrupted", async () => {
		await writeFile(join(repo, "item.md"), "# Fix the README typo\n");
		const first = await workflows(["ship", "item.md"], {
			cwd: repo,
			script: { interruptAt: { kind: "challenge", nth: 1 } },
		});
		expect(first.code).toBe(130);

		const resumed = await workflows(["resume", first.id ?? ""], { cwd: root, script: { edits: [FIXED] } });
		expect(resumed.code).toBe(0);
		expect(resumed.stderr).toEqual(["plan", "round 1: implement", "round 1: review", "judge"]);
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
		expect(git(worktreeOf(first.id), "log", "--format=%s")).toBe("initial");

		const resumed = await workflows(["resume", first.id ?? ""], { cwd: repo });
		expect(resumed.code).toBe(0);
		expect(resumed.model.calls.map((call) => call.kind)).toEqual(["review", "verdict", "judge"]);
		expect(resumed.model.calls[0]?.prompt).toContain("## reply\nI fixed the typo in README.md.");
		expect(resumed.model.calls[0]?.prompt.startsWith(`${memory(2)}Perform a deep code quality audit`)).toBe(true);
		expect(git(worktreeOf(first.id), "log", "--format=%s")).toBe("Fix the README typo\ninitial");
	});
});
