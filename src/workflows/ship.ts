/**
 * `workflows ship`: a work item is planned, then implemented and reviewed for at most a few rounds, then judged and
 * squashed into one commit on `ship/<run-id>`. The workflow script `workflows/ship.js` does that work in the worktree.
 */
import { ensureWorktree } from "../lib/git.ts";
import { parseItemArgs, prepareWorktree, readItem, subject } from "../lib/item.ts";
import { type RunBundle, type ScriptCheckpoint, scriptPhase, scriptWorkflow } from "../lib/script.ts";
import { defineWorkflow } from "../lib/workflow.ts";

type Args = {
	readonly item: string;
	readonly repo: string | undefined;
	readonly base: string;
	readonly rounds: number;
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
	  }
	| { readonly status: "blocked"; readonly rounds: number; readonly reply: string }
	| { readonly status: "stopped"; readonly rounds: number };

export const ship = defineWorkflow<Args, ShipInput, ScriptCheckpoint, ShipResult>({
	...scriptWorkflow,
	name: "ship",
	usage: "workflows ship [--repo <repository>] [--base <branch>] [--rounds <n>] [<item.md> | <text>]",
	version: 3,
	parse: async (args, io) => {
		const parsed = parseItemArgs(args, "work item");
		return { ...parsed, item: await readItem(parsed.item, io, "work item") };
	},
	prepare: async (args, run) => ({
		item: args.item,
		rounds: args.rounds,
		...(await prepareWorktree("ship", args, run)),
	}),
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
