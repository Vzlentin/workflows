#!/usr/bin/env node
/** The `workflows` executable: the terminal, Ctrl+C, and Pi's models for `check`. */
import { text } from "node:stream/consumers";
import { createAgentSessionServices } from "@earendil-works/pi-coding-agent";
import { harnessProblem } from "./harness.ts";
import { terminalRedraw } from "./progress.ts";
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
	models: async () => (await createAgentSessionServices({ cwd: process.cwd() })).modelRuntime,
});
