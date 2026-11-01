/**
 * The progress of a script run in the project store: its events, their document, and the `phase`, `log` and `title`
 * lines that wait for the next call of the script.
 */
import { type CommonDocDefinition, defineDocFamily, type JsonObject, type Tx } from "@earendil-works/pi-durable";
import { type Static, Type } from "typebox";

/** The document kind of the progress of a run in the project store. */
export const PROGRESS_KIND = "workflows.progress";

/**
 * A `phase` or `log` line of the run `run`, whose caller is `parent`, the end of the run `run`, or the start of an
 * execution of the run `run`: of a root run, from which a command that reaches the running task shows the lines, or of
 * a child run, with its caller `parent`. `at` is the time of the line or the end in ms since the epoch; events that an
 * earlier version saved have none. `continues` marks the first phase line of an execution of the run, which goes on
 * with the step of that text when it is the current one. A `title` event gives the run the title `text`, which shows
 * in place of the title of its input, and draws no line.
 */
export const PROGRESS_EVENT = Type.Union([
	Type.Object({
		kind: Type.Union([Type.Literal("phase"), Type.Literal("log")]),
		run: Type.String(),
		parent: Type.Union([Type.String(), Type.Null()]),
		text: Type.String(),
		at: Type.Optional(Type.Number()),
		continues: Type.Optional(Type.Boolean()),
	}),
	Type.Object({
		kind: Type.Literal("end"),
		run: Type.String(),
		failed: Type.Boolean(),
		at: Type.Optional(Type.Number()),
	}),
	Type.Object({ kind: Type.Literal("start"), run: Type.String(), parent: Type.Optional(Type.String()) }),
	Type.Object({ kind: Type.Literal("title"), run: Type.String(), text: Type.String() }),
]);

export type ProgressEvent = Readonly<Static<typeof PROGRESS_EVENT>>;

/** True when a document change is stored as a complete base: after 31 deltas since the last one. */
export const checkpointWhen: CommonDocDefinition<JsonObject>["checkpointWhen"] = (_value, _ops, info) =>
	info.deltasSinceBase >= 31;

/**
 * The `phase` and `log` lines and the ends of a root run and its child runs, in commit order, keyed by the root run ID.
 * The command reads them from the store file while it follows the run.
 */
export const ProgressDoc = defineDocFamily<{ events: ProgressEvent[] }, null>({
	kind: PROGRESS_KIND,
	version: 1,
	scope: "session",
	family: true,
	initial: () => ({ events: [] }),
	checkpointWhen,
});

/** Appends `events` to the progress of the root run `root`. */
export async function addProgress(tx: Tx, root: string, events: readonly ProgressEvent[]): Promise<void> {
	if (events.length === 0) return;
	(await tx.doc(ProgressDoc, root, null)).events.push(...events);
}

/** A `phase` or `log` line, with the time of its call in ms since the epoch, or the `title` of the run. */
export type Line =
	| { readonly kind: "phase" | "log"; readonly text: string; readonly at: number }
	| { readonly kind: "title"; readonly text: string };

/**
 * The lines of the script of the run `run`, whose caller is `parent`, that wait for its next call that runs, in order.
 * At most one is a phase line: a new phase line replaces it. `phase` is the current phase line, which each call that
 * starts records.
 */
export type PhaseLines = {
	readonly run: string;
	readonly parent: string | null;
	readonly lines: Line[];
	phase: string | null;
	continued?: boolean;
};

export function phaseLine(progress: PhaseLines, text: string): void {
	progress.phase = text;
	const { lines } = progress;
	lines.splice(0, lines.length, ...lines.filter((line) => line.kind !== "phase"), {
		kind: "phase",
		text,
		at: Date.now(),
	});
}

/** Takes the waiting lines as progress events of the run. The first phase line of the execution `continues`. */
export function takeLines(progress: PhaseLines): ProgressEvent[] {
	const { run, parent } = progress;

	return progress.lines.splice(0).map((line) => {
		if (line.kind === "title") return { kind: "title", run, text: line.text };

		if (line.kind === "log") return { kind: "log", run, parent, text: line.text, at: line.at };
		const event: ProgressEvent = { kind: "phase", run, parent, text: line.text, at: line.at };

		if (progress.continued === true) return event;
		progress.continued = true;

		return { ...event, continues: true };
	});
}
