/**
 * `workflows ship`: a work item is planned, then implemented and reviewed for at most a few rounds, then judged and
 * squashed into one commit on `ship/<run-id>`. The workflow script `workflows/ship.js` does that work in the worktree.
 */
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { ensureWorktree } from "../lib/git.ts";
import { parseItemArgs, prepareWorktree, readItem, subject } from "../lib/item.ts";
import { instructions } from "../lib/prompts.ts";
import { type RunBundle, readFolder, type ScriptCheckpoint, scriptPhase, scriptWorkflow } from "../lib/script.ts";
import { defineWorkflow, UsageError } from "../lib/workflow.ts";

type Args = {
	readonly item: string;
	readonly repo: string | undefined;
	readonly base: string;
	readonly rounds: number;
	/** The folder whose `<name>.md` files replace the package prompts of that name. */
	readonly prompts: string | undefined;
};

/** Everything a run needs, saved before execution starts. */
export type ShipInput = {
	readonly item: string;
	readonly repository: string;
	readonly start: string;
	readonly branch: string;
	readonly worktree: string;
	readonly rounds: number;
	/** The package's bundle, with `workflows/ship.js` as the run's own script. */
	readonly bundle: RunBundle;
};

/** The return value of `workflows/ship.js`. */
export type ShipResult =
	| {
			readonly status: "shipped";
			readonly rounds: number;
			readonly head: string;
			readonly score?: number;
			readonly judgeError?: string;
			readonly answers?: readonly ("PASS" | "FAIL")[];
			readonly findings?: readonly string[];
			readonly memory: readonly string[];
	  }
	| { readonly status: "blocked"; readonly rounds: number; readonly reply: string; readonly memory: readonly string[] }
	| { readonly status: "stopped"; readonly rounds: number; readonly memory: readonly string[] };

/**
 * `--prompts <folder>` or `--prompts=<folder>` before `--`, and the other arguments. `campaign` shares the other options
 * through `parseItemArgs`, so only `ship` takes this one.
 */
function takePrompts(args: readonly string[]): { prompts: string | undefined; rest: string[] } {
	const rest: string[] = [];
	let prompts: string | undefined;
	for (let index = 0; index < args.length; index++) {
		const arg = args[index] ?? "";
		if (arg === "--") {
			rest.push(...args.slice(index));
			break;
		}
		if (arg === "--prompts") {
			prompts = args[++index];
			if (prompts === undefined) throw new UsageError("--prompts needs a folder");
		} else if (arg.startsWith("--prompts=")) prompts = arg.slice("--prompts=".length);
		else rest.push(arg);
	}
	return { prompts, rest };
}

/** `bundle` with the prompts of `folder` in place of the package prompts of their name. */
async function withPrompts(bundle: RunBundle, folder: string): Promise<RunBundle> {
	const found = await stat(folder).then(
		(entry) => entry.isDirectory(),
		() => false,
	);
	if (!found) throw new Error(`no prompts folder ${folder}`);
	const own = await readFolder(folder, ".", ".md");
	for (const name of Object.keys(own)) {
		if (bundle.prompts[name] === undefined) throw new Error(`${folder}/${name}.md replaces no prompt of the package`);
	}
	const replaced = Object.fromEntries(Object.entries(own).map(([name, text]) => [name, instructions(text)]));
	return { ...bundle, prompts: { ...bundle.prompts, ...replaced } };
}

export const ship = defineWorkflow<Args, ShipInput, ScriptCheckpoint, ShipResult>({
	...scriptWorkflow,
	name: "ship",
	usage:
		"workflows ship [--repo <repository>] [--base <branch>] [--rounds <n>] [--prompts <folder>] [<item.md> | <text>]",
	version: 3,
	parse: async (args, io) => {
		const { prompts, rest } = takePrompts(args);
		const parsed = parseItemArgs(rest, "work item");
		return { ...parsed, prompts, item: await readItem(parsed.item, io, "work item") };
	},
	prepare: async (args, run) => {
		const prepared = await prepareWorktree("ship", args, run);
		const { prompts } = args;
		const bundle =
			prompts === undefined ? prepared.bundle : await withPrompts(prepared.bundle, resolve(run.cwd, prompts));
		return { item: args.item, rounds: args.rounds, ...prepared, bundle };
	},
	title: (input) => subject(input.item),
	phases: {
		run: async (step) => {
			const { input } = step;
			await ensureWorktree(input.repository, input.worktree, input.branch, input.start);
			const args = { item: input.item, rounds: input.rounds, start: input.start, subject: subject(input.item) };
			await scriptPhase(step, input.worktree, input.bundle, args);
		},
	},
	report: (input, result, io) => {
		const name = subject(input.item);
		switch (result.status) {
			case "shipped": {
				if (result.judgeError !== undefined) io.stderr(`judge failed on ${name}: ${result.judgeError}`);
				const score = result.score === undefined ? "failed" : result.score.toFixed(2);
				io.stdout(`shipped ${name} in ${result.rounds} rounds, judge ${score}, ${result.head}`);
				return 0;
			}
			case "blocked":
				io.stdout(`blocked ${name} after ${result.rounds} rounds: ${input.worktree}`);
				io.stdout(result.reply);
				return 1;
			case "stopped":
				io.stdout(`stopped ${name} after ${result.rounds} rounds: ${input.worktree}`);
				return 1;
		}
	},
	status: (result) => result.status,
});
