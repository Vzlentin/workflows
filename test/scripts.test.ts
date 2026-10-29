import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, defineExtension, defineTask, Harness, type TaskId } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { REMINDER } from "@vzlentin/harness/answer";
import { Value } from "typebox/value";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AGENTS } from "../pi/run-view.ts";
import { branchOf } from "../src/git.ts";
import type { Choose } from "../src/main.ts";
import { programStatus } from "../src/progress.ts";
import { CallDoc } from "../src/script.ts";
import {
	childTasks,
	conversationOf,
	detached,
	git,
	repository,
	rootTasks,
	runsOf,
	sandbox,
	storeOf,
	workflows,
	worktreeAt,
} from "./support.ts";

let root: string;

beforeEach(async () => {
	root = await sandbox();
	// `./gate.sh <name>` waits until `<name>.open` exists, after it creates `<name>.reached`. It ends when the sandbox
	// is removed, so a gate that a test leaves open does not loop after the test.
	await writeFile(
		join(root, "gate.sh"),
		'#!/bin/sh\ntouch "$1.reached"\nwhile [ ! -f "$1.open" ]; do [ -d "$PWD" ] || exit 1; sleep 0.02; done\n',
	);
	await chmod(join(root, "gate.sh"), 0o755);
});

afterEach(() => rm(root, { recursive: true, force: true }));

const log = () => readFile(join(root, "log"), "utf8");
const runs = () => runsOf(root);

/** Runs `argv` in `cwd` and presses Ctrl+C at the `nth` script prompt, or once the `gate` command is reached. */
async function stopped(argv: string[], stop: { readonly nth: number } | { readonly gate: string }, cwd = root) {
	if ("nth" in stop) {
		const interruptAt = { kind: "script" as const, nth: stop.nth };

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

/** A task that saves `value` as the call `key` and fails, or, without `value`, returns the saved value of `key`. */
const probe = defineTask<{ key: string; value?: string }, { phase: "run" }, JsonValue>({
	name: "probe",
	version: 1,
	initial: () => ({ phase: "run" }),
	phases: {
		run: async ({ input }, runtime, context) => {
			const { key, value } = input;

			if (value === undefined) {
				const result = (await runtime.snapshot(CallDoc, key, context))?.result ?? null;
				await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result } }), context);

				return;
			}

			await runtime.commit(async (tx) => {
				const doc = await tx.doc(CallDoc, key, null);
				Object.assign(doc, { kind: "sh", args: { cmd: "true" }, startedAt: "2026-01-01T00:00:00.000Z", result: value });

				return { status: "terminal", outcome: { status: "failed", error: { message: "no" } } };
			}, context);
		},
	},
	abort: async () => undefined,
});

/** Runs a `probe` task with `input` in a new harness on the store at `path`, and closes it. */
async function runProbe(path: string, input: { key: string; value?: string }) {
	const extension = defineExtension({ name: "probe", tasks: [probe] });
	const registry = createRegistry();
	registry.install(extension);

	const harness = await Harness.open(
		await openNodeSqliteStorage(path),
		{ models: createModels(), registry, settings: { extensions: [extension] } },
		BACKGROUND_CONTEXT,
	);

	try {
		const root = await harness.root(BACKGROUND_CONTEXT);

		const task: TaskId<JsonValue> = await root.commit(
			(tx) => tx.createTask(probe, input, { ownership: { kind: "conversation" } }),
			BACKGROUND_CONTEXT,
		);

		return (await harness.waitForTask(task, BACKGROUND_CONTEXT)).state.outcome;
	} finally {
		await harness.close(BACKGROUND_CONTEXT);
	}
}

/** Every row of every table in the store of the `main` project, read with `node:sqlite`. */
function rows() {
	const database = new DatabaseSync(storeOf(), { readOnly: true });

	try {
		const tables = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all();

		return tables.map(({ name }) => [name, database.prepare(`SELECT * FROM "${String(name)}"`).all()]);
	} finally {
		database.close();
	}
}

describe("workflows/script.d.ts", () => {
	it("declares only globals that a script has", async () => {
		const declarations = await readFile("workflows/script.d.ts", "utf8");
		const names = [...declarations.matchAll(/^declare (?:const|function) (\w+)/gm)].map((match) => match[1] ?? "");
		const types = names.map((name) => `${name}: typeof ${name}`).join(", ");
		await writeFile(join(root, "x.js"), `return { ${types} }`);
		const run = await workflows(["x.js"], { cwd: root });
		expect(run.code).toBe(0);
		const found = JSON.parse(run.stdout.at(-1) ?? "{}");
		expect(Object.keys(found)).toEqual(names);
		expect(Object.entries(found).filter(([, type]) => type === "undefined")).toEqual([]);
	});
});

const SOURCE = 'export const meta = { args: { word: { type: "string" } } }\nreturn "word " + args.word\n';
const SAVE = "usage: workflows save <run-id> <name> [--force]";

/** A finished run of the script `SOURCE` from stdin in a new repository, and the path that `workflows save <id> fix` writes. */
async function stdinRun() {
	const repo = join(root, "repo");
	await repository(repo);
	const run = await workflows(["-", "--word", "a"], { cwd: repo, stdin: SOURCE });
	expect([run.code, run.stdout.at(-1)]).toEqual([0, "word a"]);
	// Git prints the real path of the repository, which differs from `repo` where the temporary folder is a link.
	const file = join(await realpath(repo), ".workflows", "scripts", "fix.js");

	return { repo, id: run.id ?? "", file };
}

describe("workflows save", () => {
	it("saves the script of a run as a project workflow", async () => {
		const { repo, id, file } = await stdinRun();
		const sub = join(repo, "sub");
		await mkdir(sub);
		const saved = await workflows(["save", id, "fix"], { cwd: sub });
		expect([saved.code, saved.stdout, saved.stderr]).toEqual([0, [file], []]);
		expect(await readFile(file, "utf8")).toBe(SOURCE);
		const fix = await workflows(["fix", "--word", "x"], { cwd: repo });
		expect([fix.code, fix.stdout.at(-1)]).toEqual([0, "word x"]);
	});

	it("rejects a bad name, a command name, a bad run ID and bad usage", async () => {
		const { repo, id } = await stdinRun();
		const command = await workflows(["save", id, "show"], { cwd: repo });
		expect([command.code, command.stderr]).toEqual([1, ["workflows: show is a command and cannot be a workflow name"]]);
		const unknown = await workflows(["save", "nothing", "other"], { cwd: repo });
		expect([unknown.code, unknown.stderr]).toEqual([1, [`workflows: no run nothing in ${runs()}`]]);

		const cases = [
			[id, "Fix"],
			[id, "-x"],
			["a/b", "fix"],
			["-x", "fix"],
			[id],
			[id, "fix", "more"],
			[id, "fix", "--forse"],
		];

		for (const args of cases) {
			const bad = await workflows(["save", ...args], { cwd: repo });
			expect([bad.code, bad.stderr.at(-1)], args.join(" ")).toEqual([2, SAVE]);
		}

		expect(existsSync(join(repo, ".workflows"))).toBe(false);
	});

	it("replaces a project or package workflow of the name only with --force", async () => {
		const { repo, id, file } = await stdinRun();
		await mkdir(join(repo, ".workflows", "scripts"), { recursive: true });
		await writeFile(file, 'return "old"');
		const taken = await workflows(["save", id, "fix"], { cwd: repo });
		expect([taken.code, taken.stderr]).toEqual([1, ["workflows: a workflow fix exists; replace it with --force"]]);
		const ship = await workflows(["save", id, "ship"], { cwd: repo });
		expect([ship.code, ship.stderr]).toEqual([1, ["workflows: a workflow ship exists; replace it with --force"]]);
		expect(await readFile(file, "utf8")).toBe('return "old"');

		const forced = await workflows(["save", "--force", id, "fix"], { cwd: repo });
		expect([forced.code, forced.stdout]).toEqual([0, [file]]);
		expect(await readFile(file, "utf8")).toBe(SOURCE);
		const shipped = await workflows(["save", id, "ship", "--force"], { cwd: repo });
		expect(shipped.code).toBe(0);
		const replaced = await workflows(["ship", "--word", "y"], { cwd: repo });
		expect([replaced.code, replaced.stdout.at(-1)]).toEqual([0, "word y"]);
	});
});

describe("usage errors", () => {
	it("print the usage line of their own command", async () => {
		const cases: [string[], string][] = [
			[["resume"], "usage: workflows resume <run-id> [--answer <text>] [--background] [--json]"],
			[["resume", "a/b"], "usage: workflows resume <run-id> [--answer <text>] [--background] [--json]"],
			[["resume", "--background"], "usage: workflows resume <run-id> [--answer <text>] [--background] [--json]"],
			[["wait", "r1", "r2"], "usage: workflows wait <run-id> [--json]"],
			[["show", "r1", "r2"], "usage: workflows show <run-id> [--pick | [--calls | --agents] [--json]]"],
			[["show", ".."], "usage: workflows show <run-id> [--pick | [--calls | --agents] [--json]]"],
			[["list", "x"], "usage: workflows list [--pick] [--json]"],
			[["check"], "usage: workflows check <workflow>"],
		];

		for (const [argv, usage] of cases) {
			const run = await workflows(argv, { cwd: root });
			expect([run.code, run.stderr], argv.join(" ")).toEqual([2, [expect.stringMatching(/^workflows: /), usage]]);
		}
	});
});

describe("input", () => {
	it("waits for each answer, and gives the answers to the script on resume", async () => {
		await writeFile(join(root, "x.js"), 'const a = await input("A?");\nconst b = await input("B?");\nreturn a + b;');
		const first = await workflows(["x.js"], { cwd: root });
		const id = first.id ?? "";
		expect([first.code, first.stdout]).toEqual([3, [`run ${id}`, "A?"]]);

		const json = await workflows(["resume", id, "--json"], { cwd: root });
		expect([json.code, json.stdout]).toEqual([
			3,
			[
				`run ${id}`,
				JSON.stringify({
					runId: id,
					status: "finished",
					result: { status: "waiting", question: "A?", report: ["A?"] },
					report: ["A?"],
				}),
			],
		]);
		const listed = await workflows(["list"], { cwd: root });
		expect(listed.stdout).toEqual([`${id} x waiting x`]);
		const listedJson = await workflows(["list", "--json"], { cwd: root });
		expect(JSON.parse(listedJson.stdout[0] ?? "")).toEqual([
			{ runId: id, workflow: "x", title: "x", status: "waiting", repository: null },
		]);
		const shown = await workflows(["show", id], { cwd: root });
		expect(shown.stdout).toEqual([`run ${id} x waiting x`, "  ✗ input A?", "A?"]);

		const second = await workflows(["resume", id, "--answer", "x"], { cwd: root });
		expect([second.code, second.stdout]).toEqual([3, [`run ${id}`, "B?"]]);
		const last = await workflows(["resume", id, "--answer", "y"], { cwd: root });
		expect([last.code, last.stdout]).toEqual([0, [`run ${id}`, "xy"]]);
		const again = await workflows(["resume", id], { cwd: root });
		expect([again.code, again.stdout]).toEqual([0, [`run ${id}`, "xy"]]);
		expect(await rootTasks(id)).toEqual([
			{ status: "terminal", outcome: "completed" },
			{ status: "terminal", outcome: "completed" },
			{ status: "terminal", outcome: "completed" },
		]);
	});

	it("asks each question on a terminal, and goes on with the typed answer", async () => {
		await writeFile(join(root, "x.js"), 'const a = await input("A?");\nconst b = await input("B?");\nreturn a + b;');
		const run = await workflows(["x.js"], { cwd: root, lines: ["x", "y"] });
		const id = run.id ?? "";
		expect([run.code, run.stdout]).toEqual([0, [`run ${id}`, "A?", `run ${id}`, "B?", `run ${id}`, "xy"]]);
		expect(run.status).toEqual([
			programStatus("blocked", "A?", "question"),
			programStatus("blocked", "B?", "question"),
			programStatus("done", "xy"),
		]);
		expect(await rootTasks(id)).toEqual([
			{ status: "terminal", outcome: "completed" },
			{ status: "terminal", outcome: "completed" },
			{ status: "terminal", outcome: "completed" },
		]);
	});

	it("gives a typed answer that starts with a dash to the script", async () => {
		await writeFile(join(root, "x.js"), 'return await input("A?");');
		const run = await workflows(["x.js"], { cwd: root, lines: ["-x"] });
		expect([run.code, run.stdout.at(-1)]).toEqual([0, "-x"]);
	});

	it("asks on resume, and prints how to continue at the end of input", async () => {
		await writeFile(join(root, "x.js"), 'const a = await input("A?");\nconst b = await input("B?");\nreturn a + b;');
		const first = await workflows(["x.js"], { cwd: root });
		const id = first.id ?? "";
		expect([first.code, first.status]).toEqual([3, [programStatus("error", "A?")]]);

		const hint = `run ${id} waits for an answer; continue with: workflows resume ${id} --answer <text>`;
		const resumed = await workflows(["resume", id], { cwd: root, lines: ["x"] });
		expect([resumed.code, resumed.stdout, resumed.stderr]).toEqual([
			130,
			[`run ${id}`, "A?", `run ${id}`, "B?"],
			[hint],
		]);
		expect(resumed.status).toEqual([
			programStatus("blocked", "A?", "question"),
			programStatus("blocked", "B?", "question"),
			programStatus("idle", hint),
		]);
		expect((await workflows(["list"], { cwd: root })).stdout).toEqual([`${id} x waiting x`]);

		const waited = await workflows(["wait", id], { cwd: root, lines: ["y"] });
		expect([waited.code, waited.stdout]).toEqual([3, [`run ${id}`, "B?"]]);
		const json = await workflows(["resume", id, "--json"], { cwd: root, lines: ["y"] });
		expect([json.code, json.status]).toEqual([3, []]);
		expect(await rootTasks(id)).toHaveLength(2);
	});

	it("refuses an answer to a run that does not wait for one", async () => {
		await writeFile(join(root, "x.js"), "return 1");
		const done = await workflows(["x.js"], { cwd: root });
		const run = await workflows(["resume", done.id ?? "", "--answer", "x"], { cwd: root });
		expect([run.code, run.stderr]).toEqual([
			2,
			[
				`workflows: run ${done.id} does not wait for an answer`,
				"usage: workflows resume <run-id> [--answer <text>] [--background] [--json]",
			],
		]);
	});
});

describe("workflows show", () => {
	it("shows the failed step, the failed call and the error of a failed run", async () => {
		const body = `phase("check")\nlog("checking")\nawait sh("echo a")\nawait ok("false")\nawait sh("exit 3")`;
		await writeFile(join(root, "x.js"), body);
		const run = await workflows(["x.js"], { cwd: root });
		expect(run.code).toBe(1);
		const id = run.id ?? "";
		const steps = await workflows(["show", id], { cwd: root });
		expect([steps.code, steps.stderr]).toEqual([0, []]);
		expect(steps.stdout).toEqual([
			`run ${id} x failed x`,
			expect.stringMatching(/^✗ check {2}\d+s$/),
			"  checking",
			"failed x: sh exited with 3: exit 3",
			`continue with: workflows resume ${id}`,
		]);
		const shown = await workflows(["show", id, "--calls"], { cwd: root });
		expect([shown.code, shown.stderr]).toEqual([0, []]);
		expect(shown.stdout).toEqual([
			`run ${id} x failed x`,
			"check",
			expect.stringMatching(/^ {2}✓ sh echo a {2}\d+s$/),
			expect.stringMatching(/^ {2}✓ ok false {2}\d+s$/),
			expect.stringMatching(/^ {2}✗ sh exit 3 {2}\d+s$/),
			"failed x: sh exited with 3: exit 3",
			`continue with: workflows resume ${id}`,
		]);
		const shownJson = await workflows(["show", id, "--json"], { cwd: root });
		const { calls, steps: json, ...tree } = JSON.parse(shownJson.stdout[0] ?? "");
		expect(tree).toEqual({ runId: id, workflow: "x", title: "x", status: "failed", error: "sh exited with 3: exit 3" });
		expect(json).toEqual(steps.stdout.slice(1, 3));
		expect(
			calls.map((call: { mark: string; result?: unknown; error?: string }) => [call.mark, call.result, call.error]),
		).toEqual([
			["✓", { code: 0, stdout: "a\n", stderr: "" }, undefined],
			["✓", { code: 1, stdout: "", stderr: "" }, undefined],
			["✗", undefined, "sh exited with 3: exit 3"],
		]);
	});

	it("shows the call that a stop interrupted, and does not change the store", async () => {
		await writeFile(
			join(root, "x.js"),
			`phase("talk")\nawait agent("Script: one")\nawait agent("Script: two", { as: "default" })`,
		);
		const first = await stopped(["x.js"], { nth: 2 });
		expect(first.code).toBe(130);
		const id = first.id ?? "";
		const before = rows();
		const steps = await workflows(["show", id], { cwd: root });
		// The task has not ended, so the step runs.
		expect(steps.stdout).toEqual([`run ${id} x running x`, "◉ talk"]);
		const shown = await workflows(["show", id, "--calls"], { cwd: root });
		expect(rows()).toEqual(before);
		const a = await conversationOf(/Script: one/);
		const b = await conversationOf(/Script: two/);
		expect(shown.stdout).toEqual([
			`run ${id} x running x`,
			"talk",
			expect.stringMatching(new RegExp(`^ {2}✓ session default conversation ${a} {2}\\d+s$`)),
			expect.stringMatching(/^ {2}✓ ask default {2}\d+s$/),
			expect.stringMatching(new RegExp(`^ {2}◉ session default conversation ${b} {2}\\d+s$`)),
			expect.stringMatching(/^ {2}◉ ask default {2}\d+s$/),
		]);
		const { calls } = JSON.parse((await workflows(["show", id, "--json"], { cwd: root })).stdout[0] ?? "");
		expect(calls[0].conversation).toBe(a);
		expect(calls[2]).toMatchObject({ kind: "session", conversation: b, mark: "✓" });
		expect(calls[3]).toMatchObject({ kind: "ask", label: "default", mark: "◉", args: { prompt: "Script: two" } });
		expect(calls[3].endedAt).toBeUndefined();
		const resumed = await workflows(["resume", id], { cwd: root });
		expect(resumed.model.calls.map((call) => call.prompt)).toEqual(["Script: two"]);
		const done = await workflows(["show", id, "--calls"], { cwd: root });
		expect(done.stdout.filter((line) => line.includes(`session default conversation ${b} `))).toEqual([
			expect.stringMatching(new RegExp(`^ {2}✓ session default conversation ${b} {2}\\d+s$`)),
		]);
		expect(done.stdout.filter((line) => line.includes("◉"))).toEqual([]);
	});

	it("shows the agents of a run and of its child runs, named by their first prompt line", async () => {
		const repo = join(root, "repo");
		await repository(repo);
		const scripts = join(repo, ".workflows", "scripts");
		await mkdir(scripts, { recursive: true });

		await writeFile(
			join(scripts, "parent.js"),
			[
				'phase("plan")',
				'await agent("Script: plan.\\nMore.")',
				'phase("work")',
				'await sh("true")',
				'await parallel(["a", "b"].map((region) => () => agent(`Script: work.\\nRegion: ${region}\\nShared.`)))',
				'return await run("child", {})',
			].join("\n"),
		);

		await writeFile(join(scripts, "child.js"), 'phase("item")\nawait agent("Script: child.")');
		const run = await workflows(["parent"], { cwd: repo });
		expect(run.code).toBe(0);
		const id = run.id ?? "";
		const shown = await workflows(["show", id, "--agents"], { cwd: repo });

		const printed = JSON.parse((await workflows(["show", id, "--agents", "--json"], { cwd: repo })).stdout[0] ?? "");
		expect(Value.Check(AGENTS, printed)).toBe(true);
		const { agents, ...head } = printed;

		const child = String(agents.find((row: { kind: string }) => row.kind === "run")?.text).slice("run child ".length);
		const agent = (text: string) => new RegExp(`^ *\\u2713 ${text} {2}1 ask {2}\\d+s$`);
		expect([shown.code, shown.stderr]).toEqual([0, []]);

		expect(shown.stdout).toEqual([
			`run ${id} parent done parent`,
			"plan",
			expect.stringMatching(agent("Script: plan\\.")),
			"work",
			expect.stringMatching(agent("Region: a")),
			expect.stringMatching(agent("Region: b")),
			`  \u2713 run child ${child}`,
			"    item",
			expect.stringMatching(agent("Script: child\\.")),
			...run.stdout.slice(-1),
		]);

		expect(head).toEqual({ runId: id, workflow: "parent", title: "parent", status: "done" });
		expect(agents[1]).toMatchObject({ kind: "agent", depth: 0, mark: "\u2713", text: "Script: plan.", asks: 1 });
		expect(agents[1].conversation).toBe(await conversationOf(/Script: plan/));
		expect(agents.at(-1)).toMatchObject({ kind: "agent", depth: 1, text: "Script: child." });
		const both = await workflows(["show", id, "--agents", "--calls"], { cwd: repo });
		expect([both.code, both.stderr[0]]).toEqual([2, "workflows: give --calls or --agents, not both"]);
	});

	it("picks the agent of a session or ask line of a run without steps, and exits 130 or 2 without a pick", async () => {
		await writeFile(join(root, "x.js"), 'await sh("true")\nawait agent("Script: one")');
		const run = await workflows(["x.js"], { cwd: root });
		const id = run.id ?? "";
		const one = await conversationOf(/Script: one/);
		const asked: (readonly [string, readonly string[], readonly boolean[]])[] = [];

		const choose =
			(index: number): Choose =>
			async (question, items) => {
				asked.push([question, items.map((item) => item.text), items.map((item) => item.value !== undefined)]);

				return items[index]?.value;
			};

		const picked = await workflows(["show", id, "--pick"], { cwd: root, choose: choose(2) });
		expect([picked.code, picked.stdout, picked.stderr]).toEqual([0, [String(one)], []]);
		const asks = await workflows(["show", id, "--pick"], { cwd: root, choose: choose(3) });
		expect([asks.code, asks.stdout]).toEqual([0, [String(one)]]);
		expect(asked[0]).toEqual([
			"Pick an agent:",
			[
				`run ${id} x done x`,
				expect.stringMatching(/^ {2}✓ sh true {2}\d+s$/),
				expect.stringMatching(new RegExp(`^ {2}✓ session default conversation ${one} {2}\\d+s$`)),
				expect.stringMatching(/^ {2}✓ ask default {2}\d+s$/),
				...run.stdout.slice(-1),
			],
			[false, false, true, true, false],
		]);
		const cancelled = await workflows(["show", id, "--pick"], { cwd: root, choose: async () => undefined });
		expect([cancelled.code, cancelled.stdout, cancelled.stderr]).toEqual([130, [], []]);
		const bare = await workflows(["show", id, "--pick"], { cwd: root });
		expect([bare.code, bare.stderr[0]]).toEqual([2, "workflows: --pick needs a terminal on stdin and stderr"]);
		const calls = await workflows(["show", id, "--pick", "--calls"], { cwd: root, choose: choose(2) });
		expect([calls.code, calls.stderr[0]]).toEqual([2, "workflows: give --pick without --calls, --agents or --json"]);
		await writeFile(join(root, "y.js"), 'phase("a")\nreturn "done"');
		const none = (await workflows(["y.js"], { cwd: root })).id ?? "";
		const empty = await workflows(["show", none, "--pick"], { cwd: root, choose: choose(0) });
		expect([empty.code, empty.stderr]).toEqual([1, [`workflows: run ${none} has no agent`]]);
	});

	it("picks the agent of its own time for a step whose text comes back", async () => {
		const body = 'phase("split")\nawait agent("Script: one")\nphase("b")\nphase("split")\nawait agent("Script: two")';
		await writeFile(join(root, "x.js"), body);
		const id = (await workflows(["x.js"], { cwd: root })).id ?? "";

		const pick = async (nth: number) => {
			const picked = await workflows(["show", id, "--pick"], {
				cwd: root,
				choose: async (_question, items) => items.filter((item) => item.text.startsWith("✓ split"))[nth]?.value,
			});

			return [picked.code, picked.stdout];
		};

		const one = String(await conversationOf(/Script: one/));
		const two = String(await conversationOf(/Script: two/));
		expect([await pick(0), await pick(1)]).toEqual([
			[0, [one]],
			[0, [two]],
		]);
	});

	it("waits with --pick while a running run has no agent, until Ctrl+C", async () => {
		await writeFile(join(root, "x.js"), 'const s = session()\nphase("talk")\nawait s.ask("Script: one")');
		const running = await stopped(["x.js"], { nth: 1 });
		const id = running.id ?? "";
		const interrupt = new AbortController();
		const started = Date.now();
		setTimeout(() => interrupt.abort(), 1500);
		let asked = 0;

		const waited = await workflows(["show", id, "--pick"], {
			cwd: root,
			interrupt,
			choose: async () => {
				asked++;

				return undefined;
			},
		});

		expect([waited.code, waited.stdout, waited.stderr, asked]).toEqual([130, [], [], 0]);
		expect(Date.now() - started).toBeGreaterThanOrEqual(1400);
	});

	it("reads the store while another process holds its write lock", async () => {
		await writeFile(join(root, "x.js"), `phase("talk")\nawait agent("Script: one")\nawait agent("Script: two")`);
		const first = await stopped(["x.js"], { nth: 2 });
		const id = first.id ?? "";

		const lock = [
			'const { DatabaseSync } = require("node:sqlite");',
			"const database = new DatabaseSync(process.argv[1]);",
			'database.exec("BEGIN IMMEDIATE");',
			'process.stdout.write("locked\\n");',
			'setTimeout(() => { database.exec("COMMIT"); database.close(); }, 5500);',
		].join("\n");

		const holder = spawn(process.execPath, ["-e", lock, storeOf()]);
		const exited = new Promise((resolve) => holder.on("exit", resolve));
		await new Promise((resolve) => holder.stdout.once("data", resolve));
		const shown = await workflows(["show", id], { cwd: root });
		expect(await exited).toBe(0);
		expect(shown.code).toBe(0);
		expect(shown.stdout[0]).toBe(`run ${id} x running x`);
	});
});

describe("saved calls", () => {
	it("keeps a saved call of a failed task for a new task after a reopen", async () => {
		const path = join(root, "durable.sqlite");
		const key = "run1/k.1";
		expect(await runProbe(path, { key, value: "saved" })).toMatchObject({ status: "failed" });
		expect(await runProbe(path, { key })).toEqual({ status: "completed", result: "saved" });
	});
});

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
		expect(first.stderr.at(-1)).toBe(detached(first.id));
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
		const tools = ["read", "grep", "find", "ls", "write", "edit", "bash", "subagent", "codemode"];
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

	it("fails an ask whose answer was cut, and asks again on resume", async () => {
		await writeFile(
			join(root, "x.js"),
			'const one = await agent("Script: one")\nreturn await agent("Script: two") + ", " + one',
		);

		const run = await workflows(["x.js"], {
			cwd: root,
			script: { failAt: { kind: "script", nth: 2, stopReason: "length" } },
		});

		expect(run.code).toBe(1);
		expect(run.stderr[0]).toMatch(/^failed x: The \S+ turn stopped: length$/);
		const resumed = await workflows(["resume", run.id ?? ""], { cwd: root });
		expect([resumed.code, resumed.stdout]).toEqual([0, [`run ${run.id}`, "Reply to two, Reply to one"]]);
		expect(resumed.model.calls.map((call) => call.prompt)).toEqual(["Script: two"]);
	});

	it("reminds the model to call respond after an answer without it", async () => {
		await writeFile(
			join(root, "x.js"),
			`const { n } = await agent('Script respond: {"n": 3}', { schema: { type: "object", properties: { n: { type: "number" } }, required: ["n"] } })
return n`,
		);
		const run = await workflows(["x.js"], { cwd: root, script: { skipRespond: 1 } });
		expect(run.stderr).toEqual([]);
		expect(run.stdout).toEqual([`run ${run.id}`, "3"]);
		expect(run.model.calls.map((call) => call.prompt)).toEqual(['Script respond: {"n": 3}', REMINDER]);
	});

	it("fails an ask whose answer did not call respond after two reminders, and asks again on resume", async () => {
		await writeFile(
			join(root, "x.js"),
			`const { n } = await agent('Script respond: {"n": 3}', { schema: { type: "object", properties: { n: { type: "number" } }, required: ["n"] } })
return n`,
		);
		const run = await workflows(["x.js"], { cwd: root, script: { skipRespond: 3 } });
		expect(run.code).toBe(1);
		expect(run.stderr[0]).toBe("failed x: the answer did not call respond");
		expect(run.model.calls.map((call) => call.prompt)).toEqual(['Script respond: {"n": 3}', REMINDER, REMINDER]);
		const resumed = await workflows(["resume", run.id ?? ""], { cwd: root });
		expect([resumed.code, resumed.stdout]).toEqual([0, [`run ${run.id}`, "3"]]);
		expect(resumed.model.calls.map((call) => call.prompt)).toEqual(['Script respond: {"n": 3}']);
	});

	it("asks a failed schema ask again on resume after a later text ask in its session", async () => {
		await writeFile(
			join(root, "x.js"),
			`const schema = { type: "object", properties: { n: { type: "number" } }, required: ["n"] }
const s = session()
let a
try {
	a = await s.ask('Script respond: {"n": 3}', { schema })
} catch {
	await s.ask("Script: two")
	throw new Error("x")
}
return a.n`,
		);
		const run = await workflows(["x.js"], { cwd: root, script: { skipRespond: 3 } });
		expect(run.code).toBe(1);
		const resumed = await workflows(["resume", run.id ?? ""], { cwd: root });
		expect([resumed.code, resumed.stdout]).toEqual([0, [`run ${run.id}`, "3"]]);
		expect(resumed.model.calls.map((call) => call.prompt)).toEqual(['Script respond: {"n": 3}']);
	});

	it("does not return the answer of a later schema ask in its session on resume", async () => {
		await writeFile(
			join(root, "x.js"),
			`const schema = { type: "object", properties: { n: { type: "number" } }, required: ["n"] }
const s = session()
let a
try {
	a = await s.ask('Script respond: {"n": 3}', { schema })
} catch {
	await s.ask('Script respond: {"n": 5}', { schema })
	throw new Error("x")
}
return a.n`,
		);
		const run = await workflows(["x.js"], { cwd: root, script: { skipRespond: 3 } });
		expect(run.code).toBe(1);
		const resumed = await workflows(["resume", run.id ?? ""], { cwd: root });
		expect([resumed.code, resumed.stdout]).toEqual([0, [`run ${run.id}`, "3"]]);
	});

	it("keeps the reminder count of a turn across an interruption", async () => {
		await writeFile(
			join(root, "x.js"),
			`const { n } = await agent('Script respond: {"n": 3}', { schema: { type: "object", properties: { n: { type: "number" } }, required: ["n"] } })
return n`,
		);

		const run = await workflows(["x.js"], {
			cwd: root,
			script: { interruptAt: { kind: "script", nth: 2 }, skipRespond: 9 },
		});

		expect(run.code).not.toBe(0);
		const resumed = await workflows(["resume", run.id ?? ""], { cwd: root, script: { skipRespond: 9 } });
		expect(resumed.code).toBe(1);
		expect(resumed.stderr[0]).toBe("failed x: the answer did not call respond");
		// The interrupted turn sends its first reminder again and gets one more. The ask then sends its prompt again
		// under the next request ID, and that turn gets its own two reminders.
		const prompt = 'Script respond: {"n": 3}';
		expect(resumed.model.calls.map((call) => call.prompt)).toEqual([REMINDER, REMINDER, prompt, REMINDER, REMINDER]);
	});

	it("returns the respond answer of a message that also calls another tool", async () => {
		await writeFile(
			join(root, "x.js"),
			`const { n } = await agent('Script respond and ls: {"n": 3}', { schema: { type: "object", properties: { n: { type: "number" } }, required: ["n"] } })
return n`,
		);
		const run = await workflows(["x.js"], { cwd: root });
		expect(run.stderr).toEqual([]);
		expect(run.stdout).toEqual([`run ${run.id}`, "3"]);
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
		const scripts = join(repo, ".workflows", "scripts");
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

	it("ends the task as failed when a phase fails, and a resume continues its saved calls in a new task", async () => {
		const repo = join(root, "repo");
		await repository(repo);
		const scripts = join(repo, ".workflows", "scripts");
		await mkdir(scripts, { recursive: true });
		await writeFile(
			join(scripts, "w.js"),
			`export const meta = { worktree: true }
const one = await agent("Script: one")
const two = await agent("Script: two")
return [one, two].join(", ")`,
		);
		const first = await stopped(["w", "--repo", "."], { nth: 2 }, repo);
		expect(first.code).toBe(130);
		const id = first.id ?? "";
		// Another worktree holds the run's branch, so the worktree step of the resume fails.
		const worktree = worktreeAt(repo, id);
		const branch = git(worktree, "branch", "--show-current");
		expect(branch).toBe(`w/${id}`);
		await rm(worktree, { recursive: true, force: true });
		git(repo, "worktree", "prune");
		git(repo, "worktree", "add", "-q", join(root, "other"), branch);

		const failed = await workflows(["resume", id], { cwd: repo });
		expect(failed.code).toBe(1);
		expect(failed.stderr.at(-2)).toMatch(/^failed w: git worktree failed: /);
		expect(failed.stderr.at(-1)).toBe(`continue with: workflows resume ${id}`);
		expect(await rootTasks(id)).toEqual([{ status: "terminal", outcome: "failed" }]);

		git(repo, "worktree", "remove", "--force", join(root, "other"));
		const resumed = await workflows(["resume", id], { cwd: repo });
		expect([resumed.code, resumed.stdout.at(-1)]).toEqual([0, "Reply to one, Reply to two"]);
		// The open store continues the interrupted turn, so the failed resume can already send it. The new task submits
		// it again in the conversation of the failed task, and the saved turn is not sent again.
		const sent = [...failed.model.calls, ...resumed.model.calls].map((call) => call.prompt);
		expect(sent).toEqual(["Script: two"]);
		expect(await rootTasks(id)).toEqual([
			{ status: "terminal", outcome: "failed" },
			{ status: "terminal", outcome: "completed" },
		]);
	});

	it("resumes an aborted run in a new task with its saved calls", async () => {
		await writeFile(
			join(root, "x.js"),
			`const one = await agent("Script: one")\nconst two = await agent("Script: two")\nreturn [one, two].join(", ")`,
		);
		const first = await stopped(["x.js"], { nth: 2 });
		expect(first.code).toBe(130);
		const id = first.id ?? "";
		// The model of the host that `stop` starts does not answer, so the resumed task cannot finish the turn first.
		const stop = await workflows(["stop", id], { cwd: root, script: { interruptAt: { kind: "script", nth: 1 } } });
		expect([stop.code, stop.stdout, stop.stderr]).toEqual([
			0,
			[`stopped x; continue with: workflows resume ${id}`],
			[],
		]);
		expect(await rootTasks(id)).toEqual([{ status: "terminal", outcome: "aborted" }]);

		const resumed = await workflows(["resume", id], { cwd: root });
		expect([resumed.code, resumed.stdout.at(-1)]).toEqual([0, "Reply to one, Reply to two"]);
		expect(resumed.model.calls.map((call) => call.prompt)).toEqual(["Script: two"]);
		expect(await rootTasks(id)).toEqual([
			{ status: "terminal", outcome: "aborted" },
			{ status: "terminal", outcome: "completed" },
		]);
	});

	it("runs a child run with its own run directory, worktree and prompts", async () => {
		const repo = join(root, "repo");
		await repository(repo);
		const scripts = join(repo, ".workflows", "scripts");
		await mkdir(scripts, { recursive: true });
		await writeFile(
			join(scripts, "parent.js"),
			`const child = await run("child", { repo: ".", prompts: { plan: "---\\ndescription: x\\n---\\nChild plan.\\n$@" } })
return { child, runId, plan: await prompts.plan() }`,
		);
		await writeFile(
			join(scripts, "child.js"),
			`export const meta = { worktree: true }
const branch = await sh(["git", "branch", "--show-current"])
return { runId, runDir, cwd, branch, start: args.start, plan: await prompts.plan() }`,
		);

		const run = await workflows(["parent"], { cwd: repo });
		expect(run.code).toBe(0);
		const { child, runId, plan } = JSON.parse(run.stdout[1] ?? "");
		expect(runId).toBe(run.id);
		expect(child.runId).not.toBe(run.id);
		expect(child).toEqual({
			runId: child.runId,
			runDir: join(runs(), child.runId),
			cwd: worktreeAt(repo, child.runId),
			branch: `child/${child.runId}`,
			start: git(repo, "rev-parse", "HEAD"),
			plan: "Child plan.",
		});
		expect(plan).toMatch(/^Plan this change\./);
		expect(existsSync(join(worktreeAt(repo, child.runId), "README.md"))).toBe(true);
		expect(existsSync(join(runs(), child.runId, "project"))).toBe(false);
		const listed = await workflows(["list"], { cwd: repo });
		expect(listed.stdout).toEqual([`${run.id} parent done parent`]);
	});

	it("runs a child run without repo in the directory of the caller", async () => {
		const repo = join(root, "repo");
		const start = await repository(repo);
		const scripts = join(repo, ".workflows", "scripts");
		await mkdir(scripts, { recursive: true });
		await writeFile(join(scripts, "parent.js"), `return await run("child", { start: "${start}" })`);
		await writeFile(
			join(scripts, "child.js"),
			`export const meta = { worktree: true }
return { branch: await sh(["git", "branch", "--show-current"]), start: args.start }`,
		);

		const run = await workflows(["parent"], { cwd: repo });
		expect(run.code).toBe(0);
		const child = JSON.parse(run.stdout[1] ?? "");
		expect(child).toEqual({ branch: "main", start, runId: expect.any(String) });
		expect(existsSync(worktreeAt(repo, child.runId))).toBe(false);
		expect(git(repo, "worktree", "list", "--porcelain").split("\n\n")).toHaveLength(1);
	});

	it("creates the worktree of a child run through herdr when the command runs in Herdr", async () => {
		const repo = join(root, "repo");
		const start = await repository(repo);
		const scripts = join(repo, ".workflows", "scripts");
		await mkdir(scripts, { recursive: true });
		await writeFile(join(scripts, "parent.js"), 'return await run("child", { repo: "." })');
		await writeFile(
			join(scripts, "child.js"),
			'export const meta = { worktree: true }\nreturn { cwd, branch: await sh(["git", "branch", "--show-current"]) }',
		);
		// `herdr worktree create --cwd <repo> --path <path> --branch <branch> --base <start> --no-focus`
		await writeFile(
			join(root, "bin", "herdr"),
			`#!/bin/sh\necho "$@" >> "${root}/herdr.log"\nexec git -C "$4" worktree add -q -b "$8" "$6" "\${10}"\n`,
		);
		await chmod(join(root, "bin", "herdr"), 0o755);
		process.env.HERDR_ENV = "1";

		const run = await workflows(["parent"], { cwd: repo });
		expect(run.code).toBe(0);
		const child = JSON.parse(run.stdout[1] ?? "");
		const path = worktreeAt(repo, child.runId);
		expect(child).toEqual({ cwd: path, branch: `child/${child.runId}`, runId: child.runId });
		expect(await readFile(join(root, "herdr.log"), "utf8")).toBe(
			`worktree create --cwd ${await realpath(repo)} --path ${path} --branch child/${child.runId} --base ${start} --no-focus\n`,
		);
	});

	it("types the pick loop once in the workspace that herdr opens on the worktree of a root run", async () => {
		const repo = join(root, "repo");
		await repository(repo);
		const scripts = join(repo, ".workflows", "scripts");
		await mkdir(scripts, { recursive: true });
		await writeFile(join(scripts, "w.js"), 'export const meta = { worktree: true }\nawait agent("Script: one")');

		/** A fake herdr whose `pane list` exits with `list`: `worktree create --cwd <repo> --path <path> --branch <branch> --base <start>`. */
		const herdr = (list: number) =>
			writeFile(
				join(root, "bin", "herdr"),
				`#!/bin/sh
echo "$@" >> "${root}/herdr.log"
case "$1 $2" in
"worktree create") git -C "$4" worktree add -q -b "$8" "$6" "\${10}" && echo '{"result":{"workspace":{"workspace_id":"w7"}}}' ;;
"pane list") echo '{"result":{"panes":[{"pane_id":"p3"},{"pane_id":"p4"}]}}'; exit ${list} ;;
esac
`,
				{ mode: 0o755 },
			);

		const typed = async () =>
			(await readFile(join(root, "herdr.log"), "utf8")).split("\n").filter((line) => line.startsWith("pane run "));

		await herdr(0);
		process.env.HERDR_ENV = "1";
		const run = await workflows(["w"], { cwd: repo });
		expect(run.code).toBe(0);
		const id = run.id ?? "";
		const loop = `while c=$(workflows show ${id} --pick); do workflows attach ${id} --conversation "$c" --side; done`;
		expect(await typed()).toEqual([`pane run p3 ${loop}`]);
		expect(await readFile(join(root, "herdr.log"), "utf8")).toContain("pane list --workspace w7\n");

		// A resume finds the worktree, and types nothing again.
		await rm(join(root, "herdr.log"));
		const stopped = await workflows(["w"], { cwd: repo, script: { interruptAt: { kind: "script", nth: 1 } } });
		expect(stopped.code).toBe(130);
		const resumed = await workflows(["resume", stopped.id ?? ""], { cwd: repo });
		expect(resumed.code).toBe(0);
		expect((await typed()).length).toBe(1);

		// A failed `pane list` types nothing, and the run goes on.
		await rm(join(root, "herdr.log"));
		await herdr(1);
		const failed = await workflows(["w"], { cwd: repo });
		expect([failed.code, await typed()]).toEqual([0, []]);
	});

	it("creates the worktree with Git when herdr fails", async () => {
		const repo = join(root, "repo");
		await repository(repo);
		const scripts = join(repo, ".workflows", "scripts");
		await mkdir(scripts, { recursive: true });
		await writeFile(
			join(scripts, "w.js"),
			'export const meta = { worktree: true }\nreturn await sh(["git", "branch", "--show-current"])',
		);
		await writeFile(join(root, "bin", "herdr"), `#!/bin/sh\necho "$@" >> "${root}/herdr.log"\nexit 1\n`);
		await chmod(join(root, "bin", "herdr"), 0o755);
		process.env.HERDR_ENV = "1";

		const run = await workflows(["w"], { cwd: repo });
		expect([run.code, run.stdout.at(-1)]).toEqual([0, `w/${run.id}`]);
		const log = await readFile(join(root, "herdr.log"), "utf8");
		expect(log).toContain(`--path ${worktreeAt(repo, run.id)} `);
		expect(log).not.toContain("pane run ");
		expect(git(worktreeAt(repo, run.id), "branch", "--show-current")).toBe(`w/${run.id}`);
	});

	it("gives a child run without meta.worktree its repo, base and branch args", async () => {
		const repo = join(root, "repo");
		await repository(repo);
		const scripts = join(repo, ".workflows", "scripts");
		await mkdir(scripts, { recursive: true });
		await writeFile(join(scripts, "parent.js"), 'return await run("child", { repo: "r", base: "dev", branch: "b" })');
		await writeFile(
			join(scripts, "child.js"),
			`export const meta = { args: { base: { type: "string", default: "main" } } }
return args`,
		);

		const run = await workflows(["parent"], { cwd: repo });
		expect(run.code).toBe(0);
		expect(JSON.parse(run.stdout[1] ?? "")).toEqual({ repo: "r", base: "dev", branch: "b", runId: expect.any(String) });
	});

	it("runs a child run with checkout in a worktree on that existing branch, with the start of its caller", async () => {
		const repo = join(root, "repo");
		const start = await repository(repo);
		git(repo, "branch", "feature");
		const scripts = join(repo, ".workflows", "scripts");
		await mkdir(scripts, { recursive: true });
		await writeFile(
			join(scripts, "parent.js"),
			`return await run("child", { start: "${start}", checkout: "feature" })`,
		);
		await writeFile(
			join(scripts, "child.js"),
			'return { cwd, args, branch: await sh(["git", "branch", "--show-current"]), head: await sh("git rev-parse HEAD") }',
		);

		const run = await workflows(["parent"], { cwd: repo });
		expect(run.code).toBe(0);
		const child = JSON.parse(run.stdout[1] ?? "");
		const path = worktreeAt(repo, child.runId);
		expect(child).toEqual({ cwd: path, args: { start }, branch: "feature", head: start, runId: child.runId });
		expect(git(repo, "branch", "--show-current")).toBe("main");

		await writeFile(join(scripts, "parent.js"), 'return await run("child", { checkout: "feature" })');
		const unstarted = await workflows(["parent"], { cwd: repo });
		expect([unstarted.code, unstarted.stderr[0]]).toEqual([
			1,
			"failed parent: run child: checkout needs start as a string",
		]);

		await writeFile(join(scripts, "parent.js"), 'return await run("child", { start: "s", checkout: "none" })');
		const missing = await workflows(["parent"], { cwd: repo });
		expect([missing.code, missing.stderr[0]]).toEqual([1, "failed parent: run child: no branch none"]);

		await writeFile(join(scripts, "parent.js"), 'return await run("ship", { item: "x", checkout: "feature" })');
		const refused = await workflows(["parent"], { cwd: repo });
		expect([refused.code, refused.stderr[0]]).toEqual([
			1,
			"failed parent: run ship: checkout is for a script without meta.worktree",
		]);
	});

	it("fails a run call that gives a worktree script a start that is not a string", async () => {
		const repo = join(root, "repo");
		await repository(repo);
		const scripts = join(repo, ".workflows", "scripts");
		await mkdir(scripts, { recursive: true });
		await writeFile(join(scripts, "parent.js"), 'return await run("ship", { item: "x", start: 1 })');

		const run = await workflows(["parent"], { cwd: repo });
		expect([run.code, run.stderr[0]]).toEqual([1, "failed parent: run ship: start is not a string"]);
		expect(await readdir(runs())).toHaveLength(1);
	});

	it("resumes an interrupted child run and repeats no call of a finished one", async () => {
		await writeFile(
			join(root, "parent.js"),
			`const one = await run("child", { word: "one" })
const two = await run("child", { word: "two" })
return [one.reply, two.reply].join(", ")`,
		);
		await mkdir(join(root, ".workflows", "scripts"), { recursive: true });
		await writeFile(
			join(root, ".workflows", "scripts", "child.js"),
			'return { reply: await agent("Script: " + args.word) }',
		);

		const first = await stopped(["parent.js"], { nth: 2 });
		expect(first.code).toBe(130);
		expect(first.stderr).toEqual([detached(first.id)]);
		const children = await readdir(runs());
		const resumed = await workflows(["resume", first.id ?? ""], { cwd: root });
		expect([resumed.code, resumed.stdout]).toEqual([0, [`run ${first.id}`, "Reply to one, Reply to two"]]);
		expect(resumed.model.calls.map((call) => call.prompt)).toEqual(["Script: two"]);
		expect(await readdir(runs())).toEqual(children);
		const listed = await workflows(["list"], { cwd: root });
		expect(listed.stdout).toHaveLength(1);
	});

	it("fails the caller with a failed child run, and its resume continues the child run", async () => {
		await writeFile(join(root, "parent.js"), 'return await run("child")');
		await mkdir(join(root, ".workflows", "scripts"), { recursive: true });
		await writeFile(join(root, ".workflows", "scripts", "child.js"), 'return await agent("Script: one")');

		const run = await workflows(["parent.js"], { cwd: root, script: { failAt: { kind: "script", nth: 1 } } });
		expect(run.code).toBe(1);
		const [line = "", next] = run.stderr;
		const child = /^failed parent: child run (\S+) failed: /.exec(line)?.[1];
		expect(child).toBeDefined();
		expect(next).toBe(`continue with: workflows resume ${run.id}`);
		const own = await workflows(["resume", child ?? ""], { cwd: root });
		expect([own.code, own.stderr[0]]).toEqual([1, `workflows: no run ${child} in ${runs()}`]);
		const directories = await readdir(runs());
		expect(directories).toEqual([run.id, child].toSorted());
		const resumed = await workflows(["resume", run.id ?? ""], { cwd: root });
		expect([resumed.code, resumed.stdout]).toEqual([0, [`run ${run.id}`, "Reply to one"]]);
		expect(resumed.model.calls.map((call) => call.prompt)).toEqual(["Script: one"]);
		expect(await readdir(runs())).toEqual(directories);
		// The failed child task stays, and a new child task continues its run ID.
		expect(await childTasks(run.id ?? "")).toEqual([
			{ runId: child, status: "terminal", outcome: "failed" },
			{ runId: child, status: "terminal", outcome: "completed" },
		]);
	});

	it("keeps one session and one child run when a run stops after it opens them", async () => {
		await writeFile(join(root, "parent.js"), 'session()\nreturn await run("child")');
		await mkdir(join(root, ".workflows", "scripts"), { recursive: true });
		await writeFile(join(root, ".workflows", "scripts", "child.js"), 'await sh("./gate.sh c")\nreturn "done"');

		const first = await stopped(["parent.js"], { gate: "c" });
		expect(first.code).toBe(130);
		const resumed = await workflows(["resume", first.id ?? ""], { cwd: root });
		expect([resumed.code, resumed.stdout.at(-1)]).toEqual([0, "done"]);
		const id = first.id ?? "";
		const storage = await openNodeSqliteStorage(storeOf());

		try {
			const { items } = await storage.scanConversations({}, 256, undefined, BACKGROUND_CONTEXT);
			expect(items.filter((conversation) => conversation.owner !== undefined)).toHaveLength(1);
		} finally {
			await storage.close(BACKGROUND_CONTEXT);
		}

		expect(await childTasks(id)).toHaveLength(1);
		expect((await readdir(runs())).filter((run) => run !== id)).toHaveLength(1);
	});

	it("ends a caller that catches the failure of a child run", async () => {
		await writeFile(join(root, "parent.js"), 'try { await run("child") } catch (error) { return "caught" }');
		await mkdir(join(root, ".workflows", "scripts"), { recursive: true });
		await writeFile(join(root, ".workflows", "scripts", "child.js"), 'throw new Error("no")');

		const run = await workflows(["parent.js"], { cwd: root });
		expect([run.code, run.stdout, run.stderr]).toEqual([0, [`run ${run.id}`, "caught"], []]);
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

		await writeFile(join(root, "x.js"), 'await tools.read({ path: "x" })');
		const tools = await workflows(["x.js"], { cwd: root });
		expect([tools.code, tools.stderr[0]]).toEqual([1, expect.stringContaining("failed x: tools.read does not exist")]);

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

	it("fails a call with bad arguments at the deepest wrong value", async () => {
		for (const [code, error] of [
			['sh(["git", 1])', "sh got bad arguments: /0/1 must be string"],
			["ok(1)", "ok got bad arguments: /0 must be string"],
			["input(1)", "input got bad arguments: /0 must be string"],
		]) {
			await writeFile(join(root, "bad.js"), `await ${code}`);
			const run = await workflows(["bad.js"], { cwd: root });
			expect([run.code, run.stderr[0]], code).toEqual([1, `failed bad: ${error}`]);
		}
	});

	it("finds a project script before a package script of the same name", async () => {
		const repo = join(root, "repo");
		await repository(repo);
		const scripts = join(repo, ".workflows", "scripts");
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
			`// Not the description.\nexport const meta = { description: "Count words.", args: { path: { type: "string", positional: true, required: true }, depth: { type: "number", default: 2 }, all: { type: "boolean" } } }\nreturn args`,
		);
		const scripts = join(root, ".workflows", "scripts");
		await mkdir(scripts, { recursive: true });
		await writeFile(join(scripts, "plain.js"), "// Not the description.\nreturn 1");
		const listed = await workflows([], { cwd: root });
		expect(listed.code).toBe(0);
		expect(listed.stdout).toEqual([
			"campaign: Split a goal into work items and ship each one as a commit on one branch.",
			"implement: Implement a plan in the current directory, and commit the change.",
			"judge: Judge a change (the current branch, a PR, a ref or a range) against its intent with the fixed rubric.",
			"optimize: Search for better ship prompts over a folder of work items.",
			"rpi: Research, plan and implement one work item, and commit it on a new branch.",
			"ship: Ship one work item onto a new branch: research, plan, implement, review rounds, judge, and one squashed commit.",
			"thermoloop: Review a change (the current branch, a PR, a ref or a range), and fix it in rounds until the reviewer answers SHIP.",
			"plain",
		]);
		const plain = await workflows(["plain", "--help"], { cwd: root });
		expect(plain.stdout).toEqual(["usage: workflows plain [--prompts <folder>] [--background] [--json]"]);

		const ship = await workflows(["ship", "--help"], { cwd: root });
		expect([ship.code, ship.stdout[0]]).toEqual([
			0,
			"usage: workflows ship [--rounds <n>] [--repo <repository>] [--base <branch>] [--branch <name>] [--prompts <folder>] [<item.md> | <text>] [--background] [--json]",
		]);
		const own = await workflows(["count.js", "--help"], { cwd: root });
		expect(own.stdout).toEqual([
			"usage: workflows count [--depth <n>] [--all] [--prompts <folder>] <path> [--background] [--json]",
			"Count words.",
		]);

		const run = await workflows(["count.js", "--all", "--", "-p"], { cwd: root });
		expect([run.code, run.stdout.at(-1)]).toEqual([0, '{"path":"-p","depth":2,"all":true}']);
		const flag = await workflows(["count.js", "--path", "src"], { cwd: root });
		expect(flag.stdout.at(-1)).toBe('{"path":"src","depth":2,"all":false}');
	});

	it("leaves out an optional text argument without a value and without stdin or with a blank stdin", async () => {
		await writeFile(
			join(root, "note.js"),
			`export const meta = { args: { note: { type: "text" } } }\nreturn "note" in args`,
		);
		const run = await workflows(["note.js"], { cwd: root });
		expect([run.code, run.stderr, run.stdout.at(-1)]).toEqual([0, [], "false"]);
		const blank = await workflows(["note.js"], { cwd: root, stdin: " \n" });
		expect([blank.code, blank.stderr, blank.stdout.at(-1)]).toEqual([0, [], "false"]);

		await writeFile(
			join(root, "need.js"),
			`export const meta = { args: { note: { type: "text", required: true } } }\nreturn args.note`,
		);
		const required = await workflows(["need.js"], { cwd: root, stdin: "" });
		expect([required.code, required.stderr]).toEqual([1, ["workflows: the note is empty"]]);
	});

	it("rejects bad arguments with the usage of the workflow", async () => {
		await writeFile(
			join(root, "x.js"),
			`export const meta = { args: { path: { type: "string", positional: true, required: true }, depth: { type: "number" } } }\nreturn args`,
		);
		const usage = "usage: workflows x [--depth <n>] [--prompts <folder>] <path> [--background] [--json]";

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
		await writeFile(join(root, "described.js"), `export const meta = { description: 1 }\nreturn 1`);
		const described = await workflows(["described.js"], { cwd: root });
		expect([described.code, described.stderr[0]]).toEqual([
			1,
			"workflows: described: meta.description is not a string",
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

describe("branchOf", () => {
	it("names a branch from the type and the words of a commit subject", () => {
		expect(branchOf("feat(pi)!: Show the Runs, in Pi")).toBe("feat/show-the-runs-in-pi");
		expect(branchOf("Fix the README typo")).toBe("fix-the-readme-typo");
		expect(branchOf(`fix: ${"word ".repeat(20)}`)).toBe(`fix/${Array(9).fill("word").join("-")}`);
		expect(branchOf("docs: ...")).toBe("");
	});
});
