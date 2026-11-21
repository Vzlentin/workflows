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
import type { Ask, ServesInput } from "@vzlentin/harness/protocol";
import { addTodo, readTodos, setTodo, type TodoOwner, TodoState } from "@vzlentin/harness/todo";
import { type Static, type TLiteral, type TObject, type TProperties, type TUnion, Type } from "typebox";
import { failure, type Result, run } from "../git.ts";
import { readProject } from "../launch/input.ts";
import { cutTail, JSON_VALUE, OUTPUT_BYTES } from "../tool.ts";
import type { RunBundle } from "../workflow/bundle.ts";
import type { Roles } from "../workflow/roles.ts";
import { answerOf, asksOf, newAsk, openAsk, plainText, readAsk } from "./asks.ts";
import { keyIn } from "./keys.ts";
import { firstTask, PAST_OPTIONS, type PastOptions, pastRuns, scanRuns, scanTasks } from "./past.ts";
import { addProgress, checkpointWhen, type PhaseLines, takeLines } from "./progress.ts";
import { HARNESS_ARGS, type HarnessArgs, runRequest } from "./serves.ts";
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
	/** What the run serves, the item or the parley, from the saved input, which its child runs keep. */
	readonly serves: ServesInput | undefined;
	readonly args: JsonObject;
	/** The files that the sessions of the run see in place of the disk, from the saved input. */
	readonly overlay: Overlay | undefined;
	/** The driver of the current task, from the saved input, which its child runs get. */
	readonly driver: string | undefined;
	/** The task of every script run, which the child runs of the `run` calls are tasks of. */
	readonly definition: ScriptTask;
};

/**
 * The args of a `session` call: `profile`, the role name, the fields that override its role, and `key`, which tells
 * apart the sessions of the same role: the `digest` of the key that the script gives (for an `agent` call, its prompt).
 */
export const SESSION_ARGS = Type.Object(
	{
		profile: Type.String(),
		provider: Type.Optional(Type.String()),
		model: Type.Optional(Type.String()),
		thinking: Type.Optional(Type.String()),
		key: Type.Optional(Type.String()),
	},
	{ additionalProperties: false },
);

/** A JSON object. */
export const JSON_OBJECT = Type.Record(Type.String(), JSON_VALUE);

/**
 * The args of an `ask` call: the conversation of its session, its prompt, the schema of its answer, if any, and
 * `settle` when a failure of the call is its saved result.
 */
export const ASK_ARGS = Type.Object(
	{
		conversation: Type.Number(),
		prompt: Type.String(),
		schema: Type.Union([JSON_OBJECT, Type.Null()]),
		settle: Type.Optional(Type.Literal(true)),
	},
	{ additionalProperties: false },
);

const SHELL_CMD = Type.Union([Type.String(), Type.Array(Type.String())]);

/** The args of a `sh` call: its command, whether a non-zero exit throws, and `settle` when a failure is its result. */
export const SH_ARGS = Type.Object(
	{ cmd: SHELL_CMD, check: Type.Boolean(), settle: Type.Optional(Type.Literal(true)) },
	{ additionalProperties: false },
);

/** The args of an `ok` call: its command, and whether a non-zero exit throws. */
export const OK_ARGS = Type.Object({ cmd: SHELL_CMD, check: Type.Boolean() }, { additionalProperties: false });

/** The args of a `run` call: the workflow of the child run and its args. */
export const RUN_ARGS = Type.Object({ name: Type.String(), args: JSON_OBJECT }, { additionalProperties: false });

/** The args of an `input` call: its question. */
export const INPUT_ARGS = Type.Object({ question: Type.String() }, { additionalProperties: false });

/** The args of a `pastRuns` call: the workflow, or null for every workflow, and the options. */
export const PAST_RUNS_ARGS = Type.Object(
	{ workflow: Type.Union([Type.String(), Type.Null()]), options: PAST_OPTIONS },
	{ additionalProperties: false },
);

/** The args of a `todo` call: its action, and the values of the action. */
export const TODO_ARGS = Type.Union([
	Type.Object({ action: Type.Literal("add"), text: Type.String() }, { additionalProperties: false }),
	Type.Object(
		{
			action: Type.Literal("set"),
			id: Type.Integer({ minimum: 1 }),
			state: TodoState,
			text: Type.Optional(Type.String()),
		},
		{ additionalProperties: false },
	),
	Type.Object({ action: Type.Literal("list") }, { additionalProperties: false }),
]);

/** The args of a `todo` call. */
export type TodoArgs = Readonly<Static<typeof TODO_ARGS>>;

/** The model of a session: its provider and model ID, and its thinking level when it has one. */
export const SESSION_MODEL = Type.Object(
	{ provider: Type.String(), model: Type.String(), thinking: Type.Optional(Type.String()) },
	{ additionalProperties: false },
);

/**
 * The end of a call: `done` with its result, `failed` with its error, or `cancelled` when the end of its script
 * cancelled it, each with its time as an ISO string.
 */
export const CALL_END = Type.Union([
	Type.Object({ kind: Type.Literal("done"), at: Type.String(), result: JSON_VALUE }, { additionalProperties: false }),
	Type.Object(
		{ kind: Type.Literal("failed"), at: Type.String(), error: Type.String() },
		{ additionalProperties: false },
	),
	Type.Object({ kind: Type.Literal("cancelled"), at: Type.String() }, { additionalProperties: false }),
]);

/**
 * The fields of every call record: the phase line that was current when the call started, its start time as an ISO
 * string, and its `end`; a call that started and did not end has no `end`. `task` is the task that started it last.
 */
const CALL_FIELDS = {
	phase: Type.Union([Type.String(), Type.Null()]),
	startedAt: Type.String(),
	end: Type.Optional(CALL_END),
	task: Type.Optional(Type.Number()),
};

/** The args of each kind of script call. */
const CALL_ARGS = {
	session: SESSION_ARGS,
	ask: ASK_ARGS,
	sh: SH_ARGS,
	ok: OK_ARGS,
	run: RUN_ARGS,
	input: INPUT_ARGS,
	pastRuns: PAST_RUNS_ARGS,
	todo: TODO_ARGS,
	harness: HARNESS_ARGS,
};

/** The kinds of script calls. */
export type CallKind = keyof typeof CALL_ARGS;

/** The fields that only some kinds of a call union have, by kind. */
type KindFields = { readonly [K in CallKind]?: TProperties };

/** The member of the kind `K` in a call union: its kind, its args, the fields `F`, and the fields of `K` in `E`. */
type CallMember<K extends CallKind, F extends TProperties, E extends KindFields> = TObject<
	{ kind: TLiteral<K>; args: (typeof CALL_ARGS)[K] } & F & (K extends keyof E ? E[K] : unknown)
>;

/** A call union: one strict member for each kind. */
export type CallUnion<F extends TProperties, E extends KindFields> = TUnion<
	[{ [K in CallKind]: CallMember<K, F, E> }[CallKind]]
>;

/**
 * A union of one strict object for each kind of call, from `CALL_ARGS`: its kind, its args, the fields `fields` of every
 * kind, and the fields of its kind in `extra`.
 */
export function callUnion<F extends TProperties, E extends KindFields>(fields: F, extra: E): CallUnion<F, E> {
	const extras: { readonly [kind: string]: TProperties | undefined } = extra;

	const members = Object.entries(CALL_ARGS).map(([kind, args]) =>
		Type.Object({ kind: Type.Literal(kind), args, ...fields, ...extras[kind] }, { additionalProperties: false }),
	);

	// SAFETY: `members` has one strict object for each entry of `CALL_ARGS`, with its kind, its args, `fields` and the
	// fields of its kind in `extra`, which is `CallUnion`. TypeBox types a union only from a tuple, which `map` does
	// not give.
	return Type.Union(members) as CallUnion<F, E>;
}

/** The most UTF-8 bytes of each stream of a failed `sh` call that its record keeps. */
export const KEPT_OUTPUT_BYTES = 1 << 20;

/** The exit code and the output of a shell command: the result of a `sh` or `ok` call, or the kept output of a failed `sh` call. */
export const SHELL_OUTPUT = Type.Object(
	{ code: Type.Number(), stdout: Type.String(), stderr: Type.String() },
	{ additionalProperties: false },
);

/**
 * One script call: its kind with the args of that kind, the fields of every call, and the fields of its kind. The
 * `conversation` of a `session` call is its session, and `model` the model of its session. The `child` of a `run` call
 * is its child run, so a stopped call reuses them, and `childRun` the run ID of its child run, saved before the child
 * run directory exists. The `ask` of an `input` call is the ID of its ask in the store of the host. The `output` of a
 * failed `sh` call is its exit code with the last `KEPT_OUTPUT_BYTES` bytes of its stdout and of its stderr.
 */
export const CALL_RECORD = callUnion(CALL_FIELDS, {
	sh: { output: Type.Optional(SHELL_OUTPUT) },
	session: { conversation: Type.Optional(Type.Number()), model: Type.Optional(SESSION_MODEL) },
	run: {
		child: Type.Optional(Type.Object({ task: Type.Number(), runId: Type.String() }, { additionalProperties: false })),
		childRun: Type.Optional(Type.String()),
	},
	input: { ask: Type.Optional(Type.Number()) },
});

/** A call record as the command reads it from the store file, where its IDs are plain numbers. */
export type SavedCall = Static<typeof CALL_RECORD>;

/** The end of a call. */
export type CallEnd = Static<typeof CALL_END>;

/** `T` with the pi-durable types of its IDs `conversation` and `child`. */
type WithIds<T> = T extends unknown
	? { [K in keyof T]: K extends "conversation" ? ConversationId : K extends "child" ? Child : T[K] }
	: never;

/** A call record, with the pi-durable types of its IDs. */
export type CallRecord = WithIds<SavedCall>;

/** The record `record` of the call `key`, which must be a call of `kind`. */
export function callOfKind<R extends CallRecord, K extends CallKind>(
	record: R,
	kind: K,
	key: string,
): Extract<R, { kind: K }> {
	if (isKind(record, kind)) return record;

	throw new Error(`the call ${key} is a ${record.kind} call, not a ${kind} call`);
}

/** Whether `record` is a call of `kind`. */
function isKind<R extends CallRecord, K extends CallKind>(record: R, kind: K): record is Extract<R, { kind: K }> {
	return record.kind === kind;
}

/** The child run that the saved call `record` started, when it is a `run` call whose child run started. */
export function childOf(record: SavedCall): Extract<SavedCall, { kind: "run" }>["child"] {
	return record.kind === "run" ? record.child : undefined;
}

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
	initial: () => ({ kind: "sh", args: { cmd: "", check: true }, phase: null, startedAt: "" }),
	checkpointWhen,
});

/** The saved result of the call `key`, if it has one. */
export async function savedCall(runtime: Runtime, key: string, context: Context): Promise<JsonValue | undefined> {
	const record = await runtime.snapshot(CallDoc, key, context);

	return record?.end?.kind === "done" ? record.end.result : undefined;
}

/** The first 16 hex characters of the sha256 of `text`. */
export function digest(text: string): string {
	return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

/** `<digest(name + JSON args)>.<n>`, n counting identical calls in this execution. */
function keyOf(name: string, args: JsonObject, counters: Map<string, number>): string {
	const hash = digest(name + JSON.stringify(args));

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
	return keyIn(calls.script.runId, keyOf(name, args, calls.counters));
}

/** What a call records when it starts: its kind with its args, and the ask of an `input` call. */
type Start = PickEach<CallRecord, "kind" | "args" | "ask">;

/** `T` with only those of the fields `K` that it has, for each member of a union. */
type PickEach<T, K extends PropertyKey> = T extends unknown ? Pick<T, Extract<K, keyof T>> : never;

/**
 * The result of the call `key`: its saved result, or the value of `effect`, which gets the key. The call records its
 * start, with the waiting lines, before `effect`, and its end with the value or the error after it. A stopped call
 * records no end, and a call that throws saves no result, so both run again. A call whose args have `settle: true` and
 * whose effect throws while the call context is not aborted saves `{ error }`, the message of the error, as its result,
 * and returns it. A call with a saved result drops the log lines and keeps the phase line, so a resume shows the phase
 * of the first call that runs.
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
	let failure: ShFailure | undefined;

	try {
		value = await effect(key);
	} catch (error) {
		if (!("settle" in start.args) || calls.context.abortSignal?.aborted) {
			return failCall(calls, key, start.kind, error);
		}

		value = { error: messageOf(error) };
		failure = error instanceof ShFailure ? error : undefined;
	}

	return endCall(calls, key, async () => value, failure);
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
		delete doc.end;

		if (doc.kind === "sh") delete doc.output;

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
 * The value of a settled `sh` call is its failure `failure`, whose record keeps what a failed call keeps.
 */
async function endCall(
	calls: Calls,
	key: string,
	result: (tx: Tx) => Promise<JsonValue>,
	failure?: ShFailure,
): Promise<JsonValue> {
	const { runtime, context } = calls;
	let value: JsonValue = null;

	await runtime.commit(async (tx) => {
		value = await result(tx);
		const doc = await tx.doc(CallDoc, key, null);
		doc.end = { kind: "done", at: new Date().toISOString(), result: value };
		keepOutput(doc, failure);

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
		await runtime.commit(async (tx) => {
			const doc = await tx.doc(CallDoc, key, null);
			doc.end = { kind: "failed", at: new Date().toISOString(), error: messageOf(cause) };
			keepOutput(doc, cause);

			return undefined;
		}, context);
	} else if (kind !== "input" && !runtime.signal.aborted) await cancelCall(calls, key);

	throw cause;
}

/** Keeps in the record `doc` the output of its `sh` call when the error `cause` of the call has it. */
function keepOutput(doc: CallRecord, cause: unknown): void {
	if (cause instanceof ShFailure && doc.kind === "sh") doc.output = cause.output;
}

/** The message of the error `cause`. */
function messageOf(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}

/** `args`, with `settle: true` when `settle` is true. */
export function settleArgs<T extends object>(args: T, settle: boolean): T | (T & { settle: true }) {
	return settle ? { ...args, settle: true as const } : args;
}

/** Records that the end of the script cancelled the call `key`, in the context of the phase, which still commits. */
async function cancelCall(calls: Calls, key: string): Promise<void> {
	await calls.runtime.commit(async (tx) => {
		const doc = await tx.doc(CallDoc, key, null);
		doc.end = { kind: "cancelled", at: new Date().toISOString() };

		return undefined;
	}, calls.phase);
}

/** The exit code and output of a shell command in `cwd`. */
function shell(calls: Calls, cwd: string, cmd: string | string[]): Promise<Result> {
	// A string is `sh -c <cmd>`; an array is the program `cmd[0]` with the arguments `cmd.slice(1)` and no shell.
	const [file = "", ...rest] = Array.isArray(cmd) ? cmd : ["sh", "-c", cmd];

	return run(file, rest, cwd, calls.context.abortSignal);
}

/** The error text of the `sh` call `key` that ran `cmd` and exited with a non-zero code. */
function shError(calls: Calls, key: string, cmd: string | string[], result: Result): string {
	const hint = `workflows log ${calls.script.root} ${key} shows the call`;

	if (Array.isArray(cmd)) return failure(cmd, result, hint);
	const stderr = result.stderr.trim();

	return `sh exited with ${result.code}: ${cmd}${stderr === "" ? "" : `\n${cutTail(stderr, OUTPUT_BYTES, hint)}`}`;
}

/** The error of a `sh` call that exited with a non-zero code, with the output that its record keeps. */
class ShFailure extends Error {
	readonly output: Static<typeof SHELL_OUTPUT>;

	constructor(message: string, { code, stdout, stderr }: Result) {
		super(message);
		this.output = { code, stdout: cutTail(stdout, KEPT_OUTPUT_BYTES), stderr: cutTail(stderr, KEPT_OUTPUT_BYTES) };
	}
}

/** A `sh` call, whose failure is its result with `settle`. */
export function shCall(calls: Calls, cwd: string, cmd: string | string[], settle: boolean): Promise<JsonValue> {
	const args = settleArgs({ cmd, check: true }, settle);

	return memoized(calls, callKey(calls, "sh", args), { kind: "sh", args }, async (key) => {
		const result = await shell(calls, cwd, cmd);

		if (result.code !== 0) throw new ShFailure(shError(calls, key, cmd, result), result);

		return result;
	});
}

/** An `ok` call. */
export function okCall(calls: Calls, cwd: string, cmd: string | string[]): Promise<JsonValue> {
	const args = { cmd, check: false };

	return memoized(calls, callKey(calls, "sh", args), { kind: "ok", args }, () => shell(calls, cwd, cmd));
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

	if (record?.end?.kind === "done") return replayed(calls, record.end.result);

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

	const saved = record === undefined ? undefined : callOfKind(record, "input", key).ask;
	const decided = calls.inputs.then(() => decide(calls, question, saved));
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
function failInput(calls: Calls, key: string, args: { question: string }, cause: unknown): Promise<JsonValue> {
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
 * The `pastRuns` call of `workflow`, or of every workflow for null, with `options`. A resume replays the saved list, so
 * runs that end later do not change it.
 */
export function pastRunsCall(calls: Calls, workflow: string | null, options: PastOptions): Promise<JsonValue> {
	const args = { workflow, options };

	return memoized(calls, callKey(calls, "pastRuns", args), { kind: "pastRuns", args }, async () =>
		pastRuns(await scanRuns(calls.runtime, calls.context), workflow, options),
	);
}

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

/**
 * The `harness` call with `args`: the reply of the host of the run's project to the request, with the run as the caller
 * of a `link` and a `set`. A resume replays the saved reply.
 */
export function harnessCall(calls: Calls, args: HarnessArgs): Promise<JsonValue> {
	return memoized(calls, callKey(calls, "harness", args), { kind: "harness", args }, async () => {
		const project = await readProject(calls.script.runDir);

		return runRequest(project, calls.script.runId, args, calls.context.abortSignal);
	});
}
