/**
 * The script calls and their records. Each call saves its result in a document of the project store, keyed by the run
 * ID and the call, so when the script runs again, the finished calls return their saved results and only the rest runs.
 */
import { createHash } from "node:crypto";
import { once } from "node:events";
import type { Context } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord/json";
import {
	type ConversationId,
	defineDocFamily,
	type JsonObject,
	type TaskId,
	type Tx,
} from "@earendil-works/pi-durable";
import type { Owner } from "@vzlentin/harness/children";
import type { Overlay } from "@vzlentin/harness/overlay";
import type { Ask } from "@vzlentin/harness/protocol";
import { addTodo, readTodos, setTodo, type TodoOwner, type TodoState } from "@vzlentin/harness/todo";
import { type Static, Type } from "typebox";
import { failure, run } from "../git.ts";
import { readProject } from "../launch/input.ts";
import { JSON_VALUE } from "../tool.ts";
import type { RunBundle } from "../workflow/bundle.ts";
import type { Roles } from "../workflow/roles.ts";
import { answerOf, asksOf, newAsk, openAsk, plainText, readAsk } from "./asks.ts";
import { firstTask, type PastOptions, pastRuns, scanRuns, scanTasks } from "./past.ts";
import { addProgress, checkpointWhen, type PhaseLines, takeLines } from "./progress.ts";
import type { Host, Runtime, ScriptTask } from "./version.ts";

/** A started child run: its task and its run ID. */
export type Child = { readonly task: TaskId<JsonValue>; readonly runId: string };

/** What a script phase runs: its run IDs and directory, bundle and args, and what its child runs get. */
export type ScriptRun = {
	readonly runId: string;
	/** The run ID of the caller of a child run, or null for a root run. */
	readonly parent: string | null;
	/** The run ID of the root run, which keys the progress of the run and its child runs. */
	readonly root: string;
	readonly runDir: string;
	readonly bundle: RunBundle;
	/** The run layer of the roles, from `--agents`, which its child runs keep. */
	readonly agents: Roles;
	readonly args: JsonObject;
	/** The files that the sessions of the run see in place of the disk, from the saved input. */
	readonly overlay: Overlay | undefined;
	/** The conversation whose `workflow` tool started the run, from `PI_SESSION_ID`. */
	readonly session: string | undefined;
	/** The task of every script run, which the child runs of the `run` calls are tasks of. */
	readonly definition: ScriptTask;
};

const CALL_KINDS = Type.Union([
	Type.Literal("session"),
	Type.Literal("ask"),
	Type.Literal("sh"),
	Type.Literal("ok"),
	Type.Literal("run"),
	Type.Literal("input"),
	Type.Literal("pastRuns"),
	Type.Literal("todo"),
]);

/** The kinds of script calls. */
export type CallKind = Static<typeof CALL_KINDS>;

/**
 * One script call: its kind, its args, the phase line that was current when it started, its start and end times as ISO
 * strings, and its result or its error. A call that started and did not end has no `endedAt`. `task` is the task that
 * started it last, and `cancelledAt` the time when the end of its script cancelled it. The `conversation` of a
 * `session` call is its session, and the `child` of a `run` call is its child run, so a stopped call reuses them. The
 * `childRun` of a `run` call is the run ID of its child run, saved before the child run directory exists. The `ask` of
 * an `input` call is the ID of its ask in the store of the host.
 */
export const CALL_RECORD = Type.Object({
	kind: CALL_KINDS,
	args: Type.Record(Type.String(), JSON_VALUE),
	phase: Type.Union([Type.String(), Type.Null()]),
	startedAt: Type.String(),
	endedAt: Type.Optional(Type.String()),
	result: Type.Optional(JSON_VALUE),
	error: Type.Optional(Type.String()),
	task: Type.Optional(Type.Number()),
	cancelledAt: Type.Optional(Type.String()),
	conversation: Type.Optional(Type.Number()),
	child: Type.Optional(Type.Object({ task: Type.Number(), runId: Type.String() })),
	childRun: Type.Optional(Type.String()),
	ask: Type.Optional(Type.Number()),
});

/** A call record as the command reads it from the store file, where its IDs are plain numbers. */
export type SavedCall = Static<typeof CALL_RECORD>;

/** A call record, with the pi-durable types of its IDs. */
export type CallRecord = Omit<SavedCall, "conversation" | "child"> & { conversation?: ConversationId; child?: Child };

/** The document kind of the call records. */
export const CALL_KIND = "workflows.call";

/**
 * The record of each script call, keyed `<run ID>/<call key>`. The store keeps it after its task ends, so a new task of
 * the run finds it. Each write gets the record with `tx.doc(CallDoc, key, null)` and changes its fields.
 */
export const CallDoc = defineDocFamily<CallRecord, null>({
	kind: CALL_KIND,
	version: 1,
	scope: "session",
	family: true,
	initial: () => ({ kind: "sh", args: {}, phase: null, startedAt: "" }),
	checkpointWhen,
});

/** The saved result of the call `key`, if it has one. */
export async function savedCall(runtime: Runtime, key: string, context: Context): Promise<JsonValue | undefined> {
	const record = await runtime.snapshot(CallDoc, key, context);

	return record !== undefined && "result" in record ? record.result : undefined;
}

/** `<sha256(name + JSON args), 16 hex>.<n>`, n counting identical calls in this execution. */
function keyOf(name: string, args: JsonObject, counters: Map<string, number>): string {
	const hash = createHash("sha256")
		.update(name + JSON.stringify(args))
		.digest("hex")
		.slice(0, 16);

	const n = (counters.get(hash) ?? 0) + 1;
	counters.set(hash, n);

	return `${hash}.${n}`;
}

/** What the calls of one script execution share. */
export type Calls = {
	readonly script: ScriptRun;
	readonly runtime: Runtime;
	/** The context of the calls, which the end of the script cancels. */
	readonly context: Context;
	/** The context of the phase, which the end of the script does not cancel. */
	readonly phase: Context;
	readonly counters: Map<string, number>;
	readonly progress: PhaseLines;
	readonly host: Host;
	/** The owner of the run's sessions: the task, in the group of the run ID, so a later task of the run finds them. */
	readonly owner: Owner;
	/** The question of the `input` call that the run waits for an answer to. */
	waiting?: string;
	/** Settles when the `input` calls that came before have decided whether they wait, so they decide one at a time. */
	inputs: Promise<void>;
	/** The error of the first `input` call that would wait while another one waits, which fails the run. */
	secondInput?: Error;
	/** The list of todos of the run, which the first `todo` call of the execution finds. */
	todos?: Promise<TodoOwner>;
};

/** The document key of the call `name` with `args` in this execution: `<run ID>/<call key>`. */
export function callKey(calls: Calls, name: string, args: JsonObject): string {
	return `${calls.script.runId}/${keyOf(name, args, calls.counters)}`;
}

/** What a call records when it starts, and the ask of an `input` call. */
type Start = { readonly kind: CallKind; readonly args: JsonObject; readonly ask?: number };

/**
 * The result of the call `key`: its saved result, or the value of `effect`, which gets the key. The call records its
 * start, with the waiting lines, before `effect`, and its end with the value or the error after it. A stopped call
 * records no end, and a call that throws saves no result, so both run again. A call with a saved result drops the log
 * lines and keeps the phase line, so a resume shows the phase of the first call that runs.
 */
export async function memoized(
	calls: Calls,
	key: string,
	start: Start,
	effect: (key: string) => Promise<JsonValue>,
): Promise<JsonValue> {
	const saved = await startCall(calls, key, start);

	if (saved !== undefined) return saved;
	let value: JsonValue;

	try {
		value = await effect(key);
	} catch (error) {
		return failCall(calls, key, start.kind, error);
	}

	return endCall(calls, key, async () => value);
}

/**
 * The result of the call `key`, as `memoized` gives it, for a call whose effect is `change`, a change of the store. The
 * change runs in the commit that saves its value as the result, so a stop cannot make the change without the result,
 * and a resume never makes it twice.
 */
async function memoizedChange(
	calls: Calls,
	key: string,
	start: Start,
	change: (tx: Tx) => Promise<JsonValue>,
): Promise<JsonValue> {
	const saved = await startCall(calls, key, start);

	if (saved !== undefined) return saved;

	try {
		return await endCall(calls, key, change);
	} catch (error) {
		return failCall(calls, key, start.kind, error);
	}
}

/**
 * Records the start of the call `key` with the waiting lines, and gives undefined. When the call has a saved result, it
 * records nothing, drops the log lines, keeps the phase line, and gives the result.
 */
async function startCall(calls: Calls, key: string, start: Start): Promise<JsonValue | undefined> {
	const { runtime, context, progress } = calls;
	const saved = await savedCall(runtime, key, context);

	if (saved !== undefined) return replayed(calls, saved);

	const events = takeLines(progress);
	await runtime.commit(async (tx) => {
		await addProgress(tx, calls.script.root, events);
		const doc = await tx.doc(CallDoc, key, null);
		Object.assign(doc, { ...start, phase: progress.phase, startedAt: new Date().toISOString(), task: runtime.taskId });
		delete doc.endedAt;
		delete doc.error;
		delete doc.cancelledAt;

		return undefined;
	}, context);

	return undefined;
}

/** The saved result `saved` of a call, after it drops the log lines and keeps the phase line. */
function replayed(calls: Calls, saved: JsonValue): JsonValue {
	const { lines } = calls.progress;
	lines.splice(0, lines.length, ...lines.filter((line) => line.kind === "phase"));

	return saved;
}

/**
 * Records the end of the call `key` with the value that `result` gives in the same commit, and gives the saved value.
 */
async function endCall(calls: Calls, key: string, result: (tx: Tx) => Promise<JsonValue>): Promise<JsonValue> {
	const { runtime, context } = calls;
	let value: JsonValue = null;

	await runtime.commit(async (tx) => {
		value = await result(tx);
		const doc = await tx.doc(CallDoc, key, null);
		doc.result = value;
		doc.endedAt = new Date().toISOString();

		return undefined;
	}, context);

	return (await savedCall(runtime, key, context)) ?? value;
}

/** Records the error `cause` of the call `key` of `kind`, or that the end of its script cancelled it, and throws it. */
async function failCall(calls: Calls, key: string, kind: CallKind, cause: unknown): Promise<never> {
	const { runtime, context } = calls;

	// A call that the end of its script or task cancelled did not fail, and runs again. The waiting `input` call ends by
	// that cancel too, and stays open.
	if (!context.abortSignal?.aborted) {
		const message = cause instanceof Error ? cause.message : String(cause);

		await runtime.commit(async (tx) => {
			const doc = await tx.doc(CallDoc, key, null);
			doc.error = message;
			doc.endedAt = new Date().toISOString();

			return undefined;
		}, context);
	} else if (kind !== "input" && !runtime.signal.aborted) await cancelCall(calls, key);

	throw cause;
}

/** Records that the end of the script cancelled the call `key`, in the context of the phase, which still commits. */
async function cancelCall(calls: Calls, key: string): Promise<void> {
	await calls.runtime.commit(async (tx) => {
		const doc = await tx.doc(CallDoc, key, null);
		doc.cancelledAt = new Date().toISOString();

		return undefined;
	}, calls.phase);
}

/** The result of a shell command in `cwd`. With `check`, a non-zero exit throws. */
async function shell(calls: Calls, cwd: string, cmd: string | string[], check: boolean): Promise<JsonValue> {
	// A string is `sh -c <cmd>`; an array is the program `cmd[0]` with the arguments `cmd.slice(1)` and no shell.
	const [file = "", ...rest] = Array.isArray(cmd) ? cmd : ["sh", "-c", cmd];
	const result = await run(file, rest, cwd, calls.context.abortSignal);

	if (check && result.code !== 0) {
		if (Array.isArray(cmd)) throw new Error(failure(cmd, result));
		const stderr = result.stderr.trim();
		throw new Error(`sh exited with ${result.code}: ${cmd}${stderr === "" ? "" : `\n${stderr}`}`);
	}

	return result;
}

/** A `sh` call when `check` is true, else an `ok` call. */
export function shellCall(calls: Calls, cwd: string, cmd: string | string[], check: boolean): Promise<JsonValue> {
	const args = { cmd, check };

	return memoized(calls, callKey(calls, "sh", args), { kind: check ? "sh" : "ok", args }, () =>
		shell(calls, cwd, cmd, check),
	);
}

/**
 * The `input` call with `question`: its saved answer, or the answer of its ask, which the call writes in the store of
 * the host with the run as its asker. Without an answer, the first such call stops the script with `stop` and leaves
 * its record open, so a resume finds its ask. A second call that would wait before the script stops rejects, so the
 * run waits for one ask, and fails the run when the script ends, also when the script caught the error. A child run
 * cannot ask, and a dropped ask fails the call.
 */
export async function inputCall(calls: Calls, question: string, stop: () => void): Promise<JsonValue> {
	const args = { question };
	const key = callKey(calls, "input", args);
	const { script, runtime, context } = calls;
	const record = await runtime.snapshot(CallDoc, key, context);

	if (record !== undefined && "result" in record) return replayed(calls, record.result ?? null);

	if (script.parent !== null) {
		return failInput(
			calls,
			key,
			args,
			new Error(`input() in the child run ${script.runId}: only a root run can ask the user`),
		);
	}

	if (plainText(question).trim() === "") {
		return failInput(calls, key, args, new Error("input() needs a question that is not blank"));
	}

	const decided = calls.inputs.then(() => decide(calls, question, record?.ask));
	calls.inputs = decided.then(
		() => undefined,
		() => undefined,
	);
	let ask: Ask;

	try {
		ask = await decided;
	} catch (error) {
		// The second input fails the run when the script ends, so its call records nothing.
		if (error === calls.secondInput) throw error;

		return failInput(calls, key, args, error);
	}

	return memoized(calls, key, { kind: "input", args, ask: ask.id }, async () => {
		switch (ask.state) {
			case "answered":
				return answerOf(ask);
			case "dropped":
				throw new Error(`the user dropped ask ${ask.id} of input ${JSON.stringify(question)}`);
			case "open": {
				// The effect never resolves: it stops the script, and throws once the end of the script cancels the calls,
				// so the call records no error and its record stays open.
				stop();
				const signal = context.abortSignal;

				if (signal !== undefined && !signal.aborted) await once(signal, "abort");
				throw new Error(`the run waits for an answer to: ${question}`);
			}
		}
	});
}

/** Fails the `input` call `key` with `args` and the error `cause`, which its record keeps. */
function failInput(calls: Calls, key: string, args: JsonObject, cause: unknown): Promise<JsonValue> {
	return memoized(calls, key, { kind: "input", args }, () => Promise.reject(cause));
}

/**
 * The ask of the `input` call with `question`, once the `input` calls before it decided. An open ask makes the run wait
 * for it. While the run waits for another ask, it throws the error of a second input, `calls.secondInput`, and it
 * throws the error of a failed request.
 */
async function decide(calls: Calls, question: string, saved: number | undefined): Promise<Ask> {
	if (calls.waiting !== undefined) {
		calls.secondInput ??= new Error(`the run waits for an answer to: ${calls.waiting}`);

		throw calls.secondInput;
	}

	const ask = await askOf(calls, question, saved);

	if (ask.state === "open") calls.waiting = question;

	return ask;
}

/**
 * The ask of the `input` call with `question`: the ask `saved` of its record, else the open ask of the run with its
 * title, which a call that stopped before its record saved the ask wrote, else a new ask.
 */
async function askOf(calls: Calls, question: string, saved: number | undefined): Promise<Ask> {
	const { runId, runDir } = calls.script;
	const asks = asksOf(await readProject(runDir), calls.context.abortSignal);

	if (saved !== undefined) return readAsk(asks, saved);

	return (await openAsk(asks, runId, question)) ?? newAsk(asks, runId, question);
}

/**
 * The `pastRuns` call of `workflow` with `options`. A resume replays the saved list, so runs that end later do not
 * change it.
 */
export function pastRunsCall(calls: Calls, workflow: string, options: PastOptions): Promise<JsonValue> {
	const args = { workflow, options };

	return memoized(calls, callKey(calls, "pastRuns", args), { kind: "pastRuns", args }, async () =>
		pastRuns(await scanRuns(calls.runtime, calls.context), workflow, options),
	);
}

/** The args of a `todo` call: its action, and the values of the action. */
export type TodoArgs =
	| { readonly action: "add"; readonly text: string }
	| { readonly action: "set"; readonly id: number; readonly state: TodoState; readonly text?: string }
	| { readonly action: "list" };

/**
 * The list of todos of the run: the list of its first task, so every task of the run, and no other run, uses it. The
 * first `todo` call of the execution finds it, so the other calls do not read the tasks again.
 */
function runTodos(calls: Calls): Promise<TodoOwner> {
	const { runtime, context, script } = calls;

	calls.todos ??= scanTasks(runtime, context).then((tasks) => ({
		kind: "task",
		id: firstTask(tasks, script.runId)?.id ?? runtime.taskId,
	}));

	return calls.todos;
}

/**
 * The `todo` call with `args` on the list of the run: the todo that `add` adds or `set` changes, or the todos of the
 * list for `list`. An `add` or a `set` changes the list in the commit that saves its result.
 */
export async function todoCall(calls: Calls, args: TodoArgs): Promise<JsonValue> {
	const key = callKey(calls, "todo", args);
	const start = { kind: "todo", args } as const;

	if (args.action === "list") {
		return memoized(calls, key, start, async () => {
			const { todos } = await readTodos(calls.runtime, await runTodos(calls), calls.context);

			return todos;
		});
	}

	const list = await runTodos(calls);

	return memoizedChange(calls, key, start, (tx) =>
		args.action === "add" ? addTodo(tx, list, args.text) : setTodo(tx, list, args),
	);
}
