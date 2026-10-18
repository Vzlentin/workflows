#!/usr/bin/env node
/** The `workflows` executable: the terminal and Ctrl+C. */
import { text } from "node:stream/consumers";
import { main } from "./main.ts";
import { terminalRedraw } from "./progress.ts";

/** How long the command waits for a second Ctrl+C, which stops the run, after the first, which detaches. */
const STOP_WINDOW_MS = 2000;

const interrupt = new AbortController();
const stop = new AbortController();
process.on("SIGINT", () => {
	if (stop.signal.aborted) process.exit(130);
	if (interrupt.signal.aborted) stop.abort();
	else interrupt.abort();
});

const live = process.stderr.isTTY ? terminalRedraw(process.stderr) : undefined;

process.exitCode = await main(process.argv.slice(2), {
	cwd: process.cwd(),
	stdin: async () => (process.stdin.isTTY ? undefined : await text(process.stdin)),
	stdout: (line) => process.stdout.write(`${line}\n`),
	stderr: (line) => {
		live?.forget();
		process.stderr.write(`${line}\n`);
	},
	redraw: live?.redraw,
	interrupt: interrupt.signal,
	stop: stop.signal,
	stopWindowMs: STOP_WINDOW_MS,
});
