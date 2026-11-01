/** The display of the steps of a run on the terminal: redrawn in place, as JSON lines, or as plain lines. */
import { truncateToWidth } from "@earendil-works/pi-tui";
import { type Mark, Progress } from "../../records/steps.ts";
import type { ProgressEvent } from "../../run/progress.ts";
import type { Io } from "../../workflow/find.ts";

/** Where the steps of a run go: the events of its script task, and its end in the command. */
export type Display = {
	readonly event: (event: ProgressEvent) => void;
	/** Gives each step that still runs the mark `mark`, and draws the steps once more. */
	readonly stop: (mark: Mark) => void;
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
		stop: (mark) => {
			progress.stop(mark);
			draw(undefined);
		},
	};
}

const COLORS: Readonly<Record<Mark, string>> = { "✓": "32", "◉": "36", "✗": "31", "·": "90" };

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
			const body = cut.slice(first).map((line) => `${line.replace(/^(\s*)([✓◉✗·])/, colored)}\n`);
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
