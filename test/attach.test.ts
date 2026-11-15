import { existsSync } from "node:fs";
import { chmod, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import type { Choose } from "../src/cli/main.ts";
import { conversationOf, runsOf, sandbox, workflows } from "./support.ts";

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

describe("show --pick", () => {
	/** The value of the first item that has one. */
	const first = <T>(items: readonly { readonly value?: T | undefined }[]) => items.find((item) => item.value)?.value;

	it("asks for a run, the runs that run first, each with its steps that run, then for an agent of it", async () => {
		await ran('phase("a")\nawait agent("Script: done")');
		await writeFile(join(root, "y.js"), 'phase("talk")\nawait agent("Script: one")\nawait agent("Script: two")');
		await workflows(["y.js"], { cwd: root, script: { interruptAt: { kind: "script", nth: 2 } } });
		const one = await conversationOf(/Script: one/);
		const asked: string[][] = [];

		const choose: Choose = async (question, items) => {
			asked.push([question, ...items.map((item) => item.text)]);

			return first(items);
		};

		const picked = await workflows(["show", "--pick"], { cwd: root, choose });
		expect(asked[0]).toEqual(["Pick a run:", "◉ y  y running: talk", "· x  x done, exit 0"]);
		expect(asked.map(([question]) => question)).toEqual(["Pick a run:", "Pick an agent:"]);
		expect([picked.code, picked.stdout]).toEqual([0, [String(one)]]);
		const cancelled = await workflows(["show", "--pick"], { cwd: root, choose: async () => undefined });
		expect([cancelled.code, cancelled.stdout, cancelled.stderr]).toEqual([130, [], []]);
		expect((await workflows(["show", "--pick"], { cwd: root })).code).toBe(2);
	});

	it("fails with no runs", async () => {
		const picked = await workflows(["show", "--pick"], { cwd: root, choose: async () => undefined });
		expect([picked.code, picked.stderr]).toEqual([1, [`workflows: no runs in the project of ${root}`]]);
	});

	it("reads the runs again while the pick waits, with the run ID of each run as its value", async () => {
		await writeFile(join(root, "y.js"), 'phase("talk")\nawait agent("Script: one")\nawait agent("Script: two")');
		const running = await workflows(["y.js"], { cwd: root, script: { interruptAt: { kind: "script", nth: 2 } } });
		const id = running.id ?? "";
		const one = await conversationOf(/Script: one/);
		const seen: string[][] = [];

		const choose: Choose = async (question, items, refresh) => {
			if (question !== "Pick a run:") return first(items);
			seen.push(items.map((item) => item.text));
			expect((await workflows(["resume", id], { cwd: root })).code).toBe(0);
			const after = (await refresh?.()) ?? [];
			seen.push(after.map((item) => item.text));

			return after[0]?.value;
		};

		const picked = await workflows(["show", "--pick"], { cwd: root, choose });
		expect(seen).toEqual([["◉ y  y running: talk"], ["· y  y done, exit 0"]]);
		expect([picked.code, picked.stdout]).toEqual([0, [String(one)]]);
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
	let id: string;
	let conversation: number | undefined;

	/** A fake hc that logs its arguments, and gives the terminal t3 the space s1 and the tab tb1. */
	const hc = () =>
		fake(
			"hc",
			`echo "$@" >> "${root}/hc.log"
[ "$1 $2" = "get --json" ] && echo '{"labels":{"herdr.space":"s1","herdr.tab":"tb1"}}'
exit 0
`,
		);

	const logged = async () =>
		existsSync(join(root, "hc.log")) ? (await readFile(join(root, "hc.log"), "utf8")).trim().split("\n") : undefined;

	beforeEach(async () => {
		id = await ran('phase("a")\nawait agent("Script: one")');
		conversation = await conversationOf(/Script: one/);
		// Only now: the host shares this environment, so the setup run sees no hc terminal.
		process.env.HC_TERMINAL_ID = "t3";
		await hc();
	});

	it("runs Pi in this terminal without --side", async () => {
		const attached = await workflows(["attach", id], { cwd: root });
		expect([attached.code, await piLog()]).toEqual([7, `--harness main --harness-conversation ${conversation}`]);
		expect(await logged()).toBeUndefined();
	});

	it("opens the session in a new pane to the right of this terminal with --side", async () => {
		const attached = await workflows(["attach", id, "--side"], { cwd: root });
		expect(attached.code).toBe(0);

		expect(await logged()).toEqual([
			"get --json t3",
			expect.stringMatching(
				new RegExp(
					`^run .* --label herdr\\.space=s1 --label herdr\\.tab=tb1 -- .* attach --conversation ${conversation}$`,
				),
			),
		]);

		expect(await piLog()).toBeUndefined();
	});

	it("fails when hc fails with --side", async () => {
		await fake("hc", "echo broken >&2\nexit 1\n");
		const attached = await workflows(["attach", id, "--side"], { cwd: root });
		expect(attached.code).toBe(1);
		expect(await piLog()).toBeUndefined();
	});
});
