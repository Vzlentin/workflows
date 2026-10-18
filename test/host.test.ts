import { existsSync } from "node:fs";
import { chmod, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Cursor } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { request } from "@vzlentin/harness/client";
import { addProject } from "@vzlentin/harness/projects";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CtrlC, newRunId } from "../src/run.ts";
import { TASK } from "../src/task.ts";
import {
	detached,
	piSettings,
	rootTasks,
	runsOf,
	sandbox,
	setEntries,
	startHost,
	storeOf,
	workflows,
} from "./support.ts";

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

const CHILD = Type.Object({ key: Type.String(), closed: Type.Boolean() });

/** The library state of each child conversation in the `main` store, by key: whether it is closed. */
async function children(): Promise<Record<string, boolean>> {
	const storage = await openNodeSqliteStorage(storeOf());

	try {
		const found: Record<string, boolean> = {};
		let cursor: Cursor | undefined;

		do {
			const page = await storage.scanConversations({}, 256, cursor, BACKGROUND_CONTEXT);

			for (const { id } of page.items) {
				const scope = { kind: "conversation" as const, conversationId: id };
				const record = await storage.findDocument({ kind: "pi-subagent.child", scope }, "current", BACKGROUND_CONTEXT);
				const stored = record && (await storage.document(record.id, "current", BACKGROUND_CONTEXT));
				const value = stored?.value;

				if (Value.Check(CHILD, value) && value.key !== "") found[value.key] = value.closed;
			}

			cursor = page.next;
		} while (cursor !== undefined);

		return found;
	} finally {
		await storage.close(BACKGROUND_CONTEXT);
	}
}

/**
 * The path of an entry that gives the task `workflows.run` at `version`, as an older workflows. Its phase creates the
 * file `old-ran` and waits until the task is aborted.
 */
async function oldWorkflows(version: number): Promise<string> {
	const pkg = join(root, "old-workflows");
	await mkdir(pkg, { recursive: true });
	await writeFile(join(pkg, "package.json"), JSON.stringify({ name: "old-workflows", type: "module" }));
	await writeFile(
		join(pkg, "index.ts"),
		`import { writeFileSync } from "node:fs";
export default function ({ durable }) {
	const task = durable.defineTask({
		name: "workflows.run",
		version: ${version},
		initial: () => ({ phase: "run" }),
		phases: {
			run: (_task, runtime, context) => {
				writeFileSync(${JSON.stringify(join(root, "old-ran"))}, "");
				return runtime.sleep(runtime.now() + 3600000, context);
			},
		},
		abort: (_task, runtime, context) =>
			runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
	});
	return { extensions: [], tasks: [task], close: async () => {} };
}
`,
	);

	return join(pkg, "index.ts");
}

/** The line of a command that a host of the version `version` of the workflows task refused. */
const refused = (version: number) =>
	`workflows: This host has version ${version} of workflows.run, not ${TASK.version}: stop the host so it starts again with the installed version (the harness host of project main has pid ${process.pid}: kill ${process.pid})`;

describe("runs in the harness host", { timeout: 30_000 }, () => {
	it("goes on in the host after Ctrl+C, and resume follows the same task from the start of its execution", async () => {
		await writeFile(join(root, "phased.js"), 'phase("gate")\nlog("waits")\nawait sh("./gate.sh g")\nreturn "done"');
		const interrupt = new AbortController();
		const pending = workflows(["phased.js"], { cwd: root, interrupt, keepHost: true });
		await reached("g");
		interrupt.abort();
		const first = await pending;
		const { host } = first;

		if (host === undefined) throw new Error("no host");
		const id = first.id ?? "";
		expect([first.code, first.stderr]).toEqual([130, ["gate", "  waits", detached(id)]]);

		try {
			const resumed = workflows(["resume", id], { cwd: root, host });
			await new Promise((resolve) => setTimeout(resolve, 100));
			await writeFile(join(root, "g.open"), "");
			const outcome = await resumed;
			expect([outcome.code, outcome.stdout, outcome.stderr]).toEqual([0, [`run ${id}`, "done"], ["gate", "  waits"]]);
		} finally {
			await host.close();
		}

		expect(await rootTasks(id)).toEqual([{ status: "terminal", outcome: "completed" }]);
	});

	it("stops the run on a second Ctrl+C in the window, and a resume continues it", async () => {
		const ctrlC = new CtrlC(() => {});
		const pending = workflows(["gated.js", "--json"], { cwd: root, ctrlC, stopWindowMs: 5000 });
		await reached("g");
		ctrlC.press();
		setTimeout(() => ctrlC.press(), 50);
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

	it("stops the run on a second Ctrl+C that comes before the command waits for it", async () => {
		const ctrlC = new CtrlC(() => {});
		const pending = workflows(["gated.js"], { cwd: root, ctrlC });
		await reached("g");
		ctrlC.press();
		ctrlC.press();
		const run = await pending;
		expect([run.code, run.stderr]).toEqual([
			130,
			[detached(run.id), `stopped gated; continue with: workflows resume ${run.id}`],
		]);
		expect([run.exits, await rootTasks(run.id ?? "")]).toEqual([0, [{ status: "terminal", outcome: "aborted" }]]);
	});

	it("reports a run that ends while it waits for a second Ctrl+C", async () => {
		const interrupt = new AbortController();
		const pending = workflows(["gated.js"], { cwd: root, interrupt, stopWindowMs: 5000 });
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
		const listed = await workflows(["list"], { cwd: root });
		expect(listed.stdout).toEqual([`${id} gated stopped gated`]);
		const shown = await workflows(["show", id], { cwd: root });
		expect(shown.stdout).toEqual([
			`run ${id} gated stopped gated`,
			"  ✗ sh ./gate.sh g",
			`stopped gated; continue with: workflows resume ${id}`,
		]);
		const usage = await workflows(["stop"], { cwd: root });
		expect([usage.code, usage.stderr.at(-1)]).toEqual([2, "usage: workflows stop <run-id> [--json]"]);
	});

	it("kills a running sh and closes the subagents of the sessions when a run stops", async () => {
		await writeFile(
			join(root, "x.js"),
			'await session().ask("Script spawn: child")\nawait sh("./gate.sh g; touch late")\nreturn "done"',
		);
		const interrupt = new AbortController();
		const pending = workflows(["x.js"], { cwd: root, interrupt, keepHost: true });
		await reached("g");
		interrupt.abort();
		const run = await pending;
		const { host } = run;

		if (host === undefined) throw new Error("no host");

		try {
			const stopped = await workflows(["stop", run.id ?? ""], { cwd: root, host });
			expect(stopped.code).toBe(0);
			expect(Object.values(await children())).toEqual([false, true]);
		} finally {
			await host.close();
		}

		await writeFile(join(root, "g.open"), "");
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(existsSync(join(root, "late"))).toBe(false);
	});

	it("cancels the calls of a script that ends before them", async () => {
		await writeFile(join(root, "x.js"), 'sh("./gate.sh g; touch late")\nawait sh("sleep 0.2; exit 3")');
		const run = await workflows(["x.js"], { cwd: root });
		expect([run.code, run.stderr.at(-2)]).toEqual([1, "failed x: sh exited with 3: sleep 0.2; exit 3"]);
		await writeFile(join(root, "g.open"), "");
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(existsSync(join(root, "late"))).toBe(false);
		const shown = await workflows(["show", run.id ?? ""], { cwd: root });
		expect(shown.stdout.slice(0, 3)).toEqual([
			`run ${run.id} x failed x`,
			"  ✗ sh ./gate.sh g; touch late",
			expect.stringMatching(/^ {2}✗ sh sleep 0\.2; exit 3 {2}\d+s$/),
		]);
	});

	it("leaves the run pending when its host stops while the command follows it", async () => {
		const host = await startHost();
		const pending = workflows(["gated.js"], { cwd: root, host });
		await reached("g");
		await host.close();
		const run = await pending;
		const id = run.id ?? "";
		expect([run.code, run.stderr]).toEqual([
			1,
			[`the host stopped; the run continues when it starts again: workflows resume ${id}`],
		]);
		// The store still has the task as it was when the host stopped; the next host continues it.
		expect(await rootTasks(id)).toEqual([{ status: expect.stringMatching(/^(pending|running)$/) }]);
		const listed = await workflows(["list"], { cwd: root });
		expect(listed.stdout).toEqual([`${id} gated running gated`]);

		await writeFile(join(root, "g.open"), "");
		const resumed = await workflows(["resume", id, "--json"], { cwd: root });
		expect(resumed.code).toBe(0);
		expect(await rootTasks(id)).toEqual([{ status: "terminal", outcome: "completed" }]);
	});

	it("refuses a host that runs another version of workflows, which starts no task", async () => {
		await writeFile(join(root, "x.js"), 'await sh("test -f ok")\nreturn "done"');
		const failed = await workflows(["x.js"], { cwd: root });
		expect(failed.code).toBe(1);
		const id = failed.id ?? "";

		// The host started before the command set the entry of this workflows.
		await setEntries({ workflows: await oldWorkflows(TASK.version - 1) });
		const host = await startHost();

		try {
			const fresh = await workflows(["x.js"], { cwd: root, host });
			expect([fresh.code, fresh.stdout, fresh.stderr]).toEqual([1, [], [refused(TASK.version - 1)]]);
			expect(await readdir(runsOf(root))).toEqual([id]);
			const resumed = await workflows(["resume", id], { cwd: root, host });
			expect([resumed.code, resumed.stdout, resumed.stderr]).toEqual([1, [], [refused(TASK.version - 1)]]);
			expect(await rootTasks(id)).toEqual([{ status: "terminal", outcome: "failed" }]);
			expect(existsSync(join(root, "old-ran"))).toBe(false);
		} finally {
			await host.close();
		}

		await writeFile(join(root, "ok"), "");
		const listed = await workflows(["list"], { cwd: root });
		expect(listed.stdout).toEqual([`${id} x failed x`]);
		const again = await workflows(["resume", id], { cwd: root });
		expect([again.code, again.stdout]).toEqual([0, [`run ${id}`, "done"]]);
		expect(await rootTasks(id)).toEqual([
			{ status: "terminal", outcome: "failed" },
			{ status: "terminal", outcome: "completed" },
		]);
	});

	it("follows a run whose start request failed after the host created its task", async () => {
		await writeFile(join(root, "x.js"), 'phase("one")\nreturn "done"');
		const run = await workflows(["x.js"], { cwd: root, dropStart: true });
		expect([run.code, run.stdout, run.stderr]).toEqual([0, [`run ${run.id}`, "done"], ["one"]]);
		expect(await rootTasks(run.id ?? "")).toEqual([{ status: "terminal", outcome: "completed" }]);
	});

	it("says to start the host once when the store needs a schema update", async () => {
		const id = newRunId();
		await mkdir(join(runsOf(root), id), { recursive: true });
		await writeFile(join(runsOf(root), id, "project"), "main\n");
		await mkdir(join(root, "state", "harness", "main"), { recursive: true });
		new DatabaseSync(storeOf()).close();
		const shown = await workflows(["show", id], { cwd: root });
		expect([shown.code, shown.stderr]).toEqual([
			1,
			[
				`workflows: ${storeOf()} needs a schema update that only its harness host makes: start the host once, such as with harness --project main host, and run the command again`,
			],
		]);
	});

	it("stops a pending run of an earlier version, which ends as orphaned", async () => {
		await setEntries({ workflows: await oldWorkflows(TASK.version - 1) });
		const id = newRunId();
		await mkdir(join(runsOf(root), id), { recursive: true });
		await writeFile(join(runsOf(root), id, "project"), "main\n");
		const old = await startHost();

		try {
			const input = { runId: id, name: "x" };
			await request({ type: "start", kind: TASK.name, input, key: `wf:${id}#1` }, { start: false });
		} finally {
			await old.close();
		}

		await setEntries();

		expect((await workflows(["list"], { cwd: root })).stdout).toEqual([`${id} x earlier-version x`]);
		const resumed = await workflows(["resume", id], { cwd: root });
		expect(resumed.stderr).toEqual([`workflows: run ${id} was saved by an earlier version of x and cannot resume`]);
		const stopped = await workflows(["stop", id], { cwd: root });
		expect([stopped.code, stopped.stdout]).toEqual([
			0,
			["stopped x, which an earlier version saved; it cannot resume"],
		]);
		expect(await rootTasks(id)).toEqual([{ status: "terminal", outcome: "orphaned" }]);
		expect((await workflows(["list"], { cwd: root })).stdout).toEqual([`${id} x orphaned x`]);
		const again = await workflows(["stop", id], { cwd: root });
		expect(again.stderr).toEqual([`workflows: run ${id} is not running`]);
	});

	it("starts no turn in a session of an earlier task after a failed run ended its sessions", async () => {
		await writeFile(
			join(root, "x.js"),
			`const s = session()
await s.ask("Script: one")
await sh("test -f ok")
const asks = Array.from({ length: 10 }, (_, n) => s.ask("Script: hang"))
await Promise.all([...asks, Promise.reject(new Error("no"))])`,
		);
		const first = await workflows(["x.js"], { cwd: root });
		expect(first.code).toBe(1);
		await writeFile(join(root, "ok"), "");

		// The second task asks in the session of the first task, and the model does not answer.
		const run = await workflows(["resume", first.id ?? ""], {
			cwd: root,
			keepHost: true,
			script: { hang: "Script: hang" },
		});

		const { host } = run;

		if (host === undefined) throw new Error("no host");

		try {
			expect([run.code, run.stderr.at(-2)]).toEqual([1, "failed x: no"]);
			await new Promise((resolve) => setTimeout(resolve, 300));
			// Every turn that the asks started was aborted when the run ended, and none started after.
			expect(run.model.waiting).toEqual(["Script: hang"]);
			expect(run.model.aborted).toEqual(["Script: hang"]);
		} finally {
			await host.close();
		}
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
		expect(listed.stdout).toEqual([`${id} x running x`]);
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
