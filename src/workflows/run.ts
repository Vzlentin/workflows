/**
 * `workflows run`: one workflow script in the sandbox. A runner session starts the script's `workflow` call, and the
 * call's result is the run's result.
 */
import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { JsonObject } from "@earendil-works/pi-durable";
import { type Bundle, loadBundle, openRunner, RUNNER, runnerProvider, scriptExtension } from "../lib/script.ts";
import { defineWorkflow, type Io, type SessionCheckpoint, type Step, UsageError } from "../lib/workflow.ts";

type Args = {
	readonly name: string;
	readonly json: boolean;
	readonly source: string;
	readonly args: JsonObject;
	readonly bundle: Bundle;
};

/** Everything a run needs, saved before execution starts. */
export type RunInput = Args & { readonly cwd: string };

type RunCheckpoint = { readonly phase: "run" } & SessionCheckpoint;

/** A name in the package's `workflows/`, a `.js` file or a path relative to the current directory, or `-` for stdin. */
async function readScript(argument: string, bundle: Bundle, io: Io): Promise<{ name: string; source: string }> {
	if (argument === "-") {
		const source = await io.stdin();
		if (source === undefined) throw new UsageError("missing workflow script on stdin");
		return { name: "stdin", source };
	}
	if (argument.endsWith(".js") || argument.includes("/")) {
		const path = resolve(io.cwd, argument);
		const source = await readFile(path, "utf8").catch(() => {
			throw new Error(`cannot read workflow ${path}`);
		});
		return { name: basename(argument, ".js"), source };
	}
	const source = bundle.scripts[argument];
	if (source === undefined) throw new Error(`no workflow ${argument}`);
	return { name: argument, source };
}

function parseRun(args: readonly string[]) {
	const { values, positionals } = parseArgs({
		args: [...args],
		options: { arg: { type: "string", multiple: true }, json: { type: "boolean" } },
		allowPositionals: true,
	});
	const [script, ...rest] = positionals;
	if (script === undefined || rest.length > 0) throw new UsageError("give one workflow: a name, a .js file or -");
	const parsed: Record<string, string> = {};
	for (const pair of values.arg ?? []) {
		const at = pair.indexOf("=");
		if (at < 1) throw new UsageError(`--arg ${pair} is not <key>=<value>`);
		const key = pair.slice(0, at);
		if (Object.hasOwn(parsed, key)) throw new UsageError(`--arg ${key} is given more than once`);
		parsed[key] = pair.slice(at + 1);
	}
	return { script, args: parsed, json: values.json ?? false };
}

export const run = defineWorkflow<Args, RunInput, RunCheckpoint, unknown>({
	name: "run",
	usage: "workflows run <name | file.js | -> [--arg <key>=<value>]... [--json]",
	parse: async (args, io) => {
		const parsed = parseRun(args);
		const bundle = await loadBundle();
		const { name, source } = await readScript(parsed.script, bundle, io);
		return { name, json: parsed.json, source, args: parsed.args, bundle };
	},
	prepare: async (args, run) => ({ ...args, cwd: run.cwd }),
	title: (input) => input.name,
	initial: () => ({ phase: "run" }),
	phases: {
		run: async ({ input, session, finish }: Step<RunInput, RunCheckpoint, RunCheckpoint, unknown>) => {
			const runner = await session(RUNNER, input.cwd, (tx, conversation) =>
				openRunner(tx, conversation, { ...input.bundle, main: input.source }),
			);
			if (runner === undefined) return;
			await finish(JSON.parse(await runner.say("run", JSON.stringify({ args: input.args }))));
		},
	},
	report: (input, result, io) => {
		io.stdout(typeof result === "string" && !input.json ? result : JSON.stringify(result));
		return 0;
	},
	extensions: (host) => [scriptExtension(host)],
	providers: [runnerProvider()],
});
