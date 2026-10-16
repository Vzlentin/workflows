/**
 * The progress of a run as a tree of steps. Each `phase` line of a run is a step, and each `log` line goes under the
 * step of its run that is current. A child run goes under the step of its caller that is current when its first line
 * comes. The command draws the tree on stderr, and the Pi tool draws the lines that the command sends with `--json`,
 * so both show the same steps.
 */
import type { Io } from "./run.ts";

/** A `phase` or `log` line of the run `run`, whose caller is `parent`, or the end of the run `run`. */
export type ProgressEvent =
	| { readonly kind: "phase" | "log"; readonly run: string; readonly parent: string | null; readonly text: string }
	| { readonly kind: "end"; readonly run: string; readonly failed: boolean };

export type Mark = "✓" | "◉" | "✗";

type Step = { readonly text: string; mark: Mark; readonly items: Item[] };
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
		if (event.kind === "end") {
			const step = this.#runs.get(event.run)?.current;
			if (step?.mark === "◉") step.mark = event.failed ? "✗" : "✓";
			return undefined;
		}
		const run = this.#node(event.run, event.parent);
		const { current } = run;
		if (event.kind === "log") {
			(current?.items ?? run.items).push({ log: event.text });
			return `${"  ".repeat(depth(run) + (current === undefined ? 0 : 1))}${event.text}`;
		}
		if (current?.mark === "◉") current.mark = "✓";
		const step: Step = { text: event.text, mark: "◉", items: [] };
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

	/** Each step as `<indent><mark> <text>` and each log line as `<indent><text>`, with 2 spaces for each level. */
	lines(): string[] {
		const lines: string[] = [];
		const visit = (items: readonly Item[], indent: string) => {
			for (const item of items) {
				if ("run" in item) visit(item.run.items, indent);
				else if ("log" in item) lines.push(`${indent}${item.log}`);
				else {
					lines.push(`${indent}${item.mark} ${item.text}`);
					visit(item.items, `${indent}  `);
				}
			}
		};
		visit(this.#top, "");
		return lines;
	}

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
 * line of the tree. Else, on a terminal, `io.redraw` draws the tree again in place. Else each step and log line prints
 * once, with its indent and without a mark.
 */
export function display(io: Io, json: boolean): Display {
	const progress = new Progress();
	// A run without steps prints no progress line.
	let last = JSON.stringify({ progress: [] });
	const draw = (added: string | undefined) => {
		if (json) {
			const line = JSON.stringify({ progress: progress.lines() });
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
 * again, and colors the marks. A line is cut to the width of the terminal, so that each line takes one row. After
 * `forget`, because another write moved the cursor below the lines, the lines on the screen stay, and a change prints
 * the lines from the first changed one below them.
 */
export function terminalRedraw(stream: {
	write(text: string): unknown;
	readonly columns?: number;
	readonly rows?: number;
}): { redraw: (lines: readonly string[]) => void; forget: () => void } {
	let shown: readonly string[] = [];
	// How many of the last lines of `shown` are just above the cursor.
	let below = 0;
	return {
		redraw: (lines) => {
			const width = Math.max((stream.columns ?? 80) - 1, 10);
			const cut = lines.map((line) => (line.length > width ? `${line.slice(0, width - 1)}…` : line));
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
