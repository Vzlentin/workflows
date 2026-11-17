import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { TASK } from "../src/run/version.ts";
import { logLine, sandbox, saveAs, saveRun, workflows } from "./support.ts";

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

const footer = `version ${TASK.version - 1} of workflows.run saved this run, and this is version ${TASK.version}: it cannot resume`;

describe("runs that another version saved", () => {
	it("lists and shows an ended run as earlier-version from its task record, and refuses to follow it", async () => {
		const ran = await workflows(["t.js", "Fix the parser"], { cwd: root });
		expect(ran.code).toBe(0);
		const id = ran.id ?? "";
		saveAs(TASK.version - 1);

		const listed = await workflows(["list"], { cwd: root });
		expect(listed.stdout).toEqual([`${id} t earlier-version t`]);
		const listedJson = await workflows(["list", "--json"], { cwd: root });
		const [row] = JSON.parse(listedJson.stdout[0] ?? "");
		expect(row).toMatchObject({ runId: id, workflow: "t", title: "t", state: "earlier-version" });
		expect(row).toMatchObject({ repository: null, steps: [] });
		expect(row.result).toBeUndefined();

		const shown = await workflows(["show", id], { cwd: root });
		expect([shown.code, shown.stdout]).toEqual([0, [`run ${id} t earlier-version t`, footer]]);
		const json = await workflows(["show", id, "--json"], { cwd: root });
		const run = JSON.parse(json.stdout[0] ?? "");
		expect(run).toMatchObject({ state: "earlier-version", todos: [], steps: [], calls: [] });
		expect([run.result, run.report, run.error]).toEqual([undefined, undefined, undefined]);
		const agents = await workflows(["show", id, "--agents", "--json"], { cwd: root });
		expect(JSON.parse(agents.stdout[0] ?? "")).toMatchObject({ state: "earlier-version", ended: true, agents: [] });

		const resumed = await workflows(["resume", id], { cwd: root });
		expect([resumed.code, resumed.stderr]).toEqual([
			4,
			[`workflows: run ${id} was saved by an earlier version of t and cannot resume`],
		]);
		const waited = await workflows(["wait", id], { cwd: root });
		expect([waited.code, waited.stderr]).toEqual([
			4,
			[`workflows: run ${id} was saved by an earlier version of t and cannot be waited for`],
		]);
		const saved = await workflows(["save", id, "again"], { cwd: root });
		expect([saved.code, saved.stderr]).toEqual([
			4,
			[`workflows: run ${id} was saved by an earlier version of t and cannot be saved`],
		]);
	});

	it("lists and shows an ended run that a later version saved as later-version", async () => {
		const ran = await workflows(["t.js", "Fix the parser"], { cwd: root });
		expect(ran.code).toBe(0);
		const id = ran.id ?? "";
		saveAs(TASK.version + 1);

		const listed = await workflows(["list", "--json"], { cwd: root });
		const [row] = JSON.parse(listed.stdout[0] ?? "");
		expect(row).toMatchObject({ runId: id, workflow: "t", title: "t", state: "later-version" });
		expect([row.result, row.steps]).toEqual([undefined, []]);
		const shown = await workflows(["show", id, "--json"], { cwd: root });
		const run = JSON.parse(shown.stdout[0] ?? "");
		expect(run).toMatchObject({ state: "later-version", steps: [], calls: [] });
		expect([run.result, run.report, run.error]).toEqual([undefined, undefined, undefined]);
		const waited = await workflows(["wait", id], { cwd: root });
		expect([waited.code, waited.stderr]).toEqual([
			4,
			[`workflows: run ${id} was saved by a later version of t and cannot be waited for`],
		]);
	});

	it("tells to resume a failed run only when this version saved it", async () => {
		const ran = await workflows(["f.js"], { cwd: root });
		expect(ran.code).toBe(1);
		const id = ran.id ?? "";
		const hint = `continue with: workflows resume ${id}`;

		const current = await workflows(["show", id], { cwd: root });
		expect([current.code, current.stdout.slice(-2)]).toEqual([0, ["failed f: boom", hint]]);
		const currentJson = await workflows(["show", id, "--json"], { cwd: root });
		expect(JSON.parse(currentJson.stdout[0] ?? "")).toMatchObject({ state: "failed" });
		const listed = await workflows(["list", "--json"], { cwd: root });
		expect(JSON.parse(listed.stdout[0] ?? "")).toMatchObject([{ runId: id, state: "failed" }]);

		saveAs(TASK.version - 1);
		const shown = await workflows(["show", id], { cwd: root });
		expect([shown.code, shown.stdout]).toEqual([0, [`run ${id} f earlier-version f`, footer]]);
		const shownJson = await workflows(["show", id, "--json"], { cwd: root });
		expect(JSON.parse(shownJson.stdout[0] ?? "")).toMatchObject({ state: "earlier-version" });

		// The log keeps the steps and the end of the old run, with the state of its outcome.
		const logged = await workflows(["log", id], { cwd: root });
		expect(logged.stdout[0]).toEqual(logLine("\\[f\\] start"));
		expect(logged.stdout.at(-2)).toEqual(logLine("\\[f\\] failed  \\d+s"));
		expect(logged.stdout.at(-1)).toEqual(logLine("\\[f\\] \\| boom"));
	});

	it("shows a run whose task has not ended with the state of its version", async () => {
		for (const [version, state] of [
			[TASK.version - 1, "earlier-version"],
			[TASK.version + 1, "later-version"],
		] as const) {
			const id = await saveRun(root, "workflows.run", version, { name: "t" });

			const shown = await workflows(["show", id], { cwd: root });
			expect([shown.code, shown.stdout[0]]).toEqual([0, `run ${id} t ${state} t`]);
			const shownJson = await workflows(["show", id, "--json"], { cwd: root });
			const run = JSON.parse(shownJson.stdout[0] ?? "");
			expect(run).toMatchObject({ runId: id, workflow: "t", title: "t", state, steps: [] });
			const listed = await workflows(["list", "--json"], { cwd: root });
			const rows: { runId: string }[] = JSON.parse(listed.stdout[0] ?? "");
			const row = rows.find((each) => each.runId === id);
			expect(row).toMatchObject({ workflow: "t", title: "t", state, steps: [] });
			const waited = await workflows(["wait", id], { cwd: root });
			expect(waited.code).toBe(4);
			const logged = await workflows(["log", id], { cwd: root });
			// The saved task has no start time, so the line has a blank time column.
			expect([logged.code, logged.stdout]).toEqual([0, [`${" ".repeat(8)}  [t] start  ${state}`]]);
		}

		// An input without a name gives the workflow `?`.
		const nameless = await saveRun(root, "workflows.run", TASK.version - 1);
		const shown = await workflows(["show", nameless], { cwd: root });
		expect(shown.stdout[0]).toBe(`run ${nameless} ? earlier-version ?`);
	});
});
