/**
 * `workflows campaign`: a goal is split into work items, and each item ships as one commit on `campaign/<run-id>`, one
 * after another, in one worktree. The workflow script `workflows/campaign.js` does that work in the worktree.
 */
import { ensureWorktree } from "../lib/git.ts";
import { parseItemArgs, prepareWorktree, readItem, subject } from "../lib/item.ts";
import { type RunBundle, type ScriptCheckpoint, scriptPhase, scriptWorkflow } from "../lib/script.ts";
import { defineWorkflow } from "../lib/workflow.ts";
import type { ShipResult } from "./ship.ts";

type Args = {
	readonly goal: string;
	readonly repo: string | undefined;
	readonly base: string;
	readonly rounds: number;
};

/** Everything a run needs, saved before execution starts. */
export type CampaignInput = {
	readonly goal: string;
	readonly repository: string;
	readonly start: string;
	readonly branch: string;
	readonly worktree: string;
	readonly rounds: number;
	/** The package's bundle, with `workflows/campaign.js` as the run's own script. */
	readonly bundle: RunBundle;
};

/** The return value of `workflows/campaign.js`: each item that ran, in order, with its ship result. */
export type CampaignResult =
	| { readonly status: "done"; readonly head: string; readonly items: readonly CampaignItem[] }
	| { readonly status: "stopped"; readonly items: readonly CampaignItem[] };

type CampaignItem = { readonly item: string; readonly result: ShipResult };

export const campaign = defineWorkflow<Args, CampaignInput, ScriptCheckpoint, CampaignResult>({
	...scriptWorkflow,
	name: "campaign",
	usage: "workflows campaign [--repo <repository>] [--base <branch>] [--rounds <n>] [<goal.md> | <text>]",
	version: 1,
	parse: async (args, io) => {
		const { item, ...parsed } = parseItemArgs(args, "goal");
		return { ...parsed, goal: await readItem(item, io, "goal") };
	},
	prepare: async (args, run) => ({
		goal: args.goal,
		rounds: args.rounds,
		...(await prepareWorktree("campaign", args, run)),
	}),
	title: (input) => subject(input.goal),
	phases: {
		run: async (step) => {
			const { input } = step;
			await ensureWorktree(input.repository, input.worktree, input.branch, input.start);
			await scriptPhase(step, input.worktree, input.bundle, { goal: input.goal, rounds: input.rounds });
		},
	},
	report: (input, result, io) => {
		const name = subject(input.goal);
		if (result.status === "done") {
			io.stdout(`done ${name} in ${result.items.length} items, ${result.head}`);
			return 0;
		}
		io.stdout(`stopped ${name} at item ${result.items.length}: ${input.worktree}`);
		return 1;
	},
	status: (result) => result.status,
});
