/**
 * The text of `workflows log`: the short log of a run, with its steps, its calls and the ends of its runs in time
 * order, and the full text of one call.
 */
import type { JsonValue } from "@earendil-works/chord/json";
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { SavedCall } from "../run/calls.ts";
import type { ProgressEvent } from "../run/progress.ts";
import { duration, type Progress, type RunStep, stepTime } from "./steps.ts";
import type { RunRecords } from "./store.ts";
import { type CallNode, commandOf, conversationOf, markOf } from "./tree.ts";

/** How many lines of the error of a failed call the short log shows. */
const TAIL_LINES = 5;

/** The characters of a tail line that the short log shows. */
const TAIL_WIDTH = 120;

/** The characters of a phase text that the short log shows. */
const PHASE_WIDTH = 80;

/** The blank time column of a line that has no time. */
const NO_TIME = " ".repeat(8);

/**
 * A line of the short log: `item` names what the line is about. `log --follow` prints a line once for each item, so a
 * line that must print again when it changes has a new item then.
 */
export type LogLine = { readonly item: string; readonly text: string };

const SHELL_RESULT = Type.Object({ code: Type.Number(), stdout: Type.String(), stderr: Type.String() });

/** One entry of a run in the short log, at `at` ms since the epoch; `rank` orders entries of the same time. */
type Entry =
	| {
			readonly kind: "step";
			readonly at: number | undefined;
			readonly rank: 0;
			readonly step: RunStep;
			readonly n: number;
	  }
	| { readonly kind: "call"; readonly at: number; readonly rank: 1; readonly node: CallNode }
	| {
			readonly kind: "end";
			readonly at: number | undefined;
			readonly rank: 2;
			readonly word: string;
			readonly n: number;
	  };

/** The name of the call `key` in the run `root`: the key without `<root>/`, or the whole key for a child run. */
export function callName(root: string, key: string): string {
	return key.startsWith(`${root}/`) ? key.slice(root.length + 1) : key;
}

/** The store key of the call named `name` in the run `root`. */
export function callKey(root: string, name: string): string {
	return name.includes("/") ? name : `${root}/${name}`;
}

/** `ms` as local `HH:MM:SS`, or a blank column when there is no time. */
function clock(ms: number | undefined): string {
	if (ms === undefined || Number.isNaN(ms)) return NO_TIME;
	const time = new Date(ms);
	const pad = (n: number) => String(n).padStart(2, "0");

	return `${pad(time.getHours())}:${pad(time.getMinutes())}:${pad(time.getSeconds())}`;
}

/** The UTF-8 size of `text` in B, KB or MB. */
export function size(text: string): string {
	const bytes = Buffer.byteLength(text);

	if (bytes < 1024) return `${bytes} B`;

	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;

	return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** The output of a `sh` or `ok` call that ended with a result, or undefined for another call. */
function shellResult(record: SavedCall) {
	return (record.kind === "sh" || record.kind === "ok") && Value.Check(SHELL_RESULT, record.result)
		? record.result
		: undefined;
}

/** The text of a result: a string as it is, else its JSON. */
function resultText(result: JsonValue): string {
	return Value.Check(Type.String(), result) ? result : JSON.stringify(result);
}

/** The size of the output of `record`: stdout and stderr of a shell call, else its result or its error. */
function outputSize(record: SavedCall): string | undefined {
	const shell = shellResult(record);

	if (shell !== undefined) return size(shell.stdout + shell.stderr);

	if (record.result !== undefined) return size(resultText(record.result));

	return record.error === undefined ? undefined : size(record.error);
}

/** The lines of `text`, without the empty line after a last newline. */
function linesOf(text: string): string[] {
	const lines = text.split("\n");

	if (lines.at(-1) === "") lines.pop();

	return lines;
}

/**
 * The entries of the run `runId` in time order: its steps in `progress`, its calls and its `end` events. An entry
 * without a time comes first.
 */
function entriesOf(
	progress: Progress,
	events: readonly ProgressEvent[],
	runId: string,
	calls: readonly CallNode[],
): Entry[] {
	const steps = progress
		.steps(runId)
		.map((step, n) => ({ kind: "step", at: step.firstStart, rank: 0, step, n }) as const);

	const ends = events.flatMap((event, n) => {
		if (event.kind !== "end" || event.run !== runId) return [];
		const word = "stopped" in event ? "stopped" : event.failed ? "failed" : "ok";

		return [{ kind: "end", at: event.at, rank: 2, word, n } as const];
	});

	const called = calls.map((node) => ({ kind: "call", at: Date.parse(node.record.startedAt), rank: 1, node }) as const);
	const key = (entry: Entry) => entry.at ?? -Infinity;

	return [...steps, ...called, ...ends].sort((a, b) => key(a) - key(b) || a.rank - b.rank);
}

/** The line of the call `node` at `indent`, and the last lines of its error when it failed. */
function callLines(root: string, node: CallNode, indent: string): LogLine[] {
	const { record, state, key } = node;
	const started = Date.parse(record.startedAt);
	const time = record.endedAt === undefined ? state : duration(Date.parse(record.endedAt) - started);
	const shell = shellResult(record);
	const exit = shell === undefined ? [] : [`exit ${shell.code}`];
	const bytes = outputSize(record);
	const facts = [time, ...exit, ...(bytes === undefined ? [] : [bytes]), callName(root, key)];
	const text = `${clock(started)}  ${indent}  ${markOf(state)} ${record.kind} ${node.label}  ${facts.join("  ")}`;
	// A call prints again in `log --follow` when its state changes.
	const lines = [{ item: `${key}:${state}`, text }];

	if (state === "failed" && record.error !== undefined) {
		const tail = linesOf(record.error.trimEnd()).slice(-TAIL_LINES);

		for (const [n, line] of tail.entries()) {
			lines.push({ item: `${key}#${n}`, text: `${NO_TIME}  ${indent}    | ${line.slice(0, TAIL_WIDTH)}` });
		}
	}

	return lines;
}

/** The lines of the run `runId` at `indent`, with the lines of each child run under its `run` call. */
function runLines(
	root: string,
	runId: string,
	read: Pick<RunRecords, "progress" | "events">,
	calls: readonly CallNode[],
	indent: string,
): LogLine[] {
	const lines: LogLine[] = [];

	for (const entry of entriesOf(read.progress, read.events, runId, calls)) {
		if (entry.kind === "call") {
			lines.push(...callLines(root, entry.node, indent));

			const { calls: childCalls, record } = entry.node;
			const child = record.child?.runId;

			if (child !== undefined && childCalls !== undefined) {
				lines.push(...runLines(root, child, read, childCalls, `${indent}    `));
			}
		} else if (entry.kind === "step") {
			const line = `${clock(entry.at)}  ${indent}${entry.step.text.slice(0, PHASE_WIDTH)}${stepTime(entry.step)}`;
			lines.push({ item: `step:${runId}:${entry.n}`, text: line });
		} else {
			lines.push({ item: `end:${runId}:${entry.n}`, text: `${clock(entry.at)}  ${indent}end ${entry.word}` });
		}
	}

	return lines;
}

/**
 * The short log of the root run `root`: the line `head`, then the steps, the calls and the ends of the run, each child
 * run under its `run` call, indented by 4 more. `events` are the progress events of the run, and `progress` their steps.
 */
export function shortLog(
	head: string,
	root: string,
	read: Pick<RunRecords, "progress" | "events">,
	calls: readonly CallNode[],
): LogLine[] {
	return [{ item: "run", text: head }, ...runLines(root, root, read, calls, "")];
}

/** The call `key` among `calls` and the calls of their child runs, or undefined when there is none. */
export function findCall(calls: readonly CallNode[], key: string): CallNode | undefined {
	for (const node of calls) {
		const found = node.key === key ? node : findCall(node.calls ?? [], key);

		if (found !== undefined) return found;
	}

	return undefined;
}

/**
 * The full text of the call `node` of the root run `root`: its kind with its whole command or its label, its phase and
 * times, and its output, or its args with its result or error.
 */
export function callText(root: string, node: CallNode): string[] {
	const { key, record, label } = node;
	const { kind, args } = record;
	const what = kind === "sh" || kind === "ok" ? commandOf(args) : label;
	const lines = [`call ${callName(root, key)}`, `${kind} ${what}`, `phase ${record.phase ?? "-"}`];
	lines.push(`started ${record.startedAt}`);

	if (record.endedAt === undefined) {
		lines.push("the call still runs; the store gets its output only when it ends");
	} else {
		lines.push(`ended ${record.endedAt}  ${duration(Date.parse(record.endedAt) - Date.parse(record.startedAt))}`);
	}

	const conversation = conversationOf(record);

	if (conversation !== undefined) {
		lines.push(`conversation ${conversation}: workflows attach ${root} --conversation ${conversation}`);
	}

	const shell = shellResult(record);

	if (shell !== undefined) {
		lines.push(`exit ${shell.code}`);
		lines.push(`--- stdout (${size(shell.stdout)})`, ...linesOf(shell.stdout));
		lines.push(`--- stderr (${size(shell.stderr)})`, ...linesOf(shell.stderr));

		return lines;
	}

	lines.push("--- args", JSON.stringify(args, null, 2));

	if (record.result !== undefined) lines.push("--- result", ...linesOf(resultText(record.result)));

	if (record.error !== undefined) lines.push("--- error", ...linesOf(record.error));

	return lines;
}
