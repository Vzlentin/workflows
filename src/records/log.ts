/**
 * The text of `workflows log`: the short log of a run, with its steps, the calls that did not end done, its child runs
 * and their ends, the calls of one step, and the full text of one call.
 */
import type { JsonValue } from "@earendil-works/chord/json";
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { SavedCall } from "../run/calls.ts";
import type { ProgressEvent } from "../run/progress.ts";
import { duration, type Progress, type RunStep, stepIndexOf, stepTime } from "./steps.ts";
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

/**
 * The calls of one step of a run: the step with its index `n` in `Progress.steps`, 1-based, or index 0 and no step for
 * the calls that are in no step. `at` is the time of the line: the first start of the step, or the start of the first
 * call of group 0.
 */
type StepGroup = {
	readonly n: number;
	readonly step: RunStep | undefined;
	readonly at: number | undefined;
	readonly calls: CallNode[];
};

/** The progress events of a root run and their steps. */
export type RunProgress = Pick<RunRecords, "progress" | "events">;

/** The last end of a run, with its index among the events. */
type RunEnd = { readonly word: string; readonly at: number | undefined; readonly n: number };

/** The name of a step: `s<n>` in the root run, `<run>/s<n>` in a child run. */
const STEP_NAME = /^(?:(.+)\/)?s(\d+)$/;

/** Whether `name` names a step and not a call: call keys are hex and never start with `s`. */
export function isStepName(name: string): boolean {
	return STEP_NAME.test(name);
}

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
	return sizeOf(Buffer.byteLength(text));
}

/** `bytes` in B, KB or MB. */
function sizeOf(bytes: number): string {
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

/** The UTF-8 bytes of the output of `record`: stdout and stderr of a shell call, else its result or its error. */
function outputBytes(record: SavedCall): number | undefined {
	const shell = shellResult(record);

	if (shell !== undefined) return Buffer.byteLength(shell.stdout + shell.stderr);

	if (record.result !== undefined) return Buffer.byteLength(resultText(record.result));

	return record.error === undefined ? undefined : Buffer.byteLength(record.error);
}

/** The lines of `text`, without the empty line after a last newline. */
function linesOf(text: string): string[] {
	const lines = text.split("\n");

	if (lines.at(-1) === "") lines.pop();

	return lines;
}

/**
 * The steps of the run `runId` in `progress`, each with its own calls among `calls`, in the order they started, and
 * group 0 at the start of its first call when a call is in no step. A step with no start time comes first.
 */
function groupsOf(progress: Progress, runId: string, calls: readonly CallNode[]): StepGroup[] {
	const steps = progress.steps(runId);
	const groups: StepGroup[] = steps.map((step, i) => ({ n: i + 1, step, at: step.firstStart, calls: [] }));
	const loose: CallNode[] = [];

	for (const node of calls) (groups[stepIndexOf(steps, node.record)]?.calls ?? loose).push(node);

	const first = loose[0];

	if (first !== undefined) {
		groups.push({ n: 0, step: undefined, at: Date.parse(first.record.startedAt), calls: loose });
	}

	const key = (group: StepGroup) => group.at ?? -Infinity;

	return groups.sort((a, b) => key(a) - key(b));
}

/**
 * The end of the run `runId` when its last `start` or `end` event in `events` is an end: each task of the run, a resume
 * too, starts with a `start` event, so a run that goes on has none.
 */
function lastEnd(events: readonly ProgressEvent[], runId: string): RunEnd | undefined {
	const n = events.findLastIndex((event) => (event.kind === "start" || event.kind === "end") && event.run === runId);
	const event = events[n];

	if (event?.kind !== "end") return undefined;

	return { word: "stopped" in event ? "stopped" : event.failed ? "failed" : "ok", at: event.at, n };
}

/** The name of the step `n` of the run `runId` in the root run `root`. */
function stepName(root: string, runId: string, n: number): string {
	return runId === root ? `s${n}` : `${runId}/s${n}`;
}

/**
 * The line of the step `group` of the run `runId` at `indent`: its text, its duration, the count and output size of its
 * own calls, and its name. Group 0 has the text `-`, and ends with `end`, the end of its run.
 */
function stepLine(root: string, runId: string, group: StepGroup, end: RunEnd | undefined, indent: string): LogLine {
	const { n, step, at, calls } = group;
	const text = step === undefined ? "-" : `${step.text.slice(0, PHASE_WIDTH)}${stepTime(step)}`;
	const count = `${calls.length} ${calls.length === 1 ? "call" : "calls"}`;
	const bytes = calls.reduce((sum, node) => sum + (outputBytes(node.record) ?? 0), 0);
	const facts = [count, sizeOf(bytes), stepName(root, runId, n)];
	const ended = step === undefined ? end?.at : step.ended;

	// A step prints again in `log --follow` when it ends, with its last count.
	return { item: `step:${runId}:${n}:${ended ?? "open"}`, text: `${clock(at)}  ${indent}${text}  ${facts.join("  ")}` };
}

/** The line of the call `node` at `indent`, and the last lines of its error when it failed. */
function callLines(root: string, node: CallNode, indent: string): LogLine[] {
	const { record, state, key } = node;
	const started = Date.parse(record.startedAt);
	const time = record.endedAt === undefined ? state : duration(Date.parse(record.endedAt) - started);
	const shell = shellResult(record);
	const exit = shell === undefined ? [] : [`exit ${shell.code}`];
	const bytes = outputBytes(record);
	const facts = [time, ...exit, ...(bytes === undefined ? [] : [sizeOf(bytes)]), callName(root, key)];
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

/**
 * The lines of the run `runId` of the root run `root` at `indent`: each step line; under it each call of the step that
 * is not done and each `run` call, with its child run under it, indented by 4 more; then the end of the run when the
 * run does not go on. `read` gives the progress events of the run and their steps.
 */
export function runLines(
	root: string,
	runId: string,
	read: RunProgress,
	calls: readonly CallNode[],
	indent: string,
): LogLine[] {
	const lines: LogLine[] = [];
	const end = lastEnd(read.events, runId);

	for (const group of groupsOf(read.progress, runId, calls)) {
		lines.push(stepLine(root, runId, group, end, indent));

		for (const node of group.calls) {
			if (node.state === "done" && node.record.kind !== "run") continue;
			lines.push(...callLines(root, node, indent));
			const child = node.record.child?.runId;

			if (child !== undefined && node.calls !== undefined) {
				lines.push(...runLines(root, child, read, node.calls, `${indent}    `));
			}
		}
	}

	if (end !== undefined) {
		lines.push({ item: `end:${runId}:${end.n}`, text: `${clock(end.at)}  ${indent}end ${end.word}` });
	}

	return lines;
}

/**
 * The step named `name` in the root run `root`: its line, then the line of each of its own calls with the last lines of
 * the error of a failed one, without the calls of its child runs. Undefined when there is no such step.
 */
export function stepLog(
	root: string,
	read: RunProgress,
	calls: readonly CallNode[],
	name: string,
): string[] | undefined {
	const [, child, n] = STEP_NAME.exec(name) ?? [];
	const runId = child ?? root;
	const own = runId === root ? calls : (findCall(calls, (node) => node.record.child?.runId === runId)?.calls ?? []);
	const group = groupsOf(read.progress, runId, own).find((g) => String(g.n) === n);

	if (group === undefined) return undefined;
	const head = stepLine(root, runId, group, lastEnd(read.events, runId), "");

	return [head, ...group.calls.flatMap((node) => callLines(root, node, ""))].map((line) => line.text);
}

/** The first call among `calls` and the calls of their child runs for which `test` holds, or undefined. */
export function findCall(calls: readonly CallNode[], test: (node: CallNode) => boolean): CallNode | undefined {
	for (const node of calls) {
		const found = test(node) ? node : findCall(node.calls ?? [], test);

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
