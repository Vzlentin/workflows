/**
 * The calls of a saved run as `workflows show` and `workflows attach` read them: the call tree of a run and its child
 * runs, its lines for `show --calls`, and its agent rows for `show --agents`.
 */
import type { JsonValue } from "@earendil-works/chord";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { duration, type Mark } from "./progress.ts";
import type { SavedCall } from "./script.ts";

/** One call of `workflows show`, with the calls of its child run when it is a `run` call. */
type Shown = Omit<SavedCall, "child"> & {
	readonly label: string;
	readonly mark: Mark;
	readonly calls?: Shown[];
};

/**
 * The calls of the run `runId` in the order they started, each `run` call with the calls of its child run. A call that
 * started and did not end is `◉` while the run's task runs, and `✗` once it `ended`.
 */
export function callTree(records: Map<string, SavedCall>, runId: string, ended: boolean): Shown[] {
	const own = [...records].flatMap(([key, record]) => (key.startsWith(`${runId}/`) ? [record] : []));

	return own
		.sort((a, b) => a.startedAt.localeCompare(b.startedAt))
		.map(({ child: started, ...record }) => {
			const cut = ended && record.endedAt === undefined;
			const mark = record.error !== undefined || cut ? "✗" : record.endedAt !== undefined ? "✓" : "◉";
			// A `run` call that failed before its child run started has no `child`.
			const child = started?.runId;
			const shown = { ...record, label: labelOf(record, child, records), mark } as const;

			return child === undefined ? shown : { ...shown, calls: callTree(records, child, ended) };
		});
}

/**
 * The phase lines at `indent` and the calls under them, the calls of a child run under its `run` line. A call that a
 * stopped or failed task cut has no duration. A working session prints `◉`.
 */
export function treeLines(calls: readonly Shown[], indent: string, now: number): string[] {
	return treeEntries(calls, indent, now).map((entry) => entry.text);
}

/** A line of `treeLines`, with the conversation of its session or its ask. */
export type TreeEntry = { readonly text: string; readonly conversation?: number };

/** The lines of `treeLines`, each session with its conversation and each ask with the conversation that it asks. */
export function treeEntries(calls: readonly Shown[], indent: string, now: number): TreeEntry[] {
	const entries: TreeEntry[] = [];
	let phase: string | null = null;

	for (const call of calls) {
		if (call.phase !== null && call.phase !== phase) entries.push({ text: `${indent}${call.phase}` });
		phase = call.phase;
		const mark = works(call, calls) ? "◉" : call.mark;
		const end = mark === "◉" ? now : call.endedAt === undefined ? undefined : Date.parse(call.endedAt);
		const time = end === undefined ? "" : `  ${duration(end - Date.parse(call.startedAt))}`;
		const text = `${indent}  ${mark} ${call.kind} ${call.label}${time}`;
		const conversation = call.kind === "session" ? call.conversation : askedConversation(call);

		entries.push(conversation === undefined ? { text } : { text, conversation });

		if (call.calls !== undefined) entries.push(...treeEntries(call.calls, `${indent}    `, now));
	}

	return entries;
}

/** The conversation that the ask `call` asks, or undefined for another call. */
function askedConversation(call: Shown): number | undefined {
	const asked = call.args.conversation;

	return call.kind === "ask" && Value.Check(Type.Number(), asked) ? asked : undefined;
}

/**
 * The conversation of each step, keyed by `stepKey` of its run ID and its text: the first session that opened a
 * conversation in the step, or in a child run that the step started. The summarizer of a step starts after the session
 * whose note it compresses, so it is never the one.
 */
export function stepAgents(records: Map<string, SavedCall>): Map<string, number> {
	const callers = new Map<string, { readonly run: string; readonly phase: string | null }>();

	for (const [key, record] of records) {
		if (record.kind === "run" && record.child !== undefined) {
			callers.set(record.child.runId, { run: runOf(key), phase: record.phase });
		}
	}

	const sessions = [...records]
		.filter(([, record]) => record.kind === "session" && record.conversation !== undefined)
		.sort(([, a], [, b]) => a.startedAt.localeCompare(b.startedAt));

	const agents = new Map<string, number>();

	for (const [key, { conversation, phase }] of sessions) {
		if (conversation === undefined) continue;

		for (let at: { run: string; phase: string | null } | undefined = { run: runOf(key), phase }; at !== undefined; ) {
			if (at.phase !== null && !agents.has(stepKey(at.run, at.phase)))
				agents.set(stepKey(at.run, at.phase), conversation);
			at = callers.get(at.run);
		}
	}

	return agents;
}

/** The key of the step `text` of the run `run` in `stepAgents`. */
export function stepKey(run: string, text: string): string {
	return JSON.stringify([run, text]);
}

/** The run ID of the call record key `key`: the part before its `/`. */
function runOf(key: string): string {
	return key.slice(0, key.indexOf("/"));
}

/**
 * A row of `show --agents`: a phase line, an agent, or a child run. `depth` is the nesting of child runs. An agent has
 * the phase of its session, and no `endedAt` while it works. Its `facts` are its model, asks and time, as one text.
 */
type AgentRow =
	| { readonly kind: "phase"; readonly depth: number; readonly text: string }
	| {
			readonly kind: "agent";
			readonly depth: number;
			readonly mark: Mark;
			readonly text: string;
			readonly phase: string | null;
			readonly model: string;
			readonly asks: number;
			readonly conversation: number;
			readonly startedAt: string;
			readonly endedAt?: string;
			readonly facts: string;
	  }
	| { readonly kind: "run"; readonly depth: number; readonly mark: Mark; readonly text: string };

/** The lines of `text` that are not blank, with their spaces collapsed. */
function textLines(text: JsonValue | undefined): string[] {
	return Value.Check(Type.String(), text)
		? text
				.split("\n")
				.map((line) => line.replace(/\s+/g, " ").trim())
				.filter((line) => line !== "")
		: [];
}

/**
 * The phase lines of `calls`, each session that opened a conversation as an agent, and each child run with its rows
 * under it. An agent's text is the first line of its first prompt. When other agents of `calls` have the same first
 * line, it is the first line of its prompt that not all of them have. A working agent's time ends at `now`.
 */
export function agentRows(calls: readonly Shown[], depth: number, now: number): AgentRow[] {
	const prompts = new Map<number, string[]>();

	for (const call of calls) {
		const { conversation } = call.args;

		if (call.kind === "ask" && Value.Check(Type.Number(), conversation) && !prompts.has(conversation)) {
			prompts.set(conversation, textLines(call.args.prompt));
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
			rows.push(...agentRows(call.calls ?? [], depth + 1, now));
			continue;
		}

		const { conversation } = call;

		if (conversation === undefined) continue;
		const asks = calls.filter((ask) => ask.kind === "ask" && ask.args.conversation === conversation);
		const working = works(call, calls);
		const failed = call.mark === "✗" || asks.some((ask) => ask.mark === "✗");
		const ends = [call, ...asks].flatMap(({ endedAt }) => (endedAt === undefined ? [] : [endedAt])).sort();
		const endedAt = working ? undefined : ends.at(-1);
		const model = Value.Check(Type.String(), call.args.model) ? call.args.model : "";
		const end = endedAt === undefined ? now : Date.parse(endedAt);
		const count = `${asks.length} ${asks.length === 1 ? "ask" : "asks"}`;

		const row = {
			kind: "agent",
			depth,
			mark: working ? "◉" : failed ? "✗" : "✓",
			text: textOf(prompts.get(conversation) ?? []) ?? call.label,
			phase: call.phase,
			model,
			asks: asks.length,
			conversation,
			startedAt: call.startedAt,
			facts: [model, count, duration(end - Date.parse(call.startedAt))].filter(Boolean).join("  "),
		} as const;

		rows.push(endedAt === undefined ? row : { ...row, endedAt });
	}

	return rows;
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
function works(call: Shown, siblings: readonly Shown[]): boolean {
	return (
		call.kind === "session" &&
		siblings.some((ask) => ask.kind === "ask" && ask.mark === "◉" && ask.args.conversation === call.conversation)
	);
}

/**
 * The profile and conversation of a session, the profile of the session for an ask, the command on one line for `sh` and
 * `ok`, the workflow and child run ID for `run`, and the question on one line for `input`.
 */
function labelOf(
	{ kind, args, conversation }: Pick<SavedCall, "kind" | "args" | "conversation">,
	child: string | undefined,
	records: Map<string, SavedCall>,
): string {
	if (kind === "sh" || kind === "ok") {
		const { cmd } = args;

		return (Array.isArray(cmd) ? cmd.join(" ") : String(cmd)).replace(/\s+/g, " ").trim().slice(0, 80);
	}

	if (kind === "run") return [args.name, child].filter((value) => value !== undefined).join(" ");

	if (kind === "input") return String(args.question).replace(/\s+/g, " ").trim().slice(0, 80);

	if (kind === "session") {
		return conversation === undefined ? String(args.profile) : `${args.profile} conversation ${conversation}`;
	}

	// A linear scan for each ask; an index by conversation if runs get thousands of calls.
	const session = [...records.values()].find((record) => record.conversation === args.conversation);

	return String(session?.args.profile);
}
