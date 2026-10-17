#!/usr/bin/env node
/** The `workflows` executable: Pi's providers and credentials, the terminal, and Ctrl+C. */
import { text } from "node:stream/consumers";
import { createAgentSessionServices } from "@earendil-works/pi-coding-agent";
import { main } from "./main.ts";
import { terminalRedraw } from "./progress.ts";

const interrupt = new AbortController();
process.on("SIGINT", () => {
	if (interrupt.signal.aborted) process.exit(130);
	interrupt.abort();
});

const { modelRuntime } = await createAgentSessionServices({ cwd: process.cwd() });
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
	models: modelRuntime,
	interrupt: interrupt.signal,
});
