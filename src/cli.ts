#!/usr/bin/env node
/** The `workflows` executable: the terminal, Ctrl+C, and Pi's models for `check`. */
import { createInterface } from "node:readline";
import { text } from "node:stream/consumers";
import { createAgentSessionServices } from "@earendil-works/pi-coding-agent";
import { StdinBuffer } from "@earendil-works/pi-tui";
import { harnessProblem } from "./harness.ts";
import { actionOf } from "./keys.ts";
import type { Choose } from "./main.ts";
import { type Pick, press, render } from "./pick.ts";
import { fit, terminalRedraw } from "./progress.ts";
import { CtrlC } from "./run.ts";
import { ensureHarness, PACKAGE, setup } from "./setup.ts";

// `main.ts` imports harness, so the command checks harness before it loads `main.ts`. An installed command installs a
// missing harness and finishes the setup, as npm 12 runs no install script; a checkout does neither.
const installed = import.meta.url.endsWith(".js");
const problem = installed ? ensureHarness(PACKAGE) : harnessProblem(PACKAGE);

if (problem !== undefined) {
	process.stderr.write(`${problem}\n`);
	process.exit(1);
}

if (installed) await setup(PACKAGE);

const { main } = await import("./main.ts");

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

/**
 * Asks which of `items` to take, on stderr, with the keys of stdin in raw mode, and gives its index, or undefined when
 * cancelled. It clears its lines before it returns.
 */
const choose: Choose = (question, items) => {
	live?.forget();
	const { stdin, stderr } = process;
	let pick: Pick = { query: "", cursor: 0 };
	let drawn = 0;

	const draw = (lines: readonly string[]) => {
		const width = Math.max((stderr.columns ?? 80) - 1, 10);
		const up = drawn > 1 ? `\x1b[${drawn - 1}A` : "";
		const cut = lines.map((line) => fit(line, width));
		stderr.write(`${up}\r\x1b[J${cut.join("\n")}`);
		drawn = cut.length;
	};

	const drawPick = () => draw(render(question, items, pick, Math.min(stderr.rows ?? 24, 20)));

	return new Promise((resolve) => {
		// Splits the chunks of stdin into whole keys, so a chunk with several keys or half a key reads right.
		const keys = new StdinBuffer();

		const done = (index: number | undefined) => {
			stdin.off("data", onData);
			keys.destroy();
			stdin.setRawMode(false);
			stdin.pause();
			draw([""]);
			resolve(index);
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
	});
};

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
