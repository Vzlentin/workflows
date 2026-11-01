/**
 * The run view of the `/workflows` command: the phases, agents and child runs of one run, as `workflows show --agents
 * --json` gives them, with one selected agent.
 */
import { type Static, Type } from "@earendil-works/pi-ai";
import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { type Component, truncateToWidth } from "@earendil-works/pi-tui";
import { Value } from "typebox/value";
import type { Output } from "../src/tool.ts";

/** How often the run view reads the run again. */
const REFRESH_MS = 2000;

/** The rows that the run view shows at most; the selected agent stays among them. */
const VIEW_HEIGHT = 30;

export const MARKS = new Map<string, ThemeColor>([
	["✓", "success"],
	["◉", "accent"],
	["✗", "error"],
	["·", "dim"],
]);

const MARK = Type.Union([Type.Literal("✓"), Type.Literal("✗"), Type.Literal("◉")]);

/** A row of `workflows show --agents --json`, as far as the run view reads it: a phase line, an agent, or a child run. */
const AGENT_ROW = Type.Union([
	Type.Object({ kind: Type.Literal("phase"), depth: Type.Number(), text: Type.String() }),
	Type.Object({
		kind: Type.Literal("agent"),
		depth: Type.Number(),
		mark: MARK,
		text: Type.String(),
		conversation: Type.Number(),
		facts: Type.String(),
	}),
	Type.Object({ kind: Type.Literal("run"), depth: Type.Number(), mark: MARK, text: Type.String() }),
]);

/** The stdout of `workflows show <run-id> --agents --json`. */
export const AGENTS = Type.Object({
	runId: Type.String(),
	workflow: Type.String(),
	title: Type.String(),
	status: Type.String(),
	agents: Type.Array(AGENT_ROW),
});

type Agents = Static<typeof AGENTS>;

/** The agents of a run from the output of `workflows show --agents --json`, or the error to show. */
export function parseRun(output: Output): Agents | string {
	if (output.code !== 0) return output.stderr.join("\n") || `workflows show exited with ${output.code}`;
	const invalid = "workflows show did not print the expected JSON";

	try {
		const shown: unknown = JSON.parse(output.stdout.join("\n"));

		return Value.Check(AGENTS, shown) ? shown : invalid;
	} catch {
		return invalid;
	}
}

/**
 * The run view of `/workflows`: the run's phases, agents and child runs, read again `REFRESH_MS` after each read ends.
 * Up and down move between the agents, Enter gives the conversation of the selected agent, Escape gives undefined.
 * Before the first good read it shows the error of the last read; a later failed read keeps the rows it shows.
 */
export class RunView implements Component {
	readonly #read: () => Promise<Agents | string>;
	readonly #render: () => void;
	readonly #theme: Theme;
	readonly #matches: (data: string, binding: "up" | "down" | "confirm" | "cancel") => boolean;
	readonly #done: (conversation: number | undefined) => void;
	#timer: ReturnType<typeof setTimeout> | undefined;
	#closed = false;
	#shown: Agents | undefined;
	#error: string | undefined;
	/** The conversation of the selected agent. */
	#selected: number | undefined;

	constructor(options: {
		read: () => Promise<Agents | string>;
		render: () => void;
		theme: Theme;
		matches: (data: string, binding: "up" | "down" | "confirm" | "cancel") => boolean;
		done: (conversation: number | undefined) => void;
	}) {
		this.#read = options.read;
		this.#render = options.render;
		this.#theme = options.theme;
		this.#matches = options.matches;
		this.#done = options.done;
		void this.#refresh();
	}

	/**
	 * Reads the run, keeps the selected agent, or selects the last agent that works, else the last agent, and reads
	 * again `REFRESH_MS` later.
	 */
	async #refresh(): Promise<void> {
		try {
			const read = await this.#read();

			if (this.#closed) return;

			if (Value.Check(Type.String(), read)) {
				this.#error = read;
			} else {
				this.#shown = read;
				const agents = this.#agents();

				if (!agents.some((row) => row.conversation === this.#selected)) {
					this.#selected = (agents.findLast((row) => row.mark === "◉") ?? agents.at(-1))?.conversation;
				}
			}

			this.#render();
		} finally {
			if (!this.#closed) this.#timer = setTimeout(() => void this.#refresh(), REFRESH_MS);
		}
	}

	handleInput(data: string): void {
		const agents = this.#agents();
		const index = agents.findIndex((row) => row.conversation === this.#selected);
		const step = this.#matches(data, "up") ? -1 : this.#matches(data, "down") ? 1 : 0;

		if (this.#matches(data, "cancel")) {
			this.#finish(undefined);
		} else if (this.#matches(data, "confirm")) {
			if (index >= 0) this.#finish(this.#selected);
		} else if (index >= 0 && step !== 0) {
			this.#selected = agents[(index + step + agents.length) % agents.length]?.conversation;
			this.#render();
		}
	}

	render(width: number): string[] {
		const theme = this.#theme;
		const shown = this.#shown;

		if (shown === undefined) {
			const lines = this.#error === undefined ? [theme.fg("dim", "Reading the run...")] : this.#error.split("\n");

			return lines.map((line) => truncateToWidth(this.#error === undefined ? line : theme.fg("error", line), width));
		}

		const selected = shown.agents.findIndex((row) => row.kind === "agent" && row.conversation === this.#selected);
		const header = `${theme.bold(`${shown.workflow} ${shown.runId}`)} ${theme.fg("dim", shown.status)} ${shown.title}`;

		const lines = shown.agents.map((row, index) => {
			const indent = "    ".repeat(row.depth);

			if (row.kind === "phase") return `  ${indent}${theme.fg("accent", row.text)}`;
			const mark = theme.fg(MARKS.get(row.mark) ?? "dim", row.mark);

			if (row.kind === "run") return `  ${indent}  ${mark} ${theme.fg("dim", row.text)}`;
			const pointer = index === selected ? theme.fg("accent", ">") : " ";
			const text = index === selected ? theme.bold(row.text) : row.text;

			return `${pointer} ${indent}  ${mark} ${text}${theme.fg("dim", `  ${row.facts}`)}`;
		});

		const start = Math.max(0, Math.min(selected - Math.floor(VIEW_HEIGHT / 2), lines.length - VIEW_HEIGHT));
		const empty = lines.length === 0 ? [theme.fg("dim", "  No agent yet")] : [];
		const help = theme.fg("dim", "up/down select an agent, enter attaches, escape closes");

		return [header, ...lines.slice(start, start + VIEW_HEIGHT), ...empty, help].map((line) =>
			truncateToWidth(line, width),
		);
	}

	invalidate(): void {}

	dispose(): void {
		this.#closed = true;
		clearTimeout(this.#timer);
	}

	#finish(conversation: number | undefined): void {
		this.dispose();
		this.#done(conversation);
	}

	/** The agent rows, in the order they show. */
	#agents() {
		return (this.#shown?.agents ?? []).flatMap((row) => (row.kind === "agent" ? [row] : []));
	}
}
