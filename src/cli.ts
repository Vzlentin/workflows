#!/usr/bin/env node
/** The `workflows` executable: the terminal, Ctrl+C, and Pi's models for `check`. */
import { text } from "node:stream/consumers";
import { createAgentSessionServices } from "@earendil-works/pi-coding-agent";
import { main } from "./main.ts";
import { terminalRedraw } from "./progress.ts";

const interrupt = new AbortController();
/** Resolves the wait for a second Ctrl+C while the command waits for one. */
let second: ((stop: boolean) => void) | undefined;
// The first Ctrl+C detaches from the run. A later one stops the run while the command waits for it, else exits.
process.on("SIGINT", () => {
	if (!interrupt.signal.aborted) interrupt.abort();
	else if (second !== undefined) second(true);
	else process.exit(130);
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
	secondInterrupt: (ms) =>
		new Promise((resolve) => {
			const timer = setTimeout(() => second?.(false), ms);
			second = (stop) => {
				clearTimeout(timer);
				second = undefined;
				resolve(stop);
			};
		}),
	models: async () => (await createAgentSessionServices({ cwd: process.cwd() })).modelRuntime,
});
