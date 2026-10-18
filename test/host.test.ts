import { existsSync } from "node:fs";
import { chmod, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId, Cursor } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { addProject } from "harness/src/projects.ts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detached, piSettings, rootTasks, runsOf, sandbox, storeOf, workflows } from "./support.ts";

let root: string;

beforeEach(async () => {
	root = await sandbox();
	// `./gate.sh <name>` waits until `<name>.open` exists, after it creates `<name>.reached`.
	await writeFile(
		join(root, "gate.sh"),
		'#!/bin/sh\ntouch "$1.reached"\nwhile [ ! -f "$1.open" ]; do sleep 0.02; done\n',
	);
	await chmod(join(root, "gate.sh"), 0o755);
	await writeFile(join(root, "gated.js"), 'await sh("./gate.sh g")\nreturn "done"');
});

afterEach(() => rm(root, { recursive: true, force: true }));

/** Waits until the gate `name` in the sandbox is reached. */
async function reached(name: string): Promise<void> {
	while (!existsSync(join(root, `${name}.reached`))) await new Promise((resolve) => setTimeout(resolve, 10));
}

/** Starts `gated.js`, and detaches once its gate is reached. The host keeps running the run. */
async function detachedRun() {
	const interrupt = new AbortController();
	const pending = workflows(["gated.js"], { cwd: root, interrupt, keepHost: true });
	await reached("g");
	interrupt.abort();
	const run = await pending;
	expect([run.code, run.stderr]).toEqual([130, [detached(run.id)]]);
	if (run.host === undefined) throw new Error("no host");
	return { id: run.id ?? "", host: run.host };
}

/** The library state of each child conversation in the `main` store, by key: whether it is closed. */
async function children(): Promise<Record<string, boolean>> {
	const storage = await openNodeSqliteStorage(storeOf());
	try {
		const found: Record<string, boolean> = {};
		let cursor: Cursor | undefined;
		do {
			const page = await storage.scanConversations({}, 256, cursor, BACKGROUND_CONTEXT);
			for (const { id } of page.items) {
				const scope = { kind: "conversation" as const, conversationId: id as ConversationId };
				const record = await storage.findDocument({ kind: "pi-subagent.child", scope }, "current", BACKGROUND_CONTEXT);
				const stored = record && (await storage.document(record.id, "current", BACKGROUND_CONTEXT));
				const value = stored?.value as { key: string; closed: boolean } | undefined;
				if (value !== undefined && value.key !== "") found[value.key] = value.closed;
			}
			cursor = page.next;
		} while (cursor !== undefined);
		return found;
	} finally {
		await storage.close(BACKGROUND_CONTEXT);
	}
}

describe("runs in the harness host", { timeout: 30_000 }, () => {
	it("goes on in the host after Ctrl+C, and resume follows the same task", async () => {
		const { id, host } = await detachedRun();
		try {
			const resumed = workflows(["resume", id], { cwd: root, host });
			await new Promise((resolve) => setTimeout(resolve, 100));
			await writeFile(join(root, "g.open"), "");
			const outcome = await resumed;
			expect([outcome.code, outcome.stdout]).toEqual([0, [`run ${id}`, "done"]]);
		} finally {
			await host.close();
		}
		expect(await rootTasks(id)).toEqual([{ status: "terminal", outcome: "completed" }]);
	});

	it("stops the run on a second Ctrl+C, and a resume continues it", async () => {
		const interrupt = new AbortController();
		const stop = new AbortController();
		const pending = workflows(["gated.js", "--json"], { cwd: root, interrupt, stop });
		await reached("g");
		interrupt.abort();
		setTimeout(() => stop.abort(), 50);
		const run = await pending;
		expect([run.code, run.stdout.at(-1)]).toEqual([130, JSON.stringify({ runId: run.id, status: "stopped" })]);
		const id = run.id ?? "";
		expect(await rootTasks(id)).toEqual([{ status: "terminal", outcome: "aborted" }]);

		await writeFile(join(root, "g.open"), "");
		const resumed = await workflows(["resume", id], { cwd: root });
		expect([resumed.code, resumed.stdout]).toEqual([0, [`run ${id}`, "done"]]);
		expect(await rootTasks(id)).toEqual([
			{ status: "terminal", outcome: "aborted" },
			{ status: "terminal", outcome: "completed" },
		]);
	});

	it("reports a run that ends while it waits for a second Ctrl+C", async () => {
		const interrupt = new AbortController();
		const pending = workflows(["gated.js"], { cwd: root, interrupt, stop: new AbortController() });
		await reached("g");
		interrupt.abort();
		await writeFile(join(root, "g.open"), "");
		const run = await pending;
		expect([run.code, run.stdout, run.stderr]).toEqual([0, [`run ${run.id}`, "done"], [detached(run.id)]]);
	});

	it("starts no run after a Ctrl+C before the run starts", async () => {
		const interrupt = new AbortController();
		interrupt.abort();
		const run = await workflows(["gated.js"], { cwd: root, interrupt });
		expect([run.code, run.stdout, run.stderr]).toEqual([130, [], ["workflows: interrupted before the run started"]]);
		expect(existsSync(runsOf(root)) ? await readdir(runsOf(root)) : []).toEqual([]);
		expect(existsSync(join(root, "g.reached"))).toBe(false);
	});

	it("stops a run with workflows stop, and refuses a run that does not run", async () => {
		const { id, host } = await detachedRun();
		try {
			const stopped = await workflows(["stop", id], { cwd: root, host });
			expect([stopped.code, stopped.stdout, stopped.stderr]).toEqual([
				0,
				[`stopped gated; continue with: workflows resume ${id}`],
				[],
			]);
			const again = await workflows(["stop", id, "--json"], { cwd: root, host });
			expect([again.code, again.stderr]).toEqual([1, [`workflows: run ${id} is not running`]]);
		} finally {
			await host.close();
		}
		expect(await rootTasks(id)).toEqual([{ status: "terminal", outcome: "aborted" }]);
		const usage = await workflows(["stop"], { cwd: root });
		expect([usage.code, usage.stderr.at(-1)]).toEqual([2, "usage: workflows stop <run-id> [--json]"]);
	});

	it("cancels the calls of a script that ends before them", async () => {
		await writeFile(join(root, "x.js"), 'sh("./gate.sh g; touch late")\nawait sh("sleep 0.2; exit 3")');
		const run = await workflows(["x.js"], { cwd: root });
		expect([run.code, run.stderr.at(-2)]).toEqual([1, "failed x: sh exited with 3: sleep 0.2; exit 3"]);
		await writeFile(join(root, "g.open"), "");
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(existsSync(join(root, "late"))).toBe(false);
	});

	it("closes the sessions and their subagents when a run completes", async () => {
		await writeFile(join(root, "x.js"), 'const s = session()\nawait s.ask("Script spawn: child")\nreturn "ok"');
		const run = await workflows(["x.js"], { cwd: root });
		expect([run.code, run.stdout.at(-1)]).toEqual([0, "ok"]);
		const states = await children();
		expect(Object.keys(states)).toEqual([expect.stringMatching(/^wf:\S+\/\S+$/), expect.stringMatching(/^sub:/)]);
		expect(Object.values(states)).toEqual([true, true]);
	});

	it("closes only the subagents of the sessions when a run fails, and keeps the sessions for a resume", async () => {
		await writeFile(
			join(root, "x.js"),
			'const s = session()\nawait s.ask("Script spawn: child")\nawait sh("test -f ok")\nreturn await s.ask("Script: two")',
		);
		const run = await workflows(["x.js"], { cwd: root });
		expect(run.code).toBe(1);
		expect(Object.values(await children())).toEqual([false, true]);

		await writeFile(join(root, "ok"), "");
		const resumed = await workflows(["resume", run.id ?? ""], { cwd: root });
		expect([resumed.code, resumed.stdout.at(-1)]).toEqual([0, "Reply to two"]);
		expect(Object.values(await children())).toEqual([true, true]);
	});

	it("closes the sessions of a failed child run that the script caught when the run completes", async () => {
		await mkdir(join(root, ".workflows", "workflows"), { recursive: true });
		await writeFile(
			join(root, ".workflows", "workflows", "child.js"),
			'await session().ask("Script spawn: child")\nthrow new Error("no")',
		);
		await writeFile(join(root, "parent.js"), 'try { await run("child") } catch { return "caught" }');
		const run = await workflows(["parent.js"], { cwd: root });
		expect([run.code, run.stdout.at(-1)]).toEqual([0, "caught"]);
		expect(Object.values(await children())).toEqual([true, true]);
	});

	it("aborts the turn of a session that an earlier task of the run opened when the run stops", async () => {
		await writeFile(
			join(root, "x.js"),
			'const s = session()\nawait s.ask("Script: one")\nawait sh("test -f ok")\nreturn await s.ask("Script: two")',
		);
		const run = await workflows(["x.js"], { cwd: root });
		expect(run.code).toBe(1);
		const id = run.id ?? "";
		await writeFile(join(root, "ok"), "");
		// The second task asks in the session of the first task, and the model does not answer.
		const resumed = await workflows(["resume", id], {
			cwd: root,
			keepHost: true,
			script: { interruptAt: { kind: "script", nth: 1 } },
		});
		const { host } = resumed;
		if (host === undefined) throw new Error("no host");
		try {
			expect(resumed.code).toBe(130);
			const stopped = await workflows(["stop", id], { cwd: root, host });
			expect(stopped.code).toBe(0);
			expect(resumed.model.aborted).toEqual(["Script: two"]);
		} finally {
			await host.close();
		}
		expect(await rootTasks(id)).toEqual([
			{ status: "terminal", outcome: "failed" },
			{ status: "terminal", outcome: "aborted" },
		]);
	});

	it("lists the runs of the project of the current directory, and resumes a run from another directory", async () => {
		const project = join(root, "project");
		await mkdir(project);
		const real = addProject("demo", project);
		await writeFile(join(real, "x.js"), 'return await agent("Script: one")');
		await writeFile(join(root, "y.js"), 'return "main"');

		const own = await workflows(["x.js"], { cwd: real, script: { interruptAt: { kind: "script", nth: 1 } } });
		expect(own.code).toBe(130);
		const id = own.id ?? "";
		expect(await readFile(join(runsOf(root), id, "project"), "utf8")).toBe("demo\n");
		const main = await workflows(["y.js"], { cwd: root });
		expect(main.code).toBe(0);

		const listed = await workflows(["list"], { cwd: real });
		expect(listed.stdout).toEqual([`${id} x unfinished x`]);
		const other = await workflows(["list"], { cwd: root });
		expect(other.stdout).toEqual([`${main.id} y done y`]);

		const resumed = await workflows(["resume", id], { cwd: root });
		expect([resumed.code, resumed.stdout]).toEqual([0, [`run ${id}`, "Reply to one"]]);
		expect(await rootTasks(id, "demo")).toEqual([{ status: "terminal", outcome: "completed" }]);
		expect(existsSync(storeOf("demo"))).toBe(true);
		const shown = await workflows(["show", id], { cwd: root });
		expect(shown.stdout[0]).toBe(`run ${id} x done x`);
	});

	it("gives a session the provider, model and thinking of its call, and the project agent's model without one", async () => {
		await piSettings(root, [], { defaultProvider: "anthropic", defaultModel: "claude-haiku-5" });
		await mkdir(join(root, ".workflows", "agents"), { recursive: true });
		await writeFile(join(root, ".workflows", "agents", "fast.md"), "---\nthinking: low\n---\nFast profile body.\n");
		await writeFile(
			join(root, "x.js"),
			`const one = await agent("Script: one", { model: "claude-haiku-5", thinking: "high" })
const two = await session({ provider: "other", model: "o-1" }).ask("Script: two")
const three = await agent("Script: three", { as: "fast" })
return [one, two, three].join(", ")`,
		);
		const run = await workflows(["x.js"], { cwd: root });
		expect([run.code, run.stdout.at(-1)]).toEqual([0, "Reply to one, Reply to two, Reply to three"]);
		expect(run.model.calls.map((call) => [call.provider, call.model, call.thinking])).toEqual([
			["anthropic", "claude-haiku-5", "high"],
			["other", "o-1", "medium"],
			["anthropic", "claude-haiku-5", "low"],
		]);
		expect(run.model.calls[2]?.sections.instructions).toContain("Fast profile body.");

		await writeFile(join(root, "bad.js"), 'return await agent("Script: one", { model: "nope" })');
		const bad = await workflows(["bad.js"], { cwd: root });
		expect([bad.code, bad.stderr.at(-2)]).toEqual([1, "failed bad: Unknown model: anthropic/nope"]);
	});

	it("checks the literal models of a script against the model registry", async () => {
		await writeFile(
			join(root, "known.js"),
			`const name = "x"
const repo = { provider: "github" }
// agent("a", { model: "commented" })
await agent("a", { provider: "other", model: "o-1" })
await session({ model: name }).ask("Reply like { model: 'nope' }")
await agent("b", { ...repo, model: "nope" })
return await agent("c", { as: "planner", model: "claude-haiku-5", schema: { type: "object" } })`,
		);
		await writeFile(
			join(root, "model.js"),
			'return await session({ thinking: "high", model: "nope", schema: { type: "object" } }).ask("a")',
		);
		await writeFile(join(root, "provider.js"), "return await agent('a', { provider: 'gone' })");

		const known = await workflows(["check", "known.js"], { cwd: root });
		expect([known.code, known.stdout]).toEqual([0, ["ok known"]]);
		const model = await workflows(["check", "model.js"], { cwd: root });
		expect([model.code, model.stderr]).toEqual([
			1,
			["workflows: model uses the model anthropic/nope, which Pi's model registry does not have"],
		]);
		await writeFile(join(root, "regex.js"), 'const quote = /"/\nreturn await agent("a", { model: "gone" })');
		const regex = await workflows(["check", "regex.js"], { cwd: root });
		expect(regex.stderr).toEqual([
			"workflows: regex uses the model anthropic/gone, which Pi's model registry does not have",
		]);
		await mkdir(join(root, ".workflows", "agents"), { recursive: true });
		await writeFile(join(root, ".workflows", "agents", "old.md"), "---\nmodel: anthropic/claude-2\n---\nOld.\n");
		await writeFile(join(root, "profile.js"), 'return await agent("a", { as: "old" })');
		const profile = await workflows(["check", "profile.js"], { cwd: root });
		expect(profile.stderr).toEqual([
			"workflows: profile uses the agent profile old, whose model anthropic/claude-2 Pi's model registry does not have",
		]);
		const provider = await workflows(["check", "provider.js"], { cwd: root });
		expect([provider.code, provider.stderr]).toEqual([
			1,
			["workflows: provider uses the model gone/claude-opus-5-5, which Pi's model registry does not have"],
		]);
	});
});
