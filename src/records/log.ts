/**
 * The text of `workflows log`: the short log of a run, with its steps, the calls that did not end done, its child runs
 * and their ends, the calls of one step, and the full text of one call.
 */
import type { JsonValue } from "@earendil-works/chord/json";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { childOf, type SavedCall, SHELL_OUTPUT } from "../run/calls.ts";
import { nameOfKey, type StepRef, stepName } from "../run/keys.ts";
import { hasEnded, type RunStatus } from "../run/past.ts";
import type { ProgressEvent } from "../run/progress.ts";
import { duration, type Progress, type RunStep, stepIndexOf, stepTime } from "./steps.ts";
import type { RunRecords } from "./store.ts";
import { type CallNode, commandOf, conversationOf, endedAt, markOf } from "./tree.ts";

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

/** The progress events of a root run and their steps, and the state of each task of the store by task ID. */
export type RunProgress = Pick<RunRecords, "progress" | "events" | "states">;

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

/** The output of a `sh` or `ok` call that ended with a result or of a failed `sh` call, or undefined for another call. */
function shellResult(record: SavedCall) {
	if (record.kind === "sh" && record.end?.kind === "failed") return record.output;
	const result = record.end?.kind === "done" ? record.end.result : undefined;

	return (record.kind === "sh" || record.kind === "ok") && Value.Check(SHELL_OUTPUT, result) ? result : undefined;
}

/** The text of a result: a string as it is, else its JSON. */
function resultText(result: JsonValue): string {
	return Value.Check(Type.String(), result) ? result : JSON.stringify(result);
}

/** The UTF-8 bytes of the output of `record`: stdout and stderr of a shell call, else its result or its error. */
function outputBytes(record: SavedCall): number | undefined {
	const shell = shellResult(record);

	if (shell !== undefined) return Buffer.byteLength(shell.stdout + shell.stderr);

	if (record.end?.kind === "done") return Buffer.byteLength(resultText(record.end.result));

	return record.end?.kind === "failed" ? Buffer.byteLength(record.end.error) : undefined;
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
 * The time of the end of the run `runId` when its last `start` or `end` event in `events` is an end: each task of the
 * run, a resume too, starts with a `start` event, so a run that goes on has none.
 */
function lastEnd(events: readonly ProgressEvent[], runId: string): number | undefined {
	const event = events.findLast((each) => (each.kind === "start" || each.kind === "end") && each.run === runId);

	return event?.kind === "end" ? event.at : undefined;
}

/**
 * The line of the step `group` of the run `runId` at `indent`: its text, its duration, the count and output size of its
 * own calls, and its name. Group 0 has the text `-`, and ends at `end`, the time of the end of its run.
 */
function stepLine(root: string, runId: string, group: StepGroup, end: number | undefined, indent: string): LogLine {
	const { n, step, at, calls } = group;
	const text = step === undefined ? "-" : `${step.text.slice(0, PHASE_WIDTH)}${stepTime(step)}`;
	const count = `${calls.length} ${calls.length === 1 ? "call" : "calls"}`;
	const bytes = calls.reduce((sum, node) => sum + (outputBytes(node.record) ?? 0), 0);
	const facts = [count, sizeOf(bytes), stepName(root, runId, n)];
	const ended = step === undefined ? end : step.ended;

	// A step prints again in `log --follow` when it ends, with its last count.
	return { item: `step:${runId}:${n}:${ended ?? "open"}`, text: `${clock(at)}  ${indent}${text}  ${facts.join("  ")}` };
}

/** The line of the call `node` at `indent`, and the last lines of its error when it failed. */
function callLines(root: string, node: CallNode, indent: string): LogLine[] {
	const { record, state, key } = node;
	const started = Date.parse(record.startedAt);
	const ended = endedAt(record.end);
	const time = ended === undefined ? state : duration(Date.parse(ended) - started);
	const shell = shellResult(record);
	const exit = shell === undefined ? [] : [`exit ${shell.code}`];
	const bytes = outputBytes(record);
	const facts = [time, ...exit, ...(bytes === undefined ? [] : [sizeOf(bytes)]), nameOfKey(root, key)];
	const text = `${clock(started)}  ${indent}  ${markOf(state)} ${record.kind} ${node.label}  ${facts.join("  ")}`;
	// A call prints again in `log --follow` when its state changes.
	const lines = [{ item: `${key}:${state}`, text }];

	if (record.end?.kind === "failed") lines.push(...tailLines(key, record.end.error, indent));

	return lines;
}

/** The last lines of `error` at `indent`, each cut at its width, as items `<item>#<n>`. */
function tailLines(item: string, error: string, indent: string): LogLine[] {
	const tail = linesOf(error.trimEnd()).slice(-TAIL_LINES);

	return tail.map((line, n) => ({
		item: `${item}#${n}`,
		text: `${NO_TIME}  ${indent}    | ${line.slice(0, TAIL_WIDTH)}`,
	}));
}

/** The last lines of `error`, the error of the root run `runId`, under its end line. None when it has no error. */
export function errorLines(runId: string, error: string | undefined): LogLine[] {
	return error === undefined ? [] : tailLines(`end:${runId}`, error, "");
}

/**
 * The lines of the run `runId` of the root run `root` at `indent`: each step line; under it each call of the step that
 * is not done and each `run` call, with its child run under it, indented by 4 more; then `end <state>` when the run,
 * whose task is in `state`, has ended. `read` gives the progress events of the run, their steps and the states of the
 * tasks.
 */
export function runLines(
	root: string,
	runId: string,
	state: RunStatus | undefined,
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
			const child = childOf(node.record);

			if (child !== undefined && node.calls !== undefined) {
				const childState = read.states.get(child.task);
				lines.push(...runLines(root, child.runId, childState, read, node.calls, `${indent}    `));
			}
		}
	}

	if (state !== undefined && hasEnded(state)) {
		const at = end ?? "-";
		lines.push({ item: `end:${runId}:${state}:${at}`, text: `${clock(end)}  ${indent}end ${state}` });
	}

	return lines;
}

/**
 * The step `step` in the root run `root`: its line, then the line of each of its own calls with the last lines of
 * the error of a failed one, without the calls of its child runs. Undefined when there is no such step.
 */
export function stepLog(
	root: string,
	read: RunProgress,
	calls: readonly CallNode[],
	step: StepRef,
): string[] | undefined {
	const { runId, n } = step;
	const own = runId === root ? calls : (findCall(calls, (node) => childOf(node.record)?.runId === runId)?.calls ?? []);
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
	const what = record.kind === "sh" || record.kind === "ok" ? commandOf(record.args) : label;
	const lines = [`call ${nameOfKey(root, key)}`, `${kind} ${what}`, `phase ${record.phase ?? "-"}`];
	lines.push(`started ${record.startedAt}`);

	const ended = endedAt(record.end);

	if (ended === undefined) {
		lines.push("the call still runs; the store gets its output only when it ends");
	} else {
		lines.push(`ended ${ended}  ${duration(Date.parse(ended) - Date.parse(record.startedAt))}`);
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
	} else {
		lines.push("--- args", JSON.stringify(args, null, 2));

		if (record.end?.kind === "done") lines.push("--- result", ...linesOf(resultText(record.end.result)));
	}

	if (record.end?.kind === "failed") lines.push("--- error", ...linesOf(record.end.error));

	return lines;
}
