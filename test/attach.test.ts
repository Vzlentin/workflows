import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import type { Choose } from "../src/cli/main.ts";
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
			[4, [`workflows: no run nothing in ${runs}`]],
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

describe("attach in hc", () => {
	let repo: string;
	let id: string;
	let worktree: string;

	/** A fake hc that logs its arguments, and gives the terminal t3 the space s1 and the tab tb1. */
	const hc = () =>
		fake(
			"hc",
			`echo "$@" >> "${root}/hc.log"
[ "$1 $2" = "get --json" ] && echo '{"labels":{"herdr.space":"s1","herdr.tab":"tb1"}}'
exit 0
`,
		);

	const logged = async () => (await readFile(join(root, "hc.log"), "utf8")).trim().split("\n");

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
		// Only now: the host shares this environment, so the setup run sees no hc terminal.
		process.env.HC_TERMINAL_ID = "t3";
		await hc();
	});

	it("opens the session in a new tab of the space of the run when its worktree exists", async () => {
		const conversation = await conversationOf(/Script: one/);
		const attached = await workflows(["attach", id], { cwd: repo });
		expect(attached.code).toBe(0);
		const lines = await logged();
		expect(lines).toEqual([
			expect.stringMatching(
				new RegExp(
					`^run --bg --keep --no-parent .* --label herdr\\.space=${id} -- .* attach --conversation ${conversation}$`,
				),
			),
		]);
		expect(await piLog()).toBeUndefined();
	});

	it("opens the session in a new pane to the right of this terminal with --side", async () => {
		const attached = await workflows(["attach", id, "--side"], { cwd: repo });
		expect(attached.code).toBe(0);
		const lines = await logged();
		expect(lines[0]).toBe("get --json t3");
		expect(lines[1]).toMatch(/^run .* --label herdr\.space=s1 --label herdr\.tab=tb1 -- /);
		expect(await piLog()).toBeUndefined();
	});

	it("opens the session in a new tab of the space of this terminal when the worktree is gone", async () => {
		await rm(worktree, { recursive: true, force: true });
		const attached = await workflows(["attach", id], { cwd: repo });
		expect(attached.code).toBe(0);
		const lines = await logged();
		expect(lines[0]).toBe("get --json t3");
		expect(lines[1]).toMatch(/^run .* --label herdr\.space=s1 -- /);
		expect(lines[1]).not.toContain("herdr.tab");
		expect(await piLog()).toBeUndefined();
	});

	it("fails when hc fails", async () => {
		await fake("hc", "echo broken >&2\nexit 1\n");
		const attached = await workflows(["attach", id], { cwd: repo });
		expect([attached.code, attached.stderr]).toEqual([1, [expect.stringMatching(/^workflows: .*broken/)]]);
		expect(await piLog()).toBeUndefined();
	});
});
