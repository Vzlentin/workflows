/**
 * The calls of a saved run as `workflows show` and `workflows attach` read them: the call tree of a run and its child
 * runs, its lines for a run without steps, and its agent rows for `show --agents`.
 */
import { Todo } from "@vzlentin/harness/todo";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import {
	CALL_END,
	type CallEnd,
	type CallKind,
	callUnion,
	childOf,
	type SavedCall,
	SESSION_MODEL,
	SHELL_OUTPUT,
} from "../run/calls.ts";
import { ownedBy } from "../run/keys.ts";
import { duration, type Progress, type StepView, stepIndexOf } from "./steps.ts";

/** The mark of a call: running, done, or any other state. */
const CALL_MARK = Type.Union([Type.Literal("✓"), Type.Literal("◉"), Type.Literal("✗")]);

export type CallMark = Static<typeof CALL_MARK>;

/**
 * The state of a call: `done` or `failed` once it ended, `cancelled` when the end of its script cancelled it, `waiting`
 * for the open `input` call of a waiting run, `running` while its task runs, and `cut` when its task ended first.
 */
const CALL_STATE = Type.Union([
	Type.Literal("running"),
	Type.Literal("done"),
	Type.Literal("failed"),
	Type.Literal("cancelled"),
	Type.Literal("cut"),
	Type.Literal("waiting"),
]);

export type CallState = Static<typeof CALL_STATE>;

/**
 * The fields of every call of `workflows show --json`: its run, label, phase, state, mark and start time, and the end
 * of a call that ended, as its record saves it.
 */
const SHOWN_FIELDS = {
	runId: Type.String(),
	label: Type.String(),
	phase: Type.Union([Type.String(), Type.Null()]),
	state: CALL_STATE,
	mark: CALL_MARK,
	startedAt: Type.String(),
	end: Type.Optional(CALL_END),
};

/**
 * One call of `workflows show --json`, one member for each kind. A `session` call has its conversation and the model
 * that it used, an `input` call its ask, and a `run` call whose child run started its `child`: the list of todos and
 * the calls of that child run.
 */
export const SHOWN_CALL = Type.Cyclic(
	{
		Call: callUnion(SHOWN_FIELDS, {
			session: { conversation: Type.Optional(Type.Number()), model: Type.Optional(SESSION_MODEL) },
			input: { ask: Type.Optional(Type.Number()) },
			sh: { output: Type.Optional(SHELL_OUTPUT) },
			run: {
				child: Type.Optional(
					Type.Object(
						{ todos: Type.Array(Todo), calls: Type.Array(Type.Ref("Call")) },
						{ additionalProperties: false },
					),
				),
			},
		}),
	},
	"Call",
);

/** One call of the run `runId` in `workflows show`. */
export type Shown = Static<typeof SHOWN_CALL>;

/**
 * What the state of a call depends on: whether the root run `ended`, whether it `waiting` for an answer, and the IDs
 * of the tasks that run.
 */
export type RunState = { readonly ended: boolean; readonly waiting: boolean; readonly live: ReadonlySet<number> };

/**
 * The state of the call `record` in a run of `run`. A record of an earlier version has no task: it is cut once the run
 * ended.
 */
function stateOf(record: SavedCall, run: RunState): CallState {
	if (record.end !== undefined) return record.end.kind;

	if (record.kind === "input" && run.waiting) return "waiting";

	if (record.task === undefined) return run.ended ? "cut" : "running";

	return run.live.has(record.task) ? "running" : "cut";
}

/** The time when the call that ended with `end` ended done or failed, or undefined for a call that did not. */
export function endedAt(end: CallEnd | undefined): string | undefined {
	return end === undefined || end.kind === "cancelled" ? undefined : end.at;
}

/** The mark of a call in `state`: `◉` running, `✓` done, else `✗`. */
export function markOf(state: CallState): CallMark {
	return state === "running" ? "◉" : state === "done" ? "✓" : "✗";
}

/**
 * One call of the run `runId` with its store `key`, its record, its label and its state, and the calls of its child run
 * when it is a `run` call whose child run started.
 */
export type CallNode = {
	readonly key: string;
	readonly runId: string;
	readonly record: SavedCall;
	readonly label: string;
	readonly state: CallState;
	readonly calls?: CallNode[];
};

/** The calls of the run `runId` in the order they started, each `run` call with the calls of its child run. */
export function callNodes(records: Map<string, SavedCall>, runId: string, run: RunState): CallNode[] {
	const own = [...records].filter(([key]) => ownedBy(runId, key));

	return own
		.sort(([, a], [, b]) => a.startedAt.localeCompare(b.startedAt))
		.map(([key, record]) => {
			// A `run` call that failed before its child run started has no `child`.
			const child = childOf(record)?.runId;
			const node = { key, runId, record, label: labelFor(record.kind, record, records), state: stateOf(record, run) };

			return child === undefined ? node : { ...node, calls: callNodes(records, child, run) };
		});
}

/**
 * The calls of the run `runId` as `show` gives them: the nodes of `callNodes`, each with its mark, and each `run` call
 * with the list of todos of its child run in `todos`, empty when `todos` has none.
 */
export function callTree(
	records: Map<string, SavedCall>,
	todos: ReadonlyMap<string, Todo[]>,
	runId: string,
	run: RunState,
): Shown[] {
	return callNodes(records, runId, run).map((node) => shownCall(node, todos));
}

/** The fields of every kind of call in `workflows show --json`. */
type ShownFields = Static<Type.TObject<typeof SHOWN_FIELDS>>;

/** The fields of every kind of the call `node`, with the end of a call that ended. */
function shownFields({ record, runId, label, state }: CallNode): ShownFields {
	const fields: ShownFields = {
		runId,
		label,
		phase: record.phase,
		state,
		mark: markOf(state),
		startedAt: record.startedAt,
	};

	if (record.end !== undefined) fields.end = record.end;

	return fields;
}

/** The call `node` as `show` gives it, with the fields of its kind. */
function shownCall(node: CallNode, todos: ReadonlyMap<string, Todo[]>): Shown {
	const { record } = node;
	const fields = shownFields(node);

	switch (record.kind) {
		case "session": {
			const shown: Shown = { kind: record.kind, args: record.args, ...fields };

			if (record.conversation !== undefined) shown.conversation = record.conversation;

			if (record.model !== undefined) shown.model = record.model;

			return shown;
		}

		case "input": {
			const shown: Shown = { kind: record.kind, args: record.args, ...fields };

			if (record.ask !== undefined) shown.ask = record.ask;

			return shown;
		}

		case "run": {
			const shown: Shown = { kind: record.kind, args: record.args, ...fields };

			if (record.child !== undefined && node.calls !== undefined) {
				const calls = node.calls.map((call) => shownCall(call, todos));
				shown.child = { todos: todos.get(record.child.runId) ?? [], calls };
			}

			return shown;
		}

		case "ask":
			return { kind: record.kind, args: record.args, ...fields };
		case "sh": {
			const shown: Shown = { kind: record.kind, args: record.args, ...fields };

			if (record.output !== undefined) shown.output = record.output;

			return shown;
		}

		case "ok":
			return { kind: record.kind, args: record.args, ...fields };
		case "pastRuns":
			return { kind: record.kind, args: record.args, ...fields };
		case "todo":
			return { kind: record.kind, args: record.args, ...fields };
		case "harness":
			return { kind: record.kind, args: record.args, ...fields };
		case "gitHost":
			return { kind: record.kind, args: record.args, ...fields };
		default:
			return record satisfies never;
	}
}

/** A line of `treeEntries`, with the conversation of its session or its ask. */
export type TreeEntry = { readonly text: string; readonly conversation?: number | undefined };

/**
 * The phase lines at `indent` and the calls under them, the calls of a child run under its `run` line, each session
 * with its conversation and each ask with the conversation that it asks. A call that a stopped or failed task cut has
 * no duration. A working session prints `◉`.
 */
function treeEntries(calls: readonly Shown[], indent: string, now: number): TreeEntry[] {
	const entries: TreeEntry[] = [];
	let phase: string | null = null;

	for (const call of calls) {
		if (call.phase !== null && call.phase !== phase) entries.push({ text: `${indent}${call.phase}` });
		phase = call.phase;
		const mark = call.kind === "session" && works(call, calls) ? "◉" : call.mark;
		const ended = endedAt(call.end);
		const end = mark === "◉" ? now : ended === undefined ? undefined : Date.parse(ended);
		const time = end === undefined ? shownState(call.state) : `  ${duration(end - Date.parse(call.startedAt))}`;
		const text = `${indent}  ${mark} ${call.kind} ${call.label}${time}`;
		const conversation = conversationOf(call);

		entries.push({ text, conversation });

		const children = childCalls(call);

		if (children !== undefined) entries.push(...treeEntries(children, `${indent}    `, now));
	}

	return entries;
}

/** The word that a call in `state` with no duration shows in place of it. */
function shownState(state: CallState): string {
	return state === "cancelled" || state === "cut" || state === "waiting" ? `  ${state}` : "";
}

/** A `session` call of `workflows show --json`. */
type ShownSession = Extract<Shown, { kind: "session" }>;

/** The calls of the child run of `call`, when it is a `run` call whose child run started. */
function childCalls(call: Shown): readonly Shown[] | undefined {
	return call.kind === "run" ? call.child?.calls : undefined;
}

/** The conversation of `call`: the one that a session opened, or the one that an ask asks; else undefined. */
export function conversationOf(call: SavedCall | Shown): number | undefined {
	return call.kind === "session" ? call.conversation : askedConversation(call);
}

/** The conversation that the ask `call` asks, or undefined for another call. */
function askedConversation(call: SavedCall | Shown): number | undefined {
	return call.kind === "ask" ? call.args.conversation : undefined;
}

/**
 * The body lines of `show` with the agent of each: the step lines of `progress`, each with the agent of its step, or the
 * lines of `treeEntries` of `calls` when the run has no steps.
 */
export function showEntries(calls: readonly Shown[], progress: Progress, now: number): TreeEntry[] {
	if (!progress.stepped) return treeEntries(calls, "", now);

	const entries = progress.entries();

	const agents = stepAgents(
		calls,
		entries.flatMap(({ step }) => (step === undefined ? [] : [step])),
	);

	return entries.map(({ text, step }) => ({ text, conversation: step === undefined ? undefined : agents.get(step) }));
}

/**
 * The agent of each of `steps`: the first session of `calls` that opened a conversation in the step, or in a child run
 * that a `run` call of the step started, with the step of a call from `stepIndexOf`. The summarizer of a step starts
 * after the session whose note it compresses, so it is never the one.
 */
function stepAgents(calls: readonly Shown[], steps: readonly StepView[]): Map<StepView, number> {
	const sessions: { readonly call: ShownSession; readonly at: readonly StepView[] }[] = [];
	const byRun = Map.groupBy(steps, (step) => step.runId);

	const visit = (shown: readonly Shown[], outer: readonly StepView[]) => {
		for (const call of shown) {
			const own = byRun.get(call.runId) ?? [];
			const step = own[stepIndexOf(own, call)];

			const at = step === undefined ? outer : [...outer, step];

			if (call.kind === "session") sessions.push({ call, at });
			visit(childCalls(call) ?? [], at);
		}
	};

	visit(calls, []);
	// Child runs can work at once, so the first session is the first to start in the whole tree.
	sessions.sort((a, b) => a.call.startedAt.localeCompare(b.call.startedAt));
	const agents = new Map<StepView, number>();

	for (const { call, at } of sessions) {
		if (call.conversation === undefined) continue;

		for (const step of at) if (!agents.has(step)) agents.set(step, call.conversation);
	}

	return agents;
}

/**
 * A row of `show --agents --json`: a phase line, an agent, or a child run. `depth` is the nesting of child runs. An
 * agent has the phase of its session, the model that its session used when the record has it, and no `endedAt` while
 * it works. Its `facts` are its model ID, asks and time, as one text.
 */
export const AGENT_ROW = Type.Union([
	Type.Object(
		{ kind: Type.Literal("phase"), depth: Type.Integer(), text: Type.String() },
		{ additionalProperties: false },
	),
	Type.Object(
		{
			kind: Type.Literal("agent"),
			depth: Type.Integer(),
			mark: CALL_MARK,
			text: Type.String(),
			phase: Type.Union([Type.String(), Type.Null()]),
			model: Type.Optional(SESSION_MODEL),
			asks: Type.Integer(),
			conversation: Type.Number(),
			startedAt: Type.String(),
			endedAt: Type.Optional(Type.String()),
			facts: Type.String(),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{ kind: Type.Literal("run"), depth: Type.Integer(), mark: CALL_MARK, text: Type.String() },
		{ additionalProperties: false },
	),
]);

type AgentRow = Static<typeof AGENT_ROW>;

/** An agent of `show --agents`. */
type Agent = Extract<AgentRow, { kind: "agent" }>;

/** The lines of `text` that are not blank, with their spaces collapsed. */
function textLines(text: string): string[] {
	return text
		.split("\n")
		.map((line) => line.replace(/\s+/g, " ").trim())
		.filter((line) => line !== "");
}

/**
 * The phase lines of `calls`, each session that opened a conversation as an agent, and each child run with its rows
 * under it. An agent's text is the first line of its first prompt. When other agents of `calls` have the same first
 * line, it is the first line of its prompt that not all of them have. A working agent's time ends at `now`.
 */
export function agentRows(calls: readonly Shown[], depth: number, now: number): AgentRow[] {
	const prompts = new Map<number, string[]>();

	for (const call of calls) {
		if (call.kind === "ask" && !prompts.has(call.args.conversation)) {
			prompts.set(call.args.conversation, textLines(call.args.prompt));
		}
	}

	const textOf = (lines: readonly string[]): string | undefined => {
		const same = [...prompts.values()].filter((other) => other !== lines && other[0] === lines[0]);

		return lines.find((line) => same.length === 0 || !same.every((other) => other.includes(line))) ?? lines[0];
	};

	const rows: AgentRow[] = [];
	let phase: string | null = null;

	for (const call of calls) {
		if (call.kind !== "run" && (call.kind !== "session" || call.conversation === undefined)) continue;

		if (call.phase !== null && call.phase !== phase) rows.push({ kind: "phase", depth, text: call.phase });
		phase = call.phase;

		if (call.kind === "run") {
			rows.push({ kind: "run", depth, mark: call.mark, text: `run ${call.label}` });
			rows.push(...agentRows(call.child?.calls ?? [], depth + 1, now));
			continue;
		}

		const { conversation } = call;

		if (conversation === undefined) continue;
		const asks = calls.filter((ask) => askedConversation(ask) === conversation);
		const working = works(call, calls);
		const failed = call.mark === "✗" || asks.some((ask) => ask.mark === "✗");
		const ends = [call, ...asks].flatMap(({ end }) => endedAt(end) ?? []).sort();
		const ended = working ? undefined : ends.at(-1);
		const end = ended === undefined ? now : Date.parse(ended);
		const count = `${asks.length} ${asks.length === 1 ? "ask" : "asks"}`;
		const facts = [call.model?.model, count, duration(end - Date.parse(call.startedAt))];

		const row: Agent = {
			kind: "agent",
			depth,
			mark: working ? "◉" : failed ? "✗" : "✓",
			text: textOf(prompts.get(conversation) ?? []) ?? call.label,
			phase: call.phase,
			asks: asks.length,
			conversation,
			startedAt: call.startedAt,
			facts: facts.filter((fact) => fact !== undefined && fact !== "").join("  "),
		};

		if (call.model !== undefined) row.model = call.model;

		if (ended !== undefined) row.endedAt = ended;
		rows.push(row);
	}

	return rows;
}

/**
 * The agent of a run among `rows`, the rows of `agentRows`, whose conversation `wanted` takes: the agent that works now,
 * else the last agent to start. Undefined when no agent of the rows is taken.
 */
export function runAgent(rows: readonly AgentRow[], wanted: (conversation: number) => boolean = () => true) {
	const agents = rows
		.flatMap((row) => (row.kind === "agent" && wanted(row.conversation) ? [row] : []))
		.sort((a, b) => a.startedAt.localeCompare(b.startedAt));

	return agents.findLast((row) => row.mark === "◉") ?? agents.at(-1);
}

/** The lines of `show --agents`: each row indented by its depth, an agent with its facts. */
export function agentLines(rows: readonly AgentRow[]): string[] {
	return rows.map((row) => {
		const indent = "    ".repeat(row.depth);

		if (row.kind === "phase") return `${indent}${row.text}`;

		return row.kind === "run"
			? `${indent}  ${row.mark} ${row.text}`
			: `${indent}  ${row.mark} ${row.text}  ${row.facts}`;
	});
}

/** Whether `call` is a session that one of its asks among `siblings` works in now. */
function works(call: ShownSession, siblings: readonly Shown[]): boolean {
	const { conversation } = call;

	return (
		conversation !== undefined && siblings.some((ask) => ask.mark === "◉" && askedConversation(ask) === conversation)
	);
}

/** The whole command of the args of a `sh` or `ok` call. */
export function commandOf({ cmd }: { readonly cmd: string | string[] }): string {
	return Array.isArray(cmd) ? cmd.join(" ") : cmd;
}

/** A call record of the kind `K`. */
type CallOf<K extends CallKind> = SavedCall & { readonly kind: K };

/** The label of a call of each kind, from its record and the records of its run. */
export type Labels = {
	readonly [K in CallKind]: (record: CallOf<K>, records: ReadonlyMap<string, SavedCall>) => string;
};

/** A `harness` request with a string `action`. */
const ACTION = Type.Object({ action: Type.String() });

/**
 * The label of each kind of call: the role name and conversation of a session, the role name of the session for an
 * ask, the command on one line for `sh` and `ok`, the workflow and child run ID for `run`, the question on one line
 * for `input`, the workflow for `pastRuns` (`any` for every workflow), the action with its text, or its ID and state,
 * on one line for `todo`, the request type for `harness`, with its action when that is a string, on one line, and
 * the action with its branch or number for `gitHost`, on one line.
 * A kind without a label fails the type check.
 */
export const LABELS: Labels = {
	session: ({ args, conversation }) =>
		conversation === undefined ? args.profile : `${args.profile} conversation ${conversation}`,
	// A linear scan for each ask; an index by conversation if runs get thousands of calls.
	ask: ({ args }, records) =>
		String(
			[...records.values()].find(
				(record): record is CallOf<"session"> => record.kind === "session" && record.conversation === args.conversation,
			)?.args.profile,
		),
	sh: ({ args }) => labelLine(commandOf(args)),
	ok: ({ args }) => labelLine(commandOf(args)),
	run: ({ args, child }) => (child === undefined ? args.name : `${args.name} ${child.runId}`),
	input: ({ args }) => labelLine(args.question),
	pastRuns: ({ args }) => args.workflow ?? "any",
	todo: ({ args }) => {
		if (args.action === "add") return labelLine(`add ${args.text}`);

		if (args.action === "set") return labelLine(`set ${args.id} ${args.state}`);

		return labelLine(args.action);
	},
	harness: ({ args }) => labelLine(Value.Check(ACTION, args) ? `${args.type} ${args.action}` : args.type),
	gitHost: ({ args }) => labelLine(`${args.action} ${"branch" in args ? args.branch : args.number}`),
};

/** The label of the call of the kind `kind` with the record `record` among the records of its run, from `LABELS`. */
function labelFor<K extends CallKind>(kind: K, record: CallOf<K>, records: ReadonlyMap<string, SavedCall>): string {
	return LABELS[kind](record, records);
}

/** `text` as a label: on one line, cut at 80 characters. */
function labelLine(text: string): string {
	return text.replace(/\s+/g, " ").trim().slice(0, 80);
}
