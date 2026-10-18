/**
 * The `workflows` command line, a client of the harness host of a project. `workflows <workflow> ...` starts a run of a
 * workflow script in the host and follows it, `workflows resume <run-id>` continues or follows one, `workflows stop
 * <run-id>` stops one, `workflows list` prints the runs of the project, `workflows show <run-id>` prints the calls of
 * one run, and `workflows save <run-id> <name>` keeps the script of one run as a project workflow. The project store
 * holds the runs; a run directory holds the run's `project` file and whatever the workflow writes there.
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import type { JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai/models";
import type { Cursor, DocumentId, TaskRecord } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { Client } from "harness/src/client.ts";
import type { TaskInfo } from "harness/src/protocol.ts";
import { createJiti } from "jiti";
import * as script from "./meta.ts";
import { display, PROGRESS_KIND, type ProgressEvent } from "./progress.ts";
import { type Io, newRunId, UsageError, withUsage } from "./run.ts";
import { CALL_KIND, type CallRecord, loadScripts, projectFolder } from "./script.ts";
import { current, TASK } from "./task.ts";

/** The command reads the store while the host writes to it, so it waits longer than the 5 s default for a lock. */
const STORAGE = { busyTimeoutMs: 60_000 };

/** How often the command reads the progress of a run that it follows. */
const POLL_MS = 500;

type Storage = Awaited<ReturnType<typeof openNodeSqliteStorage>>;

export type Terminal = Io & {
	/** Aborted by the first Ctrl+C: the command detaches, and the run goes on in the host. */
	readonly interrupt: AbortSignal;
	/** Aborted by a second Ctrl+C: the command stops the run. */
	readonly stop: AbortSignal;
	/** How long the command waits for a second Ctrl+C after the first. */
	readonly stopWindowMs: number;
	/** Pi's model registry, for `check`. */
	readonly models: () => Promise<Models>;
	/** Connects to the host of `project`, which it starts when none runs. Default: harness's client. */
	readonly connect?: (project: string) => Promise<Client>;
};

const RESUME = "workflows resume <run-id> [--json]";
const STOP = "workflows stop <run-id> [--json]";
const LIST = "workflows list [--json]";
const SHOW = "workflows show <run-id> [--json]";
const SAVE = "workflows save <run-id> <name> [--force]";

/** The commands by name. No script can have one of these names. */
const COMMANDS: Readonly<
	Record<string, (args: readonly string[], terminal: Terminal, json: boolean) => Promise<number>>
> = { list, resume, stop, show, save, check: script.check };

/** The exit code: 0 for a successful result, 1 for any other result or error, 2 for bad usage, 130 after Ctrl+C. */
export async function main(argv: readonly string[], terminal: Terminal): Promise<number> {
	const usage = [
		`${script.USAGE} [--json]`,
		"workflows <workflow> --help",
		RESUME,
		STOP,
		LIST,
		SHOW,
		SAVE,
		script.CHECK,
		"workflows",
	]
		.map((line, index) => `${index === 0 ? "usage: " : "       "}${line}`)
		.join("\n");
	try {
		const dashes = argv.indexOf("--");
		const options = dashes === -1 ? argv.length : dashes;
		const json = argv.slice(0, options).includes("--json");
		const [command, ...args] = argv.filter((arg, index) => index >= options || arg !== "--json");
		if (command === undefined) {
			for (const line of await script.listScripts(terminal)) terminal.stdout(line);
			return 0;
		}
		const run = Object.hasOwn(COMMANDS, command) ? COMMANDS[command] : undefined;
		if (run !== undefined) return await run(args, terminal, json);
		const flags = args.indexOf("--");
		if (args.slice(0, flags === -1 ? args.length : flags).includes("--help")) {
			for (const line of await script.help(command, terminal)) terminal.stdout(line);
			return 0;
		}
		return await start([command, ...args], terminal, json);
	} catch (error) {
		terminal.stderr(`workflows: ${error instanceof Error ? error.message : String(error)}`);
		const code = (error as { code?: unknown } | undefined)?.code;
		if (error instanceof UsageError || (typeof code === "string" && code.startsWith("ERR_PARSE_ARGS"))) {
			terminal.stderr(error instanceof UsageError && error.usage !== undefined ? `usage: ${error.usage}` : usage);
			return 2;
		}
		return 1;
	}
}

/** The modules of harness that the command uses. Node does not strip types under `node_modules`, so jiti loads them. */
type Harness = {
	readonly client: typeof import("harness/src/client.ts");
	readonly projects: typeof import("harness/src/projects.ts");
	readonly protocol: typeof import("harness/src/protocol.ts");
};

let harnessModules: Promise<Harness> | undefined;

function harness(): Promise<Harness> {
	harnessModules ??= (async () => {
		const jiti = createJiti(import.meta.url);
		const [client, projects, protocol] = await Promise.all([
			jiti.import<Harness["client"]>("harness/src/client.ts"),
			jiti.import<Harness["projects"]>("harness/src/projects.ts"),
			jiti.import<Harness["protocol"]>("harness/src/protocol.ts"),
		]);
		return { client, projects, protocol };
	})();
	return harnessModules;
}

/** The project of `cwd`, as harness routes a client there. */
async function projectOf(cwd: string): Promise<string> {
	return (await harness()).projects.resolveProject(process.env, cwd);
}

/** The project store of `project`. */
async function storeOf(project: string): Promise<string> {
	return join((await harness()).protocol.statePaths(project).dir, "durable.sqlite");
}

/** A connection to the host of `project`. harness's client reads the project from `HARNESS_PROJECT`. */
async function connectTo(terminal: Terminal, project: string): Promise<Client> {
	if (terminal.connect !== undefined) return terminal.connect(project);
	const { client } = await harness();
	const saved = process.env.HARNESS_PROJECT;
	process.env.HARNESS_PROJECT = project;
	try {
		const connected = await client.connect({ start: true });
		if (connected === undefined) throw new Error(`no harness host for ${project}`);
		return connected;
	} finally {
		if (saved === undefined) delete process.env.HARNESS_PROJECT;
		else process.env.HARNESS_PROJECT = saved;
	}
}

function runsDirectory(): string {
	const state = process.env.XDG_STATE_HOME || join(homedir(), ".local", "state");
	return join(state, "workflows", "runs");
}

/** The `start` key of the task `n` of the run `id`, counting from 1. */
const taskKey = (id: string, n: number) => `wf:${id}#${n}`;

/** Starts the task of `key` with `input` in the host of `client`. */
async function startTask(client: Client, input: script.ScriptInput, key: string): Promise<void> {
	try {
		await client.request({ type: "start", kind: TASK.name, input, key });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (!message.startsWith("Unknown task kind")) throw error;
		throw new Error(`${message}: the harness host does not load workflows; add it to Pi with pi install`);
	}
}

async function start(args: readonly string[], terminal: Terminal, json: boolean): Promise<number> {
	const parsed = await script.parse(args, terminal);
	const id = newRunId();
	const directory = join(runsDirectory(), id);
	const project = await projectOf(terminal.cwd);
	const key = taskKey(id, 1);
	await mkdir(directory, { recursive: true });
	let client: Client | undefined;
	let input: script.ScriptInput;
	try {
		input = await script.prepare(parsed, { id, directory, cwd: terminal.cwd });
		await writeFile(join(directory, "project"), `${project}\n`);
		client = await connectTo(terminal, project);
		await startTask(client, input, key);
	} catch (error) {
		client?.close();
		await rm(directory, { recursive: true, force: true });
		throw error;
	}
	terminal.stdout(`run ${id}`);
	return follow({ id, project, key, input, client, from: 0 }, terminal, json);
}

/** The one run ID of `args`. Bad usage prints `usage`. */
function oneRunId(args: readonly string[], usage: string): string {
	const [id, ...rest] = args;
	if (id === undefined || rest.length > 0 || id.startsWith("-")) throw new UsageError("give one run ID", usage);
	return id;
}

/** A run that the command started: its ID, its project, and the path of the project store. */
type SavedRun = { readonly id: string; readonly project: string; readonly store: string };

/** The saved run `id`, from the `project` file of its run directory. A run ID that is a path is bad usage. */
async function savedRun(id: string, usage: string): Promise<SavedRun> {
	if (id.includes("/") || id.includes("\\") || id === "." || id === "..") {
		throw new UsageError(`${id} is not a run ID`, usage);
	}
	const file = join(runsDirectory(), id, "project");
	const project = (
		await readFile(file, "utf8").catch(() => {
			throw new Error(`no run ${id} in ${runsDirectory()}`);
		})
	).trim();
	return { id, project, store: await storeOf(project) };
}

/** `read` on the store at `path`, opened for reads; `fallback` when the store does not exist. */
async function reading<T>(path: string, fallback: T, read: (storage: Storage) => Promise<T>): Promise<T> {
	if (!existsSync(path)) return fallback;
	const storage = await openNodeSqliteStorage(path, STORAGE);
	try {
		return await read(storage);
	} finally {
		await storage.close(BACKGROUND_CONTEXT);
	}
}

const PREFIX = "workflows.";

/** The run ID in the input of a workflow task, also of an earlier version, which some versions wrapped as `{ input }`. */
function runIdOf(input: JsonValue): string | undefined {
	const saved = script.isObject(input) && script.isObject(input.input) ? input.input : input;
	return script.isObject(saved) && typeof saved.runId === "string" ? saved.runId : undefined;
}

/**
 * The workflow tasks that no task owns, so not the tasks of child runs, by run ID, oldest first. Their kind can be one
 * that no installed workflow has, such as a workflow of an earlier version.
 */
async function runTasks(storage: Storage): Promise<Map<string, TaskRecord<JsonValue, JsonValue, JsonValue>[]>> {
	const runs = new Map<string, TaskRecord<JsonValue, JsonValue, JsonValue>[]>();
	let cursor: Cursor | undefined;
	do {
		const page = await storage.scanTasks({}, 256, cursor, BACKGROUND_CONTEXT);
		for (const task of page.items) {
			const id = runIdOf(task.input);
			if (!task.kind.startsWith(PREFIX) || task.owner !== undefined || id === undefined) continue;
			runs.set(id, [...(runs.get(id) ?? []), task]);
		}
		cursor = page.next;
	} while (cursor !== undefined);
	return runs;
}

/** The root tasks of `run`, oldest first. */
function tasksOf(run: SavedRun): Promise<TaskRecord<JsonValue, JsonValue, JsonValue>[]> {
	return reading(run.store, [], async (storage) => (await runTasks(storage)).get(run.id) ?? []);
}

/** The number of progress events of the root run `id`. */
function progressCount(run: SavedRun): Promise<number> {
	return reading(run.store, 0, async (storage) => (await progressEvents(storage, run.id)).length);
}

/** The progress events of the root run `id`, read from the storage only. */
async function progressEvents(storage: Storage, id: string): Promise<readonly ProgressEvent[]> {
	const address = { kind: PROGRESS_KIND, scope: { kind: "session" as const }, key: id };
	const record = await storage.findDocument(address, "current", BACKGROUND_CONTEXT);
	if (record === undefined) return [];
	const stored = await storage.document(record.id, "current", BACKGROUND_CONTEXT);
	return (stored?.value as { events?: ProgressEvent[] } | undefined)?.events ?? [];
}

/**
 * Continues the run of `args`. A finished run prints its result. A run whose last task ended without a result continues
 * in a new task with the same input. A run whose last task did not end is followed.
 */
async function resume(args: readonly string[], terminal: Terminal, json: boolean): Promise<number> {
	const run = await savedRun(oneRunId(args, RESUME), RESUME);
	const tasks = await tasksOf(run);
	const { input, state } = checked(tasks.at(-1), run.id, "resume");
	if (state.status === "terminal" && state.outcome.status === "completed") {
		terminal.stdout(`run ${run.id}`);
		return finished(input, run.id, state.outcome.result, terminal, json);
	}
	const from = await progressCount(run);
	const ended = state.status === "terminal";
	const key = taskKey(run.id, tasks.length + (ended ? 1 : 0));
	const client = await connectTo(terminal, run.project);
	try {
		if (ended) await startTask(client, input, key);
	} catch (error) {
		client.close();
		throw error;
	}
	terminal.stdout(`run ${run.id}`);
	return follow({ id: run.id, project: run.project, key, input, client, from }, terminal, json);
}

/** Stops the run of `args` in its host. Its task ends as aborted, and a resume continues it. */
async function stop(args: readonly string[], terminal: Terminal, json: boolean): Promise<number> {
	const run = await savedRun(oneRunId(args, STOP), STOP);
	const tasks = await tasksOf(run);
	const { input, state } = checked(tasks.at(-1), run.id, "be stopped");
	if (state.status === "terminal") throw new Error(`run ${run.id} is not running`);
	const outcome = await abortRun(terminal, run.project, taskKey(run.id, tasks.length));
	if (outcome?.status !== "aborted") throw new Error(`run ${run.id} is not running`);
	if (json) terminal.stdout(JSON.stringify({ runId: run.id, status: "stopped" }));
	else terminal.stdout(`stopped ${script.title(input)}; continue with: workflows resume ${run.id}`);
	return 0;
}

/** Aborts the task of `key` in the host of `project`, and gives its outcome once it ended. */
async function abortRun(terminal: Terminal, project: string, key: string): Promise<TaskInfo["outcome"]> {
	const client = await connectTo(terminal, project);
	try {
		await client.request({ type: "abort-task", key });
		return (await client.request({ type: "wait-task", key })).outcome;
	} finally {
		client.close();
	}
}

type Listed = { readonly runId: string; readonly workflow: string; readonly title: string; readonly status: string };

/** Prints the runs of the project of the current directory, newest run ID first. It reads the project store only. */
async function list(args: readonly string[], terminal: Terminal, json: boolean): Promise<number> {
	if (args.length > 0) throw new UsageError("list takes no arguments", LIST);
	const store = await storeOf(await projectOf(terminal.cwd));
	const runs = await reading(store, new Map(), runTasks);
	const listed: Listed[] = [];
	for (const [id, tasks] of [...runs].sort(([a], [b]) => b.localeCompare(a))) {
		const latest = tasks.at(-1);
		if (latest === undefined || !current(latest)) continue;
		const { input, state } = latest;
		const done = state.status === "terminal" && state.outcome.status === "completed";
		const status = done ? (script.statusOf(state.outcome.result) ?? "done") : "unfinished";
		listed.push({ runId: id, workflow: input.name, title: script.title(input), status });
	}
	if (json) terminal.stdout(JSON.stringify(listed));
	else for (const run of listed) terminal.stdout(`${run.runId} ${run.workflow} ${run.status} ${run.title}`);
	return 0;
}

/** One call of `workflows show`, with the calls of its child run when it is a `run` call. */
type Shown = Omit<CallRecord, "conversation" | "child"> & {
	readonly label: string;
	readonly mark: "✓" | "✗" | "◉";
	readonly calls?: Shown[];
};

/**
 * Prints the phases and calls of a run as a tree, then its report lines, or its error. It reads the task records and
 * the call records from the project store only.
 */
async function show(args: readonly string[], terminal: Terminal, json: boolean): Promise<number> {
	const run = await savedRun(oneRunId(args, SHOW), SHOW);
	const { id } = run;
	const { latest, records } = await reading(run.store, { latest: undefined, records: new Map() }, async (storage) => ({
		latest: (await runTasks(storage)).get(id)?.at(-1),
		records: await callRecords(storage, id),
	}));
	const { input, state } = checked(latest, id, "be shown");
	const outcome = state.status === "terminal" ? state.outcome : undefined;
	const status =
		outcome?.status === "completed"
			? (script.statusOf(outcome.result) ?? "done")
			: outcome?.status === "failed"
				? "failed"
				: "unfinished";
	const calls = callTree(records, id);
	const title = script.title(input);
	const footer: string[] = [];
	let end: { report: string[] } | { error: string } | undefined;
	if (outcome?.status === "completed") {
		script.report(input, outcome.result, { ...terminal, stdout: (line) => footer.push(line) });
		end = { report: footer };
	} else if (outcome?.status === "failed") {
		footer.push(`failed ${title}: ${outcome.error.message}`, `continue with: workflows resume ${id}`);
		end = { error: outcome.error.message };
	}
	if (json) {
		terminal.stdout(JSON.stringify({ runId: id, workflow: input.name, title, status, ...end, calls }));
		return 0;
	}
	terminal.stdout(`run ${id} ${input.name} ${status} ${title}`);
	for (const line of treeLines(calls, "", Date.now())) terminal.stdout(line);
	for (const line of footer) terminal.stdout(line);
	return 0;
}

/** Writes the script of a saved run to `workflows/<name>.js` of the project folder, and prints the file's path. */
async function save(args: readonly string[], terminal: Terminal): Promise<number> {
	const { values, positionals } = withUsage(
		() => parseArgs({ args: [...args], options: { force: { type: "boolean" } }, allowPositionals: true, strict: true }),
		SAVE,
	);
	const [id, name, ...rest] = positionals;
	if (id === undefined || name === undefined || rest.length > 0) {
		throw new UsageError("give one run ID and one name", SAVE);
	}
	if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
		throw new UsageError(`${name} is not a workflow name: use lowercase letters, digits and -`, SAVE);
	}
	if (Object.hasOwn(COMMANDS, name)) throw new Error(`${name} is a command and cannot be a workflow name`);
	const run = await savedRun(id, SAVE);
	const { input } = checked((await tasksOf(run)).at(-1), id, "be saved");
	const project = await projectFolder(terminal.cwd);
	if (!values.force && Object.hasOwn(await loadScripts(project), name)) {
		throw new Error(`a workflow ${name} exists; replace it with --force`);
	}
	const folder = join(project, "workflows");
	const file = join(folder, `${name}.js`);
	await mkdir(folder, { recursive: true });
	await writeFile(file, input.bundle.main);
	terminal.stdout(file);
	return 0;
}

/** The call records of the run `runId` and of its child runs, by key, read from the storage only. */
async function callRecords(storage: Storage, runId: string): Promise<Map<string, CallRecord>> {
	const documents = new Map<string, DocumentId>();
	let cursor: Cursor | undefined;
	do {
		const query = { scope: { kind: "session" as const }, at: "current" as const, kind: CALL_KIND };
		const page = await storage.scanDocuments(query, 256, cursor, BACKGROUND_CONTEXT);
		for (const record of page.items) if (record.key !== undefined) documents.set(record.key, record.id);
		cursor = page.next;
	} while (cursor !== undefined);
	const records = new Map<string, CallRecord>();
	const runs = [runId];
	for (const run of runs) {
		for (const [key, id] of documents) {
			if (!key.startsWith(`${run}/`)) continue;
			const stored = await storage.document(id, "current", BACKGROUND_CONTEXT);
			if (stored === undefined) continue;
			const record = stored.value as CallRecord;
			records.set(key, record);
			if (record.child !== undefined) runs.push(record.child.runId);
		}
	}
	return records;
}

/** The calls of the run `runId` in the order they started, each `run` call with the calls of its child run. */
function callTree(records: Map<string, CallRecord>, runId: string): Shown[] {
	const own = [...records].filter(([key]) => key.startsWith(`${runId}/`)).map(([, record]) => record);
	return own
		.sort((a, b) => a.startedAt.localeCompare(b.startedAt))
		.map(({ conversation: _, child: started, ...record }) => {
			const mark = record.error !== undefined ? "✗" : record.endedAt !== undefined ? "✓" : "◉";
			// A `run` call that failed before its child run started has no `child`.
			const child = started?.runId;
			const shown = { ...record, label: labelOf(record, child, records), mark } as const;
			return child === undefined ? shown : { ...shown, calls: callTree(records, child) };
		});
}

/**
 * The profile of a session, also for an ask in it, the command on one line for `sh` and `ok`, and the workflow and child
 * run ID for `run`.
 */
function labelOf(
	{ kind, args }: Pick<CallRecord, "kind" | "args">,
	child: string | undefined,
	records: Map<string, CallRecord>,
): string {
	if (kind === "sh" || kind === "ok") {
		const { cmd } = args;
		return (Array.isArray(cmd) ? cmd.join(" ") : String(cmd)).replace(/\s+/g, " ").trim().slice(0, 80);
	}
	if (kind === "run") return [args.name, child].filter((value) => value !== undefined).join(" ");
	if (kind === "session") return String(args.profile);
	// A linear scan for each ask; an index by conversation if runs get thousands of calls.
	const session = [...records.values()].find((record) => record.conversation === args.conversation);
	return String(session?.args.profile);
}

/** The task `latest` of the run `id`. It throws when there is none, or when another version saved it. */
function checked(
	latest: TaskRecord<JsonValue, JsonValue, JsonValue> | undefined,
	id: string,
	verb: string,
): TaskRecord<script.ScriptInput, JsonValue, JsonValue> {
	if (latest === undefined) throw new Error(`run ${id} has no workflow`);
	if (current(latest)) return latest;
	// A script task of an earlier version names its workflow in its input, which some versions wrapped as `{ input }`;
	// an earlier task kind names it in the kind.
	const { input } = latest;
	const saved = script.isObject(input) && script.isObject(input.input) ? input.input : input;
	const name = script.isObject(saved) && typeof saved.name === "string" ? saved.name : latest.kind.slice(PREFIX.length);
	const word = latest.kind === TASK.name && latest.version > TASK.version ? "a later" : "an earlier";
	throw new Error(`run ${id} was saved by ${word} version of ${name} and cannot ${verb}`);
}

/** `12s`, `3m05s` or `1h02m`. */
function duration(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	const pad = (n: number) => String(n).padStart(2, "0");
	if (seconds < 60) return `${seconds}s`;
	if (seconds < 3600) return `${Math.floor(seconds / 60)}m${pad(seconds % 60)}s`;
	return `${Math.floor(seconds / 3600)}h${pad(Math.floor(seconds / 60) % 60)}m`;
}

/** The phase lines at `indent` and the calls under them, the calls of a child run under its `run` line. */
function treeLines(calls: readonly Shown[], indent: string, now: number): string[] {
	const lines: string[] = [];
	let phase: string | null = null;
	for (const call of calls) {
		if (call.phase !== null && call.phase !== phase) lines.push(`${indent}${call.phase}`);
		phase = call.phase;
		const end = call.endedAt === undefined ? now : Date.parse(call.endedAt);
		const time = duration(end - Date.parse(call.startedAt));
		lines.push(`${indent}  ${call.mark} ${call.kind} ${call.label}  ${time}`);
		if (call.calls !== undefined) lines.push(...treeLines(call.calls, `${indent}    `, now));
	}
	return lines;
}

/** Prints the report of the finished run `id` with `result`, or its JSON outcome line, and gives its exit code. */
function finished(input: script.ScriptInput, id: string, result: JsonValue, terminal: Terminal, json: boolean): number {
	if (!json) return script.report(input, result, terminal);
	const report: string[] = [];
	const code = script.report(input, result, { ...terminal, stdout: (line) => report.push(line) });
	terminal.stdout(JSON.stringify({ runId: id, status: "finished", result, report }));
	return code;
}

/** True when `signal` aborts within `ms`. */
function abortedWithin(signal: AbortSignal, ms: number): Promise<boolean> {
	if (signal.aborted) return Promise.resolve(true);
	return new Promise((resolve) => {
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", done);
			resolve(false);
		}, ms);
		const done = () => {
			clearTimeout(timer);
			resolve(true);
		};
		signal.addEventListener("abort", done, { once: true });
	});
}

/** Resolves when `signal` aborts. */
function aborted(signal: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal.aborted) resolve();
		else signal.addEventListener("abort", () => resolve(), { once: true });
	});
}

/** A run that the command follows: the task of `key` in the host of `client`, with the progress after `from`. */
type Following = {
	readonly id: string;
	readonly project: string;
	readonly key: string;
	readonly input: script.ScriptInput;
	readonly client: Client;
	/** The number of progress events of the run before the command started or reached the task. */
	readonly from: number;
};

/**
 * Shows the progress of the run until its task ends, and reports its outcome. Ctrl+C detaches and leaves the run to
 * the host; a second Ctrl+C within the window stops it.
 */
async function follow(run: Following, terminal: Terminal, json: boolean): Promise<number> {
	const { id, input, client } = run;
	const shown = display(terminal, json);
	// With `--json`, the outcome line replaces the footer lines on stderr, so each stderr line is a progress line.
	const end = (
		status: "finished" | "failed" | "detached" | "stopped",
		rest: { result?: JsonValue; report?: string[]; error?: string },
		...footer: string[]
	) => {
		if (json) terminal.stdout(JSON.stringify({ runId: id, status, ...rest }));
		else for (const line of footer) terminal.stderr(line);
	};
	const storage = await openNodeSqliteStorage(await storeOf(run.project), STORAGE);
	let seen = run.from;
	const poll = async () => {
		const events = await progressEvents(storage, id);
		for (const event of events.slice(seen)) shown.event(event);
		seen = Math.max(seen, events.length);
	};
	const polled = new AbortController();
	const polling = (async () => {
		while (!polled.signal.aborted) {
			await poll();
			await abortedWithin(polled.signal, POLL_MS);
		}
	})();
	// A failed read rejects `polling`, which the end of the command awaits.
	polling.catch(() => undefined);
	/** Stops the reads, then reads the events that came after the last one. */
	const stopPolling = async () => {
		polled.abort();
		await polling;
		await poll();
	};
	try {
		const waited = client.request({ type: "wait-task", key: run.key });
		// A detached command closes the connection, which ends the wait.
		waited.catch(() => undefined);
		const info = await Promise.race([waited, aborted(terminal.interrupt).then(() => undefined)]);
		if (info === undefined) {
			await stopPolling();
			const follow = `Follow it with: workflows resume ${id}. Stop it with: workflows stop ${id}`;
			if (!json) terminal.stderr(`detached; run ${id} goes on. ${follow}`);
			if (!(await abortedWithin(terminal.stop, terminal.stopWindowMs))) {
				if (json) end("detached", {});
				return 130;
			}
			await abortRun(terminal, run.project, run.key);
			return await report(await waited);
		}
		return await report(info);
	} catch (error) {
		await stopPolling().catch(() => undefined);
		shown.stop(true);
		end("failed", { error: error instanceof Error ? error.message : String(error) });
		throw error;
	} finally {
		polled.abort();
		client.close();
		await storage.close(BACKGROUND_CONTEXT);
	}

	async function report(info: TaskInfo): Promise<number> {
		await stopPolling();
		const { outcome } = info;
		if (outcome?.status === "completed") {
			shown.stop(false);
			if (!json) return script.report(input, outcome.result, terminal);
			const lines: string[] = [];
			const code = script.report(input, outcome.result, { ...terminal, stdout: (line) => lines.push(line) });
			end("finished", { result: outcome.result, report: lines });
			return code;
		}
		shown.stop(true);
		if (outcome?.status === "failed") {
			const { message } = outcome.error;
			end(
				"failed",
				{ error: message },
				`failed ${script.title(input)}: ${message}`,
				`continue with: workflows resume ${id}`,
			);
			return 1;
		}
		if (outcome?.status === "aborted") {
			end("stopped", {}, `stopped ${script.title(input)}; continue with: workflows resume ${id}`);
			return 130;
		}
		throw new Error(`run ended ${outcome?.status ?? info.status}`);
	}
}
