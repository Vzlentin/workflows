/**
 * `workflows run`: one workflow script in the sandbox. A runner session starts the script's `workflow` call, and the
 * call's result is the run's result.
 */
import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { JsonObject } from "@earendil-works/pi-durable";
import {
	type Bundle,
	loadBundle,
	type RunBundle,
	type ScriptCheckpoint,
	scriptPhase,
	scriptWorkflow,
} from "../lib/script.ts";
import { defineWorkflow, type Io, UsageError } from "../lib/workflow.ts";

type Args = {
	readonly name: string;
	/** Set only in runs saved before `--json` moved to the command. */
	readonly json?: boolean;
	readonly args: JsonObject;
	readonly bundle: RunBundle;
};

/** Everything a run needs, saved before execution starts. */
export type RunInput = Args & { readonly cwd: string };

/** A name in the bundle's scripts, a `.js` file or a path relative to the current directory, or `-` for stdin. */
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
		options: { arg: { type: "string", multiple: true } },
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
	return { script, args: parsed };
}

export const run = defineWorkflow<Args, RunInput, ScriptCheckpoint, unknown>({
	...scriptWorkflow,
	name: "run",
	usage: "workflows run <name | file.js | -> [--arg <key>=<value>]...",
	version: 2,
	parse: async (args, io) => {
		const parsed = parseRun(args);
		const bundle = await loadBundle(io.cwd);
		const { name, source } = await readScript(parsed.script, bundle, io);
		return { name, args: parsed.args, bundle: { ...bundle, main: source } };
	},
	prepare: async (args, run) => ({ ...args, cwd: run.cwd }),
	title: (input) => input.name,
	phases: { run: (step) => scriptPhase(step, step.input.cwd, step.input.bundle, step.input.args) },
	report: (input, result, io) => {
		io.stdout(typeof result === "string" && !input.json ? result : JSON.stringify(result));
		return 0;
	},
});
