/**
 * The catch-up hook of the workflows entry: before an input of the project agent, the lines of the workflows runs that
 * ended since the agent last saw them, with their sessions.
 */
import type { JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Harness, TaskId } from "@earendil-works/pi-durable";
import { StartedTasks } from "@vzlentin/harness/tasks";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { SessionsDoc } from "./sessions.ts";
import { type Host, TASK } from "./version.ts";

const context = BACKGROUND_CONTEXT;

/** What the agent has seen: the highest started task ID, and the workflows runs that were not terminal, by task ID. */
const SEEN = Type.Object({ lastTaskId: Type.Integer(), pending: Type.Array(Type.Integer()) });

type Seen = Static<typeof SEEN>;

/** The fields of a run input that the catch-up reads. It also takes the inputs of earlier versions. */
const RUN_INPUT = Type.Object({
	name: Type.String(),
	runId: Type.String(),
	root: Type.Optional(Type.String()),
	worktree: Type.Optional(Type.Object({ branch: Type.String() })),
});

/** The fields of a run result that the catch-up reads. */
const RUN_RESULT = Type.Object({
	status: Type.Optional(Type.String()),
	subject: Type.Optional(Type.String()),
	branch: Type.Optional(Type.String()),
	head: Type.Optional(Type.String()),
	divergence: Type.Optional(Type.String()),
	lessons: Type.Optional(Type.Array(Type.Unknown())),
});

/** A session of a run, with the key of its lineage and the agent profile that opened it. */
type Session = { run: string; conversation: number; key?: string; label?: string };

/** One ended workflows run, as the data of the hook gives it. */
type RunFacts = Omit<Static<typeof RUN_RESULT>, "status" | "lessons"> & {
	task: number;
	runId: string;
	workflow: string;
	status: string;
	lessons?: JsonValue[];
	sessions: Session[];
};

/** A workflows run that the catch-up cannot report: its record is gone, or its input is not a workflows run input. */
type LostRun = { task: number; reason: string };

/** What the hook gives the host for one catch-up. The host checks it at runtime. */
type Part = { seen: JsonValue; lines: string[]; data?: JsonValue };

/** What the catch-up reports of one task. */
type RunState = { kind: "run"; facts: RunFacts } | { kind: "lost"; lost: LostRun } | { kind: "pending" };

/**
 * The catch-up hook `workflows.runs`. A `seen` that is missing or not valid, as at the first catch-up, gives no lines:
 * the hook only records the runs. A read that fails throws, so the host keeps the last `seen` and tries again.
 */
export function runsCatchUp(host: Host) {
	return {
		kind: "workflows.runs",
		run: (harness: Harness, seen: JsonValue | undefined) => runsPart(host, harness, seen),
	};
}

async function runsPart(host: Host, harness: Harness, seen: JsonValue | undefined): Promise<Part> {
	const started = Object.values((await harness.snapshot(StartedTasks, context))?.tasks ?? {}).sort((a, b) => a - b);
	const before: Seen | undefined = Value.Check(SEEN, seen) ? seen : undefined;
	const last = before?.lastTaskId ?? 0;
	const lastTaskId = Math.max(last, ...started);
	const runs: RunFacts[] = [];
	const lost: LostRun[] = [];
	const pending: number[] = [];

	for (const id of started) {
		const known = before?.pending.includes(id) ?? false;

		if (!known && id <= last) continue;
		const found = await runState(host, harness, id, known);

		switch (found?.kind) {
			case "pending":
				pending.push(id);
				break;
			case "lost":
				lost.push(found.lost);
				break;
			case "run":
				runs.push(found.facts);
				break;
		}
	}

	const next = { lastTaskId, pending };

	if (before === undefined || (runs.length === 0 && lost.length === 0)) return { seen: next, lines: [] };
	const lines: string[] = [];

	if (runs.length > 0) lines.push("Workflow runs that ended:", ...runs.map((facts) => `- ${runLine(facts)}`));

	if (lost.length > 0) {
		lines.push(
			"Workflow runs that cannot be reported:",
			...lost.map(({ task, reason }) => `- task ${task}: ${reason}`),
		);
	}

	// SAFETY: the facts come from stored JSON and strings, so they are JSON.
	const data = (lost.length > 0 ? { runs, lost } : { runs }) as JsonValue;

	return { seen: next, lines, data };
}

/**
 * The facts of the task `id` when it is a terminal workflows run, `pending` while it runs, and nothing for another
 * task. A lost run is the task of a run whose input is not a workflows run input, or of a `known` run, which was
 * pending, whose record is gone.
 */
async function runState(
	host: Host,
	harness: Harness,
	id: TaskId<JsonValue>,
	known: boolean,
): Promise<RunState | undefined> {
	const record = await harness.getTask(id, context);

	if (record === undefined) {
		return known ? { kind: "lost", lost: { task: id, reason: "its task record is gone" } } : undefined;
	}

	if (record.kind !== TASK.name) return undefined;

	if (record.state.status !== "terminal") return { kind: "pending" };
	const { input } = record;

	if (!Value.Check(RUN_INPUT, input)) {
		return { kind: "lost", lost: { task: id, reason: "its input is not a workflows run input" } };
	}

	const { outcome } = record.state;
	const result = outcome.result !== undefined && Value.Check(RUN_RESULT, outcome.result) ? outcome.result : {};
	const status = outcome.status === "completed" && result.status !== undefined ? result.status : outcome.status;
	const sessions = await sessionsOf(host, harness, input.root ?? input.runId);
	const facts: RunFacts = { task: id, runId: input.runId, workflow: input.name, status, sessions };

	if (result.subject !== undefined) facts.subject = result.subject;
	const branch = result.branch ?? input.worktree?.branch;

	if (branch !== undefined) facts.branch = branch;

	if (result.head !== undefined) facts.head = result.head;

	if (result.divergence !== undefined) facts.divergence = result.divergence;

	if (result.lessons !== undefined) {
		// SAFETY: the result is stored JSON, so each lesson is JSON.
		facts.lessons = result.lessons as JsonValue[];
	}

	return { kind: "run", facts };
}

/** The sessions of the root run `rootRun`, with their lineage keys and labels. */
async function sessionsOf(host: Host, harness: Harness, rootRun: string): Promise<Session[]> {
	const doc = await harness.snapshot(SessionsDoc, rootRun, context);
	const sessions: Session[] = [];

	for (const { run, conversation, label } of doc?.sessions ?? []) {
		const lineage = await host.children.lineage(harness, String(conversation), context);
		const session: Session = { run, conversation };

		if (lineage !== undefined) session.key = lineage.key;

		if (label !== undefined) session.label = label;
		sessions.push(session);
	}

	return sessions;
}

function runLine(facts: RunFacts): string {
	const parts = [`${facts.runId} (${facts.workflow}): ${facts.status}`];

	if (facts.subject !== undefined) parts.push(`subject: ${facts.subject}`);

	if (facts.branch !== undefined || facts.head !== undefined) {
		parts.push(`branch: ${[facts.branch, facts.head].filter((part) => part !== undefined).join(" @ ")}`);
	}

	if (facts.divergence !== undefined) parts.push(`divergence: ${facts.divergence}`);

	if (facts.lessons !== undefined) parts.push(`lessons: ${JSON.stringify(facts.lessons)}`);

	if (facts.sessions.length > 0) parts.push(`sessions: ${sessionsText(facts.sessions)}`);

	return parts.join("; ");
}

/**
 * `[run <run>: <label> #<conversation>, ...]`, one group for each run. A session without a label gives
 * `<key> #<conversation>`, and without a key `#<conversation>`.
 */
function sessionsText(sessions: readonly Session[]): string {
	const byRun = Map.groupBy(sessions, (session) => session.run);

	return [...byRun]
		.map(([run, group]) => {
			const named = group.map(({ conversation, key, label }) => {
				const name = label ?? key;

				return name === undefined ? `#${conversation}` : `${name} #${conversation}`;
			});

			return `[run ${run}: ${named.join(", ")}]`;
		})
		.join(" ");
}
