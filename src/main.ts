/**
 * The `workflows` command line. `workflows <workflow> ...` starts a run of a workflow script,
 * `workflows resume <run-id>` continues one, and `workflows list` prints the runs. A run directory holds the durable
 * store, which holds everything a resume needs, and whatever the workflow writes there.
 */
import { existsSync } from "node:fs";
import { access, mkdir, readdir, readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";
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
import { Sessions } from "./agents.ts";
import * as script from "./meta.ts";
import { type Io, newRunId, UsageError } from "./run.ts";
import { answerExtension } from "./script.ts";
import { current, scriptTask, type TaskInput } from "./task.ts";

export type Terminal = Io & {
	readonly models: Models;
	/** Aborted by Ctrl+C: the run stops where it is and stays resumable. */
	readonly interrupt: AbortSignal;
};

/** The exit code: 0 for a successful result, 1 for any other result or error, 2 for bad usage, 130 when interrupted. */
export async function main(argv: readonly string[], terminal: Terminal): Promise<number> {
	const usage = [
		`${script.USAGE} [--json]`,
		"workflows <workflow> --help",
		"workflows resume <run-id> [--json]",
		"workflows list [--json]",
		"workflows check <workflow>",
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
		if (command === "list") return await list(args, terminal, json);
		if (command === "resume") return await resume(args, terminal, json);
		if (command === "check") return await script.check(args, terminal);
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
	const { store, task, input } = await openRun(directory, terminal, () =>
		script.prepare(parsed, { id, directory, cwd: terminal.cwd }),
	);
	terminal.stdout(`run ${id}`);
	return follow(store, task, input, id, terminal, json);
}

async function resume(args: readonly string[], terminal: Terminal, json: boolean): Promise<number> {
	const [id, ...rest] = args;
	if (id === undefined || rest.length > 0 || id.startsWith("-")) throw new UsageError("give one run ID");
	if (id.includes("/") || id.includes("\\") || id === "." || id === "..") throw new UsageError(`${id} is not a run ID`);
	const directory = join(runsDirectory(), id);
	await access(join(directory, "durable.sqlite")).catch(() => {
		throw new Error(`no run ${id} in ${runsDirectory()}`);
	});
	const { store, task, input } = await openRun(directory, terminal);
	terminal.stdout(`run ${id}`);
	return follow(store, task, input, id, terminal, json);
}

/**
 * The open store, the task and the input of the run in `directory`. When the store holds a workflow task, this is that
 * task, also after a failed phase; it throws for a task that an earlier version saved.
 * Otherwise `source` gives the input of a new run, and without `source` it throws. When the new run fails to start,
 * the store closes and the directory is removed.
 */
async function openRun(
	directory: string,
	terminal: Terminal,
	source?: () => Promise<script.ScriptInput>,
): Promise<{ store: Store; task: TaskId<JsonValue>; input: script.ScriptInput }> {
	const id = basename(directory);
	const path = join(directory, "durable.sqlite");
	const latest = existsSync(path) ? await latestTask(path) : undefined;
	if (latest !== undefined) {
		if (!current(latest)) {
			const name = latest.kind.slice(PREFIX.length);
			throw new Error(`run ${id} was saved by an earlier version of ${name} and cannot resume`);
		}
		const { input } = latest.input;
		return { store: await openStore(directory, terminal), task: latest.id, input };
	}
	if (source === undefined) throw new Error(`run ${id} has no workflow`);
	await mkdir(directory, { recursive: true });
	let store: Store | undefined;
	try {
		const input = await source();
		store = await openStore(directory, terminal);
		return { store, task: await store.create(input), input };
	} catch (error) {
		await store?.close();
		await rm(directory, { recursive: true, force: true });
		throw error;
	}
}

type Outcome =
	| { readonly status: "completed"; readonly result: JsonValue }
	| { readonly status: "interrupted" }
	| { readonly status: "failed"; readonly error: string };

/**
 * Runs `task` to its end and closes the store. `interrupt` and a failed phase both stop it and leave the task pending;
 * when both happen, the outcome is `interrupted`. Any other error of the wait propagates, and so does a task that ends
 * without completing, which only an abort can do.
 */
async function wait(store: Store, task: TaskId<JsonValue>, interrupt: AbortSignal): Promise<Outcome> {
	let settled: SettledTask<JsonValue> | { readonly failed: string };
	try {
		const settling = store.harness.waitForTask(task, withAbortSignal(interrupt, BACKGROUND_CONTEXT));
		// After a failure, the wait rejects when the store closes.
		settling.catch(() => undefined);
		const failed = store.failure(task).catch((error: Error) => ({ failed: error.message }));
		settled = await Promise.race([settling, failed]);
	} catch (error) {
		if (interrupt.aborted) return { status: "interrupted" };
		throw error;
	} finally {
		await store.close();
	}
	if ("failed" in settled)
		return interrupt.aborted ? { status: "interrupted" } : { status: "failed", error: settled.failed };
	const { outcome } = settled.state;
	if (outcome.status === "completed") return { status: "completed", result: outcome.result };
	throw new Error(`run ended ${outcome.status}`);
}

type Listed = { readonly runId: string; readonly workflow: string; readonly title: string; readonly status: string };

/** Prints the runs, newest run ID first. It reads the task records without a harness, so no run continues. */
async function list(args: readonly string[], terminal: Terminal, json: boolean): Promise<number> {
	if (args.length > 0) throw new UsageError("list takes no arguments");
	const ids = await readdir(runsDirectory()).catch(() => []);
	const runs: Listed[] = [];
	for (const id of ids.sort().reverse()) {
		const path = join(runsDirectory(), id, "durable.sqlite");
		if (!existsSync(path)) continue;
		const latest = await latestTask(path);
		if (latest === undefined || !current(latest)) continue;
		const { input } = latest.input;
		const { state } = latest;
		const finished = state.status === "terminal" && state.outcome.status === "completed";
		const status = finished ? (script.statusOf(state.outcome.result) ?? "done") : "unfinished";
		runs.push({ runId: id, workflow: input.name, title: script.title(input), status });
	}
	if (json) terminal.stdout(JSON.stringify(runs));
	else for (const run of runs) terminal.stdout(`${run.runId} ${run.workflow} ${run.status} ${run.title}`);
	return 0;
}

const PREFIX = "workflows.";

/**
 * The newest workflow task in the store at `path` that no task owns, so not the task of a child run, read from the
 * storage only. Its kind can be one that no installed workflow has, such as a workflow of an earlier version.
 */
async function latestTask(path: string): Promise<TaskRecord<JsonValue, JsonValue, JsonValue> | undefined> {
	const storage = await openNodeSqliteStorage(path);
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
	/**
	 * Rejects with the failure that the script host's `fail` reports for `task`. The task stays pending, so that a
	 * resume runs the failed phase again with its saved calls.
	 */
	failure(task: TaskId): Promise<never>;
	/** A new task of the script workflow. */
	create(input: script.ScriptInput): Promise<TaskId<JsonValue>>;
	close(): Promise<void>;
};

/** Pi's run settings from its `settings.json`, read at every use, with `extensions` as the default selection. */
function piSettings(cwd: string, extensions: readonly Extension[]): HarnessSettings {
	const settings = SettingsManager.create(cwd);
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

/**
 * The `piDurable` entries of the installed packages in Pi's settings for `cwd`, in one shared event bus. Project
 * packages count only when Pi trusts the project. Missing packages are skipped, not installed. Node does not strip
 * types under `node_modules`, so entries of npm packages fail to load.
 */
async function loadEntries(cwd: string): Promise<Entry[]> {
	const agentDir = getAgentDir();
	const settingsManager = SettingsManager.create(cwd, agentDir, {
		projectTrusted: new ProjectTrustStore(agentDir).get(cwd) === true,
	});
	const roots = new Set(
		new DefaultPackageManager({ cwd, agentDir, settingsManager })
			.listConfiguredPackages()
			.flatMap((found) => found.installedPath ?? []),
	);
	const events = createEventBus();
	const entries: Entry[] = [];
	for (const root of roots) {
		const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8").catch(() => "{}")) as {
			readonly piDurable?: { readonly extensions?: readonly string[] };
		};
		for (const path of manifest.piDurable?.extensions ?? []) {
			const entry = await import(pathToFileURL(resolvePath(root, path)).href);
			entries.push(await entry.default({ durable, ai, events }));
		}
	}
	return entries;
}

/**
 * The run's durable store, open with the session tools, the package tools and the script task selected by default,
 * and `workflows-answer` installed. Sessions select it only by name.
 */
async function openStore(directory: string, terminal: Terminal): Promise<Store> {
	// A failure is kept until it is read: a child run can fail before its caller waits for it.
	const failures = new Map<TaskId, PromiseWithResolvers<never>>();
	const failure = (task: TaskId) => {
		let found = failures.get(task);
		if (found === undefined) {
			found = Promise.withResolvers<never>();
			found.promise.catch(() => undefined);
			failures.set(task, found);
		}
		return found;
	};
	const host = {
		log: terminal.stderr,
		fail: (task: TaskId, message: string) => failure(task).reject(new Error(message)),
		failure: (task: TaskId) => failure(task).promise,
	};
	const task = scriptTask(host);
	const registry = createRegistry();
	const entries = await loadEntries(terminal.cwd);
	const selected = [
		Sessions,
		...entries.flatMap((entry) => entry.extensions),
		defineExtension({ name: "workflows", tasks: [task] }),
	];
	for (const extension of selected) registry.install(extension);
	registry.install(answerExtension);
	const envs = new Map<string, NodeExecutionEnv>();
	const warn = (error: unknown) =>
		terminal.stderr(`warning: ${error instanceof Error ? error.message : String(error)}`);
	const harness = await Harness.open(
		await openNodeSqliteStorage(join(directory, "durable.sqlite")),
		{
			models: terminal.models,
			registry,
			settings: piSettings(terminal.cwd, selected),
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
	let closed: Promise<void> | undefined;
	const close = async () => {
		// Entries close first: an entry may still need the open harness.
		for (const result of await Promise.allSettled(entries.map((entry) => entry.close()))) {
			if (result.status === "rejected") warn(result.reason);
		}
		await harness.close(BACKGROUND_CONTEXT);
		for (const env of envs.values()) await env.cleanup(BACKGROUND_CONTEXT);
	};
	return {
		harness,
		failure: host.failure,
		create: async (input) => {
			const stored: TaskInput = { input };
			const root = await harness.root(BACKGROUND_CONTEXT);
			return root.commit(
				(tx) => tx.createTask(task, stored, { ownership: { kind: "conversation" } }),
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
 * Runs the task to its end and reports it; Ctrl+C and a failed phase close the store with the task still
 * pending.
 */
async function follow(
	store: Store,
	task: TaskId<JsonValue>,
	input: script.ScriptInput,
	id: string,
	terminal: Terminal,
	json: boolean,
): Promise<number> {
	// With `--json`, the outcome line replaces the footer lines on stderr, so each stderr line is a step.
	const end = (
		status: "finished" | "failed" | "interrupted",
		rest: { result?: JsonValue; report?: string[]; error?: string },
		...footer: string[]
	) => {
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
	if (!json) return script.report(input, outcome.result, terminal);
	const report: string[] = [];
	const code = script.report(input, outcome.result, { ...terminal, stdout: (line) => report.push(line) });
	end("finished", { result: outcome.result, report });
	return code;
}
