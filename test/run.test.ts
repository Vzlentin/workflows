import { existsSync } from "node:fs";
import { chmod, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Kind, sandbox, workflows } from "./support.ts";

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

/** Runs `argv` and presses Ctrl+C at the `nth` script prompt, or once the `gate` command is reached. */
async function stopped(argv: string[], stop: { readonly nth: number } | { readonly gate: string }) {
	if ("nth" in stop) {
		const interruptAt = { kind: "script" as Kind, nth: stop.nth };
		return workflows(argv, { cwd: root, script: { interruptAt } });
	}
	const interrupt = new AbortController();
	const pending = workflows(argv, { cwd: root, interrupt });
	const gate = join(root, stop.gate);
	while (!existsSync(`${gate}.reached`)) await new Promise((resolve) => setTimeout(resolve, 10));
	interrupt.abort();
	const outcome = await pending;
	await writeFile(`${gate}.open`, "");
	return outcome;
}

describe("workflows run", () => {
	it("resumes after a stop at each call and repeats no finished call", async () => {
		await writeFile(
			join(root, "x.js"),
			`phase("start")
const one = await agent("Script: one")
const planner = session()
const two = await planner.ask("Script: two")
const { n } = await planner.ask('Script respond: {"n": 3}', { schema: { type: "object", properties: { n: { type: "number" } }, required: ["n"] } })
await sh("./gate.sh a && echo a >> log")
await sh("./gate.sh b && echo b >> log")
return [one, two, n, args.word].join(", ")`,
		);
		const first = await stopped(["run", "x.js", "--arg", "word=done"], { nth: 1 });
		expect(first.code).toBe(130);
		expect(first.stderr.at(-1)).toBe(`interrupted; continue with: workflows run resume ${first.id}`);
		const resume = ["run", "resume", first.id ?? ""];
		const answered = [...first.model.calls];
		for (const stop of [{ nth: 2 }, { nth: 2 }, { gate: "a" }, { gate: "b" }]) {
			const again = await stopped(resume, stop);
			expect(again.code, JSON.stringify(stop)).toBe(130);
			answered.push(...again.model.calls);
		}
		const last = await workflows(resume, { cwd: root });
		answered.push(...last.model.calls);

		expect(last.code).toBe(0);
		expect(last.stdout).toEqual([`run ${first.id}`, "Reply to one, Reply to two, 3, done"]);
		expect(answered.map((call) => call.prompt)).toEqual(["Script: one", "Script: two", 'Script respond: {"n": 3}']);
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
		const first = await stopped(["run", "x.js"], { gate: "g" });
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
		const first = await stopped(["run", "x.js"], { gate: "g" });
		expect(first.code).toBe(130);
		expect(await log()).toBe("2a\n2b\n1a\n");
		const resumed = await workflows(["run", "resume", first.id ?? ""], { cwd: root });
		expect([resumed.code, resumed.stdout.at(-1)]).toEqual([0, "1b 2b"]);
		expect(await log()).toBe("2a\n2b\n1a\n1b\n");
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
		const run = await workflows(["run", "x.js", "--json"], { cwd: root });
		expect(run.code).toBe(1);
		expect(run.stdout).toEqual([`run ${run.id}`]);
		expect(run.stderr).toEqual([
			"failed x: sh exited with 1: test -f fixed",
			`continue with: workflows run resume ${run.id}`,
		]);

		await writeFile(join(root, "fixed"), "");
		const resumed = await workflows(["run", "resume", run.id ?? ""], { cwd: root });
		expect(resumed.code).toBe(0);
		expect(resumed.stdout).toEqual([`run ${run.id}`, '{"reply":"Reply to one"}']);
		expect(resumed.model.calls).toEqual([]);
		expect(await log()).toBe("a\nb\n");
	});

	it("gives a caught error again on resume", async () => {
		await writeFile(
			join(root, "x.js"),
			`let seen = "ok"
try { await sh("test -f flag") } catch { seen = "missing" }
await sh("touch flag")
await sh("./gate.sh g")
return seen`,
		);
		const first = await stopped(["run", "x.js"], { gate: "g" });
		expect(first.code).toBe(130);
		const resumed = await workflows(["run", "resume", first.id ?? ""], { cwd: root });
		expect([resumed.code, resumed.stdout.at(-1)]).toEqual([0, "missing"]);
	});

	it("runs a rethrown earlier error's call again on resume", async () => {
		await writeFile(
			join(root, "x.js"),
			`const results = await Promise.allSettled([sh("test -f a"), ok("true"), sh("test -f b")])
const failed = results.find((r) => r.status === "rejected")
if (failed) throw failed.reason
return "done"`,
		);
		const run = await workflows(["run", "x.js"], { cwd: root });
		expect(run.code).toBe(1);
		await writeFile(join(root, "a"), "");
		await writeFile(join(root, "b"), "");
		const resume = ["run", "resume", run.id ?? ""];
		const again = await workflows(resume, { cwd: root });
		expect([again.code, again.stderr[0]]).toEqual([1, "failed x: sh exited with 1: test -f b"]);
		const resumed = await workflows(resume, { cwd: root });
		expect([resumed.code, resumed.stdout.at(-1)]).toEqual([0, "done"]);
	});

	it("rejects bad scripts and arguments", async () => {
		for (const [code, name] of [
			["Date.now()", "Date.now"],
			["new Date()", "Date"],
			["Math.random()", "Math.random"],
		]) {
			await writeFile(join(root, "clock.js"), `return [Math.max(1, 2), ${code}]`);
			const clock = await workflows(["run", "clock.js"], { cwd: root });
			expect([clock.code, clock.stderr[0]], code).toEqual([
				1,
				`failed clock: ${name} is not available in workflow scripts`,
			]);
		}

		await writeFile(join(root, "ok.js"), "const ok = 1; return ok");
		const cases: [string[], string, number][] = [
			[["run", "ok.js"], "1", 0],
			[["run", "x.js", "--arg", "word"], "workflows: --arg word is not <key>=<value>", 2],
			[["run", "x.js", "--arg", "a=1", "--arg", "a=2"], "workflows: --arg a is given more than once", 2],
			[["run"], "workflows: give one workflow: a name, a .js file or -", 2],
			[["run", "nope"], "workflows: no workflow nope", 1],
			[["run", "-"], "workflows: missing workflow script on stdin", 2],
		];
		for (const [argv, error, code] of cases) {
			const run = await workflows(argv, { cwd: root });
			expect([run.code, run.stderr[0] ?? run.stdout.at(-1)], argv.join(" ")).toEqual([code, error]);
		}
	});
});
