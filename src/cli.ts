#!/usr/bin/env node
/** The `workflows` executable: Pi's provider credentials, the terminal, Ctrl+C, and the installed workflows. */
import { text } from "node:stream/consumers";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { main } from "./lib/main.ts";
import { ship } from "./workflows/ship.ts";

const interrupt = new AbortController();
process.on("SIGINT", () => {
	if (interrupt.signal.aborted) process.exit(130);
	interrupt.abort();
});

process.exitCode = await main(
	process.argv.slice(2),
	{
		cwd: process.cwd(),
		stdin: async () => (process.stdin.isTTY ? undefined : await text(process.stdin)),
		stdout: (line) => process.stdout.write(`${line}\n`),
		stderr: (line) => process.stderr.write(`${line}\n`),
		models: await ModelRuntime.create(),
		interrupt: interrupt.signal,
	},
	[ship],
);
