/**
 * The script calls and their records. Each call saves its result in a document of the project store, keyed by the run
 * ID and the call, so when the script runs again, the finished calls return their saved results and only the rest runs.
 */
import { createHash } from "node:crypto";
import { once } from "node:events";
import type { Context, JsonValue } from "@earendil-works/chord";
import { type ConversationId, defineDocFamily, type JsonObject, type TaskId } from "@earendil-works/pi-durable";
import type { Owner } from "@vzlentin/harness/children";
import type { Overlay } from "@vzlentin/harness/overlay";
import { type Static, Type } from "typebox";
import { failure, run } from "../git.ts";
import type { RunBundle } from "../workflow/bundle.ts";
import { type PastOptions, pastRuns, scanRuns } from "./past.ts";
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
	readonly args: JsonObject;
	/** The files that the sessions of the run see in place of the disk, from the saved input. */
	readonly overlay: Overlay | undefined;
	/** The conversation whose `workflow` tool started the run, from `PI_SESSION_ID`. */
	readonly session: string | undefined;
	/** The answer to the `input` call with the document key `call`, from `resume --answer`. */
	readonly answer: { readonly call: string; readonly text: string } | undefined;
	/** True when the run opens its worktree in Herdr, from the saved input; its child runs do too. */
	readonly herdr: true | undefined;
	/** The task of every script run, which the child runs of the `run` calls are tasks of. */
	readonly definition: ScriptTask;
};

/** A JSON value. */
export const JSON_VALUE = Type.Cyclic(
	{
		Json: Type.Union([
			Type.Null(),
			Type.Boolean(),
			Type.Number(),
			Type.String(),
			Type.Array(Type.Ref("Json")),
			Type.Record(Type.String(), Type.Ref("Json")),
		]),
	},
	"Json",
);

const CALL_KINDS = Type.Union([
	Type.Literal("session"),
	Type.Literal("ask"),
	Type.Literal("sh"),
	Type.Literal("ok"),
	Type.Literal("run"),
	Type.Literal("input"),
	Type.Literal("pastRuns"),
]);

/** The kinds of script calls. */
export type CallKind = Static<typeof CALL_KINDS>;

/**
 * One script call: its kind, its args, the phase line that was current when it started, its start and end times as ISO
 * strings, and its result or its error. A call that started and did not end has no `endedAt`. The `conversation` of a
 * `session` call is its session, and the `child` of a `run` call is its child run, so a stopped call reuses them.
 */
export const CALL_RECORD = Type.Object({
	kind: CALL_KINDS,
	args: Type.Record(Type.String(), JSON_VALUE),
	phase: Type.Union([Type.String(), Type.Null()]),
	startedAt: Type.String(),
	endedAt: Type.Optional(Type.String()),
	result: Type.Optional(JSON_VALUE),
	error: Type.Optional(Type.String()),
	conversation: Type.Optional(Type.Number()),
	child: Type.Optional(Type.Object({ task: Type.Number(), runId: Type.String() })),
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
	readonly context: Context;
	readonly counters: Map<string, number>;
	readonly progress: PhaseLines;
	readonly host: Host;
	/** The owner of the run's sessions: the task, in the group of the run ID, so a later task of the run finds them. */
	readonly owner: Owner;
	/** The question of the `input` call that the run waits for an answer to. */
	waiting?: string;
};

/** The document key of the call `name` with `args` in this execution: `<run ID>/<call key>`. */
export function callKey(calls: Calls, name: string, args: JsonObject): string {
	return `${calls.script.runId}/${keyOf(name, args, calls.counters)}`;
}

/** What a call records when it starts. */
type Start = { readonly kind: CallKind; readonly args: JsonObject };

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
	const { runtime, context, progress } = calls;
	const saved = await savedCall(runtime, key, context);
	const { lines } = progress;

	if (saved !== undefined) {
		lines.splice(0, lines.length, ...lines.filter((line) => line.kind === "phase"));

		return saved;
	}

	const events = takeLines(progress);
	await runtime.commit(async (tx) => {
		await addProgress(tx, calls.script.root, events);
		const doc = await tx.doc(CallDoc, key, null);
		Object.assign(doc, { ...start, phase: progress.phase, startedAt: new Date().toISOString() });
		delete doc.endedAt;
		delete doc.error;

		return undefined;
	}, context);
	let value: JsonValue;

	try {
		value = await effect(key);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);

		// A call that the end of its script or task cancelled did not fail, and runs again.
		if (!context.abortSignal?.aborted) await endCall(calls, key, { error: message });
		throw error;
	}

	await endCall(calls, key, { result: value });

	return (await savedCall(runtime, key, context)) ?? value;
}

/** Records the end of the call `key`, with its result, or its error when it failed. */
async function endCall(calls: Calls, key: string, end: { result: JsonValue } | { error: string }): Promise<void> {
	await calls.runtime.commit(async (tx) => {
		const doc = await tx.doc(CallDoc, key, null);
		Object.assign(doc, end);
		doc.endedAt = new Date().toISOString();

		return undefined;
	}, calls.context);
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
 * The `input` call with `question`: the saved answer, or the answer of `resume --answer` to this call. Without one, the
 * first such call stops the script with `stop` and leaves its record open, so `resume --answer` finds its key. A second
 * call that would wait only rejects, so the answer has one call.
 */
export async function inputCall(calls: Calls, question: string, stop: AbortController): Promise<JsonValue> {
	const args = { question };
	const key = callKey(calls, "input", args);
	const start = { kind: "input", args } as const;
	const { answer } = calls.script;

	if (answer?.call === key) return memoized(calls, key, start, async () => answer.text);
	const saved = await savedCall(calls.runtime, key, calls.context);

	if (saved !== undefined) return memoized(calls, key, start, async () => saved);

	if (calls.waiting !== undefined) throw new Error(`the run waits for an answer to: ${calls.waiting}`);
	calls.waiting = question;

	// The effect never resolves: it stops the script, and throws once the end of the script cancels the calls, so the
	// call records no error and its record stays open.
	return memoized(calls, key, start, async () => {
		stop.abort();
		const signal = calls.context.abortSignal;

		if (signal !== undefined && !signal.aborted) await once(signal, "abort");
		throw new Error(`the run waits for an answer to: ${question}`);
	});
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
