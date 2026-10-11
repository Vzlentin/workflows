/**
 * `workflows ship`: a work item is planned, then implemented and reviewed for at most a few rounds, then judged and
 * squashed into one commit on `ship/<run-id>`. The workflow script `workflows/ship.js` does that work in the worktree.
 */
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { ensureWorktree, selectRepository } from "../lib/git.ts";
import { loadBundle, type RunBundle, type ScriptCheckpoint, scriptPhase, scriptWorkflow } from "../lib/script.ts";
import { defineWorkflow, type Io, UsageError } from "../lib/workflow.ts";

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

/** The first non-empty line of `item`, without leading #. */
export function subject(item: string): string {
	const line = item.split("\n").find((candidate) => candidate.trim() !== "") ?? "";
	return line.replace(/^#+/, "").trim();
}

/** The work item: a `.md` file, inline text, or piped stdin. Throws when it has no non-empty line. */
async function readItem(argument: string | undefined, io: Io): Promise<string> {
	let text: string | undefined;
	if (argument === undefined) {
		text = await io.stdin();
		if (text === undefined) throw new UsageError("missing work item");
	} else if (argument.endsWith(".md")) {
		const path = resolve(io.cwd, argument);
		text = await readFile(path, "utf8").catch(() => {
			throw new Error(`cannot read work item ${path}`);
		});
	} else {
		text = argument;
	}
	if (text.trim() === "") throw new Error("the work item is empty");
	return text;
}

export const ship = defineWorkflow<Args, ShipInput, ScriptCheckpoint, ShipResult>({
	...scriptWorkflow,
	name: "ship",
	usage: "workflows ship [--repo <repository>] [--base <branch>] [--rounds <n>] [<item.md> | <text>]",
	version: 3,
	parse: async (args, io) => {
		const parsed = parseShip(args);
		return { ...parsed, item: await readItem(parsed.item, io) };
	},
	prepare: async (args, run) => {
		const bundle = await loadBundle();
		const main = bundle.scripts.ship;
		if (main === undefined) throw new Error("the package has no workflows/ship.js");
		const repository = await selectRepository(run.cwd, args.repo, args.base, join(run.directory, "repository"));
		return {
			item: args.item,
			repository: repository.path,
			start: repository.start,
			branch: `ship/${run.id}`,
			worktree: join(run.directory, "worktree"),
			rounds: args.rounds,
			bundle: { ...bundle, main },
		};
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

function parseShip(args: readonly string[]) {
	const { values, positionals } = parseArgs({
		args: [...args],
		options: { repo: { type: "string" }, base: { type: "string" }, rounds: { type: "string" } },
		allowPositionals: true,
	});
	if (positionals.length > 1) throw new UsageError("give the work item as one argument");
	const rounds = Number(values.rounds ?? "3");
	if (!Number.isInteger(rounds) || rounds < 1) throw new UsageError("--rounds must be a positive integer");
	return { repo: values.repo, base: values.base ?? "main", rounds, item: positionals[0] };
}
