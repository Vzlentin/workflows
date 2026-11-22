/** `workflows <workflow> ...`: starts a run of a workflow script in the host and follows it. */
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Client } from "@vzlentin/harness/client";
import { resolveHost } from "@vzlentin/harness/hosts";
import {
	drivenInput,
	driverOf,
	newRunId,
	parse,
	postsTo,
	prepare,
	type ScriptInput,
	writeHost,
} from "../../launch/input.ts";
import { taskKey } from "../../run/past.ts";
import type { Background } from "../follow.ts";
import { connectTo, Refused, runsDirectory, startTask } from "../host.ts";
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
	const host = resolveHost(process.env, terminal.cwd);
	const key = taskKey(id, 1);
	await mkdir(directory, { recursive: true });
	// A run directory whose host file names no task is an unstarted run, which `list` shows and `sweep` removes.
	await writeHost(directory, host);
	const driver = driverOf(process.env, host);
	let client: Client | undefined;
	let input: ScriptInput | undefined;
	let sent = false;

	try {
		const prepared = await prepare(parsed, { id, directory, cwd: terminal.cwd });
		// The `workflow` tool of a conversation of the host drives the run, so the run's sessions go under it.
		// A run started in the background posts its outcome to its driver when it ends.
		input = drivenInput(prepared, driver, background);
		terminal.interrupt.throwIfAborted();
		terminal.following(true);
		client = await connectTo(terminal, host, true);
		terminal.interrupt.throwIfAborted();
		sent = true;
		await startTask(client, host, input, key);
	} catch (error) {
		client?.close();
		terminal.following(false);

		if (sent && input !== undefined && !(error instanceof Refused)) {
			// The host may have created the task before the error, such as a closed connection. The host creates the task
			// of a key once, so the same `start` again gives that task, or creates it.
			return startAgain(
				{ id, host, key, input, error },
				terminal,
				json,
				background && { posts: postsTo(input, driver) },
			);
		}

		await rm(directory, { recursive: true, force: true });

		if (!terminal.interrupt.aborted) throw error;
		terminal.stderr("workflows: interrupted before the run started");

		return 130;
	}

	terminal.stdout(`run ${id}`);

	return followAnswering(
		{ id, host, key, input, client, from: 0 },
		terminal,
		json,
		background && { posts: postsTo(input, driver) },
	);
}

/**
 * Sends the `start` of the run `id` again on a new connection, after the first one failed with `error`, and follows the
 * run. When it fails too, it throws, and keeps the run directory: the run may have started.
 */
async function startAgain(
	run: { id: string; host: string; key: string; input: ScriptInput; error: unknown },
	terminal: Terminal,
	json: boolean,
	background: Background,
): Promise<number> {
	const { id, host, key, input, error } = run;
	let client: Client | undefined;

	try {
		client = await connectTo(terminal, host, true);
		await startTask(client, host, input, key);
	} catch {
		client?.close();
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`${message}; run ${id} may have started: workflows resume ${id}`);
	}

	terminal.following(true);
	terminal.stdout(`run ${id}`);

	return followAnswering({ id, host, key, input, client, from: 0 }, terminal, json, background);
}
