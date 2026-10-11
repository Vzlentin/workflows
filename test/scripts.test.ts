import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Kind, repository, sandbox, workflows } from "./support.ts";

let root: string;

beforeEach(async () => {
	root = await sandbox();
	// `./gate.sh <name>` waits until `<name>.open` exists, after it creates `<name>.reached`.
	await writeFile(
		join(root, "gate.sh"),
		'#!/bin/sh\ntouch "$1.reached"\nwhile [ ! -f "$1.open" ]; do sleep 0.02; done\n',
	);
	await chmod(join(root, "gate.sh"), 0o755);
});

afterEach(() => rm(root, { recursive: true, force: true }));

const log = () => readFile(join(root, "log"), "utf8");

/** Runs `argv` in `cwd` and presses Ctrl+C at the `nth` script prompt, or once the `gate` command is reached. */
async function stopped(argv: string[], stop: { readonly nth: number } | { readonly gate: string }, cwd = root) {
	if ("nth" in stop) {
		const interruptAt = { kind: "script" as Kind, nth: stop.nth };
		return workflows(argv, { cwd, script: { interruptAt } });
	}
	const interrupt = new AbortController();
	const pending = workflows(argv, { cwd, interrupt });
	const gate = join(cwd, stop.gate);
	while (!existsSync(`${gate}.reached`)) await new Promise((resolve) => setTimeout(resolve, 10));
	interrupt.abort();
	const outcome = await pending;
	await writeFile(`${gate}.open`, "");
	return outcome;
}

describe("workflow scripts", () => {
	it("resumes after a stop at each call and repeats no finished call", async () => {
		await writeFile(
			join(root, "x.js"),
			`export const meta = { args: { word: { type: "string" } } }
phase("start")
const one = await agent("Script: one")
const planner = session()
const two = await planner.ask("Script: two")
const { n } = await planner.ask('Script respond: {"n": 3}', { schema: { type: "object", properties: { n: { type: "number" } }, required: ["n"] } })
await sh("./gate.sh a && echo a >> log")
await sh("./gate.sh b && echo b >> log")
return [one, two, n, args.word].join(", ")`,
		);
		const first = await stopped(["x.js", "--word", "done"], { nth: 1 });
		expect(first.code).toBe(130);
		expect(first.stderr.at(-1)).toBe(`interrupted; continue with: workflows resume ${first.id}`);
		const resume = ["resume", first.id ?? ""];
		const answered = [...first.model.calls];
		for (const stop of [{ nth: 2 }, { nth: 2 }, { gate: "a" }, { gate: "b" }]) {
			const again = await stopped(resume, stop);
			expect(again.code, JSON.stringify(stop)).toBe(130);
			expect(again.stderr[0], JSON.stringify(stop)).toBe("start");
			answered.push(...again.model.calls);
		}
		const last = await workflows(resume, { cwd: root });
		answered.push(...last.model.calls);

		expect(last.code).toBe(0);
		expect(last.stdout).toEqual([`run ${first.id}`, "Reply to one, Reply to two, 3, done"]);
		expect(answered.map((call) => call.prompt)).toEqual(["Script: one", "Script: two", 'Script respond: {"n": 3}']);
		expect(answered.map((call) => call.sections.answer_schema)).toEqual([
			undefined,
			undefined,
			'<answer_schema>\nThe answer of respond must match this JSON Schema:\n{"type":"object","properties":{"n":{"type":"number"}},"required":["n"]}\n</answer_schema>',
		]);
		expect(await log()).toBe("a\nb\n");
		const tools = ["read", "grep", "find", "ls", "write", "edit", "bash"];
		expect(answered.map((call) => [call.model, call.thinking, call.tools])).toEqual([
			["claude-opus-5-5", "medium", tools],
			["claude-opus-5-5", "medium", tools],
			["claude-opus-5-5", "medium", [...tools, "respond"]],
		]);
	});

	it("keys identical calls by their position", async () => {
		await writeFile(
			join(root, "x.js"),
			`await sh("echo a >> log")
await sh("echo a >> log")
await sh("./gate.sh g && echo b >> log")
return "ok"`,
		);
		const first = await stopped(["x.js"], { gate: "g" });
		expect(first.code).toBe(130);
		expect(await log()).toBe("a\na\n");
		const resumed = await workflows(["resume", first.id ?? ""], { cwd: root });
		expect([resumed.code, resumed.stdout.at(-1)]).toEqual([0, "ok"]);
		expect(await log()).toBe("a\na\nb\n");
	});

	it("replays pipeline calls whose order changes between runs", async () => {
		await writeFile(
			join(root, "x.js"),
			`const first = (n) => sh(n === 1 ? "./gate.sh w && echo 1a >> log && echo 1" : "echo 2a >> log && echo 2")
const second = (n) => sh(n === "1" ? "./gate.sh g && echo 1b >> log && echo 1b" : "echo 2b >> log && touch w.open && echo 2b")
return (await pipeline([1, 2], first, second)).join(" ")`,
		);
		const first = await stopped(["x.js"], { gate: "g" });
		expect(first.code).toBe(130);
		expect(await log()).toBe("2a\n2b\n1a\n");
		const resumed = await workflows(["resume", first.id ?? ""], { cwd: root });
		expect([resumed.code, resumed.stdout.at(-1)]).toEqual([0, "1b 2b"]);
		expect(await log()).toBe("2a\n2b\n1a\n1b\n");
	});

	it("accepts an object answer sent as JSON text, and keeps a string answer to a string schema", async () => {
		await writeFile(
			join(root, "x.js"),
			`const planner = session()
const object = { type: "object", properties: { n: { type: "number" } }, required: ["n"] }
const text = JSON.stringify(JSON.stringify({ n: 3 }))
const { n } = await planner.ask(\`Script respond: \${text}\`, { schema: object })
const verdict = await planner.ask('Script respond: "SHIP"', { schema: { type: "string", enum: ["SHIP", "FIX"] } })
return [n, typeof n, verdict].join(", ")`,
		);
		const run = await workflows(["x.js"], { cwd: root });
		expect(run.stderr).toEqual([]);
		expect(run.stdout).toEqual([`run ${run.id}`, "3, number, SHIP"]);
	});

	it("shows the schema in the prompt and sends back the error of a parsed JSON text answer", async () => {
		const schema = {
			type: "object",
			properties: {
				findings: {
					type: "array",
					items: { type: "object", properties: { finding: { type: "string" } }, required: ["finding"] },
				},
			},
			required: ["findings"],
		};
		// The first attempt sends the object as JSON text, without the required `finding`.
		const wrongAsText = JSON.stringify(JSON.stringify({ findings: [{ title: "x" }] }));
		const right = JSON.stringify({ findings: [{ finding: "y" }] });
		const prompt = `Script respond: ${wrongAsText}\n${right}`;
		await writeFile(
			join(root, "x.js"),
			`const { findings } = await agent(${JSON.stringify(prompt)}, { schema: ${JSON.stringify(schema)} })
return findings[0].finding`,
		);
		const run = await workflows(["x.js"], { cwd: root });
		expect(run.stderr).toEqual([]);
		expect(run.stdout).toEqual([`run ${run.id}`, "y"]);
		expect(run.model.results[0]).toContain("must have required properties finding");
		expect(run.model.calls[0]?.prompt).toBe(prompt);
		expect(run.model.calls[0]?.sections.answer_schema).toContain(JSON.stringify(schema));
	});

	it("runs a failed call again on resume, and no finished call", async () => {
		await writeFile(
			join(root, "x.js"),
			`const reply = await agent("Script: one")
await sh("echo a >> log")
await sh("test -f fixed")
await sh("echo b >> log")
return { reply }`,
		);
		const run = await workflows(["x.js", "--json"], { cwd: root });
		expect(run.code).toBe(1);
		const error = "sh exited with 1: test -f fixed";
		expect(run.stdout).toEqual([`run ${run.id}`, JSON.stringify({ runId: run.id, status: "failed", error })]);
		expect(run.stderr).toEqual([]);

		await writeFile(join(root, "fixed"), "");
		const resumed = await workflows(["resume", run.id ?? ""], { cwd: root });
		expect(resumed.code).toBe(0);
		expect(resumed.stdout).toEqual([`run ${run.id}`, '{"reply":"Reply to one"}']);
		expect(resumed.model.calls).toEqual([]);
		expect(await log()).toBe("a\nb\n");
	});

	it("runs a caught failure again on resume", async () => {
		await writeFile(
			join(root, "x.js"),
			`let seen = "ok"
try { await sh("test -f flag") } catch { seen = "missing" }
await sh("touch flag")
await sh("./gate.sh g")
return seen`,
		);
		const first = await stopped(["x.js"], { gate: "g" });
		expect(first.code).toBe(130);
		const resumed = await workflows(["resume", first.id ?? ""], { cwd: root });
		expect([resumed.code, resumed.stdout.at(-1)]).toEqual([0, "ok"]);
	});

	it("runs every failed call again in one resume", async () => {
		await writeFile(
			join(root, "x.js"),
			`const results = await Promise.allSettled([sh("test -f a"), ok("true"), sh("test -f b")])
const failed = results.find((r) => r.status === "rejected")
if (failed) throw failed.reason
return "done"`,
		);
		const run = await workflows(["x.js"], { cwd: root });
		expect(run.code).toBe(1);
		await writeFile(join(root, "a"), "");
		await writeFile(join(root, "b"), "");
		const resumed = await workflows(["resume", run.id ?? ""], { cwd: root });
		expect([resumed.code, resumed.stdout.at(-1)]).toEqual([0, "done"]);
	});

	it("runs and resumes project workflows from .workflows/ of the repository", async () => {
		const repo = join(root, "repo");
		await repository(repo);
		const scripts = join(repo, ".workflows", "workflows");
		await mkdir(scripts, { recursive: true });
		await writeFile(
			join(scripts, "parent.js"),
			`export const meta = { args: { word: { type: "string" } } }\nawait sh("echo x >> log")\nreturn await run("child", args)`,
		);
		const gate = join(root, "gate.sh");
		await writeFile(join(scripts, "child.js"), `await sh("echo x >> log")\nawait sh("${gate} c")\nreturn args.word`);
		const cwd = join(repo, "sub", "dir");
		await mkdir(cwd, { recursive: true });

		const first = await stopped(["parent", "--word", "nested"], { gate: "c" }, cwd);
		expect(first.code).toBe(130);
		const resumed = await workflows(["resume", first.id ?? ""], { cwd });
		expect([resumed.code, resumed.stdout.at(-1)]).toEqual([0, "nested"]);
		expect(await readFile(join(cwd, "log"), "utf8")).toBe("x\nx\n");
	});

	it("uses a project agent profile in place of the package profile", async () => {
		const agents = join(root, ".workflows", "agents");
		await mkdir(agents, { recursive: true });
		await writeFile(
			join(agents, "default.md"),
			"---\nmodel: anthropic/claude-opus-5-5\nthinking: high\n---\nProject profile body.\n",
		);
		await writeFile(join(root, "x.js"), `return await agent("Script: one")`);
		const run = await workflows(["x.js"], { cwd: root });
		expect([run.code, run.stdout.at(-1)]).toEqual([0, "Reply to one"]);
		const [call] = run.model.calls;
		expect(call?.thinking).toBe("high");
		expect(call?.sections.instructions).toContain("Project profile body.");
	});

	it("rejects bad scripts and arguments", async () => {
		for (const [code, name] of [
			["Date.now()", "Date.now"],
			["new Date()", "Date"],
			["Math.random()", "Math.random"],
		]) {
			await writeFile(join(root, "clock.js"), `return [Math.max(1, 2), ${code}]`);
			const clock = await workflows(["clock.js"], { cwd: root });
			expect([clock.code, clock.stderr[0]], code).toEqual([
				1,
				`failed clock: ${name} is not available in workflow scripts`,
			]);
		}

		await writeFile(join(root, "ok.js"), "const ok = 1; return ok");
		await writeFile(join(root, "status.js"), 'return { status: "toString" }');
		await writeFile(
			join(root, "pos.js"),
			'export const meta = { args: { toString: { type: "string", positional: true } } };\nreturn args.toString',
		);
		const cases: [string[], string, number][] = [
			[["ok.js"], "1", 0],
			[["status.js"], '{"status":"toString"}', 0],
			[["pos.js", "hello"], "hello", 0],
			[["ok.js", "--word", "x"], "workflows: Unknown option '--word'", 2],
			[["nope"], "workflows: unknown command nope", 2],
			[["toString"], "workflows: unknown command toString", 2],
			[["missing.js"], `workflows: cannot read workflow ${join(root, "missing.js")}`, 1],
			[["-"], "workflows: missing workflow script on stdin", 2],
		];
		for (const [argv, error, code] of cases) {
			const run = await workflows(argv, { cwd: root });
			expect([run.code, run.stderr[0] ?? run.stdout.at(-1)], argv.join(" ")).toEqual([
				code,
				expect.stringContaining(error),
			]);
		}
	});

	it("finds a project script before a package script of the same name", async () => {
		const repo = join(root, "repo");
		await repository(repo);
		const scripts = join(repo, ".workflows", "workflows");
		await mkdir(scripts, { recursive: true });
		await writeFile(join(scripts, "ship.js"), 'return "project ship"');
		await writeFile(join(scripts, "fix.js"), 'return "project fix"');

		const ship = await workflows(["ship"], { cwd: repo });
		const fix = await workflows(["fix"], { cwd: repo });
		const outside = await workflows(["fix"], { cwd: root });
		expect([ship.code, ship.stdout.at(-1)]).toEqual([0, "project ship"]);
		expect([fix.code, fix.stdout.at(-1)]).toEqual([0, "project fix"]);
		expect([outside.code, outside.stderr[0]]).toEqual([2, "workflows: unknown command fix"]);
	});

	it("lists the workflows and prints the usage of one from its meta", async () => {
		await writeFile(
			join(root, "count.js"),
			`// Count words.\nexport const meta = { args: { path: { type: "string", positional: true, required: true }, depth: { type: "number", default: 2 }, all: { type: "boolean" } } }\nreturn args`,
		);
		const listed = await workflows([], { cwd: root });
		expect(listed.code).toBe(0);
		expect(listed.stdout).toEqual([
			"campaign: Split a goal into work items and ship each one as a commit on one branch.",
			"ship: Ship one work item onto a new branch: plan, implement and review rounds, judge, and one squashed commit.",
		]);

		const ship = await workflows(["ship", "--help"], { cwd: root });
		expect([ship.code, ship.stdout[0]]).toEqual([
			0,
			"usage: workflows ship [--rounds <n>] [--repo <repository>] [--base <branch>] [--prompts <folder>] [<item.md> | <text>] [--json]",
		]);
		const own = await workflows(["count.js", "--help"], { cwd: root });
		expect(own.stdout).toEqual([
			"usage: workflows count [--depth <n>] [--all] [--prompts <folder>] <path> [--json]",
			"Count words.",
		]);

		const run = await workflows(["count.js", "--all", "--", "-p"], { cwd: root });
		expect([run.code, run.stdout.at(-1)]).toEqual([0, '{"path":"-p","depth":2,"all":true}']);
		const flag = await workflows(["count.js", "--path", "src"], { cwd: root });
		expect(flag.stdout.at(-1)).toBe('{"path":"src","depth":2,"all":false}');
	});

	it("rejects bad arguments with the usage of the workflow", async () => {
		await writeFile(
			join(root, "x.js"),
			`export const meta = { args: { path: { type: "string", positional: true, required: true }, depth: { type: "number" } } }\nreturn args`,
		);
		const usage = "usage: workflows x [--depth <n>] [--prompts <folder>] <path> [--json]";
		const cases: [string[], string][] = [
			[["x.js", "--depth", "two", "src"], "workflows: --depth must be a positive integer"],
			[["x.js"], "workflows: missing path"],
			[["x.js", "--path", "a", "b"], "workflows: give the path once"],
		];
		for (const [argv, error] of cases) {
			const run = await workflows(argv, { cwd: root });
			expect([run.code, run.stderr], argv.join(" ")).toEqual([2, [error, usage]]);
		}
		await writeFile(join(root, "bad.js"), `export const meta = { args: { n: { type: "integer" } } }\nreturn 1`);
		const bad = await workflows(["bad.js"], { cwd: root });
		expect([bad.code, bad.stderr[0]]).toEqual([
			1,
			"workflows: bad: meta.args.n.type is not string, number, boolean or text",
		]);
	});

	it("checks the prompts and profiles of a workflow without a run", async () => {
		await writeFile(join(root, "missing.js"), 'return await agent(prompts.nothing(), { as: "planner" })');
		await writeFile(join(root, "profile.js"), 'return await session("nobody").ask(prompts.plan())');
		await writeFile(join(root, "inherited.js"), "return prompts.toString()");

		const ship = await workflows(["check", "ship"], { cwd: root });
		const missing = await workflows(["check", "missing.js"], { cwd: root });
		const profile = await workflows(["check", "profile.js"], { cwd: root });
		const inherited = await workflows(["check", "inherited.js"], { cwd: root });
		const started = await workflows(["missing.js"], { cwd: root });
		expect([ship.code, ship.stdout]).toEqual([0, ["ok ship"]]);
		expect([missing.code, missing.stderr]).toEqual([
			1,
			["workflows: missing uses prompts.nothing, which has no template"],
		]);
		expect([profile.code, profile.stderr]).toEqual([
			1,
			["workflows: profile uses the agent profile nobody, which does not exist"],
		]);
		expect([inherited.code, inherited.stderr]).toEqual([
			1,
			["workflows: inherited uses prompts.toString, which has no template"],
		]);
		expect([started.code, started.stdout]).toEqual([1, []]);
		expect(existsSync(join(root, "state", "workflows", "runs"))).toBe(false);
	});
});
