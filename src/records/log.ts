/**
 * The text of `workflows log`: the flat short log of a run, each line with its time and the path of its run, with the
 * start and end of each run, its steps and the calls that did not end done, the calls of one step, and the full text of
 * one call.
 */
import type { JsonValue } from "@earendil-works/chord/json";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { type SavedCall, SHELL_OUTPUT } from "../run/calls.ts";
import { nameOfKey, type StepRef, stepName } from "../run/keys.ts";
import { endedOutcome, hasEnded, recordedStatus, type RunTask, taskOf, taskOutcome, taskResult } from "../run/past.ts";
import type { ProgressEvent } from "../run/progress.ts";
import { duration, type Mark, type Progress, type RunStep, stepIndexOf, stepTime } from "./steps.ts";
import { inputName, type RunRecords } from "./store.ts";
import { type CallNode, commandOf, conversationOf, endedAt } from "./tree.ts";

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

/** The progress events of a root run and their steps, and the task of each child run by task ID. */
export type RunProgress = Pick<RunRecords, "progress" | "events" | "children">;

/**
 * A run as the log shows it: its run ID, its path (the workflow of the root run, then the workflow of each child run
 * down to it, joined with `/`), the time of its start, its last task, the state of that task, and the error that its
 * end line has under it.
 */
export type LogRun = {
	readonly runId: string;
	readonly path: string;
	readonly start: number | undefined;
	readonly task: RunTask | undefined;
	readonly error: string | undefined;
};

/**
 * The root run `id` whose tasks are `tasks`: its path is the workflow in the saved input of its last task, as `list`
 * gives it, or `?`; it starts at the start of its first task, and its error is the one that `show` gives.
 */
export function rootRun(id: string, tasks: readonly RunTask[]): LogRun {
	const task = taskOf(tasks);
	const path = (task === undefined ? undefined : inputName(task.input)) ?? "?";

	return { runId: id, path, start: tasks[0]?.startedAt, task, error: errorOf(id, task) };
}

/** The error of the task `task` of the run `id`, when it ended with one: failed, faulted or orphaned. */
function errorOf(id: string, task: RunTask | undefined): string | undefined {
	const outcome = task === undefined ? undefined : taskOutcome(task);

	if (outcome === undefined || outcome.status === "completed") return undefined;
	const ended = endedOutcome(id, outcome);

	return ended.state === "aborted" ? undefined : ended.error;
}

/** The word of a step that did not end done, by its mark. */
const STEP_WORDS: Readonly<Record<Mark, string | undefined>> = {
	"✓": undefined,
	"◉": "running",
	"✗": "failed",
	"·": "aborted",
};

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

/** The start of a line: its time, two spaces and the path of its run in brackets. */
function lineHead(at: number | undefined, path: string): string {
	return `${clock(at)}  [${path}]`;
}

/**
 * The line of the step `group` of the run `runId` at `path`: its text, `failed`, `running` or `aborted` when it did
 * not end done, its duration, the count and output size of its own calls, and its name. Undefined for group 0.
 */
function stepLine(root: string, runId: string, path: string, group: StepGroup): LogLine | undefined {
	const { n, step, at, calls } = group;

	if (step === undefined) return undefined;
	const word = STEP_WORDS[step.mark];
	const text = `${step.text.slice(0, PHASE_WIDTH)}${word === undefined ? "" : `  ${word}`}${stepTime(step)}`;
	const count = `${calls.length} ${calls.length === 1 ? "call" : "calls"}`;
	const bytes = calls.reduce((sum, node) => sum + (outputBytes(node.record) ?? 0), 0);
	const facts = [count, sizeOf(bytes), stepName(root, runId, n)];

	// A step prints again in `log --follow` when it ends, with its last count.
	return {
		item: `step:${runId}:${n}:${step.ended ?? "open"}`,
		text: `${lineHead(at, path)} ${text}  ${facts.join("  ")}`,
	};
}

/** The line of the call `node` of the run at `path`, and the last lines of its error when it failed. */
function callLines(root: string, path: string, node: CallNode): LogLine[] {
	const { record, state, key } = node;
	const started = Date.parse(record.startedAt);
	const ended = endedAt(record.end);
	const word = state === "done" ? [] : [state];
	const time = ended === undefined ? [] : [duration(Date.parse(ended) - started)];
	const shell = shellResult(record);
	const exit = shell === undefined ? [] : [`exit ${shell.code}`];
	const bytes = outputBytes(record);
	const facts = [...word, ...time, ...exit, ...(bytes === undefined ? [] : [sizeOf(bytes)]), nameOfKey(root, key)];
	const text = `${lineHead(started, path)} ${record.kind} ${node.label}  ${facts.join("  ")}`;
	// A call prints again in `log --follow` when its state changes.
	const lines = [{ item: `${key}:${state}`, text }];

	if (record.end?.kind === "failed") {
		lines.push(...tailLines(key, record.end.error, lineHead(Date.parse(record.end.at), path)));
	}

	return lines;
}

/** The last lines of `error` after `head`, each cut at its width, as items `<item>#<n>`. */
function tailLines(item: string, error: string, head: string): LogLine[] {
	const tail = linesOf(error.trimEnd()).slice(-TAIL_LINES);

	return tail.map((line, n) => ({ item: `${item}#${n}`, text: `${head} | ${line.slice(0, TAIL_WIDTH)}` }));
}

/** A child run of the log and its calls. */
type ChildRun = { readonly run: LogRun; readonly calls: readonly CallNode[] };

/**
 * The child run of the `run` call `node` of the run at `parentPath`, with its calls, when its child run started. It
 * starts at the start of its `run` call, its task is in `children`, and its error is the error of its `run` call.
 */
function childRun(node: CallNode, parentPath: string, children: RunProgress["children"]): ChildRun | undefined {
	const { record } = node;

	if (record.kind !== "run" || record.child === undefined) return undefined;

	const run = {
		runId: record.child.runId,
		path: `${parentPath}/${record.args.name}`,
		start: Date.parse(record.startedAt),
		task: children.get(record.child.task),
		error: record.end?.kind === "failed" ? record.end.error : undefined,
	};

	return { run, calls: node.calls ?? [] };
}

/**
 * The lines of the run `run` of the root run `root`: its `start` line; each step line, and under it each call of the
 * step that is not done, with each `run` call replaced by the lines of its child run; then its end line, when its task
 * has ended, with its error under it. A run whose task has not ended and does not run has its state after `start`.
 * `read` gives the progress events of the run, their steps and the child tasks.
 */
export function runLines(root: string, run: LogRun, read: RunProgress, calls: readonly CallNode[]): LogLine[] {
	const { runId, path, start, task } = run;
	const state = task === undefined ? undefined : recordedStatus(task);
	const other = state === undefined || state === "running" || hasEnded(state) ? "" : `  ${state}`;
	const lines: LogLine[] = [{ item: `start:${runId}`, text: `${lineHead(start, path)} start${other}` }];

	for (const group of groupsOf(read.progress, runId, calls)) {
		const line = stepLine(root, runId, path, group);

		if (line !== undefined) lines.push(line);

		for (const node of group.calls) {
			const child = childRun(node, path, read.children);

			if (child !== undefined) lines.push(...runLines(root, child.run, read, child.calls));
			else if (node.state !== "done") lines.push(...callLines(root, path, node));
		}
	}

	if (state === undefined || !hasEnded(state)) return lines;
	const end = lastEnd(read.events, runId) ?? task?.endedAt;
	const word = (task === undefined ? undefined : taskResult(task)?.status) ?? state;
	const time = start === undefined || end === undefined ? "" : `  ${duration(end - start)}`;
	const item = `end:${runId}:${word}:${end ?? "-"}`;
	lines.push({ item, text: `${lineHead(end, path)} ${word}${time}` });

	if (run.error !== undefined) lines.push(...tailLines(item, run.error, lineHead(end, path)));

	return lines;
}

/**
 * The path and the calls of the run `runId`: the run `run`, whose calls are `calls`, or one of its child runs, at any
 * depth. Undefined when there is no such run.
 */
function runOf(run: ChildRun, runId: string, children: RunProgress["children"]): ChildRun | undefined {
	if (run.run.runId === runId) return run;

	for (const node of run.calls) {
		const child = childRun(node, run.run.path, children);
		const found = child === undefined ? undefined : runOf(child, runId, children);

		if (found !== undefined) return found;
	}

	return undefined;
}

/**
 * The step `step` in the root run `root`, whose calls are `calls`: its line, then the line of each of its own calls
 * with the last lines of the error of a failed one, without the calls of its child runs. Step 0 has no line of its
 * own. Undefined when there is no such step.
 */
export function stepLog(
	root: LogRun,
	read: RunProgress,
	calls: readonly CallNode[],
	step: StepRef,
): string[] | undefined {
	const { runId, n } = step;
	const found = runOf({ run: root, calls }, runId, read.children);
	// A step of a run that is not among `calls` has no calls, and an unknown path.
	const path = found?.run.path ?? "?";
	const group = groupsOf(read.progress, runId, found?.calls ?? []).find((g) => String(g.n) === n);

	if (group === undefined) return undefined;
	const head = stepLine(root.runId, runId, path, group);
	const lines = group.calls.flatMap((node) => callLines(root.runId, path, node));

	return [...(head === undefined ? [] : [head]), ...lines].map((line) => line.text);
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
