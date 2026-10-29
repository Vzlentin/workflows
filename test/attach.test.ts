import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Choose } from "../src/main.ts";
import { conversationOf, repository, runsOf, sandbox, workflows, worktreeAt } from "./support.ts";

let root: string;

/** Writes the executable `bin/<name>` of the sandbox. */
async function fake(name: string, body: string): Promise<void> {
	const file = join(root, "bin", name);
	await writeFile(file, `#!/bin/sh\n${body}`);
	await chmod(file, 0o755);
}

/** The arguments that the fake `pi` got, or undefined when it did not run. */
const piLog = async () =>
	existsSync(join(root, "pi.log")) ? (await readFile(join(root, "pi.log"), "utf8")).trim() : undefined;

/** A finished run of `script`, with its ID. */
async function ran(script: string): Promise<string> {
	await writeFile(join(root, "x.js"), script);
	const run = await workflows(["x.js"], { cwd: root });
	expect(run.code).toBe(0);

	return run.id ?? "";
}

beforeEach(async () => {
	root = await sandbox();
	await fake("pi", `echo "$@" > "${root}/pi.log"\nexit 7\n`);
});

afterEach(() => rm(root, { recursive: true, force: true }));

describe("attach", () => {
	it("opens the last session of a run, or the session of a conversation, in Pi", async () => {
		const id = await ran('phase("a")\nawait agent("Script: one")\nphase("b")\nawait agent("Script: two")');
		const one = await conversationOf(/Script: one/);
		const two = await conversationOf(/Script: two/);
		const last = await workflows(["attach", id], { cwd: root });
		expect([last.code, await piLog()]).toEqual([7, `--harness main --harness-conversation ${two}`]);
		const chosen = await workflows(["attach", id, "--conversation", String(one)], { cwd: root });
		expect([chosen.code, await piLog()]).toEqual([7, `--harness main --harness-conversation ${one}`]);
	});

	it("opens the session that works now, also when a later session started", async () => {
		await writeFile(
			join(root, "x.js"),
			'const s = session()\nawait s.ask("Script: one")\nconst t = session()\nawait t.ask("Script: two")\nawait s.ask("Script: three")',
		);
		const run = await workflows(["x.js"], { cwd: root, script: { interruptAt: { kind: "script", nth: 3 } } });
		expect(run.code).toBe(130);
		const s = await conversationOf(/Script: one/);
		expect(s).not.toBe(await conversationOf(/Script: two/));
		const attached = await workflows(["attach", run.id ?? ""], { cwd: root });
		expect([attached.code, await piLog()]).toEqual([7, `--harness main --harness-conversation ${s}`]);
	});

	it("fails for a run with no session, a second argument, an unknown conversation, an unknown run and no run ID", async () => {
		const bare = await ran('return "done"');
		const id = await ran('phase("a")\nawait agent("Script: one")');
		const runs = runsOf(root);
		const usage = "workflows attach <run-id> [--conversation <id>] [--side]";
		const cases = [];

		const argvs = [
			["attach", bare],
			["attach", id, "a"],
			["attach", id, "--conversation", "999999"],
			["attach", "nothing"],
			["attach"],
			["attach", id, "--conversation", "x"],
		];

		for (const argv of argvs) {
			const { code, stderr } = await workflows(argv, { cwd: root });
			cases.push([code, stderr]);
		}

		expect(cases).toEqual([
			[1, [`workflows: run ${bare} has no session`]],
			[2, ["workflows: give one run ID", `usage: ${usage}`]],
			[1, [`workflows: run ${id} has no session with conversation 999999`]],
			[1, [`workflows: no run nothing in ${runs}`]],
			[2, ["workflows: give one run ID", `usage: ${usage}`]],
			[2, ["workflows: x is not a conversation ID", `usage: ${usage}`]],
		]);
		expect(await piLog()).toBeUndefined();
	});
});

describe("list --pick", () => {
	it("prints the run ID that the pick takes, the runs that run first, each with its steps that run", async () => {
		await ran('phase("a")\nawait agent("Script: done")');
		await writeFile(join(root, "y.js"), 'phase("talk")\nawait agent("Script: one")\nawait agent("Script: two")');
		const running = await workflows(["y.js"], { cwd: root, script: { interruptAt: { kind: "script", nth: 2 } } });
		const asked: string[][] = [];

		const choose: Choose = async (question, items) => {
			asked.push([question, ...items.map((item) => item.text)]);

			return items[0]?.value;
		};

		const picked = await workflows(["list", "--pick"], { cwd: root, choose });
		expect(asked).toEqual([["Pick a run:", "◉ y  y running: talk", "· x  x done"]]);
		expect([picked.code, picked.stdout]).toEqual([0, [running.id]]);
		const cancelled = await workflows(["list", "--pick"], { cwd: root, choose: async () => undefined });
		expect([cancelled.code, cancelled.stdout, cancelled.stderr]).toEqual([130, [], []]);
		expect((await workflows(["list", "--pick"], { cwd: root })).code).toBe(2);
	});

	it("reads the runs again while the pick waits, with the run ID of each run as its value", async () => {
		await writeFile(join(root, "y.js"), 'phase("talk")\nawait agent("Script: one")\nawait agent("Script: two")');
		const running = await workflows(["y.js"], { cwd: root, script: { interruptAt: { kind: "script", nth: 2 } } });
		const id = running.id ?? "";
		const seen: string[][] = [];

		const choose: Choose = async (_question, items, refresh) => {
			seen.push(items.map((item) => item.text));
			expect((await workflows(["resume", id], { cwd: root })).code).toBe(0);
			const after = (await refresh?.()) ?? [];
			seen.push(after.map((item) => item.text));

			return after[0]?.value;
		};

		const picked = await workflows(["list", "--pick"], { cwd: root, choose });
		expect(seen).toEqual([["◉ y  y running: talk"], ["· y  y done"]]);
		expect([picked.code, picked.stdout]).toEqual([0, [id]]);
	});
});

describe("wait", () => {
	it("shows every step of the run from its first line, also the steps before it joined", async () => {
		const script = 'phase("talk")\nawait agent("Script: one")\nphase("more")\nawait agent("Script: two")';
		await writeFile(join(root, "y.js"), script);
		const running = await workflows(["y.js"], { cwd: root, script: { interruptAt: { kind: "script", nth: 2 } } });
		const waited = await workflows(["wait", running.id ?? ""], { cwd: root });
		expect([waited.code, waited.stderr]).toEqual([0, ["talk", "more"]]);
	});
});

describe("attach in herdr", () => {
	let repo: string;
	let id: string;
	let worktree: string;

	/** A fake herdr that logs its arguments and lists `worktrees`. */
	const herdr = (worktrees: object[]) =>
		fake(
			"herdr",
			`echo "$@" >> "${root}/herdr.log"
case "$1 $2" in
"worktree list") echo '${JSON.stringify({ result: { worktrees } })}' ;;
"tab create") echo '{"result":{"root_pane":{"pane_id":"p9"}}}' ;;
"pane split") echo '{"result":{"pane":{"pane_id":"p9"}}}' ;;
"pane get") echo '{"result":{"pane":{"pane_id":"p1","workspace_id":"w5"}}}' ;;
esac
`,
		);

	const logged = async () => (await readFile(join(root, "herdr.log"), "utf8")).trim().split("\n");

	beforeEach(async () => {
		repo = join(root, "repo");
		await repository(repo);
		const scripts = join(repo, ".workflows", "scripts");
		await mkdir(scripts, { recursive: true });
		await writeFile(join(scripts, "w.js"), 'export const meta = { worktree: true }\nawait agent("Script: one")');
		const run = await workflows(["w"], { cwd: repo });
		expect(run.code).toBe(0);
		id = run.id ?? "";
		worktree = worktreeAt(repo, id);
		process.env.HERDR_ENV = "1";
	});

	it("opens the session in a new tab of the workspace that has the worktree open", async () => {
		await herdr([{ path: await realpath(worktree), open_workspace_id: "w1" }]);
		const conversation = await conversationOf(/Script: one/);
		const attached = await workflows(["attach", id], { cwd: repo });
		expect(attached.code).toBe(0);
		const lines = await logged();
		expect(lines).toContainEqual(expect.stringMatching(/^tab create --workspace w1 /));
		expect(lines).toContainEqual(
			expect.stringMatching(new RegExp(`^pane run p9 .*'attach' '--conversation' '${conversation}'$`)),
		);
		expect(await piLog()).toBeUndefined();
	});

	it("opens the session in a new pane to the right of this pane with --side", async () => {
		await herdr([{ path: await realpath(worktree), open_workspace_id: "w1" }]);
		process.env.HERDR_PANE_ID = "p1";
		const attached = await workflows(["attach", id, "--side"], { cwd: repo });
		expect(attached.code).toBe(0);
		const lines = await logged();
		expect(lines).toContainEqual(expect.stringMatching(/^pane split p1 --direction right /));
		expect(lines).not.toContainEqual(expect.stringMatching(/^tab create /));
		expect(await piLog()).toBeUndefined();
	});

	it("opens the session in a new tab of the workspace of this pane without a worktree workspace", async () => {
		await herdr([]);
		process.env.HERDR_PANE_ID = "p1";
		const attached = await workflows(["attach", id], { cwd: repo });
		expect(attached.code).toBe(0);
		const lines = await logged();
		const get = lines.findIndex((line) => line === "pane get p1");
		const tab = lines.findIndex((line) => line.startsWith("tab create --workspace w5 "));
		expect([get >= 0, tab > get]).toEqual([true, true]);
		expect(lines).not.toContainEqual(expect.stringMatching(/^pane split /));
		expect(await piLog()).toBeUndefined();
	});

	it("opens a tab with --side outside a Herdr pane", async () => {
		await herdr([{ path: await realpath(worktree), open_workspace_id: "w1" }]);
		const attached = await workflows(["attach", id, "--side"], { cwd: repo });
		expect(attached.code).toBe(0);
		expect(await logged()).toContainEqual(expect.stringMatching(/^tab create --workspace w1 /));
		expect(await piLog()).toBeUndefined();
	});

	it("fails when herdr fails", async () => {
		await fake("herdr", "echo broken >&2\nexit 1\n");
		const attached = await workflows(["attach", id], { cwd: repo });
		expect([attached.code, attached.stderr]).toEqual([1, [expect.stringMatching(/^workflows: .*broken/)]]);
		expect(await piLog()).toBeUndefined();
	});
});
