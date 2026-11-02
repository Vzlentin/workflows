/** `workflows <workflow> ...`: starts a run of a workflow script in the host and follows it. */
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Client } from "@vzlentin/harness/client";
import { resolveProject } from "@vzlentin/harness/projects";
import { newRunId, parse, prepare, type ScriptInput } from "../../launch/input.ts";
import { connectTo, Refused, runsDirectory, startTask, taskKey } from "../host.ts";
import type { Terminal } from "../main.ts";
import { followAnswering } from "./resume.ts";

export async function start(
	args: readonly string[],
	terminal: Terminal,
	json: boolean,
	background: boolean,
): Promise<number> {
	const parsed = await parse(args, terminal);
	const id = newRunId();
	const directory = join(runsDirectory(), id);
	const project = await resolveProject(process.env, terminal.cwd);
	const key = taskKey(id, 1);
	await mkdir(directory, { recursive: true });
	// A run directory whose `project` names no task is an unstarted run, which `list` shows and `prune` removes.
	await writeFile(join(directory, "project"), `${project}\n`);
	let client: Client | undefined;
	let input: ScriptInput | undefined;
	let sent = false;

	try {
		const prepared = await prepare(parsed, { id, directory, cwd: terminal.cwd });
		// The `workflow` tool of a conversation of the host sets `PI_SESSION_ID`, so the run's sessions go under it.
		const session = process.env.PI_SESSION_ID;
		const parented = session ? { ...prepared, parent: session } : prepared;
		// In Herdr, the run asks Herdr to create its worktrees, so they show in the sidebar.
		const own = process.env.HERDR_ENV ? { ...parented, herdr: true as const } : parented;
		// A run started in the background posts its outcome to that conversation when it ends.
		input = background ? { ...own, notify: true } : own;
		terminal.interrupt.throwIfAborted();
		terminal.following(true);
		client = await connectTo(terminal, project, true);
		terminal.interrupt.throwIfAborted();
		sent = true;
		await startTask(client, project, input, key);
	} catch (error) {
		client?.close();
		terminal.following(false);

		if (sent && input !== undefined && !(error instanceof Refused)) {
			// The host may have created the task before the error, such as a closed connection. The host creates the task
			// of a key once, so the same `start` again gives that task, or creates it.
			return startAgain({ id, project, key, input, error }, terminal, json, background);
		}

		await rm(directory, { recursive: true, force: true });

		if (!terminal.interrupt.aborted) throw error;
		terminal.stderr("workflows: interrupted before the run started");

		return 130;
	}

	terminal.stdout(`run ${id}`);

	return followAnswering({ id, project, key, input, client, from: 0 }, terminal, json, background);
}

/**
 * Sends the `start` of the run `id` again on a new connection, after the first one failed with `error`, and follows the
 * run. When it fails too, it throws, and keeps the run directory: the run may have started.
 */
async function startAgain(
	run: { id: string; project: string; key: string; input: ScriptInput; error: unknown },
	terminal: Terminal,
	json: boolean,
	background: boolean,
): Promise<number> {
	const { id, project, key, input, error } = run;
	let client: Client | undefined;

	try {
		client = await connectTo(terminal, project, true);
		await startTask(client, project, input, key);
	} catch {
		client?.close();
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`${message}; run ${id} may have started: workflows resume ${id}`);
	}

	terminal.following(true);
	terminal.stdout(`run ${id}`);

	return followAnswering({ id, project, key, input, client, from: 0 }, terminal, json, background);
}
