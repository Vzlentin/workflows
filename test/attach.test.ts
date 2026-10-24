import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { conversationOf, repository, runsOf, sandbox, workflows } from "./support.ts";

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
	it("opens the last session of a run, or the last session of a step, in Pi", async () => {
		const id = await ran('phase("a")\nawait agent("Script: one")\nphase("b")\nawait agent("Script: two")');
		const one = await conversationOf(/Script: one/);
		const two = await conversationOf(/Script: two/);
		const last = await workflows(["attach", id], { cwd: root });
		expect([last.code, await piLog()]).toEqual([7, `--harness main --harness-conversation ${two}`]);
		const first = await workflows(["attach", id, "a"], { cwd: root });
		expect([first.code, await piLog()]).toEqual([7, `--harness main --harness-conversation ${one}`]);
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

	it("fails for a run with no session, an unknown step, an unknown run and no run ID", async () => {
		const bare = await ran('return "done"');
		const id = await ran('phase("a")\nawait agent("Script: one")');
		const runs = runsOf(root);
		const cases = [];

		for (const argv of [["attach", bare], ["attach", id, "b c"], ["attach", "nothing"], ["attach"]]) {
			const { code, stderr } = await workflows(argv, { cwd: root });
			cases.push([code, stderr]);
		}

		expect(cases).toEqual([
			[1, [`workflows: run ${bare} has no session`]],
			[1, [`workflows: run ${id} has no session in b c`]],
			[1, [`workflows: no run nothing in ${runs}`]],
			[2, ["workflows: give one run ID", "usage: workflows attach <run-id> [<step>]"]],
		]);
		expect(await piLog()).toBeUndefined();
	});
});

describe("list --pick and show --follow", () => {
	it("prints the run ID that the pick takes, the runs that run first, each with its steps that run", async () => {
		await ran('phase("a")\nawait agent("Script: done")');
		await writeFile(join(root, "y.js"), 'phase("talk")\nawait agent("Script: one")\nawait agent("Script: two")');
		const running = await workflows(["y.js"], { cwd: root, script: { interruptAt: { kind: "script", nth: 2 } } });
		expect(running.code).toBe(130);
		const asked: string[][] = [];

		const picked = await workflows(["list", "--pick"], {
			cwd: root,
			choose: async (question, items) => {
				asked.push([question, ...items]);

				return 0;
			},
		});

		expect(asked).toEqual([
			[
				"Pick a run:",
				expect.stringMatching(/^◉ y {2}y running: talk {2}\d+s ago$/),
				expect.stringMatching(/^· x {2}x done {2}\d+s ago$/),
			],
		]);
		expect([picked.code, picked.stdout]).toEqual([0, [running.id]]);
		const json = await workflows(["list", "--pick", "--json"], { cwd: root, choose: async () => 0 });
		expect(JSON.parse(json.stdout[0] ?? "")).toMatchObject({ runId: running.id, status: "running", title: "y" });
	});

	it("exits 130 with no output when the pick is cancelled, and needs a terminal", async () => {
		await ran('phase("a")\nawait agent("Script: one")');
		const cancelled = await workflows(["list", "--pick"], { cwd: root, choose: async () => undefined });
		expect([cancelled.code, cancelled.stdout, cancelled.stderr]).toEqual([130, [], []]);
		const piped = await workflows(["list", "--pick"], { cwd: root });
		expect([piped.code, piped.stderr]).toEqual([
			2,
			["workflows: --pick needs a terminal on stdin and stderr", "usage: workflows list [--pick] [--json]"],
		]);
	});

	it("draws the steps of a run in place until Ctrl+C, and prints a run that ended as show does", async () => {
		await writeFile(join(root, "y.js"), 'phase("talk")\nawait agent("Script: one")\nawait agent("Script: two")');
		const running = await workflows(["y.js"], { cwd: root, script: { interruptAt: { kind: "script", nth: 2 } } });
		const id = running.id ?? "";
		const drawn: string[][] = [];
		const interrupt = new AbortController();

		const following = workflows(["show", id, "--follow"], {
			cwd: root,
			interrupt,
			redraw: (lines) => {
				drawn.push([...lines]);

				if (drawn.length === 2) interrupt.abort();
			},
		});

		const followed = await following;
		expect([followed.code, followed.stdout]).toEqual([130, [`run ${id} y running y`]]);
		expect(drawn[1]).toEqual([expect.stringMatching(/^◉ talk {2}\d+s$/)]);

		const done = await ran('phase("a")\nawait agent("Script: one")');
		const shown = await workflows(["show", done], { cwd: root });
		const plain = await workflows(["show", done, "--follow"], { cwd: root });
		expect(plain.stdout).toEqual(shown.stdout);
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
esac
`,
		);

	const logged = async () => (await readFile(join(root, "herdr.log"), "utf8")).trim().split("\n");

	beforeEach(async () => {
		repo = join(root, "repo");
		await repository(repo);
		const scripts = join(repo, ".workflows", "workflows");
		await mkdir(scripts, { recursive: true });
		await writeFile(join(scripts, "w.js"), 'export const meta = { worktree: true }\nawait agent("Script: one")');
		const run = await workflows(["w"], { cwd: repo });
		expect(run.code).toBe(0);
		id = run.id ?? "";
		worktree = join(runsOf(root), id, "worktree");
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

	it("opens the session in a new pane to the right of this pane without a workspace", async () => {
		await herdr([]);
		process.env.HERDR_PANE_ID = "p1";
		const attached = await workflows(["attach", id], { cwd: repo });
		expect(attached.code).toBe(0);
		expect(await logged()).toContainEqual(expect.stringMatching(/^pane split p1 --direction right /));
		expect(await piLog()).toBeUndefined();
	});

	it("fails when herdr fails", async () => {
		await fake("herdr", "echo broken >&2\nexit 1\n");
		const attached = await workflows(["attach", id], { cwd: repo });
		expect([attached.code, attached.stderr]).toEqual([1, [expect.stringMatching(/^workflows: .*broken/)]]);
		expect(await piLog()).toBeUndefined();
	});
});
