import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { TASK } from "../src/run/version.ts";
import {
	OtherVersion,
	projectRuns,
	readRun,
	runCli,
	savedRun,
	scriptsOf,
	showEntries,
	shownLines,
} from "../src/runs.ts";
import { sandbox, saveAs, saveRun, untimed, workflows } from "./support.ts";

let root: string;

beforeEach(async () => {
	root = await sandbox();
	await writeFile(
		join(root, "t.js"),
		'export const meta = { args: { item: { type: "text", positional: true } } }\nphase("a")\nreturn await agent("Script: one")',
	);
	await writeFile(join(root, "f.js"), 'phase("a")\nthrow new Error("boom")');
});

afterEach(() => rm(root, { recursive: true, force: true }));

const USAGE = "workflows show <run-id>";

describe("runs that another version saved", () => {
	// Some earlier versions wrapped the input as `{ input }`.
	it.each([
		["its input", false],
		["its input wrapped", true],
	])("lists and shows an ended run with %s, its title, steps and report, and refuses to resume it", async (_, wrap) => {
		const ran = await workflows(["t.js", "Fix the parser"], { cwd: root });
		expect(ran.code).toBe(0);
		const id = ran.id ?? "";
		saveAs(TASK.version - 1, wrap);

		const listed = await workflows(["list"], { cwd: root });
		expect(listed.stdout).toEqual([`${id} t done Fix the parser`]);
		const shown = await workflows(["show", id], { cwd: root });
		expect([shown.code, shown.stdout.map(untimed)]).toEqual([
			0,
			[`run ${id} t done Fix the parser`, "✓ a", "Reply to one"],
		]);
		const resumed = await workflows(["resume", id], { cwd: root });
		expect([resumed.code, resumed.stderr]).toEqual([
			1,
			[`workflows: run ${id} was saved by an earlier version of t and cannot resume`],
		]);
	});

	it("tells to resume a failed run only when this version saved it", async () => {
		const ran = await workflows(["f.js"], { cwd: root });
		expect(ran.code).toBe(1);
		const id = ran.id ?? "";
		const hint = `continue with: workflows resume ${id}`;

		const current = await workflows(["show", id], { cwd: root });
		expect([current.code, current.stdout.slice(-2)]).toEqual([0, ["failed f: boom", hint]]);

		saveAs(TASK.version - 1, false);
		const shown = await workflows(["show", id], { cwd: root });
		expect([shown.code, shown.stdout[0], shown.stdout.at(-1)]).toEqual([0, `run ${id} f failed f`, "failed f: boom"]);
		expect(shown.stdout).not.toContain(hint);
		const resumed = await workflows(["resume", id], { cwd: root });
		expect([resumed.code, resumed.stderr]).toEqual([
			1,
			[`workflows: run ${id} was saved by an earlier version of f and cannot resume`],
		]);
	});

	it("refuses to show a run whose task has not ended", async () => {
		for (const [version, word] of [
			[TASK.version - 1, "an earlier"],
			[TASK.version + 1, "a later"],
		] as const) {
			// The input has the fields of a title and a report, so only the task that has not ended refuses the run.
			const input = { name: "t", args: {}, meta: { args: {}, exit: {} } };
			const id = await saveRun(root, "workflows.run", version, input);

			const read = readRun(await savedRun(id, USAGE), true, "be shown");
			await expect(read).rejects.toBeInstanceOf(OtherVersion);
			const shown = await workflows(["show", id], { cwd: root });
			expect([shown.code, shown.stderr]).toEqual([
				1,
				[`workflows: run ${id} was saved by ${word} version of t and cannot be shown`],
			]);
		}
	});
});

describe("@vzlentin/workflows/runs", () => {
	it("lists the runs and the workflows of a project, reads a run, and runs the command", async () => {
		await mkdir(join(root, ".workflows", "scripts"), { recursive: true });
		await writeFile(
			join(root, ".workflows", "scripts", "mine.js"),
			'export const meta = { description: "My workflow" }\nreturn "mine"',
		);
		const ran = await workflows(["t.js", "Fix the parser"], { cwd: root });
		const id = ran.id ?? "";

		expect(await projectRuns("main")).toEqual([
			{ runId: id, workflow: "t", title: "Fix the parser", status: "done", repository: null, run: "done" },
		]);

		const read = await readRun(await savedRun(id, USAGE), true, "be shown");
		expect([read.run, read.ended, read.resumable, read.footer]).toEqual(["done", true, false, ["Reply to one"]]);
		const now = Date.now();
		expect(shownLines(read, now).map(({ text }) => untimed(text))).toEqual([
			`run ${id} t done Fix the parser`,
			"✓ a",
			"Reply to one",
		]);

		// The step line maps to the conversation of the session of its step.
		const steps = showEntries(read.calls, read.progress, now).map(({ text, conversation }) => ({
			text: untimed(text),
			conversation,
		}));

		expect(steps).toEqual([{ text: "✓ a", conversation: expect.any(Number) }]);

		const scripts = await scriptsOf(root);
		expect(scripts).toContainEqual({ name: "mine", description: "My workflow" });
		expect(scripts.map(({ name }) => name)).toContain("ship");

		const options = { env: process.env, stdin: undefined, signal: undefined, stdout: () => {}, stderr: () => {} };
		const listed = await runCli(["list"], root, options);
		expect(listed).toEqual({ code: 0, stdout: [`${id} t done Fix the parser`], stderr: [] });
	});
});
