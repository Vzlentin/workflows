/**
 * The progress of a run as a tree of steps. Each `phase` line of a run is a step, and each `log` line goes under the
 * step of its run that is current. A child run goes under the step of its caller that is current when its first line
 * comes. The command draws the tree on stderr, and the Pi tool draws the lines that the command sends with `--json`,
 * so both show the same steps.
 */
import type { ProgressEvent } from "../run/progress.ts";

export type Mark = "✓" | "◉" | "✗";

/**
 * A step of the run `runId`, with the times of its start and its end when the events give them. `started` moves
 * forward when the step goes on after a resume, and `firstStart` keeps the time of its first start.
 */
type Step = {
	readonly runId: string;
	readonly text: string;
	readonly firstStart: number | undefined;
	mark: Mark;
	readonly items: Item[];
	started?: number | undefined;
	ended?: number | undefined;
};

type Item = Step | { readonly log: string } | { readonly run: RunNode };

/** A step as a reader of `Progress.entries` sees it: its run, its text and the time of its first start. */
export type StepView = Readonly<Pick<Step, "runId" | "text" | "firstStart">>;

/** A line of the tree, with the step that it belongs to, if any. The lines of one step share one `step` object. */
export type Entry = { readonly text: string; readonly step?: StepView | undefined };

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

		const step: Step = {
			runId: event.run,
			text: event.text,
			firstStart: event.at,
			mark: "◉",
			items: [],
			started: event.at,
		};

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
		return this.entries().map((entry) => entry.text);
	}

	/**
	 * The lines of `lines()`, each with the step that it belongs to: a step line its own step, and a log line or a line
	 * of a child run the step that encloses it. A line outside every step has none.
	 */
	entries(): Entry[] {
		const entries: Entry[] = [];

		const visit = (items: readonly Item[], indent: string, step: Entry["step"]) => {
			for (const item of items) {
				if ("run" in item) visit(item.run.items, indent, step);
				else if ("log" in item) entries.push({ text: `${indent}${item.log}`, step });
				else {
					const { started, ended } = item;
					const time = started === undefined || ended === undefined ? "" : `  ${duration(ended - started)}`;
					entries.push({ text: `${indent}${item.mark} ${item.text}${time}`, step: item });
					visit(item.items, `${indent}  `, item);
				}
			}
		};

		visit(this.#top, "", undefined);

		return entries;
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
