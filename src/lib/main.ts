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
import type { Models, Provider } from "@earendil-works/pi-ai/models";
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
import { check, childInput, help, listScripts, type ScriptInput, script } from "./meta.ts";
import { newRunId } from "./run-id.ts";
import {
	type Checkpoint,
	type ChildRequest,
	type Io,
	type Stored,
	taskKind,
	UsageError,
	workflowTask,
} from "./workflow.ts";

export type Terminal = Io & {
	readonly models: Models;
	/** Adds a provider to `models`. */
	addProvider(provider: Provider): void;
	/** Aborted by Ctrl+C: the run stops where it is and stays resumable. */
	readonly interrupt: AbortSignal;
};

/** The exit code: 0 for a successful result, 1 for any other result or error, 2 for bad usage, 130 when interrupted. */
export async function main(argv: readonly string[], terminal: Terminal): Promise<number> {
	const usage = [
		`${script.usage} [--json]`,
		"workflows <workflow> --help",
		"workflows resume <run-id> [--json]",
		"workflows list [--json]",
		"workflows check <workflow>",
		"workflows",
	]
		.map((line, index) => `${index === 0 ? "usage: " : "       "}${line}`)
		.join("\n");
	for (const provider of script.providers ?? []) terminal.addProvider(provider);
	try {
		const dashes = argv.indexOf("--");
		const options = dashes === -1 ? argv.length : dashes;
		const json = argv.slice(0, options).includes("--json");
		const [command, ...args] = argv.filter((arg, index) => index >= options || arg !== "--json");
		if (command === undefined) {
			for (const line of await listScripts(terminal)) terminal.stdout(line);
			return 0;
		}
		if (command === "list") return await list(args, terminal, json);
		if (command === "resume") return await resume(args, terminal, json);
		if (command === "check") return await check(args, terminal);
		const flags = args.indexOf("--");
		if (args.slice(0, flags === -1 ? args.length : flags).includes("--help")) {
			for (const line of await help(command, terminal)) terminal.stdout(line);
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
	await mkdir(directory, { recursive: true });
	let store: Store | undefined;
	let task: TaskId<JsonValue>;
	let input: ScriptInput;
	try {
		input = await script.prepare(parsed, { id, directory, cwd: terminal.cwd });
		const opened = await openStore(directory, terminal);
		store = opened;
		task = await opened.create(input);
	} catch (error) {
		await store?.close();
		await rm(directory, { recursive: true, force: true });
		throw error;
	}
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
	const latest = await latestTask(join(directory, "durable.sqlite"));
	const store = await openStore(directory, terminal);
	try {
		const { task, input } = await continueRun(store, latest, id);
		terminal.stdout(`run ${id}`);
		return await follow(store, task, input, id, terminal, json);
	} finally {
		await store.close();
	}
}

/**
 * The task that continues the run `id`, whose newest task is `latest`: that task, or a new task from the checkpoint of
 * a failed phase. Throws for a run without a task, or one that an earlier version saved.
 */
async function continueRun(
	store: Store,
	latest: TaskRecord<JsonValue, JsonValue, JsonValue> | undefined,
	id: string,
): Promise<{ task: TaskId<JsonValue>; input: ScriptInput }> {
	if (latest === undefined) throw new Error(`run ${id} has no workflow`);
	if (!current(latest)) {
		const name = latest.kind.slice(PREFIX.length);
		throw new Error(`run ${id} was saved by an earlier version of ${name} and cannot resume`);
	}
	const from = failedAt(latest);
	const input = (latest.input as Stored).input as ScriptInput;
	const task = from === undefined ? latest.id : await store.create(input, from);
	return { task, input };
}

/** Whether the current script workflow can continue the task `latest`. */
function current(latest: TaskRecord<JsonValue, JsonValue, JsonValue>): boolean {
	return latest.kind === taskKind(script) && latest.version >= script.version;
}

/** The open store and the task of the child run of `request`: a new run, or the run that an earlier call started. */
async function openChild(
	request: ChildRequest,
	terminal: Terminal,
): Promise<{ store: Store; task: TaskId<JsonValue> }> {
	const { id } = request;
	const directory = join(runsDirectory(), id);
	const path = join(directory, "durable.sqlite");
	const latest = existsSync(path) ? await latestTask(path) : undefined;
	let store: Store | undefined;
	try {
		if (latest !== undefined) {
			store = await openStore(directory, terminal);
			return { store, task: (await continueRun(store, latest, id)).task };
		}
		await mkdir(directory, { recursive: true });
		const input = await childInput(request, { id, directory, cwd: request.cwd });
		store = await openStore(directory, terminal);
		return { store, task: await store.create(input) };
	} catch (error) {
		await store?.close();
		if (latest === undefined) await rm(directory, { recursive: true, force: true });
		throw error;
	}
}

/** The child run of `request`, run to its end in this process; see `ExtensionHost.child`. */
async function runChild(
	request: ChildRequest,
	signal: AbortSignal | undefined,
	terminal: Terminal,
): Promise<JsonValue> {
	const { store, task } = await openChild(request, terminal);
	const failed = (reason: unknown) => new Error(`child run ${request.id} failed: ${reason}`);
	let settled: SettledTask<JsonValue>;
	try {
		const stop = AbortSignal.any(signal === undefined ? [store.failed] : [signal, store.failed]);
		settled = await store.harness.waitForTask(task, withAbortSignal(stop, BACKGROUND_CONTEXT));
	} catch (error) {
		if (store.failed.aborted && !signal?.aborted) throw failed(store.failed.reason);
		throw error;
	} finally {
		await store.close();
	}
	const { outcome } = settled.state;
	if (outcome.status !== "completed") throw failed(outcome.error?.message ?? outcome.reason ?? outcome.status);
	return outcome.result;
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
		const input = (latest.input as Stored).input as ScriptInput;
		let title = "";
		let name = script.name;
		try {
			title = script.title(input);
			name = script.label?.(input) ?? name;
		} catch {
			// An input saved by an earlier version can lack what `title` and `label` read.
		}
		const { state } = latest;
		const finished = state.status === "terminal" && state.outcome.status === "completed";
		const status = finished ? (script.status?.(state.outcome.result) ?? "done") : "unfinished";
		runs.push({ runId: id, workflow: name, title, status });
	}
	if (json) terminal.stdout(JSON.stringify(runs));
	else for (const run of runs) terminal.stdout(`${run.runId} ${run.workflow} ${run.status} ${run.title}`);
	return 0;
}

const PREFIX = "workflows.";

/**
 * The newest workflow task in the store at `path`, read from the storage only. Its kind can be one that no installed
 * workflow has, such as a workflow of an earlier version.
 */
async function latestTask(path: string): Promise<TaskRecord<JsonValue, JsonValue, JsonValue> | undefined> {
	const storage = await openNodeSqliteStorage(path);
	try {
		let latest: TaskRecord<JsonValue, JsonValue, JsonValue> | undefined;
		let cursor: Cursor | undefined;
		do {
			const page = await storage.scanTasks({}, 256, cursor, BACKGROUND_CONTEXT);
			for (const task of page.items) if (task.kind.startsWith(PREFIX)) latest = task;
			cursor = page.next;
		} while (cursor !== undefined);
		return latest;
	} finally {
		await storage.close(BACKGROUND_CONTEXT);
	}
}

/** The checkpoint of a failed phase, which a resume runs again. */
function failedAt(task: TaskRecord<JsonValue, JsonValue, JsonValue>): Checkpoint | undefined {
	if (task.state.status !== "terminal" || task.state.outcome.status !== "failed") return undefined;
	const detail = task.state.outcome.error.detail as { readonly from?: Checkpoint } | undefined;
	return detail?.from;
}

type Store = {
	readonly harness: Harness;
	/**
	 * Aborted with the message of a workflow extension's `fail`. The task stays pending, because a resume after a failed
	 * task starts a new task, and work saved under the old one would run again.
	 */
	readonly failed: AbortSignal;
	/** A new task of the script workflow; `from` is the checkpoint of a failed phase. */
	create(input: ScriptInput, from?: Checkpoint): Promise<TaskId<JsonValue>>;
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
 * and the extensions of the script workflow installed. Sessions select those only by name.
 */
async function openStore(directory: string, terminal: Terminal): Promise<Store> {
	const registry = createRegistry();
	const entries = await loadEntries(terminal.cwd);
	const task = workflowTask(script, terminal.stderr);
	const selected = [
		Sessions,
		...entries.flatMap((entry) => entry.extensions),
		defineExtension({ name: "workflows", tasks: [task] }),
	];
	for (const extension of selected) registry.install(extension);
	const failure = new AbortController();
	const host = {
		runId: basename(directory),
		runDir: directory,
		log: terminal.stderr,
		fail: (message: string) => failure.abort(message),
		child: (request: ChildRequest, signal: AbortSignal | undefined) => runChild(request, signal, terminal),
	};
	for (const extension of script.extensions?.(host) ?? []) registry.install(extension);
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
		failed: failure.signal,
		create: async (input, from) => {
			const stored: Stored = { input, ...(from === undefined ? {} : { from }) };
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
 * Runs the task to its end and reports it; Ctrl+C and a failed workflow script close the store with the task still
 * pending.
 */
async function follow(
	store: Store,
	task: TaskId<JsonValue>,
	input: ScriptInput,
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
	const failed = (message: unknown, resumable: boolean) => {
		const footer = [`failed ${script.title(input)}: ${message}`];
		if (resumable) footer.push(`continue with: workflows resume ${id}`);
		end("failed", { error: String(message) }, ...footer);
		return 1;
	};
	let settled: SettledTask<JsonValue>;
	try {
		const signal = AbortSignal.any([terminal.interrupt, store.failed]);
		settled = await store.harness.waitForTask(task, withAbortSignal(signal, BACKGROUND_CONTEXT));
	} catch (error) {
		if (store.failed.aborted && !terminal.interrupt.aborted) return failed(store.failed.reason, true);
		if (!terminal.interrupt.aborted) {
			end("failed", { error: error instanceof Error ? error.message : String(error) });
			throw error;
		}
		end("interrupted", {}, `interrupted; continue with: workflows resume ${id}`);
		return 130;
	} finally {
		await store.close();
	}
	const { outcome } = settled.state;
	if (outcome.status === "completed") {
		if (!json) return script.report(input, outcome.result, terminal);
		const report: string[] = [];
		const code = script.report(input, outcome.result, { ...terminal, stdout: (line) => report.push(line) });
		end("finished", { result: outcome.result, report });
		return code;
	}
	return failed(outcome.error?.message ?? outcome.reason ?? outcome.status, outcome.status === "failed");
}
