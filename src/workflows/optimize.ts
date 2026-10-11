/**
 * `workflows optimize ship`: AxGEPA searches for better texts of some ship prompts. Each evaluation is a `workflows
 * ship` child run of one item with a candidate's prompts, and each new text comes from a reflect turn in a saved
 * session. The result is a diff from the package prompts to the best candidate; `prompts/` stays unchanged.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { AxGEPA, type AxGEPAAdapter } from "@ax-llm/ax";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { failure, git, gitSucceeds, run } from "../lib/git.ts";
import { runsDirectory } from "../lib/main.ts";
import { render } from "../lib/prompts.ts";
import { type Bundle, loadBundle, readFolder } from "../lib/script.ts";
import { defineWorkflow, type Session, type SessionCheckpoint, UsageError } from "../lib/workflow.ts";
import type { ShipResult } from "./ship.ts";

/** The prompts that a candidate can change. `judge` is not one: it gives the score. */
const CANDIDATES = ["plan", "challenge", "handoff", "implement", "review"];

/** One work item of the items folder: `<name>.md` with frontmatter `repo` and `start`. */
type Item = { readonly name: string; readonly repo: string; readonly start: string; readonly body: string };

type Args = { readonly items: readonly Item[]; readonly prompts: readonly string[]; readonly trials: number };

/** Everything a run needs, saved before execution starts. */
export type OptimizeInput = Args & {
	readonly cwd: string;
	readonly directory: string;
	/** The package's bundle: the baseline texts, `reflect`, and the `default` profile. */
	readonly bundle: Bundle;
	/** The package template `prompts/<name>.md` of each optimized prompt, for the diff. */
	readonly templates: Readonly<Record<string, string>>;
};

type OptimizeCheckpoint = { readonly phase: "run" } & SessionCheckpoint;

/** The mean scores of the baseline and of the best candidate over the items, and the path of `prompts.diff`. */
export type OptimizeResult = { readonly baseline: number; readonly best: number; readonly diff: string };

type Candidate = Readonly<Record<string, string>>;

/** A saved evaluation: the ship run, and its result once it finished. */
type Evaluation = { readonly runId: string; readonly result?: ShipResult };

type Trajectory = { readonly item: Item; readonly result: ShipResult };

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** The candidate's texts in name order, as one JSON text. */
const textsOf = (candidate: Candidate) =>
	JSON.stringify(Object.entries(candidate).sort(([a], [b]) => a.localeCompare(b)));

const keyOf = (candidate: Candidate, item: Item) => sha256(JSON.stringify([textsOf(candidate), item.name]));

/**
 * The score of one ship result: for a shipped run, the fraction of the eight judge answers that pass, less 0.1 for
 * each round after the first. A judge that failed passes nothing. A blocked or stopped run scores 0.
 */
export function score(result: ShipResult): number {
	if (result.status !== "shipped") return 0;
	const passes = result.answers?.filter((answer) => answer === "PASS").length ?? 0;
	return passes / 8 - 0.1 * (result.rounds - 1);
}

const mean = (values: readonly number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;

async function readItems(folder: string): Promise<Item[]> {
	const files = await readFolder(folder, ".", ".md");
	return Object.entries(files).map(([name, text]) => {
		const { frontmatter, body } = parseFrontmatter<{ repo?: unknown; start?: unknown }>(text);
		if (frontmatter.repo === undefined || frontmatter.start === undefined) {
			throw new UsageError(`item ${name} needs repo and start in its frontmatter`);
		}
		return { name, repo: resolve(folder, String(frontmatter.repo)), start: String(frontmatter.start), body };
	});
}

/** The saved evaluations of the run directory `directory`, by key. */
async function readEvaluations(directory: string): Promise<Record<string, Evaluation>> {
	const text = await readFile(join(directory, "evaluations.json"), "utf8").catch(() => "{}");
	return JSON.parse(text);
}

async function saveEvaluation(directory: string, key: string, evaluation: Evaluation): Promise<void> {
	const evaluations = await readEvaluations(directory);
	evaluations[key] = evaluation;
	await writeFile(join(directory, "evaluations.json"), `${JSON.stringify(evaluations, null, "\t")}\n`);
}

/** Removes the worktree and the branch of the ship run `id` in `repo`. Its run directory stays. */
async function cleanUp(repo: string, id: string): Promise<void> {
	await rm(join(runsDirectory(), id, "worktree"), { recursive: true, force: true });
	await git(repo, "worktree", "prune");
	const branch = `refs/heads/ship/${id}`;
	if (await gitSucceeds(repo, "rev-parse", "--verify", "--quiet", branch))
		await git(repo, "branch", "-D", `ship/${id}`);
}

/**
 * The ship result of `item` with the prompts of `candidate`. A finished evaluation returns its saved result, and one
 * whose ship run did not finish resumes that run. Any outcome other than finished stops the optimization.
 */
async function evaluate(cli: readonly string[], input: OptimizeInput, candidate: Candidate, item: Item) {
	const key = keyOf(candidate, item);
	const saved = (await readEvaluations(input.directory))[key];
	if (saved?.result !== undefined) return saved.result;
	let argv: string[];
	if (saved === undefined) {
		const folder = join(input.directory, "candidates", sha256(textsOf(candidate)));
		await mkdir(folder, { recursive: true });
		for (const [name, text] of Object.entries(candidate)) await writeFile(join(folder, `${name}.md`), `${text}\n`);
		argv = ["ship", "--repo", item.repo, "--base", item.start, "--prompts", folder, "--json", "--", item.body];
	} else {
		argv = ["resume", saved.runId, "--json"];
	}
	// The run ID comes from the last line, so a hard kill of this command during the child loses it, and the next start
	// runs this item again in a new ship run.
	const [command = "", ...args] = cli;
	const output = await run(command, [...args, ...argv], input.cwd);
	const line = output.stdout.trimEnd().split("\n").at(-1) ?? "";
	let outcome: { runId: string; status: string; result?: ShipResult; error?: string };
	try {
		outcome = JSON.parse(line);
	} catch {
		throw new Error(`${failure([command, argv[0] ?? ""], output)} on ${item.name}`);
	}
	await saveEvaluation(input.directory, key, { runId: outcome.runId });
	if (outcome.status !== "finished" || outcome.result === undefined) {
		const reason = outcome.error ?? outcome.status;
		throw new Error(
			`ship run ${outcome.runId} failed on ${item.name}: ${reason}; continue with: workflows resume ${outcome.runId}`,
		);
	}
	await cleanUp(item.repo, outcome.runId);
	await saveEvaluation(input.directory, key, { runId: outcome.runId, result: outcome.result });
	return outcome.result;
}

/**
 * The Ax adapter. Ax catches adapter errors and goes on with its own fallbacks, so the first error is kept, and every
 * later call throws it at once: no ship run or reflect turn starts after it, and the phase throws it after `compile`.
 */
function adapterOf(cli: readonly string[], input: OptimizeInput, session: Session) {
	const state: { error?: unknown } = {};
	const guard = <A extends unknown[], R>(method: (...args: A) => R) => {
		return (...args: A): R => {
			if ("error" in state) throw state.error;
			try {
				const value = method(...args);
				if (value instanceof Promise) {
					return value.catch((error: unknown) => {
						state.error ??= error;
						throw error;
					}) as R;
				}
				return value;
			} catch (error) {
				state.error ??= error;
				throw error;
			}
		};
	};
	const adapter: AxGEPAAdapter<Item, Trajectory, ShipResult> = {
		evaluate: guard(async (batch: readonly Item[], candidate: Candidate) => {
			const outputs: ShipResult[] = [];
			for (const item of batch) outputs.push(await evaluate(cli, input, candidate, item));
			return {
				outputs,
				scores: outputs.map(score),
				trajectories: outputs.map((result, index) => ({ item: batch[index] as Item, result })),
			};
		}),
		make_reflective_dataset: guard((_candidate, evalBatch, components: readonly string[]) => {
			const records = (evalBatch.trajectories ?? []).map(({ item, result }, index) => ({
				item: item.body,
				score: evalBatch.scores[index] ?? 0,
				findings: result.status === "shipped" ? (result.findings ?? []) : [],
				memory: result.memory,
			}));
			return Object.fromEntries(components.map((name) => [name, records]));
		}),
		propose_new_texts: guard(async (candidate: Candidate, dataset, components: readonly string[]) => {
			const reflect = input.bundle.prompts.reflect ?? "";
			const proposed: Record<string, string> = {};
			for (const name of components) {
				const current = candidate[name] ?? "";
				const records = JSON.stringify(dataset[name] ?? [], null, 2);
				const prompt = render(reflect, { prompt: name, current, records });
				// The request ID is the prompt's hash, so a restart gets the saved answer to the same prompt.
				const reply = await session.say(`reflect-${sha256(prompt).slice(0, 16)}`, prompt);
				if (reply === "" || reply === current.trim()) throw new Error(`the reflect turn for ${name} gave no new text`);
				proposed[name] = reply;
			}
			return proposed;
		}),
	};
	return { adapter, error: () => state.error };
}

/** Writes `<directory>/prompts.diff`: a score line for each item, then a diff from the package prompts to `best`. */
async function writeDiff(input: OptimizeInput, baseline: Candidate, best: Candidate, lines: string[]): Promise<string> {
	const root = join(input.directory, "diff");
	for (const [side, candidate] of [
		["a", baseline],
		["b", best],
	] as const) {
		await mkdir(join(root, side, "prompts"), { recursive: true });
		for (const name of input.prompts) {
			const template = input.templates[name] ?? "";
			const text = template.replace(baseline[name] ?? "", () => candidate[name] ?? "");
			await writeFile(join(root, side, "prompts", `${name}.md`), text);
		}
	}
	const diff = await run("git", ["diff", "--no-index", "--no-prefix", "a/prompts", "b/prompts"], root);
	// git diff --no-index exits 1 when the files differ.
	if (diff.code > 1) throw new Error(failure(["git", "diff"], diff));
	const path = join(input.directory, "prompts.diff");
	await writeFile(path, `${[...lines, diff.stdout].join("\n").trimEnd()}\n`);
	return path;
}

/** The `optimize` workflow; `cli` is the command that runs `workflows`, such as `node src/cli.ts`. */
export function optimizeWith(cli: readonly string[]) {
	return defineWorkflow<Args, OptimizeInput, OptimizeCheckpoint, OptimizeResult>({
		name: "optimize",
		usage: "workflows optimize ship --items <folder> [--prompts <name,...>] [--trials <n>]",
		version: 1,
		parse: async (args, io) => {
			const { values, positionals } = parseArgs({
				args: [...args],
				options: { items: { type: "string" }, prompts: { type: "string" }, trials: { type: "string" } },
				allowPositionals: true,
			});
			if (positionals.length !== 1 || positionals[0] !== "ship") throw new UsageError("optimize takes ship only");
			if (values.items === undefined) throw new UsageError("missing --items");
			const items = await readItems(resolve(io.cwd, values.items));
			if (items.length < 2) throw new UsageError("--items needs at least 2 items");
			const prompts = (values.prompts ?? "review,challenge,handoff").split(",");
			for (const name of prompts) {
				if (!CANDIDATES.includes(name)) throw new UsageError(`--prompts takes ${CANDIDATES.join(", ")}, not ${name}`);
			}
			const trials = Number(values.trials ?? "3");
			if (!Number.isInteger(trials) || trials < 1) throw new UsageError("--trials must be a positive integer");
			return { items, prompts: [...new Set(prompts)], trials };
		},
		prepare: async (args, run) => {
			const bundle = await loadBundle();
			const folder = new URL("../../prompts/", import.meta.url);
			const templates = Object.fromEntries(
				await Promise.all(
					args.prompts.map(async (name) => [name, await readFile(new URL(`${name}.md`, folder), "utf8")] as const),
				),
			);
			return { ...args, cwd: run.cwd, directory: run.directory, bundle, templates };
		},
		title: () => "ship",
		initial: () => ({ phase: "run" }),
		phases: {
			run: async (step) => {
				const { input } = step;
				const profile = input.bundle.agents.default;
				if (profile === undefined) throw new Error("the package has no agents/default.md");
				const session = await step.session(profile, input.cwd);
				if (session === undefined) return;
				const baseline = Object.fromEntries(input.prompts.map((name) => [name, input.bundle.prompts[name] ?? ""]));
				const program = {
					getOptimizableComponents: () =>
						input.prompts.map((name) => ({ key: name, kind: "prompt", current: baseline[name] ?? "" })),
					applyOptimizedComponents: () => {},
					forward: () => {
						throw new Error("optimize evaluates only through its adapter");
					},
				};
				const { adapter, error } = adapterOf(cli, input, session);
				// No seed: Ax would replace the global Math.random, and AxGEPA's own generator has a fixed default seed.
				const optimizer = new AxGEPA({ studentAI: {} as never, minibatchSize: input.items.length });
				const result = await optimizer
					.compile(
						program as never,
						input.items,
						() => {
							throw new Error("optimize scores only through its adapter");
						},
						{ gepaAdapter: adapter, maxMetricCalls: input.trials * input.items.length },
					)
					.catch((thrown: unknown) => {
						throw error() ?? thrown;
					});
				if (error() !== undefined) throw error();
				const found = (result as { optimizedProgram?: { componentMap?: Candidate } }).optimizedProgram?.componentMap;
				const best = found ?? baseline;
				const evaluations = await readEvaluations(input.directory);
				const scoreOf = (candidate: Candidate, item: Item) => {
					const saved = evaluations[keyOf(candidate, item)]?.result;
					if (saved === undefined) throw new Error(`no evaluation of ${item.name}`);
					return score(saved);
				};
				const scores = input.items.map((item) => [scoreOf(baseline, item), scoreOf(best, item)] as const);
				const lines = input.items.map(
					(item, index) =>
						`${item.name}: baseline ${scores[index]?.[0].toFixed(2)}, best ${scores[index]?.[1].toFixed(2)}`,
				);
				const diff = await writeDiff(input, baseline, best, lines);
				await step.finish({
					baseline: mean(scores.map(([value]) => value)),
					best: mean(scores.map(([, value]) => value)),
					diff,
				});
			},
		},
		report: (_input, result, io) => {
			io.stdout(
				`optimized ship: baseline ${result.baseline.toFixed(2)}, best ${result.best.toFixed(2)}, ${result.diff}`,
			);
			return 0;
		},
	});
}
