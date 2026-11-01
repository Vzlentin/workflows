/** The harness host of a project, as the command line reaches it: the connection, the task keys, and the project store. */
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Client, connect } from "@vzlentin/harness/client";
import { setEntry } from "@vzlentin/harness/entries";
import type { TaskInfo } from "@vzlentin/harness/protocol";
import type { ScriptInput } from "../launch/input.ts";
import { TASK } from "../run/version.ts";
import type { Terminal } from "./main.ts";

/**
 * The entry of workflows that the harness host loads: `dist/entry.js`, or `src/entry.ts` in a checkout. The command sets
 * it in harness's `entries.json` before it can start a host.
 */
const ENTRY = fileURLToPath(new URL(import.meta.url.endsWith(".ts") ? "../entry.ts" : "../entry.js", import.meta.url));

/** The file name of the project store in the state folder of a project. */
export const STORE_FILE = "durable.sqlite";

/**
 * A connection to the host of `project`. With `start`, it starts the host when none runs; without, it is undefined
 * then. harness's client reads the project from `HARNESS_PROJECT`.
 */
export async function connectTo(terminal: Terminal, project: string, start: true): Promise<Client>;
export async function connectTo(terminal: Terminal, project: string, start: boolean): Promise<Client | undefined>;
export async function connectTo(terminal: Terminal, project: string, start: boolean): Promise<Client | undefined> {
	// A host that starts from here loads this entry. A host that runs already loads it only after it starts again.
	if (start) setEntry("workflows", ENTRY);
	let connected: Client | undefined;

	if (terminal.connect !== undefined) connected = await terminal.connect(project, start);
	else {
		const saved = process.env.HARNESS_PROJECT;
		process.env.HARNESS_PROJECT = project;

		try {
			connected = await connect({ start });
		} finally {
			if (saved === undefined) delete process.env.HARNESS_PROJECT;
			else process.env.HARNESS_PROJECT = saved;
		}
	}

	if (start && connected === undefined) throw new Error(`no harness host for ${project}`);

	return connected;
}

/** The folder of the run directories. */
export function runsDirectory(): string {
	const state = process.env.XDG_STATE_HOME || join(homedir(), ".local", "state");

	return join(state, "workflows", "runs");
}

/** The `start` key of the task `n` of the run `id`, counting from 1. */
export const taskKey = (id: string, n: number) => `wf:${id}#${n}`;

/** An error after which the host has no task of the request, or none that runs. */
export class Refused extends Error {}

/** Starts the task of `key` with `input` in the host of `client`, and checks the version of the host's task. */
export async function startTask(client: Client, project: string, input: ScriptInput, key: string): Promise<void> {
	try {
		// A host whose workflows task has another version refuses before it creates anything, so the key stays free.
		await client.request({ type: "start", kind: TASK.name, version: TASK.version, input, key });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);

		if (message.startsWith("Unknown task kind")) {
			throw new Refused(
				`${message}: the harness host started before it had the entry of workflows; stop it so it starts again with the entry (${hostOf(client, project)})`,
			);
		}

		if (message.startsWith("This host has version")) throw new Refused(`${message} (${hostOf(client, project)})`);
		throw error;
	}
}

/** The host of `project` that `client` reached, with how to stop it. */
function hostOf(client: Client, project: string): string {
	return `the harness host of project ${project} has pid ${client.pid}: kill ${client.pid}`;
}

/**
 * Throws when the host ran the task `info`, which this command did not start, with another version of workflows: a
 * host keeps the version of workflows that it loaded when it started.
 */
export function checkVersion(client: Client, project: string, info: TaskInfo): void {
	if (info.version === TASK.version) return;
	throw new Refused(
		`This host ran version ${info.version} of ${TASK.name}, not ${TASK.version}: stop the host so it starts again with the installed version (${hostOf(client, project)})`,
	);
}

/** The info of the task of `key` in the host of `project`, undefined when the host has no such task. */
export async function findTask(terminal: Terminal, project: string, key: string): Promise<TaskInfo | undefined> {
	const client = await connectTo(terminal, project, false);

	if (client === undefined) throw new Error(`no harness host for ${project}`);

	try {
		return await client.request({ type: "task", key });
	} catch (error) {
		if (error instanceof Error && error.message.startsWith("Unknown task:")) return undefined;
		throw error;
	} finally {
		client.close();
	}
}

/** Aborts the task of `key` in the host of `project`, and gives its outcome once it ended. */
export async function abortRun(terminal: Terminal, project: string, key: string): Promise<TaskInfo["outcome"]> {
	const client = await connectTo(terminal, project, true);

	try {
		await client.request({ type: "abort-task", key });

		return (await client.request({ type: "wait-task", key })).outcome;
	} finally {
		client.close();
	}
}
