/** The setup of a run worktree: `.workflows/setup` of the worktree, which runs once per run before its script. */
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, open, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Context } from "@earendil-works/chord";
import { defineDocFamily } from "@earendil-works/pi-durable";
import type { ScriptInput } from "./meta.ts";
import { addProgress } from "./script.ts";
import type { Runtime } from "./task.ts";

/** Whether the setup of a run is done, keyed by the run ID. A new task of the run does not run it again. */
const SetupDoc = defineDocFamily<{ done: boolean }, null>({
	kind: "workflows.setup",
	version: 1,
	scope: "session",
	family: true,
	checkpointWhen: () => false,
	initial: () => ({ done: false }),
});

/** The setup file of the worktree `worktree`, or undefined when it has none. */
async function setupFile(worktree: string): Promise<string | undefined> {
	const file = join(worktree, ".workflows", "setup");

	return (await stat(file).catch(() => undefined))?.isFile() === true ? file : undefined;
}

/**
 * Runs `file` with no shell in `worktree`, with its stdout and stderr in `<runDir>/setup.log`. Throws when it is not
 * executable or exits with a code other than 0.
 */
async function runSetup(file: string, worktree: string, runDir: string, signal: AbortSignal): Promise<void> {
	try {
		await access(file, constants.X_OK);
	} catch {
		throw new Error(`${file} is not executable: chmod +x it`);
	}

	await mkdir(runDir, { recursive: true });
	const log = join(runDir, "setup.log");
	const handle = await open(log, "w");

	try {
		const child = spawn(file, [], { cwd: worktree, signal, stdio: ["ignore", handle.fd, handle.fd] });

		const { code, signal: killed } = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
			(done, fail) => {
				child.on("error", fail);
				child.on("close", (code, signal) => done({ code, signal }));
			},
		);

		if (code === 0) return;
		const lines = (await readFile(log, "utf8")).split("\n").filter((line) => line.trim() !== "");
		throw new Error(`setup failed (exit ${code ?? killed}): ${lines.at(-1)?.trim() ?? ""}; see ${log}`);
	} finally {
		await handle.close();
	}
}

/**
 * Runs `.workflows/setup` of the run's worktree, once per run: the step `setup` shows while it runs, and a run whose
 * setup failed runs it again when it resumes.
 */
export async function setUp(runtime: Runtime, context: Context, input: ScriptInput, parent: string | null) {
	const { runId: run, root, worktree } = input;

	if (worktree === undefined) return;

	if ((await runtime.snapshot(SetupDoc, run, context))?.done === true) return;
	const file = await setupFile(worktree.path);

	if (file === undefined) return;
	await runtime.commit(async (tx) => {
		await addProgress(tx, root, [{ kind: "phase", run, parent, text: "setup", at: Date.now(), continues: true }]);

		return undefined;
	}, context);
	await runSetup(file, worktree.path, input.runDir, runtime.signal);
	await runtime.commit(async (tx) => {
		(await tx.doc(SetupDoc, run, null)).done = true;
		await addProgress(tx, root, [{ kind: "done", run, at: Date.now() }]);

		return undefined;
	}, context);
}
