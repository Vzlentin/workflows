/**
 * The `workflows` command line. `workflows <workflow> ...` starts a run, and `workflows <workflow> resume <run-id>` or
 * `workflows resume <run-id>` continues one. A run directory holds the durable store, which holds everything a resume
 * needs, and whatever the workflow writes there.
 */
import { randomBytes } from "node:crypto";
import { access, mkdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai/models";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import {
	type Cursor,
	createRegistry,
	defineExtension,
	Harness,
	type HarnessSettings,
	type SettledTask,
	type TaskId,
	type TaskRecord,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { Sessions } from "./agents.ts";
import {
	type AnyWorkflow,
	type Checkpoint,
	type Io,
	type Stored,
	taskKind,
	UsageError,
	workflowTask,
} from "./workflow.ts";

export type Terminal = Io & {
	readonly models: Models;
	/** Aborted by Ctrl+C: the run stops where it is and stays resumable. */
	readonly interrupt: AbortSignal;
};

/** The exit code: 0 for a successful result, 1 for any other result or error, 2 for bad usage, 130 when interrupted. */
export async function main(
	argv: readonly string[],
	terminal: Terminal,
	workflows: readonly AnyWorkflow[],
): Promise<number> {
	const usage = [
		...workflows.map((workflow) => workflow.usage),
		...workflows.map((workflow) => `workflows ${workflow.name} resume <run-id>`),
		"workflows resume <run-id>",
	]
		.map((line, index) => `${index === 0 ? "usage: " : "       "}${line}`)
		.join("\n");
	try {
		const [command, ...args] = argv;
		if (command === "resume") return await resume(args, terminal, workflows, undefined);
		const workflow = workflows.find((candidate) => candidate.name === command);
		if (workflow === undefined) {
			throw new UsageError(command === undefined ? "missing command" : `unknown command ${command}`);
		}
		if (args[0] === "resume") return await resume(args.slice(1), terminal, workflows, workflow);
		return await start(workflow, args, terminal, workflows);
	} catch (error) {
		terminal.stderr(`workflows: ${error instanceof Error ? error.message : String(error)}`);
		if (error instanceof UsageError) {
			terminal.stderr(usage);
			return 2;
		}
		return 1;
	}
}

function runsDirectory(): string {
	const state = process.env.XDG_STATE_HOME || join(homedir(), ".local", "state");
	return join(state, "workflows", "runs");
}

function newRunId(): string {
	const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*$/, "");
	return `${stamp}-${randomBytes(4).toString("hex")}`;
}

async function start(
	workflow: AnyWorkflow,
	args: readonly string[],
	terminal: Terminal,
	workflows: readonly AnyWorkflow[],
): Promise<number> {
	const parsed = await workflow.parse(args, terminal);
	const id = newRunId();
	const directory = join(runsDirectory(), id);
	await mkdir(directory, { recursive: true });
	let store: Store | undefined;
	let task: TaskId<JsonValue>;
	try {
		const input = await workflow.prepare(parsed, { id, directory, cwd: terminal.cwd });
		const opened = await openStore(directory, terminal, workflows);
		store = opened;
		task = await opened.create(workflow, { input });
	} catch (error) {
		await store?.close();
		await rm(directory, { recursive: true, force: true });
		throw error;
	}
	terminal.stdout(`run ${id}`);
	return follow(store, workflow, task, id, terminal);
}

async function resume(
	args: readonly string[],
	terminal: Terminal,
	workflows: readonly AnyWorkflow[],
	expected: AnyWorkflow | undefined,
): Promise<number> {
	const [id, ...rest] = args;
	if (id === undefined || rest.length > 0 || id.startsWith("-")) throw new UsageError("give one run ID");
	if (id.includes("/") || id.includes("\\") || id === "." || id === "..") throw new UsageError(`${id} is not a run ID`);
	const directory = join(runsDirectory(), id);
	await access(join(directory, "durable.sqlite")).catch(() => {
		throw new Error(`no run ${id} in ${runsDirectory()}`);
	});
	const store = await openStore(directory, terminal, workflows);
	try {
		const latest = await store.latest();
		if (latest === undefined) throw new Error(`run ${id} has no workflow`);
		const workflow = workflows.find((candidate) => taskKind(candidate) === latest.kind);
		if (workflow === undefined) throw new Error(`run ${id} is a ${latest.kind} run, which this command cannot run`);
		if (expected !== undefined && expected !== workflow) {
			throw new UsageError(`run ${id} is a ${workflow.name} run; use workflows ${workflow.name} resume ${id}`);
		}
		terminal.stdout(`run ${id}`);
		const from = failedAt(latest);
		const stored = latest.input as Stored;
		const task = from === undefined ? latest.id : await store.create(workflow, { input: stored.input, from });
		return await follow(store, workflow, task, id, terminal);
	} finally {
		await store.close();
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
	create(workflow: AnyWorkflow, stored: Stored): Promise<TaskId<JsonValue>>;
	/** The newest workflow task of the run. */
	latest(): Promise<TaskRecord<JsonValue, JsonValue, JsonValue> | undefined>;
	close(): Promise<void>;
};

/** Pi's run settings from its `settings.json`, read at every use. */
function piSettings(cwd: string): HarnessSettings {
	const settings = SettingsManager.create(cwd);
	return {
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

/** The run's durable store, open with the session tools and every workflow task installed. */
async function openStore(directory: string, terminal: Terminal, workflows: readonly AnyWorkflow[]): Promise<Store> {
	const registry = createRegistry();
	registry.install(Sessions);
	const tasks = workflows.map((workflow) => workflowTask(workflow, terminal.stderr));
	registry.install(defineExtension({ name: "workflows", tasks }));
	const envs = new Map<string, NodeExecutionEnv>();
	const harness = await Harness.open(
		await openNodeSqliteStorage(join(directory, "durable.sqlite")),
		{
			models: terminal.models,
			registry,
			settings: piSettings(terminal.cwd),
			env: ({ cwd }) => {
				if (cwd === undefined) return undefined;
				const found = envs.get(cwd) ?? new NodeExecutionEnv({ cwd });
				envs.set(cwd, found);
				return found;
			},
			onReport: (error) => terminal.stderr(`warning: ${error instanceof Error ? error.message : String(error)}`),
		},
		BACKGROUND_CONTEXT,
	);
	let closed: Promise<void> | undefined;
	const close = async () => {
		await harness.close(BACKGROUND_CONTEXT);
		for (const env of envs.values()) await env.cleanup(BACKGROUND_CONTEXT);
	};
	return {
		harness,
		create: async (workflow, stored) => {
			const task = tasks[workflows.indexOf(workflow)];
			if (task === undefined) throw new Error(`${workflow.name} is not installed`);
			const root = await harness.root(BACKGROUND_CONTEXT);
			return root.commit(
				(tx) => tx.createTask(task, stored, { ownership: { kind: "conversation" } }),
				BACKGROUND_CONTEXT,
			);
		},
		latest: async () => {
			const kinds = new Set(workflows.map(taskKind));
			let latest: TaskRecord<JsonValue, JsonValue, JsonValue> | undefined;
			let cursor: Cursor | undefined;
			do {
				const page = await harness.commit((tx) => tx.scanTasks({}, 256, cursor), BACKGROUND_CONTEXT);
				for (const task of page.items) if (kinds.has(task.kind)) latest = task;
				cursor = page.next;
			} while (cursor !== undefined);
			return latest;
		},
		close: () => {
			closed ??= close();
			return closed;
		},
	};
}

/** Runs the task to its end and reports it; Ctrl+C closes the store with the task still pending. */
async function follow(
	store: Store,
	workflow: AnyWorkflow,
	task: TaskId<JsonValue>,
	id: string,
	terminal: Terminal,
): Promise<number> {
	let settled: SettledTask<JsonValue>;
	try {
		settled = await store.harness.waitForTask(task, withAbortSignal(terminal.interrupt, BACKGROUND_CONTEXT));
	} catch (error) {
		if (!terminal.interrupt.aborted) throw error;
		terminal.stderr(`interrupted; continue with: workflows ${workflow.name} resume ${id}`);
		return 130;
	} finally {
		await store.close();
	}
	const input = (settled.input as Stored).input;
	const { outcome } = settled.state;
	if (outcome.status === "completed") return workflow.report(input, outcome.result, terminal);
	terminal.stderr(`failed ${workflow.title(input)}: ${outcome.error?.message ?? outcome.reason ?? outcome.status}`);
	if (outcome.status === "failed") terminal.stderr(`continue with: workflows ${workflow.name} resume ${id}`);
	return 1;
}
