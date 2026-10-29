/**
 * The progress of a run as a tree of steps. Each `phase` line of a run is a step, and each `log` line goes under the
 * step of its run that is current. A child run goes under the step of its caller that is current when its first line
 * comes. The command draws the tree on stderr, and the Pi tool draws the lines that the command sends with `--json`,
 * so both show the same steps.
 */
import { truncateToWidth } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import type { Io } from "./run.ts";

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

export type Mark = "✓" | "◉" | "✗";

/** A step, with the times of its start and its end when the events give them. */
type Step = {
	readonly text: string;
	mark: Mark;
	readonly items: Item[];
	started?: number | undefined;
	ended?: number | undefined;
};

type Item = Step | { readonly log: string } | { readonly run: RunNode };

/**
 * A run: its steps and log lines, its caller, and whether it is under a step of the caller. A child run whose caller
 * has no step yet is in the list of the caller, and moves under the next step of the caller.
 */
type RunNode = { readonly items: Item[]; readonly caller: RunNode | undefined; under: boolean; current?: Step };

/** The steps of a run and of its child runs. */
export class Progress {
	readonly #top: Item[] = [];
	readonly #runs = new Map<string, RunNode>();

	/** Adds `event`, and returns the line that it adds, with its indent and without a mark. */
	add(event: ProgressEvent): string | undefined {
		if (event.kind === "title") return undefined;

		if (event.kind === "start") {
			if (event.parent !== undefined) this.#node(event.run, event.parent);

			return undefined;
		}

		if (event.kind === "end") {
			const step = this.#runs.get(event.run)?.current;

			if (step?.mark === "◉") {
				step.mark = event.failed ? "✗" : "✓";
				step.ended = event.at;
			}

			return undefined;
		}

		const run = this.#node(event.run, event.parent);
		const { current } = run;

		if (event.kind === "log") {
			(current?.items ?? run.items).push({ log: event.text });

			return `${"  ".repeat(depth(run) + (current === undefined ? 0 : 1))}${event.text}`;
		}

		// A new execution starts again at the step that it stopped in, so the step goes on, without the time between.
		if (event.kind === "phase" && event.continues === true && current?.text === event.text) {
			if (current.started !== undefined && current.ended !== undefined && event.at !== undefined) {
				current.started += event.at - current.ended;
			}

			current.mark = "◉";
			delete current.ended;

			return undefined;
		}

		if (current?.mark === "◉") {
			current.mark = "✓";
			current.ended = event.at;
		}

		const step: Step = { text: event.text, mark: "◉", items: [], started: event.at };

		if (current === undefined) {
			const loose = run.items.filter((item) => "run" in item && !item.run.under);
			run.items.splice(0, run.items.length, ...run.items.filter((item) => !loose.includes(item)));

			for (const item of loose) if ("run" in item) item.run.under = true;
			step.items.push(...loose);
		}

		run.current = step;
		run.items.push(step);

		return `${"  ".repeat(depth(run))}${event.text}`;
	}

	/**
	 * The texts of the steps that run now, outermost first, joined with ` › `, or undefined when no step runs. Child
	 * runs that run at once join with `, `.
	 */
	status(): string | undefined {
		return running(this.#top).join(", ") || undefined;
	}

	/** Whether the run has a step. */
	get stepped(): boolean {
		return [...this.#runs.values()].some((run) => run.current !== undefined);
	}

	/** Marks each step that runs as failed, or as done. */
	stop(failed: boolean): void {
		const visit = (items: readonly Item[]) => {
			for (const item of items) {
				if ("run" in item) visit(item.run.items);

				if (!("mark" in item)) continue;

				if (item.mark === "◉") item.mark = failed ? "✗" : "✓";
				visit(item.items);
			}
		};

		visit(this.#top);
	}

	/**
	 * Each step as `<indent><mark> <text>` and each log line as `<indent><text>`, with 2 spaces for each level. A step
	 * that ended adds `  <duration>`.
	 */
	lines(): string[] {
		const lines: string[] = [];

		const visit = (items: readonly Item[], indent: string) => {
			for (const item of items) {
				if ("run" in item) visit(item.run.items, indent);
				else if ("log" in item) lines.push(`${indent}${item.log}`);
				else {
					const { started, ended } = item;
					const time = started === undefined || ended === undefined ? "" : `  ${duration(ended - started)}`;
					lines.push(`${indent}${item.mark} ${item.text}${time}`);
					visit(item.items, `${indent}  `);
				}
			}
		};

		visit(this.#top, "");

		return lines;
	}

	/** The node of `run`: a new one goes under the current step of the run `parent`, or at the top without one. */
	#node(run: string, parent: string | null): RunNode {
		const found = this.#runs.get(run);

		if (found !== undefined) return found;
		const caller = parent === null ? undefined : this.#node(parent, null);
		const node: RunNode = { items: [], caller, under: caller?.current !== undefined };
		(caller === undefined ? this.#top : (caller.current?.items ?? caller.items)).push({ run: node });
		this.#runs.set(run, node);

		return node;
	}
}

/** `12s`, `3m05s` or `1h02m`. */
export function duration(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	const pad = (n: number) => String(n).padStart(2, "0");

	if (seconds < 60) return `${seconds}s`;

	if (seconds < 3600) return `${Math.floor(seconds / 60)}m${pad(seconds % 60)}s`;

	return `${Math.floor(seconds / 3600)}h${pad(Math.floor(seconds / 60) % 60)}m`;
}

/**
 * The running step of each run in `items`, each as `<step> › <running steps under it>`, where steps under one step
 * join with `, `.
 */
function running(items: readonly Item[]): string[] {
	return items.flatMap((item) => {
		if ("log" in item) return [];

		if ("run" in item) return running(item.run.items);

		if (item.mark !== "◉") return [];
		const below = running(item.items).join(", ");

		return [below === "" ? item.text : `${item.text} › ${below}`];
	});
}

/** The level of the steps of `run`. */
function depth(run: RunNode): number {
	return run.caller === undefined ? 0 : depth(run.caller) + (run.under ? 1 : 0);
}

/** Where the steps of a run go: the events of its script task, and its end in the command. */
export type Display = {
	readonly event: (event: ProgressEvent) => void;
	/** Marks each step that still runs as failed or done, and draws the steps once more. */
	readonly stop: (failed: boolean) => void;
};

/**
 * The display of a run on `io`. With `json`, each change prints one stderr line `{"progress":[<line>...]}` with every
 * line of the tree, and `"status"` with the steps that run now. Else, on a terminal, `io.redraw` draws the tree again in
 * place. Else each step and log line prints once, with its indent and without a mark.
 */
export function display(io: Io, json: boolean): Display {
	const progress = new Progress();
	// A run without steps prints no progress line.
	let last = JSON.stringify({ progress: [] });

	const draw = (added: string | undefined) => {
		if (json) {
			const line = JSON.stringify({ progress: progress.lines(), status: progress.status() });

			if (line !== last) io.stderr(line);
			last = line;
		} else if (io.redraw !== undefined) io.redraw(progress.lines());
		else if (added !== undefined) io.stderr(added);
	};

	return {
		event: (event) => draw(progress.add(event)),
		stop: (failed) => {
			progress.stop(failed);
			draw(undefined);
		},
	};
}

const COLORS: Readonly<Record<Mark, string>> = { "✓": "32", "◉": "36", "✗": "31" };

/**
 * A `redraw` for a terminal stream. It moves the cursor up to the first line that changed, writes the lines from there
 * again, and colors the marks. A line is cut to the columns of the terminal, so that each line takes one row. After
 * `forget`, because another write moved the cursor below the lines, the lines on the screen stay, and a change prints
 * the lines from the first changed one below them.
 */
export function terminalRedraw(stream: {
	write(text: string): void;
	readonly columns?: number;
	readonly rows?: number;
}) {
	let shown: readonly string[] = [];
	// How many of the last lines of `shown` are just above the cursor.
	let below = 0;

	return {
		redraw: (lines: readonly string[]) => {
			const width = Math.max((stream.columns ?? 80) - 1, 10);
			const cut = lines.map((line) => truncateToWidth(line, width, "…"));
			let first = 0;

			while (first < cut.length && first < shown.length && cut[first] === shown[first]) first++;
			const up = shown.length - first;
			const movable = up <= below && up < (stream.rows ?? 24);
			const head = movable && up > 0 ? `\x1b[${up}A\r\x1b[J` : "";
			const body = cut.slice(first).map((line) => `${line.replace(/^(\s*)([✓◉✗])/, colored)}\n`);
			stream.write(head + body.join(""));
			below = (movable ? below - up : 0) + cut.length - first;
			shown = cut;
		},
		forget: () => {
			below = 0;
		},
	};
}

function colored(_match: string, indent: string, mark: Mark): string {
	return `${indent}\x1b[${COLORS[mark]}m${mark}\x1b[0m`;
}

/**
 * The OSC 7501 program status report of the command: `state`, with `kind` for a `blocked` state, and `message` as its
 * base64 `msg`. Each control character of `message` becomes a space, and the text is cut to 2048 UTF-8 bytes on a
 * character boundary.
 */
export function programStatus(
	state: "idle" | "working" | "done" | "blocked" | "error",
	message: string,
	kind?: "permission" | "question" | "auth",
): string {
	let cut = "";
	let bytes = 0;

	for (const char of message.replace(/\p{Cc}/gu, " ")) {
		bytes += Buffer.byteLength(char);

		if (bytes > 2048) break;
		cut += char;
	}

	const blocked = state === "blocked" && kind !== undefined ? `:kind=${kind}` : "";

	return `\x1b]7501;state=${state}${blocked}:app=workflows:msg=${Buffer.from(cut).toString("base64")}\x1b\\`;
}
