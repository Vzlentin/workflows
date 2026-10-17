/**
 * The `workflows` command line. `workflows <workflow> ...` starts a run of a workflow script,
 * `workflows resume <run-id>` continues one, `workflows list` prints the runs, `workflows show <run-id>` prints the
 * calls of one run, and `workflows save <run-id> <name>` keeps the script of one run as a project workflow. A run
 * directory holds the durable store, which holds everything a resume needs, and whatever the workflow writes there.
 */
import { existsSync } from "node:fs";
import { access, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve as resolvePath } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import * as ai from "@earendil-works/pi-ai";
import type { Models } from "@earendil-works/pi-ai/models";
import {
	createEventBus,
	DefaultPackageManager,
	getAgentDir,
	ProjectTrustStore,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import * as durable from "@earendil-works/pi-durable";
import {
	type Cursor,
	createRegistry,
	defineExtension,
	type Extension,
	Harness,
	type HarnessSettings,
	type SettledTask,
	type TaskId,
	type TaskRecord,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createJiti } from "jiti";
import { Sessions } from "./agents.ts";
import { separateHarness } from "./harness.ts";
import { takeLock } from "./lock.ts";
import * as script from "./meta.ts";
import { type Display, display } from "./progress.ts";
import { type Io, newRunId, UsageError, withUsage } from "./run.ts";
import { answerExtension, CALL_KIND, type CallRecord, loadScripts, projectFolder } from "./script.ts";
import { current, scriptTask, TASK } from "./task.ts";

/** `list`, `show` and `save` take short write locks while a run goes on in another process, so wait longer than the 5 s default. */
const STORAGE = { busyTimeoutMs: 60_000 };

export type Terminal = Io & {
	readonly models: Models;
	/** Aborted by Ctrl+C: the run stops where it is and stays resumable. */
	readonly interrupt: AbortSignal;
};

const RESUME = "workflows resume <run-id> [--json]";
const LIST = "workflows list [--json]";
const SHOW = "workflows show <run-id> [--json]";
const SAVE = "workflows save <run-id> <name> [--force]";

/** The commands by name. No script can have one of these names. */
const COMMANDS: Readonly<
	Record<string, (args: readonly string[], terminal: Terminal, json: boolean) => Promise<number>>
> = { list, resume, show, save, check: script.check };

/** The exit code: 0 for a successful result, 1 for any other result or error, 2 for bad usage, 130 when interrupted. */
export async function main(argv: readonly string[], terminal: Terminal): Promise<number> {
	const usage = [
		`${script.USAGE} [--json]`,
		"workflows <workflow> --help",
		RESUME,
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

function runsDirectory(): string {
	const state = process.env.XDG_STATE_HOME || join(homedir(), ".local", "state");
	return join(state, "workflows", "runs");
}

async function start(args: readonly string[], terminal: Terminal, json: boolean): Promise<number> {
	const parsed = await script.parse(args, terminal);
	const id = newRunId();
	const directory = join(runsDirectory(), id);
	const shown = display(terminal, json);
	const { store, task, input } = await openRun(directory, terminal, shown, () =>
		script.prepare(parsed, { id, directory, cwd: terminal.cwd }),
	);
	terminal.stdout(`run ${id}`);
	return follow(store, task, input, id, terminal, json, shown);
}

/** The one run ID of `args`. Bad usage prints `usage`. */
function oneRunId(args: readonly string[], usage: string): string {
	const [id, ...rest] = args;
	if (id === undefined || rest.length > 0 || id.startsWith("-")) throw new UsageError("give one run ID", usage);
	return id;
}

/** The directory of the saved run `id`. A run ID that is a path is bad usage, which prints `usage`. */
async function runDirectory(id: string, usage: string): Promise<string> {
	if (id.includes("/") || id.includes("\\") || id === "." || id === "..") {
		throw new UsageError(`${id} is not a run ID`, usage);
	}
	const directory = join(runsDirectory(), id);
	await access(join(directory, "durable.sqlite")).catch(() => {
		throw new Error(`no run ${id} in ${runsDirectory()}`);
	});
	return directory;
}

async function resume(args: readonly string[], terminal: Terminal, json: boolean): Promise<number> {
	const id = oneRunId(args, RESUME);
	const directory = await runDirectory(id, RESUME);
	const shown = display(terminal, json);
	const { store, task, input } = await openRun(directory, terminal, shown);
	terminal.stdout(`run ${id}`);
	return follow(store, task, input, id, terminal, json, shown);
}

/**
 * The open store, the task and the input of the run in `directory`. When the store holds a workflow task, this is that
 * task, or a new task with its input when it ended without completing, so that the script runs again with its saved
 * calls; it throws for a task that another version saved. When the new task cannot be created, the store closes and
 * the run stays. Otherwise `source` gives the input of a new run, and without `source` it throws. When the new run fails
 * to start, the store closes and the directory is removed.
 */
async function openRun(
	directory: string,
	terminal: Terminal,
	shown: Display,
	source?: () => Promise<script.ScriptInput>,
): Promise<{ store: Store; task: TaskId<JsonValue>; input: script.ScriptInput }> {
	const id = basename(directory);
	const path = join(directory, "durable.sqlite");
	const latest = existsSync(path) ? await latestTask(path) : undefined;
	if (latest !== undefined) {
		const { input, state } = checked(latest, id, "resume");
		const ended = state.status === "terminal" && state.outcome.status !== "completed";
		return openTask(directory, terminal, shown, input, ended ? undefined : latest.id);
	}
	if (source === undefined) throw new Error(`run ${id} has no workflow`);
	await mkdir(directory, { recursive: true });
	try {
		return await openTask(directory, terminal, shown, await source());
	} catch (error) {
		await rm(directory, { recursive: true, force: true });
		throw error;
	}
}

/** The open store of `directory` with `task`, or with a new task of `input`. It closes when the task cannot be created. */
async function openTask(
	directory: string,
	terminal: Terminal,
	shown: Display,
	input: script.ScriptInput,
	task?: TaskId<JsonValue>,
): Promise<{ store: Store; task: TaskId<JsonValue>; input: script.ScriptInput }> {
	const store = await openStore(directory, terminal, shown);
	try {
		return { store, task: task ?? (await store.create(input)), input };
	} catch (error) {
		await store.close();
		throw error;
	}
}

type Outcome =
	| { readonly status: "completed"; readonly result: JsonValue }
	| { readonly status: "interrupted" }
	| { readonly status: "failed"; readonly error: string };

/**
 * Runs `task` to its end and closes the store. `interrupt` stops it and leaves the task pending. Any other error of the
 * wait propagates, and so does a task that ends neither completed nor failed, with any other terminal outcome.
 * Resume continues such a task in a new task, as a failed one.
 */
async function wait(store: Store, task: TaskId<JsonValue>, interrupt: AbortSignal): Promise<Outcome> {
	let settled: SettledTask<JsonValue>;
	try {
		settled = await store.harness.waitForTask(task, withAbortSignal(interrupt, BACKGROUND_CONTEXT));
	} catch (error) {
		if (interrupt.aborted) return { status: "interrupted" };
		throw error;
	} finally {
		await store.close();
	}
	const { outcome } = settled.state;
	if (outcome.status === "completed") return { status: "completed", result: outcome.result };
	if (outcome.status === "failed") return { status: "failed", error: outcome.error.message };
	throw new Error(`run ended ${outcome.status}`);
}

type Listed = { readonly runId: string; readonly workflow: string; readonly title: string; readonly status: string };

/** Prints the runs, newest run ID first. It reads the task records without a harness, so no run continues. */
async function list(args: readonly string[], terminal: Terminal, json: boolean): Promise<number> {
	if (args.length > 0) throw new UsageError("list takes no arguments", LIST);
	const ids = await readdir(runsDirectory()).catch(() => []);
	const runs: Listed[] = [];
	for (const id of ids.sort().reverse()) {
		const path = join(runsDirectory(), id, "durable.sqlite");
		if (!existsSync(path)) continue;
		const latest = await latestTask(path);
		if (latest === undefined || !current(latest)) continue;
		const { input, state } = latest;
		const finished = state.status === "terminal" && state.outcome.status === "completed";
		const status = finished ? (script.statusOf(state.outcome.result) ?? "done") : "unfinished";
		runs.push({ runId: id, workflow: input.name, title: script.title(input), status });
	}
	if (json) terminal.stdout(JSON.stringify(runs));
	else for (const run of runs) terminal.stdout(`${run.runId} ${run.workflow} ${run.status} ${run.title}`);
	return 0;
}

/** One call of `workflows show`, with the calls of its child run when it is a `run` call. */
type Shown = Omit<CallRecord, "conversation" | "child"> & {
	readonly label: string;
	readonly mark: "✓" | "✗" | "◉";
	readonly calls?: Shown[];
};

/**
 * Prints the phases and calls of a run as a tree, then its report lines, or its error. It reads the task record and the
 * call records without a harness. It takes short write locks on the store, which a run in another process waits for
 * (see `STORAGE`).
 */
async function show(args: readonly string[], terminal: Terminal, json: boolean): Promise<number> {
	const id = oneRunId(args, SHOW);
	const path = join(await runDirectory(id, SHOW), "durable.sqlite");
	const { input, state } = checked(await latestTask(path), id, "be shown");
	const outcome = state.status === "terminal" ? state.outcome : undefined;
	const status =
		outcome?.status === "completed"
			? (script.statusOf(outcome.result) ?? "done")
			: outcome?.status === "failed"
				? "failed"
				: "unfinished";
	const calls = callTree(await callRecords(path), id);
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
	const directory = await runDirectory(id, SAVE);
	const { input } = checked(await latestTask(join(directory, "durable.sqlite")), id, "be saved");
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

/** Every call record in the store at `path` by key, read from the storage only. */
async function callRecords(path: string): Promise<Map<string, CallRecord>> {
	const storage = await openNodeSqliteStorage(path, STORAGE);
	try {
		const records = new Map<string, CallRecord>();
		let cursor: Cursor | undefined;
		do {
			const query = { scope: { kind: "session" as const }, at: "current" as const, kind: CALL_KIND };
			const page = await storage.scanDocuments(query, 256, cursor, BACKGROUND_CONTEXT);
			for (const record of page.items) {
				const stored = await storage.document(record.id, "current", BACKGROUND_CONTEXT);
				if (record.key !== undefined && stored !== undefined) records.set(record.key, stored.value as CallRecord);
			}
			cursor = page.next;
		} while (cursor !== undefined);
		return records;
	} finally {
		await storage.close(BACKGROUND_CONTEXT);
	}
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

const PREFIX = "workflows.";

/**
 * The newest workflow task in the store at `path` that no task owns, so not the task of a child run, read from the
 * storage only. Its kind can be one that no installed workflow has, such as a workflow of an earlier version.
 */
async function latestTask(path: string): Promise<TaskRecord<JsonValue, JsonValue, JsonValue> | undefined> {
	const storage = await openNodeSqliteStorage(path, STORAGE);
	try {
		let latest: TaskRecord<JsonValue, JsonValue, JsonValue> | undefined;
		let cursor: Cursor | undefined;
		do {
			const page = await storage.scanTasks({}, 256, cursor, BACKGROUND_CONTEXT);
			for (const task of page.items) if (task.kind.startsWith(PREFIX) && task.owner === undefined) latest = task;
			cursor = page.next;
		} while (cursor !== undefined);
		return latest;
	} finally {
		await storage.close(BACKGROUND_CONTEXT);
	}
}

type Store = {
	readonly harness: Harness;
	/** A new task of the script workflow. */
	create(input: script.ScriptInput): Promise<TaskId<JsonValue>>;
	close(): Promise<void>;
};

/** Pi's run settings from `settings`, read at every use, with `extensions` as the default selection. */
function piSettings(settings: SettingsManager, extensions: readonly Extension[]): HarnessSettings {
	return {
		extensions,
		get stream() {
			const provider = settings.getProviderRetrySettings();
			const idle = settings.getHttpIdleTimeoutMs();
			return {
				timeoutMs: provider.timeoutMs ?? (idle === 0 ? 2147483647 : idle),
				maxRetryDelayMs: provider.maxRetryDelayMs,
				...(provider.maxRetries === undefined ? {} : { maxRetries: provider.maxRetries }),
			};
		},
		get retry() {
			return settings.getRetrySettings();
		},
		get compaction() {
			return settings.getCompactionSettings();
		},
	};
}

/** What the default export of a `piDurable` entry returns. */
type Entry = { readonly extensions: readonly Extension[]; close(): Promise<void> };

/** The harness that workflows installs as a dependency. */
const HARNESS = fileURLToPath(new URL("../node_modules/harness", import.meta.url));

/**
 * The `piDurable` entries of the installed packages in Pi's `settingsManager` for `cwd`, and of the harness that
 * workflows installs unless Pi has its own, in one shared event bus, as one entry whose `close()` closes each of them
 * and passes its errors to `warn`. When an entry fails to load, the entries loaded before it close. Missing packages are
 * skipped, not installed. Node does not strip types under `node_modules`, so entries of npm packages fail to load, and
 * the harness dependency loads through jiti.
 */
async function loadEntries(
	cwd: string,
	agentDir: string,
	settingsManager: SettingsManager,
	warn: (error: unknown) => void,
): Promise<Entry> {
	const roots = new Set(
		new DefaultPackageManager({ cwd, agentDir, settingsManager })
			.listConfiguredPackages()
			.flatMap((found) => found.installedPath ?? []),
	);
	const own = fileURLToPath(new URL("..", import.meta.url));
	if (existsSync(HARNESS) && (await separateHarness(cwd, own, settingsManager)) === undefined) {
		roots.add(HARNESS);
	}
	const jiti = createJiti(import.meta.url);
	const events = createEventBus();
	const entries: Entry[] = [];
	const close = async () => {
		for (const result of await Promise.allSettled(entries.map((entry) => entry.close()))) {
			if (result.status === "rejected") warn(result.reason);
		}
	};
	try {
		for (const root of roots) {
			const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8").catch(() => "{}")) as {
				readonly piDurable?: { readonly extensions?: readonly string[] };
			};
			for (const path of manifest.piDurable?.extensions ?? []) {
				const file = resolvePath(root, path);
				const entry = (root === HARNESS ? await jiti.import(file) : await import(pathToFileURL(file).href)) as {
					default: (api: object) => Promise<Entry> | Entry;
				};
				entries.push(await entry.default({ durable, ai, events }));
			}
		}
	} catch (error) {
		await close();
		throw error;
	}
	return { extensions: entries.flatMap((entry) => entry.extensions), close };
}

/**
 * The run's durable store, open with the session tools, the package tools and the script task selected by default,
 * and `workflows-answer` installed. Sessions select it only by name. It holds the lock of the run until it closes, and
 * throws when another process runs the run.
 */
async function openStore(directory: string, terminal: Terminal, shown: Display): Promise<Store> {
	const lock = takeLock(directory, basename(directory));
	const task = scriptTask({ progress: shown.event });
	const registry = createRegistry();
	const agentDir = getAgentDir();
	// Project settings and packages count only when Pi trusts the project.
	const settings = SettingsManager.create(terminal.cwd, agentDir, {
		projectTrusted: new ProjectTrustStore(agentDir).get(terminal.cwd) === true,
	});
	const warn = (error: unknown) =>
		terminal.stderr(`warning: ${error instanceof Error ? error.message : String(error)}`);
	const entries = await loadEntries(terminal.cwd, agentDir, settings, warn).catch((error: unknown) => {
		lock.close();
		throw error;
	});
	const envs = new Map<string, NodeExecutionEnv>();
	let harness: Harness;
	try {
		const selected = [Sessions, ...entries.extensions, defineExtension({ name: "workflows", tasks: [task] })];
		for (const extension of selected) registry.install(extension);
		registry.install(answerExtension);
		// When its open fails, the harness closes the storage itself.
		harness = await Harness.open(
			await openNodeSqliteStorage(join(directory, "durable.sqlite"), STORAGE),
			{
				models: terminal.models,
				registry,
				settings: piSettings(settings, selected),
				env: ({ cwd }) => {
					if (cwd === undefined) return undefined;
					const found = envs.get(cwd) ?? new NodeExecutionEnv({ cwd });
					envs.set(cwd, found);
					return found;
				},
				onReport: warn,
			},
			BACKGROUND_CONTEXT,
		);
	} catch (error) {
		await entries.close();
		lock.close();
		throw error;
	}
	let closed: Promise<void> | undefined;
	const close = async () => {
		// Entries close first: an entry may still need the open harness.
		try {
			await entries.close();
			await harness.close(BACKGROUND_CONTEXT);
			for (const env of envs.values()) await env.cleanup(BACKGROUND_CONTEXT);
		} finally {
			lock.close();
		}
	};
	return {
		harness,
		create: async (input) => {
			const root = await harness.root(BACKGROUND_CONTEXT);
			return root.commit(
				(tx) => tx.createTask(task, input, { ownership: { kind: "conversation" } }),
				BACKGROUND_CONTEXT,
			);
		},
		close: () => {
			closed ??= close();
			return closed;
		},
	};
}

/**
 * Runs the task to its end and reports it; Ctrl+C closes the store with the task still pending, and a failed phase
 * ends the task as failed.
 */
async function follow(
	store: Store,
	task: TaskId<JsonValue>,
	input: script.ScriptInput,
	id: string,
	terminal: Terminal,
	json: boolean,
	shown: Display,
): Promise<number> {
	// With `--json`, the outcome line replaces the footer lines on stderr, so each stderr line is a progress line.
	const end = (
		status: "finished" | "failed" | "interrupted",
		rest: { result?: JsonValue; report?: string[]; error?: string },
		...footer: string[]
	) => {
		if (status !== "finished") shown.stop(true);
		if (json) terminal.stdout(JSON.stringify({ runId: id, status, ...rest }));
		else for (const line of footer) terminal.stderr(line);
	};
	let outcome: Outcome;
	try {
		outcome = await wait(store, task, terminal.interrupt);
	} catch (error) {
		end("failed", { error: error instanceof Error ? error.message : String(error) });
		throw error;
	}
	if (outcome.status === "interrupted") {
		end("interrupted", {}, `interrupted; continue with: workflows resume ${id}`);
		return 130;
	}
	if (outcome.status === "failed") {
		const { error } = outcome;
		end("failed", { error }, `failed ${script.title(input)}: ${error}`, `continue with: workflows resume ${id}`);
		return 1;
	}
	shown.stop(false);
	if (!json) return script.report(input, outcome.result, terminal);
	const report: string[] = [];
	const code = script.report(input, outcome.result, { ...terminal, stdout: (line) => report.push(line) });
	end("finished", { result: outcome.result, report });
	return code;
}
