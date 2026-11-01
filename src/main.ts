/**
 * The `workflows` command line, a client of the harness host of a project. `workflows <workflow> ...` starts a run of a
 * workflow script in the host and follows it, `workflows resume <run-id>` continues or follows one, `workflows wait
 * <run-id>` follows one to its outcome, `workflows stop <run-id>` stops one, `workflows list` prints the runs of the
 * project, `workflows show <run-id>` prints the steps or the calls of one run, `workflows attach <run-id>` opens a
 * session of one run in Pi, and `workflows save <run-id> <name>` keeps the script of one run as a project workflow;
 * `workflows prune` removes the worktrees of the ended runs whose branch GitHub merged. The project store holds the runs; a run directory
 * holds the run's `project` file and whatever the workflow writes there.
 */
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai/models";
import type { TaskOutcome, TaskRecord } from "@earendil-works/pi-durable";
import { type Client, connect } from "@vzlentin/harness/client";
import { setEntry } from "@vzlentin/harness/entries";
import { openConversationPane } from "@vzlentin/harness/herdr";
import { resolveProject } from "@vzlentin/harness/projects";
import { cliPath, statePaths, type TaskInfo } from "@vzlentin/harness/protocol";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { agentLines, agentRows, callTree, type Shown, showEntries, type TreeEntry, treeLines } from "./calls.ts";
import { CHECK, check } from "./cli/commands/check.ts";
import { failure, git, gitSucceeds, run as runCommand } from "./git.ts";
import { herdrPlace, removedByHerdr } from "./herdr.ts";
import { newRunId, parse, prepare, type ScriptInput, USAGE } from "./launch/input.ts";
import { repositoryAt, type Worktree } from "./launch/worktree.ts";
import type { RunTask } from "./past.ts";
import type { PickItem } from "./pick.ts";
import { display, type Mark, Progress, type ProgressEvent, programStatus } from "./progress.ts";
import { reportOf, statusOf, title as titleOf } from "./run/result.ts";
import type { SavedCall } from "./script.ts";
import {
	callRecords,
	inputString,
	inputWorktree,
	openStore,
	progressEvents,
	reading,
	runTasks,
	type Store,
} from "./store.ts";
import { current, TASK } from "./task.ts";
import { loadScripts, projectFolder } from "./workflow/bundle.ts";
import { help, type Io, listScripts, parseArgsMessage, UsageError, withUsage } from "./workflow/find.ts";

/**
 * The entry of workflows that the harness host loads: `dist/entry.js`, or `src/entry.ts` in a checkout. The command sets
 * it in harness's `entries.json` before it can start a host.
 */
const ENTRY = fileURLToPath(new URL(import.meta.url.endsWith(".ts") ? "./entry.ts" : "./entry.js", import.meta.url));

/** The part of the `package.json` of workflows that `--version` reads. */
const MANIFEST = Type.Object({ version: Type.String() });

/** How often the command reads the progress of a run that it follows. */
const POLL_MS = 500;

/** How long a command that Ctrl+C detached waits for a second Ctrl+C, which stops the run. */
const STOP_WINDOW_MS = 2000;

/** The error of harness's client when the host closes the connection, such as when it stops. */
const HOST_CLOSED = "The harness host closed the connection";

/**
 * A question with `items` to pick one of, on a terminal: the value of the item, or undefined when cancelled. Only an
 * item with a value can be taken, and the cursor starts on the first one. While it waits for a key, it calls `refresh`
 * every second for new items, and keeps the cursor on the same item.
 */
export type Choose = <V>(
	question: string,
	items: readonly PickItem<V>[],
	refresh?: () => Promise<readonly PickItem<V>[]>,
) => Promise<V | undefined>;

export type Terminal = Io & {
	/** Aborted by the first Ctrl+C: the command detaches, and the run goes on in the host. */
	readonly interrupt: AbortSignal;
	/** Aborted by a second Ctrl+C while the command follows a run: the command stops the run. */
	readonly stop: AbortSignal;
	/** Tells whether the command follows a run, so that a second Ctrl+C stops the run rather than exits. */
	readonly following: (active: boolean) => void;
	/** How long a command that Ctrl+C detached waits for a second Ctrl+C. Default 2 s. */
	readonly stopWindowMs?: number;
	/** Writes an OSC 7501 program status report to the terminal, when stderr is one. */
	readonly status?: ((report: string) => void) | undefined;
	/**
	 * Reads one typed line, or gives undefined at Ctrl+C or at the end of input. Given only when stdin and stderr are
	 * terminals.
	 */
	readonly readLine?: (() => Promise<string | undefined>) | undefined;
	/** Asks which of `items` to take, and gives its value, or undefined when cancelled. Given only on a terminal. */
	readonly choose?: Choose | undefined;
	/** Pi's model registry, for `check`. */
	readonly models: () => Promise<Models>;
	/**
	 * Connects to the host of `project`. With `start`, it starts the host when none runs; without, it gives undefined
	 * then. Default: harness's client.
	 */
	readonly connect?: (project: string, start: boolean) => Promise<Client | undefined>;
};

const RESUME = "workflows resume <run-id> [--answer <text>] [--background] [--json]";
const WAIT = "workflows wait <run-id> [--json]";
const STOP = "workflows stop <run-id> [--json]";
const LIST = "workflows list [--pick] [--json]";
const SHOW = "workflows show <run-id> [--pick | [--calls | --agents] [--json]]";
const ATTACH = "workflows attach <run-id> [--conversation <id>] [--side]";
const SAVE = "workflows save <run-id> <name> [--force]";
const PRUNE = "workflows prune [--yes] [--install-hook] [--json]";

type Command = (args: readonly string[], terminal: Terminal, json: boolean, background: boolean) => Promise<number>;

/** The commands by name. No script can have one of these names. */
const COMMANDS = new Map<string, Command>([
	["list", list],
	["resume", resume],
	["wait", (args, terminal, json) => resume(args, terminal, json, false, true)],
	["stop", stop],
	["show", show],
	["attach", attach],
	["save", save],
	["prune", prune],
	["check", check],
]);

/**
 * The exit code: 0 for a successful result, 1 for any other result or error, 2 for bad usage, 3 for a run that waits
 * for an answer, 130 after Ctrl+C.
 */
export async function main(argv: readonly string[], terminal: Terminal): Promise<number> {
	const usage = [
		`${USAGE} [--background] [--json]`,
		"workflows <workflow> --help",
		RESUME,
		WAIT,
		STOP,
		LIST,
		SHOW,
		ATTACH,
		SAVE,
		PRUNE,
		CHECK,
		"workflows --version",
		"workflows",
	]
		.map((line, index) => `${index === 0 ? "usage: " : "       "}${line}`)
		.join("\n");

	try {
		const dashes = argv.indexOf("--");
		const options = dashes === -1 ? argv.length : dashes;
		const json = argv.slice(0, options).includes("--json");
		const background = argv.slice(0, options).includes("--background");

		const [command, ...args] = argv.filter(
			(arg, index) => index >= options || (arg !== "--json" && arg !== "--background"),
		);

		if (command === undefined) {
			for (const line of await listScripts(terminal)) terminal.stdout(line);

			return 0;
		}

		if (command === "--version") {
			const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
			terminal.stdout(Value.Parse(MANIFEST, manifest).version);

			return 0;
		}

		const run = COMMANDS.get(command);

		if (run !== undefined) return await run(args, terminal, json, background);
		const flags = args.indexOf("--");

		if (args.slice(0, flags === -1 ? args.length : flags).includes("--help")) {
			for (const line of await help(command, terminal)) terminal.stdout(line);

			return 0;
		}

		return await start([command, ...args], terminal, json, background);
	} catch (error) {
		terminal.stderr(`workflows: ${error instanceof Error ? error.message : String(error)}`);

		if (error instanceof UsageError || parseArgsMessage(error) !== undefined) {
			terminal.stderr(error instanceof UsageError && error.usage !== undefined ? `usage: ${error.usage}` : usage);

			return 2;
		}

		return 1;
	}
}

/** The project of `cwd`, as harness routes a client there. */
async function projectOf(cwd: string): Promise<string> {
	return resolveProject(process.env, cwd);
}

/** The project store of `project`. */
async function storeOf(project: string): Promise<string> {
	return join(statePaths(project).dir, "durable.sqlite");
}

/**
 * A connection to the host of `project`. With `start`, it starts the host when none runs; without, it is undefined
 * then. harness's client reads the project from `HARNESS_PROJECT`.
 */
async function connectTo(terminal: Terminal, project: string, start: true): Promise<Client>;
async function connectTo(terminal: Terminal, project: string, start: boolean): Promise<Client | undefined>;
async function connectTo(terminal: Terminal, project: string, start: boolean): Promise<Client | undefined> {
	// A host that starts from here loads this entry. A host that runs already loads it only after it starts again.
	if (start) setEntry("workflows", ENTRY);
	const connected = await connectOrNot(terminal, project, start);

	if (start && connected === undefined) throw new Error(`no harness host for ${project}`);

	return connected;
}

async function connectOrNot(terminal: Terminal, project: string, start: boolean): Promise<Client | undefined> {
	if (terminal.connect !== undefined) return terminal.connect(project, start);
	const saved = process.env.HARNESS_PROJECT;
	process.env.HARNESS_PROJECT = project;

	try {
		return await connect({ start });
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

/** An error after which the host has no task of the request, or none that runs. */
class Refused extends Error {}

/** Starts the task of `key` with `input` in the host of `client`, and checks the version of the host's task. */
async function startTask(client: Client, project: string, input: ScriptInput, key: string): Promise<void> {
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
function checkVersion(client: Client, project: string, info: TaskInfo): void {
	if (info.version === TASK.version) return;
	throw new Refused(
		`This host ran version ${info.version} of ${TASK.name}, not ${TASK.version}: stop the host so it starts again with the installed version (${hostOf(client, project)})`,
	);
}

/** The info of the task of `key` in the host of `project`, undefined when the host has no such task. */
async function findTask(terminal: Terminal, project: string, key: string): Promise<TaskInfo | undefined> {
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

async function start(args: readonly string[], terminal: Terminal, json: boolean, background: boolean): Promise<number> {
	const parsed = await parse(args, terminal);
	const id = newRunId();
	const directory = join(runsDirectory(), id);
	const project = await projectOf(terminal.cwd);
	const key = taskKey(id, 1);
	await mkdir(directory, { recursive: true });
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
		await writeFile(join(directory, "project"), `${project}\n`);
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
			// The host may have created the task before the error, such as a closed connection, so the run may exist.
			const message = error instanceof Error ? error.message : String(error);
			const found = await findTask(terminal, project, key).catch(() => null);

			if (found === null) throw new Error(`${message}; run ${id} may have started: workflows resume ${id}`);

			if (found !== undefined) {
				const again = await connectTo(terminal, project, true);

				try {
					checkVersion(again, project, found);
				} catch (refused) {
					again.close();
					throw refused;
				}

				terminal.following(true);
				terminal.stdout(`run ${id}`);

				return follow({ id, project, key, input, client: again, from: 0 }, terminal, json, background);
			}
		}

		await rm(directory, { recursive: true, force: true });

		if (!terminal.interrupt.aborted) throw error;
		terminal.stderr("workflows: interrupted before the run started");

		return 130;
	}

	terminal.stdout(`run ${id}`);

	return follow({ id, project, key, input, client, from: 0 }, terminal, json, background);
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

/** The root tasks of `run`, oldest first. */
function tasksOf(run: SavedRun): Promise<RunTask[]> {
	return reading(run.store, [], async (store) => (await runTasks(store)).get(run.id) ?? []);
}

/**
 * The task of a run that the commands go by: its last task, unless that is a task of another version that ended after
 * a task of this version, as when the command refused the host's version and aborted it; then the last task of this
 * version.
 */
function taskOf(tasks: readonly RunTask[]): RunTask | undefined {
	const latest = tasks.at(-1);

	if (latest === undefined || current(latest) || latest.state.status !== "terminal") return latest;

	return tasks.findLast(current) ?? latest;
}

/** The status of a run whose task is `task`, for `list` and `show`. */
function runStatus(task: RunTask): string {
	const { state } = task;

	if (state.status !== "terminal") {
		if (current(task)) return "running";

		return savedBy(task).later ? "later-version" : "earlier-version";
	}

	const { outcome } = state;

	if (outcome.status === "completed") return statusOf(outcome.result) ?? "done";

	return outcome.status === "aborted" ? "stopped" : outcome.status;
}

/** The progress events of the root run `run`. */
function progressOf(run: SavedRun): Promise<readonly ProgressEvent[]> {
	return reading(run.store, [], (store) => progressEvents(store, run.id));
}

/**
 * Continues the run of `args`. A finished run prints its result. A run whose last task ended without a result continues
 * in a new task with the same input, and shows the progress from its start. A run that waits for an answer continues
 * in a new task with the answer of `--answer` to its open `input` call. A run whose last task did not end is
 * followed: with its host running, from the start of the task's current execution, else from when the host starts.
 * With `wait`, an ended run prints its outcome from the store, and Ctrl+C never stops the run.
 */
async function resume(
	args: readonly string[],
	terminal: Terminal,
	json: boolean,
	background: boolean,
	wait = false,
): Promise<number> {
	const usage = wait ? WAIT : RESUME;
	const { id, answer } = wait ? { id: oneRunId(args, usage), answer: undefined } : resumeArgs(args);
	const run = await savedRun(id, usage);
	const tasks = await tasksOf(run);
	const { input: last, state } = checked(taskOf(tasks), run.id, wait ? "be waited for" : "resume");

	const waiting =
		state.status === "terminal" && state.outcome.status === "completed" && statusOf(state.outcome.result) === "waiting";

	if (answer !== undefined && !waiting) throw new UsageError(`run ${run.id} does not wait for an answer`, RESUME);

	if (waiting && answer === undefined && !wait && !json && !background && terminal.readLine !== undefined) {
		terminal.stdout(`run ${run.id}`);
		let first: string | undefined;

		const keep = (print: (line: string) => void) => (line: string) => {
			first ??= line;
			print(line);
		};

		outcomeOf(
			last,
			run.id,
			state.outcome,
			{ ...terminal, stdout: keep(terminal.stdout), stderr: keep(terminal.stderr) },
			json,
			await progressOf(run),
		);
		terminal.status?.(programStatus("blocked", first ?? "", "question"));

		return answering(run.id, terminal);
	}

	if (state.status === "terminal" && answer === undefined && (wait || state.outcome.status === "completed")) {
		terminal.stdout(`run ${run.id}`);

		return outcomeOf(last, run.id, state.outcome, terminal, json, await progressOf(run));
	}

	const input = answer === undefined ? last : { ...last, answer: { call: await openInput(run), text: answer } };
	const ended = tasks.at(-1)?.state.status === "terminal";
	const key = taskKey(run.id, tasks.length + (ended ? 1 : 0));

	// A wait never tells the terminal that it follows a run, so a second Ctrl+C exits rather than stops the run. It
	// never asks for the answer of a waiting run.
	const followed: Terminal = wait
		? { ...terminal, following: () => {}, stopWindowMs: 0, readLine: undefined }
		: terminal;

	followed.following(true);
	let client: Client | undefined;
	let from: number;

	try {
		if (ended) {
			from = (await progressOf(run)).length;
			client = await connectTo(terminal, run.project, true);
			// The new task posts its outcome only when this resume runs in the background, whatever the last task did.
			const { notify: _ended, ...saved } = input;
			await startTask(client, run.project, background ? { ...saved, notify: true } : saved, key);
		} else {
			const before = (await progressOf(run)).length;
			client = await connectTo(terminal, run.project, false);

			if (client === undefined) {
				from = before;
				client = await connectTo(terminal, run.project, true);
			} else {
				const events = await progressOf(run);
				const started = events.findLastIndex((event) => event.kind === "start" && event.run === run.id);
				from = started === -1 ? events.length : started;
			}

			checkVersion(client, run.project, await client.request({ type: "task", key }));
		}
	} catch (error) {
		client?.close();
		followed.following(false);
		throw error;
	}

	terminal.stdout(`run ${run.id}`);

	// A wait shows every step of the run, from its first execution.
	return follow(
		{ id: run.id, project: run.project, key, input, client, from: wait ? 0 : from },
		followed,
		json,
		background,
	);
}

/** The run ID and the `--answer` of the args of `resume`. */
function resumeArgs(args: readonly string[]) {
	const { values, positionals } = withUsage(
		() => parseArgs({ args: [...args], options: { answer: { type: "string" } }, allowPositionals: true, strict: true }),
		RESUME,
	);

	return { id: oneRunId(positionals, RESUME), answer: values.answer };
}

/** The document key of the `input` call that the run waits for an answer to: the last one that started and did not end. */
async function openInput(run: SavedRun): Promise<string> {
	const records = await reading(run.store, new Map(), (store) => callRecords(store, run.id));

	const open = [...records]
		.filter(([key, record]) => key.startsWith(`${run.id}/`) && record.kind === "input" && record.endedAt === undefined)
		.sort(([, a], [, b]) => a.startedAt.localeCompare(b.startedAt));

	const [key] = open.at(-1) ?? [];

	if (key === undefined) throw new Error(`run ${run.id} has no open input call`);

	return key;
}

/**
 * Stops the run of `args` in its host. Its task ends as stopped, and a resume continues it. A pending task of another
 * version, which no host can run, ends as orphaned.
 */
async function stop(args: readonly string[], terminal: Terminal, json: boolean): Promise<number> {
	const run = await savedRun(oneRunId(args, STOP), STOP);
	const tasks = await tasksOf(run);
	const latest = tasks.at(-1);

	if (latest === undefined) throw new Error(`run ${run.id} has no workflow`);

	if (latest.state.status === "terminal") throw new Error(`run ${run.id} is not running`);
	const outcome = await abortRun(terminal, run.project, taskKey(run.id, tasks.length));

	if (outcome?.status !== "aborted" && outcome?.status !== "orphaned") throw new Error(`run ${run.id} is not running`);

	if (json) terminal.stdout(JSON.stringify({ runId: run.id, status: "stopped" }));
	else if (current(latest)) {
		const title = titleOf(latest.input, await progressOf(run));
		terminal.stdout(`stopped ${title}; continue with: workflows resume ${run.id}`);
	} else {
		const { name, later } = savedBy(latest);
		terminal.stdout(`stopped ${name}, which ${later ? "a later" : "an earlier"} version saved; it cannot resume`);
	}

	return 0;
}

/** Aborts the task of `key` in the host of `project`, and gives its outcome once it ended. */
async function abortRun(terminal: Terminal, project: string, key: string): Promise<TaskInfo["outcome"]> {
	const client = await connectTo(terminal, project, true);

	try {
		await client.request({ type: "abort-task", key });

		return (await client.request({ type: "wait-task", key })).outcome;
	} finally {
		client.close();
	}
}

type Listed = {
	readonly runId: string;
	readonly workflow: string;
	readonly title: string;
	readonly status: string;
	readonly repository: string | null;
};

/**
 * Prints the runs of the project of the current directory that have a run directory, newest run ID first. It reads the
 * project store only.
 */
async function list(args: readonly string[], terminal: Terminal, json: boolean): Promise<number> {
	const pick = args[0] === "--pick";

	if (args.length > Number(pick)) throw new UsageError("list takes no arguments but --pick", LIST);

	if (pick) {
		if (terminal.choose === undefined) throw new UsageError("--pick needs a terminal on stdin and stderr", LIST);
		const run = await pickRun(terminal, terminal.choose);

		if (run === undefined) return 130;
		terminal.stdout(run);

		return 0;
	}

	const listed = await reading(await storeOf(await projectOf(terminal.cwd)), [], listedRuns);

	if (json) terminal.stdout(JSON.stringify(listed));
	else for (const run of listed) terminal.stdout(`${run.runId} ${run.workflow} ${run.status} ${run.title}`);

	return 0;
}

/** The runs of the open project store `store` that have a run directory, newest run ID first. */
async function listedRuns(store: Store): Promise<Listed[]> {
	const runs = await runTasks(store);
	const listed: Listed[] = [];

	for (const [id, tasks] of [...runs].sort(([a], [b]) => b.localeCompare(a))) {
		const task = taskOf(tasks);

		if (task === undefined || !existsSync(join(runsDirectory(), id, "project"))) continue;
		const status = runStatus(task);
		const repository = inputWorktree(task.input)?.repository ?? null;

		if (current(task)) {
			const title = titleOf(task.input, await progressEvents(store, id));
			listed.push({ runId: id, workflow: task.input.name, title, status, repository });
		} else listed.push({ runId: id, workflow: savedBy(task).name, title: savedBy(task).name, status, repository });
	}

	return listed;
}

/**
 * Asks on the terminal which run of the project of the current directory to take, and gives its run ID, or undefined
 * when the person cancels. The runs that have not ended come first, each with the steps that run now. While it waits,
 * it reads the runs again every second.
 */
async function pickRun(terminal: Terminal, choose: Choose): Promise<string | undefined> {
	const items = await runItems(terminal);

	if (items.length === 0) throw new Error(`no runs in the project of ${terminal.cwd}`);

	return choose("Pick a run:", items, () => runItems(terminal));
}

/** The items of the run picker, from the project store of the current directory, each with its run ID as its value. */
async function runItems(terminal: Terminal): Promise<PickItem<string>[]> {
	const empty = { runs: [], steps: new Map<string, string>() };

	const { runs, steps } = await reading(await storeOf(await projectOf(terminal.cwd)), empty, async (store) => {
		const live = (run: Listed) => run.status === "running" || run.status === "waiting";
		// A stable sort keeps the newest first within each group.
		const sorted = (await listedRuns(store)).toSorted((a, b) => Number(live(b)) - Number(live(a)));
		const found = new Map<string, string>();

		for (const run of sorted.filter((each) => each.status === "running")) {
			const progress = new Progress();

			for (const event of await progressEvents(store, run.runId)) progress.add(event);
			const status = progress.status();

			if (status !== undefined) found.set(run.runId, status);
		}

		return { runs: sorted, steps: found };
	});

	return runs.map((run) => {
		const step = steps.get(run.runId);
		const text = `${markOf(run.status)} ${run.title}  ${run.workflow} ${run.status}${step === undefined ? "" : `: ${step}`}`;

		return { text, value: run.runId };
	});
}

/** The mark of a run in the picker by its status: `◉` running, `?` waiting for an answer, `✗` failed, else `·`. */
function markOf(status: string): Mark | "?" | "·" {
	if (status === "running") return "◉";

	if (status === "waiting") return "?";

	return status === "failed" || status === "faulted" ? "✗" : "·";
}

/** The line of the post-merge hook that `prune --install-hook` writes. */
const HOOK_LINE = "workflows prune --yes >/dev/null 2>&1 &";

type Prunable = { readonly runId: string; readonly branch: string; readonly worktree: Worktree };

/**
 * Prints the ended runs of the project of the current directory whose worktree is on a branch that GitHub merged. With
 * `--yes`, it removes their worktrees and branches. With `--install-hook`, it writes a post-merge hook that runs
 * `prune --yes`. It reads the project store only, and runs every `gh` call before it removes anything.
 */
async function prune(args: readonly string[], terminal: Terminal, json: boolean): Promise<number> {
	const { values } = withUsage(
		() =>
			parseArgs({
				args: [...args],
				options: { yes: { type: "boolean" }, "install-hook": { type: "boolean" } },
				strict: true,
			}),
		PRUNE,
	);

	if (values["install-hook"]) return installHook(terminal);
	const store = await storeOf(await projectOf(terminal.cwd));
	const runs = await reading(store, new Map<string, RunTask[]>(), runTasks);
	const merged: Prunable[] = [];

	for (const [id, tasks] of [...runs].sort(([a], [b]) => b.localeCompare(a))) {
		const found = await prunable(id, tasks);

		if (found !== undefined && (await isMerged(found))) merged.push(found);
	}

	const line = ({ runId, branch, worktree }: Prunable) => `${runId} ${branch} ${worktree.path}`;

	for (const found of merged) {
		if (values.yes) await removeWorktree(found);

		if (!json) terminal.stdout(line(found));
	}

	if (json)
		terminal.stdout(
			JSON.stringify(merged.map(({ runId, branch, worktree }) => ({ runId, branch, worktree: worktree.path }))),
		);

	return 0;
}

/**
 * The run `id` with `tasks` when it has a run directory, has ended, was saved by this or an earlier version, and has a
 * worktree on a branch.
 */
async function prunable(id: string, tasks: readonly RunTask[]): Promise<Prunable | undefined> {
	if (!existsSync(join(runsDirectory(), id, "project"))) return undefined;

	if (tasks.at(-1)?.state.status !== "terminal") return undefined;
	const task = taskOf(tasks);

	if (task === undefined || savedBy(task).later) return undefined;
	const worktree = inputWorktree(task.input);

	if (worktree === undefined || (await repositoryAt(worktree.path)) === undefined) return undefined;
	const branch = await git(worktree.path, "branch", "--show-current");

	return branch === "" ? undefined : { runId: id, branch, worktree };
}

const MERGED = Type.Array(Type.Object({ headRefOid: Type.String() }));

/**
 * Whether GitHub merged a pull request from the branch of `found` at the commit that the branch is on now. A branch name
 * can come back in a later run, so a merged pull request of an earlier commit does not count.
 */
async function isMerged({ branch, worktree }: Prunable): Promise<boolean> {
	const argv = ["pr", "list", "--head", branch, "--state", "merged", "--json", "headRefOid"];
	const result = await runCommand("gh", argv, worktree.path);

	if (result.code !== 0) throw new Error(failure(["gh", ...argv], result));
	const parsed: unknown = JSON.parse(result.stdout);

	if (!Value.Check(MERGED, parsed)) throw new Error(`gh pr list printed no list: ${result.stdout}`);
	const head = await git(worktree.path, "rev-parse", "HEAD");

	return parsed.some(({ headRefOid }) => headRefOid === head);
}

/** Removes the worktree of `found`, through herdr when a herdr workspace has it open, and then its branch. */
async function removeWorktree({ branch, worktree }: Prunable): Promise<void> {
	if (!(await removedByHerdr(worktree))) await git(worktree.repository, "worktree", "remove", worktree.path);

	if (await gitSucceeds(worktree.repository, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`)) {
		await git(worktree.repository, "branch", "-D", branch);
	}
}

/** Writes the post-merge hook of the repository of the current directory, unless a hook or a hooks path is set. */
async function installHook(terminal: Terminal): Promise<number> {
	const hooks = resolve(terminal.cwd, await git(terminal.cwd, "rev-parse", "--git-path", "hooks"));
	const add = `add this line to it: ${HOOK_LINE}`;

	if (await gitSucceeds(terminal.cwd, "config", "--get", "core.hooksPath")) {
		throw new Error(`core.hooksPath sets the hooks of this repository; ${add}`);
	}

	const file = join(hooks, "post-merge");

	if (existsSync(file)) throw new Error(`${file} exists; ${add}`);
	await mkdir(hooks, { recursive: true });
	await writeFile(file, `#!/bin/sh\n${HOOK_LINE}\n`, { mode: 0o755 });
	terminal.stdout(file);

	return 0;
}

/** The footer lines and the JSON fields of a run that ended with `outcome` without a result. */
function endOf(outcome: TaskOutcome<JsonValue>, title: string, id: string) {
	const resume = `continue with: workflows resume ${id}`;

	if (outcome.status === "failed" || outcome.status === "faulted") {
		return { lines: [`failed ${title}: ${outcome.error.message}`, resume], error: outcome.error.message };
	}

	if (outcome.status === "orphaned") return { lines: [`orphaned ${title}: ${outcome.reason}`, resume] };

	return { lines: [`stopped ${title}; ${resume}`] };
}

/** How often `show --pick` reads the store again while no line of the run can be picked. */
const PICK_POLL_MS = 1000;

/**
 * Prints the steps of a run as a tree, or with `--calls` its phases and calls, then its report lines, or how it ended.
 * A run without steps prints its calls. With `--pick`, it asks on the terminal for a line, and prints the conversation
 * of the agent of that line. It reads the task records, the progress, and the call records when it needs them, from
 * the project store only.
 */
async function show(args: readonly string[], terminal: Terminal, json: boolean): Promise<number> {
	const { values, positionals } = withUsage(
		() =>
			parseArgs({
				args: [...args],
				options: { calls: { type: "boolean" }, agents: { type: "boolean" }, pick: { type: "boolean" } },
				allowPositionals: true,
				strict: true,
			}),
		SHOW,
	);

	if (values.calls && values.agents) throw new UsageError("give --calls or --agents, not both", SHOW);

	if (values.pick && (values.calls || values.agents || json)) {
		throw new UsageError("give --pick without --calls, --agents or --json", SHOW);
	}

	const id = oneRunId(positionals, SHOW);

	if (values.pick) {
		if (terminal.choose === undefined) throw new UsageError("--pick needs a terminal on stdin and stderr", SHOW);

		return pickAgent(await savedRun(id, SHOW), terminal, terminal.choose);
	}

	const mode = values.agents ? "agents" : values.calls ? "calls" : "steps";
	const shown = await readRun(await savedRun(id, SHOW), terminal, mode !== "steps" || json, "be shown");
	const { input, title, status, head, calls, progress, footer, end } = shown;
	const now = Date.now();

	if (mode === "agents" && json) {
		const agents = agentRows(calls, 0, now);
		terminal.stdout(JSON.stringify({ runId: id, workflow: input.name, title, status, agents }));
	} else if (mode === "agents") {
		for (const line of [head, ...agentLines(agentRows(calls, 0, now)), ...footer]) terminal.stdout(line);
	} else if (json) {
		const steps = progress.lines();
		terminal.stdout(JSON.stringify({ runId: id, workflow: input.name, title, status, ...end, steps, calls }));
	} else if (mode === "calls") {
		for (const line of [head, ...treeLines(calls, "", now), ...footer]) terminal.stdout(line);
	} else {
		for (const entry of shownEntries(shown, now)) terminal.stdout(entry.text);
	}

	return 0;
}

/** A saved run as `show` prints it. `end` has the report lines or the error of a run that ended. */
type ShownRun = {
	readonly input: ScriptInput;
	readonly title: string;
	readonly status: string;
	readonly head: string;
	readonly ended: boolean;
	readonly calls: Shown[];
	readonly progress: Progress;
	readonly footer: readonly string[];
	readonly end: { report: string[] } | { error: string } | undefined;
};

/**
 * The saved run `run` as `show` prints it: its task, its head line, its steps, its calls, and its footer lines. It
 * reads the call records `withCalls`, or when the run has no steps. `verb` completes the error for a run that cannot
 * be read, as in `cannot <verb>`.
 */
async function readRun(run: SavedRun, terminal: Terminal, withCalls: boolean, verb: string): Promise<ShownRun> {
	const { id } = run;
	const empty = { task: undefined, saved: new Map<string, SavedCall>(), progress: new Progress(), events: [] };

	const { task, saved, progress, events } = await reading(run.store, empty, async (store) => {
		const read = new Progress();
		const stored = await progressEvents(store, id);

		for (const event of stored) read.add(event);
		const calls = withCalls || !read.stepped ? await callRecords(store, id) : new Map<string, SavedCall>();

		return { task: taskOf((await runTasks(store)).get(id) ?? []), saved: calls, progress: read, events: stored };
	});

	const checkedTask = checked(task, id, verb);
	const { input, state } = checkedTask;
	const outcome = state.status === "terminal" ? state.outcome : undefined;
	const title = titleOf(input, events);
	const footer: string[] = [];
	let end: { report: string[] } | { error: string } | undefined;

	if (outcome?.status === "completed") {
		footer.push(...reportOf(input, outcome.result).lines);
		end = { report: footer };
	} else if (outcome !== undefined) {
		const ended = endOf(outcome, title, id);
		footer.push(...ended.lines);

		if (ended.error !== undefined) end = { error: ended.error };
	}

	const status = runStatus(checkedTask);

	if (outcome !== undefined) progress.stop(outcome.status !== "completed");
	const head = `run ${id} ${input.name} ${status} ${title}`;
	const calls = callTree(saved, id, outcome !== undefined);

	return { input, title, status, head, ended: outcome !== undefined, calls, progress, footer, end };
}

/** The lines of `show` of `read`, each with its agent: the head line, the lines of `showEntries`, then the footer. */
function shownEntries(read: ShownRun, now: number): TreeEntry[] {
	const footer = read.footer.map((text) => ({ text }));

	return [{ text: read.head }, ...showEntries(read.calls, read.progress, now), ...footer];
}

/**
 * Asks on the terminal for a line of `show` of `run`, and prints the conversation of its agent. Only a line that maps
 * to an agent can be taken: a step line, a log line or a line of a child run gets the first session of its step, and a
 * line of `--calls`, for a run without steps, the conversation of its session or its ask. While no line maps to an
 * agent and the run has not ended, it reads the store again every second. While the pick waits for a key, it reads the
 * run again every second.
 */
async function pickAgent(run: SavedRun, terminal: Terminal, choose: Choose): Promise<number> {
	for (;;) {
		const read = await readRun(run, terminal, true, "be shown");
		const entries = shownEntries(read, Date.now());

		if (entries.some((entry) => entry.conversation !== undefined)) {
			const refresh = async () => agentItems(shownEntries(await readRun(run, terminal, true, "be shown"), Date.now()));
			const conversation = await choose("Pick an agent:", agentItems(entries), refresh);

			if (conversation === undefined) return 130;
			terminal.stdout(String(conversation));

			return 0;
		}

		if (read.ended) throw new Error(`run ${run.id} has no agent`);

		if (await abortedWithin(terminal.interrupt, PICK_POLL_MS)) return 130;
	}
}

/** The items of the agent picker: the lines of `entries`, each with the conversation of its agent as its value. */
function agentItems(entries: readonly TreeEntry[]): PickItem<number>[] {
	return entries.map(({ text, conversation }) => ({ text, value: conversation }));
}

/**
 * Opens a session of a run in Pi: the session that works now, else the last session to start, or the session of
 * `--conversation` when one is given. In Herdr, it opens Pi in a new tab of the workspace that has the run's worktree
 * open, else of the workspace of this pane; with `--side`, in a new pane to the right of this pane. Else, it runs Pi in
 * this terminal and exits with its code.
 */
async function attach(args: readonly string[], terminal: Terminal): Promise<number> {
	const { values, positionals } = withUsage(
		() =>
			parseArgs({
				args: [...args],
				options: { conversation: { type: "string" }, side: { type: "boolean" } },
				allowPositionals: true,
				strict: true,
			}),
		ATTACH,
	);

	const id = oneRunId(positionals, ATTACH);
	const wanted = values.conversation;

	if (wanted !== undefined && !/^\d+$/.test(wanted)) {
		throw new UsageError(`${wanted} is not a conversation ID`, ATTACH);
	}

	const conversation = wanted === undefined ? undefined : Number(wanted);

	const run = await savedRun(id, ATTACH);
	const { input, calls } = await readRun(run, terminal, true, "be attached");

	const list = agentRows(calls, 0, Date.now())
		.flatMap((row) => (row.kind === "agent" ? [row] : []))
		.filter((row) => conversation === undefined || row.conversation === conversation)
		.sort((a, b) => a.startedAt.localeCompare(b.startedAt));

	const session = list.findLast((row) => row.mark === "◉") ?? list.at(-1);

	if (session === undefined) {
		throw new Error(
			`run ${id} has no session${conversation === undefined ? "" : ` with conversation ${conversation}`}`,
		);
	}

	const client = await connectTo(terminal, run.project, true);

	try {
		// The watch fails here for a conversation that the host does not know, and gives the child that Herdr opens.
		const watched = String(session.conversation);
		const { child } = await client.request({ type: "watch", conversation: watched });

		if (process.env.HERDR_ENV) {
			const place = await herdrPlace(input.worktree, values.side === true, process.env.HERDR_PANE_ID || undefined);

			if (place !== undefined) {
				await openConversationPane(child, place, { ...process.env, HARNESS_PROJECT: run.project });

				return 0;
			}
		}

		const argv = [cliPath(), "--project", run.project, "attach", "--conversation", watched];
		const [code]: (number | null)[] = await once(spawn(process.execPath, argv, { stdio: "inherit" }), "exit");

		return code ?? 1;
	} finally {
		client.close();
	}
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

	if (COMMANDS.has(name)) throw new Error(`${name} is a command and cannot be a workflow name`);
	const run = await savedRun(id, SAVE);
	const { input } = checked(taskOf(await tasksOf(run)), id, "be saved");
	const project = await projectFolder(terminal.cwd);

	if (!values.force && Object.hasOwn(await loadScripts(project), name)) {
		throw new Error(`a workflow ${name} exists; replace it with --force`);
	}

	const folder = join(project, "scripts");
	const file = join(folder, `${name}.js`);
	await mkdir(folder, { recursive: true });
	await writeFile(file, input.bundle.main);
	terminal.stdout(file);

	return 0;
}

const PREFIX = "workflows.";

/** The task `latest` of the run `id`. It throws when there is none, or when another version saved it. */
function checked(
	latest: TaskRecord<JsonValue, JsonValue, JsonValue> | undefined,
	id: string,
	verb: string,
): TaskRecord<ScriptInput, JsonValue, JsonValue> {
	if (latest === undefined) throw new Error(`run ${id} has no workflow`);

	if (current(latest)) return latest;
	const { name, later } = savedBy(latest);
	throw new Error(`run ${id} was saved by ${later ? "a later" : "an earlier"} version of ${name} and cannot ${verb}`);
}

/** The workflow of the task `latest` that another version saved, and whether that version is later. */
function savedBy(latest: TaskRecord<JsonValue, JsonValue, JsonValue>) {
	// A script task of an earlier version names its workflow in its input; an earlier task kind names it in the kind.
	const name = inputString(latest.input, "name") ?? latest.kind.slice(PREFIX.length);

	return { name, later: latest.kind === TASK.name && latest.version > TASK.version };
}

/** Prints the report of the finished run `id` with `result`, or its JSON outcome line, and gives its exit code. */
function finished(input: ScriptInput, id: string, result: JsonValue, terminal: Terminal, json: boolean): number {
	const { lines, code } = reportOf(input, result);

	if (json) terminal.stdout(JSON.stringify({ runId: id, status: "finished", result, report: lines }));
	else for (const line of lines) terminal.stdout(line);

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
	readonly input: ScriptInput;
	readonly client: Client;
	/** The number of progress events of the run before the ones that the command shows. */
	readonly from: number;
};

/** True for the error of a wait whose host stopped: its connection closed. */
const hostStopped = (cause: unknown) => cause instanceof Error && cause.message === HOST_CLOSED;

/**
 * Shows the progress of the run until its task ends, and reports its outcome. Ctrl+C detaches and leaves the run to
 * the host; a second Ctrl+C, also one that came before the window, stops it. A host that stops leaves the run pending.
 */
async function follow(run: Following, terminal: Terminal, json: boolean, background: boolean): Promise<number> {
	const { id, input, client } = run;

	if (background) {
		client.close();
		terminal.following(false);

		if (json) terminal.stdout(JSON.stringify({ runId: id, status: "started", workflow: input.name }));

		return 0;
	}

	terminal.following(true);
	const shown = display(terminal, json);

	const tell = (state: "idle" | "working" | "done" | "error", message: string) => {
		if (!json) terminal.status?.(programStatus(state, message));
	};

	// With `--json`, the outcome line replaces the footer lines on stderr, so each stderr line is a progress line.
	const end = (status: "failed" | "detached" | "host-stopped", rest: { error?: string }, ...footer: string[]) => {
		if (json) terminal.stdout(JSON.stringify({ runId: id, status, ...rest }));
		else for (const line of footer) terminal.stderr(line);
	};

	const store = await openStore(await storeOf(run.project)).catch((cause: unknown) => {
		client.close();
		terminal.following(false);
		throw cause;
	});

	let seen = run.from;

	const poll = async () => {
		if (store === undefined) return;
		// A read that fails, such as one that waited too long for a lock, shows nothing; the next read catches up.
		const events = await progressEvents(store, id).catch(() => []);

		for (const event of events.slice(seen)) {
			shown.event(event);

			if (event.kind === "phase") tell("working", event.text);
		}

		seen = Math.max(seen, events.length);
	};

	const polled = new AbortController();

	const polling = (async () => {
		while (!polled.signal.aborted) {
			await poll();
			await abortedWithin(polled.signal, POLL_MS);
		}
	})();

	/** Stops the reads, then reads the events that came after the last one. */
	const stopPolling = async () => {
		polled.abort();
		await polling;
		await poll();
	};

	// Set by `report` when the command asks for the answer of a waiting run, after the client and the store close.
	let asking = false;
	const code = await watch();

	return asking ? answering(id, terminal) : code;

	async function watch(): Promise<number> {
		try {
			const waited = client.request({ type: "wait-task", key: run.key });
			// A detached command closes the connection, which ends the wait.
			waited.catch(() => undefined);
			const info = await Promise.race([waited, aborted(terminal.interrupt).then(() => undefined)]);

			if (info !== undefined) return await report(info);
			await stopPolling();
			const next = `Follow it with: workflows resume ${id}. Stop it with: workflows stop ${id}`;

			const line = `detached; run ${id} goes on. ${next}`;

			if (!json) terminal.stderr(line);
			tell("idle", line);

			// A run that ends in the window reports its outcome. A wait that fails leaves the run to the host.
			const ended = waited.then(
				(done) => ({ done }),
				() => new Promise<never>(() => {}),
			);

			const stopping = abortedWithin(terminal.stop, terminal.stopWindowMs ?? STOP_WINDOW_MS);
			const second = await Promise.race([stopping.then((stopped) => ({ stopped })), ended]);

			if ("done" in second) return await report(second.done);

			if (!second.stopped) {
				if (json) end("detached", {});

				return 130;
			}

			await abortRun(terminal, run.project, run.key);

			return await report(await waited);
		} catch (error) {
			await stopPolling();

			if (hostStopped(error)) {
				const line = `the host stopped; the run continues when it starts again: workflows resume ${id}`;
				end("host-stopped", {}, line);

				return 1;
			}

			shown.stop(true);
			end("failed", { error: error instanceof Error ? error.message : String(error) });
			throw error;
		} finally {
			polled.abort();
			client.close();
			terminal.following(false);
			await store?.close(BACKGROUND_CONTEXT);
		}
	}

	async function report(info: TaskInfo): Promise<number> {
		await stopPolling();
		const { outcome } = info;

		shown.stop(outcome?.status !== "completed");

		if (outcome === undefined) throw new Error(`run ended ${info.status}`);

		// The first line that the outcome prints is the message of the last report.
		let first: string | undefined;

		const keep = (print: (line: string) => void) => (line: string) => {
			first ??= line;
			print(line);
		};

		const shownTo = { ...terminal, stdout: keep(terminal.stdout), stderr: keep(terminal.stderr) };
		const events = store === undefined ? [] : await progressEvents(store, id).catch(() => []);
		const code = outcomeOf(input, id, outcome, shownTo, json, events);

		asking =
			outcome.status === "completed" &&
			statusOf(outcome.result) === "waiting" &&
			terminal.readLine !== undefined &&
			!json &&
			!terminal.interrupt.aborted;

		if (asking) terminal.status?.(programStatus("blocked", first ?? "", "question"));
		else tell(code === 0 ? "done" : "error", first ?? "");

		return code;
	}
}

/**
 * Reads the answer of the waiting run `id` on the terminal, and continues the run with it. Without an answer, at
 * Ctrl+C or at the end of input, it prints how to continue and exits 130.
 */
async function answering(id: string, terminal: Terminal): Promise<number> {
	const text = await terminal.readLine?.();

	if (text === undefined) {
		const line = `run ${id} waits for an answer; continue with: workflows resume ${id} --answer <text>`;
		terminal.stderr(line);
		terminal.status?.(programStatus("idle", line));

		return 130;
	}

	return resume([id, `--answer=${text}`], terminal, false, false);
}

/**
 * Prints how the run `id` ended with `outcome`: the report of a finished run, else the footer lines on stderr, or one
 * JSON outcome line. It gives the exit code.
 */
function outcomeOf(
	input: ScriptInput,
	id: string,
	outcome: TaskOutcome<JsonValue>,
	terminal: Terminal,
	json: boolean,
	events: readonly ProgressEvent[],
): number {
	if (outcome.status === "completed") return finished(input, id, outcome.result, terminal, json);
	const ended = endOf(outcome, titleOf(input, events), id);

	const end = (status: "failed" | "stopped", rest: { error?: string }) => {
		if (json) terminal.stdout(JSON.stringify({ runId: id, status, ...rest }));
		else for (const line of ended.lines) terminal.stderr(line);
	};

	if (outcome.status === "aborted") {
		end("stopped", {});

		return 130;
	}

	end("failed", {
		error: ended.error ?? `the task was orphaned: ${outcome.status === "orphaned" ? outcome.reason : ""}`,
	});

	return 1;
}
