#!/usr/bin/env node
/** The `workflows` executable: the terminal, Ctrl+C, and Pi's models for `check`. */
import { createInterface } from "node:readline";
import { text } from "node:stream/consumers";
import { createAgentSessionServices } from "@earendil-works/pi-coding-agent";
import { StdinBuffer } from "@earendil-works/pi-tui";
import { terminalRedraw } from "./cli/terminal/redraw.ts";
import { actionOf } from "./keys.ts";
import { main } from "./main.ts";
import { keepPick, type Pick, type PickItem, press, render, startPick } from "./pick.ts";
import { CtrlC } from "./run.ts";

const ctrlC = new CtrlC(() => process.exit(130));

process.on("SIGINT", () => ctrlC.press());

const live = process.stderr.isTTY ? terminalRedraw(process.stderr) : undefined;

/**
 * Reads one typed line, with its echo on stderr. In raw mode, Ctrl+C reaches the interface and not the process, so it
 * ends the read and `ctrlC` does not count it. Ctrl+C and the end of input give undefined.
 */
function readLine(): Promise<string | undefined> {
	live?.forget();
	const lines = createInterface({ input: process.stdin, output: process.stderr, terminal: true });

	return new Promise((resolve) => {
		lines.once("line", (line) => {
			resolve(line);
			lines.close();
		});
		lines.once("SIGINT", () => lines.close());
		lines.once("close", () => resolve(undefined));
	});
}

/** How long the picker waits after a refresh of its items ends before it starts the next one. */
const REFRESH_MS = 1000;

/**
 * Asks which of `items` to take, on stderr, with the keys of stdin in raw mode, and gives its value, or undefined when
 * cancelled. Only an item with a value can be taken. With `refresh`, it reads the items again 1 s after each read ends,
 * keeps the filter and the item under the cursor, and draws again; a read that fails keeps the items it has. It clears
 * its lines before it returns.
 */
function choose<V>(
	question: string,
	first: readonly PickItem<V>[],
	refresh?: () => Promise<readonly PickItem<V>[]>,
): Promise<V | undefined> {
	live?.forget();
	const { stdin, stderr } = process;
	const screen = terminalRedraw(stderr);
	let items = first;
	let pick: Pick = startPick(items, "");
	let closed = false;
	let timer: NodeJS.Timeout | undefined;
	const drawPick = () => screen.redraw(render(question, items, pick, Math.min(stderr.rows ?? 24, 20)));

	const later = () => {
		if (refresh === undefined || closed) return;
		timer = setTimeout(async () => {
			try {
				const after = await refresh();

				if (!closed) {
					pick = keepPick(items, after, pick);
					items = after;
					drawPick();
				}
			} catch {
				// The old items stay, and the next refresh tries again.
			}

			later();
		}, REFRESH_MS);
	};

	return new Promise((resolve) => {
		// Splits the chunks of stdin into whole keys, so a chunk with several keys or half a key reads right.
		const keys = new StdinBuffer();

		const done = (value: V | undefined) => {
			closed = true;
			clearTimeout(timer);
			stdin.off("data", onData);
			keys.destroy();
			stdin.setRawMode(false);
			stdin.pause();
			screen.redraw([]);
			resolve(value);
		};

		const onData = (data: Buffer) => keys.process(data);

		keys.on("data", (key) => {
			const action = actionOf(key);

			if (action === undefined) return;
			const step = press(items, pick, action);

			if ("taken" in step) done(step.taken);
			else if ("cancelled" in step) done(undefined);
			else {
				pick = step.pick;
				drawPick();
			}
		});

		stdin.setRawMode(true);
		stdin.resume();
		stdin.on("data", onData);
		drawPick();
		later();
	});
}

process.exitCode = await main(process.argv.slice(2), {
	cwd: process.cwd(),
	stdin: async () => (process.stdin.isTTY ? undefined : await text(process.stdin)),
	stdout: (line) => process.stdout.write(`${line}\n`),
	stderr: (line) => {
		live?.forget();
		process.stderr.write(`${line}\n`);
	},
	redraw: live?.redraw,
	status: live && ((report) => process.stderr.write(report)),
	interrupt: ctrlC.interrupt,
	stop: ctrlC.stop,
	following: (active) => ctrlC.following(active),
	readLine: process.stdin.isTTY && process.stderr.isTTY ? readLine : undefined,
	choose: process.stdin.isTTY && process.stderr.isTTY ? choose : undefined,
	models: async () => (await createAgentSessionServices({ cwd: process.cwd() })).modelRuntime,
});
