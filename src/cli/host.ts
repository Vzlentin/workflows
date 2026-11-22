/** The harness host of a project, as the command line reaches it: the connection, the task keys, and the project store. */
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Client, connect, HostUnreachableError, hostStopped } from "@vzlentin/harness/client";
import { setEntry } from "@vzlentin/harness/entries";
import { statePaths, type TaskInfo } from "@vzlentin/harness/protocol";
import type { ScriptInput } from "../launch/input.ts";
import type { TaskEnd } from "../run/past.ts";
import { TASK } from "../run/version.ts";
import { ENTRY_NAME } from "../tool.ts";
import type { Terminal } from "./main.ts";

/**
 * The entry of workflows that the harness host loads: `dist/entry.js`, or `src/entry.ts` in a checkout. The command sets
 * it in harness's `entries.json` before it can start a host.
 */
const ENTRY = fileURLToPath(new URL(import.meta.url.endsWith(".ts") ? "../entry.ts" : "../entry.js", import.meta.url));

/** The file name of the project store in the state folder of a project. */
const STORE_FILE = "durable.sqlite";

/** The path of the project store of `project`. */
export function storeOf(project: string): string {
	return join(statePaths(project).dir, STORE_FILE);
}

/**
 * A connection to the host of `project`. With `start`, it starts the host when none runs; without, it is undefined
 * then.
 */
export async function connectTo(terminal: Terminal, project: string, start: true): Promise<Client>;
export async function connectTo(terminal: Terminal, project: string, start: boolean): Promise<Client | undefined>;
export async function connectTo(terminal: Terminal, project: string, start: boolean): Promise<Client | undefined> {
	// A host that starts from here loads this entry. A host that runs already loads it only after it starts again.
	if (start) setEntry(ENTRY_NAME, ENTRY);

	const connected =
		terminal.connect === undefined ? await connect({ project, start }) : await terminal.connect(project, start);

	if (start && connected === undefined) throw new Error(`no harness host for ${project}`);

	return connected;
}

/** The folder of the run directories. */
export function runsDirectory(): string {
	const state = process.env.XDG_STATE_HOME || join(homedir(), ".local", "state");

	return join(state, "workflows", "runs");
}

/** An error after which the host has no task of the request, or none that runs. */
export class Refused extends Error {}

/**
 * Starts the task of `key` with `input` and its labels in the host of `client`, and checks the version of the host's
 * task. It gives the info of the task of `key`, which is a task that an earlier `start` of the same key created, when
 * there is one. An error reply of the host is a `Refused`.
 */
export async function startTask(client: Client, project: string, input: ScriptInput, key: string): Promise<TaskInfo> {
	const { labels } = input;

	try {
		// A host refuses a kind, a version or a label before it creates anything, so the key stays free.
		return await client.request({ type: "start", kind: TASK.name, version: TASK.version, input, key, labels });
	} catch (error) {
		// A host that the client did not reach, or that stopped, may have created the task.
		if (!(error instanceof Error) || error instanceof HostUnreachableError) throw error;
		const { message } = error;

		if (hostStopped(error)) throw error;

		if (message.startsWith("Unknown task kind")) {
			throw new Refused(
				`${message}: the harness host started before it had the entry of workflows; stop it so it starts again with the entry (${hostOf(client, project)})`,
			);
		}

		if (message.startsWith("This host has version")) throw new Refused(`${message} (${hostOf(client, project)})`);
		throw new Refused(message);
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

/**
 * Aborts the task of `key` in the host of `project`, and gives its end once it ended. The host commits the abort before
 * it replies, so a host that stops after the reply gives an aborted end: the task ends so when the host starts again.
 */
export async function abortRun(terminal: Terminal, project: string, key: string): Promise<TaskInfo | TaskEnd> {
	const client = await connectTo(terminal, project, true);

	try {
		await client.request({ type: "abort-task", key });

		try {
			return await client.request({ type: "wait-task", key });
		} catch (error) {
			if (!hostStopped(error)) throw error;

			return { kind: TASK.name, version: TASK.version, outcome: { status: "aborted" } } satisfies TaskEnd;
		}
	} finally {
		client.close();
	}
}
