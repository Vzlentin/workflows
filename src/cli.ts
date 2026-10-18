#!/usr/bin/env node
/** The `workflows` executable: the terminal, Ctrl+C, and Pi's models for `check`. */
import { text } from "node:stream/consumers";
import { createAgentSessionServices } from "@earendil-works/pi-coding-agent";
import { main } from "./main.ts";
import { terminalRedraw } from "./progress.ts";
import { CtrlC } from "./run.ts";

const ctrlC = new CtrlC(() => process.exit(130));

process.on("SIGINT", () => ctrlC.press());

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
	interrupt: ctrlC.interrupt,
	stop: ctrlC.stop,
	following: (active) => ctrlC.following(active),
	models: async () => (await createAgentSessionServices({ cwd: process.cwd() })).modelRuntime,
});
