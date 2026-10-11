/**
 * `workflows optimize ship`: a reflective loop searches for better texts of some ship prompts. Each evaluation is a
 * `workflows ship` child run of one item with a candidate's prompts, and each new text comes from a reflect turn in a
 * saved session. The result is a diff from the package prompts to the best candidate; `prompts/` stays unchanged.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { failure, git, gitSucceeds, run } from "../lib/git.ts";
import { instructions, render } from "../lib/prompts.ts";
import { loadBundle, type Profile, readFolder } from "../lib/script.ts";
import { defineWorkflow, type Session, type SessionCheckpoint, UsageError } from "../lib/workflow.ts";

/** The return value of `workflows/ship.js`, without its report lines. */
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

/** The prompts that a candidate can change. `judge` is not one: it gives the score. */
const CANDIDATES = ["plan", "challenge", "handoff", "implement", "review"];

/** One work item of the items folder: `<name>.md` with frontmatter `repo` and `start`. */
type Item = { readonly name: string; readonly repo: string; readonly start: string; readonly body: string };

type Args = { readonly items: readonly Item[]; readonly prompts: readonly string[]; readonly trials: number };

/** Everything a run needs, saved before execution starts. */
export type OptimizeInput = Args & {
	readonly cwd: string;
	readonly directory: string;
	/** The package's `default` profile, for the reflect session. */
	readonly profile: Profile;
	/** The instructions of the package prompt `reflect`. */
	readonly reflect: string;
	/** The package template `prompts/<name>.md` of each optimized prompt, in `prompts` order. */
	readonly templates: Readonly<Record<string, string>>;
};

type OptimizeCheckpoint = { readonly phase: "run" } & SessionCheckpoint;

/** The mean scores of the baseline and of the best candidate over the items, and the path of `prompts.diff`. */
export type OptimizeResult = { readonly baseline: number; readonly best: number; readonly diff: string };

/** One text for each optimized prompt, by prompt name. */
type Candidate = Readonly<Record<string, string>>;

/** A saved evaluation: the ship run, and its result once it finished. */
type Evaluation = { readonly runId: string; readonly result?: ShipResult };

/** A candidate with its ship result and score on each item, in item order. */
type Evaluated = {
	readonly candidate: Candidate;
	readonly results: readonly ShipResult[];
	readonly scores: readonly number[];
};

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

/** Saves `evaluation` under `key`. The file is replaced in one rename, so a kill never leaves it half written. */
async function saveEvaluation(directory: string, key: string, evaluation: Evaluation): Promise<void> {
	const evaluations = await readEvaluations(directory);
	evaluations[key] = evaluation;
	const path = join(directory, "evaluations.json");
	await writeFile(`${path}.tmp`, `${JSON.stringify(evaluations, null, "\t")}\n`);
	await rename(`${path}.tmp`, path);
}

/** Removes the worktree and the branch of the ship run `id` in `repo`. Its run directory stays. */
async function cleanUp(repo: string, id: string): Promise<void> {
	const branch = `refs/heads/ship/${id}`;
	for (const entry of (await git(repo, "worktree", "list", "--porcelain")).split("\n\n")) {
		const lines = entry.split("\n");
		const path = lines[0]?.replace(/^worktree /, "");
		if (path !== undefined && lines.includes(`branch ${branch}`))
			await git(repo, "worktree", "remove", "--force", path);
	}
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
		// ship reads an argument that ends in .md as a file; the trailing newline keeps it text and does not change the item.
		argv = ["ship", "--repo", item.repo, "--base", item.start, "--prompts", folder, "--json", "--", `${item.body}\n`];
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

/** `candidate` evaluated on every item, one ship run at a time. */
async function evaluateAll(cli: readonly string[], input: OptimizeInput, candidate: Candidate): Promise<Evaluated> {
	const results: ShipResult[] = [];
	for (const item of input.items) results.push(await evaluate(cli, input, candidate, item));
	return { candidate, results, scores: results.map(score) };
}

/** A new text of the prompt `name` from a reflect turn on the ship results of `best`. */
async function reflect(session: Session, input: OptimizeInput, name: string, best: Evaluated): Promise<string> {
	const current = best.candidate[name];
	if (current === undefined) throw new Error(`the candidate has no ${name} text`);
	const records = best.results.map((result, index) => ({
		item: input.items[index]?.body,
		score: best.scores[index],
		findings: result.status === "shipped" ? (result.findings ?? []) : [],
		memory: result.memory,
	}));
	const prompt = render(input.reflect, { prompt: name, current, records: JSON.stringify(records, null, 2) });
	// The request ID is the prompt's hash, so a restart gets the saved answer to the same prompt.
	const reply = await session.say(`reflect-${sha256(prompt).slice(0, 16)}`, prompt);
	if (reply === "" || reply === current.trim()) throw new Error(`the reflect turn for ${name} gave no new text`);
	return reply;
}

/** Writes `<directory>/prompts.diff`: a score line for each item, then a diff from the package prompts to `best`. */
async function writeDiff(input: OptimizeInput, best: Candidate, lines: readonly string[]): Promise<string> {
	const root = join(input.directory, "diff");
	await mkdir(join(root, "a", "prompts"), { recursive: true });
	await mkdir(join(root, "b", "prompts"), { recursive: true });
	for (const [name, template] of Object.entries(input.templates)) {
		const text = instructions(template);
		await writeFile(join(root, "a", "prompts", `${name}.md`), template);
		await writeFile(
			join(root, "b", "prompts", `${name}.md`),
			template.replace(text, () => best[name] ?? text),
		);
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
		usage: "workflows optimize <ship | --workflow ship> --items <folder> [--prompts <name,...>] [--trials <n>]",
		version: 1,
		parse: async (args, io) => {
			const { values, positionals } = parseArgs({
				args: [...args],
				options: {
					workflow: { type: "string" },
					items: { type: "string" },
					prompts: { type: "string" },
					trials: { type: "string" },
				},
				allowPositionals: true,
			});
			const workflows = [...positionals, ...(values.workflow === undefined ? [] : [values.workflow])];
			if (workflows.length !== 1 || workflows[0] !== "ship") throw new UsageError("optimize takes ship only");
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
			const profile = bundle.agents.default;
			if (profile === undefined) throw new Error("the package has no agents/default.md");
			const reflect = bundle.prompts.reflect;
			if (reflect === undefined) throw new Error("the package has no prompts/reflect.md");
			const folder = new URL("../../prompts/", import.meta.url);
			const templates = Object.fromEntries(
				await Promise.all(
					args.prompts.map(async (name) => [name, await readFile(new URL(`${name}.md`, folder), "utf8")] as const),
				),
			);
			return { ...args, cwd: run.cwd, directory: run.directory, profile, reflect, templates };
		},
		title: () => "ship",
		initial: () => ({ phase: "run" }),
		phases: {
			run: async (step) => {
				const { input } = step;
				const session = await step.session(input.profile, input.cwd);
				if (session === undefined) return;
				const texts = Object.entries(input.templates).map(([name, template]) => [name, instructions(template)]);
				const baseline = await evaluateAll(cli, input, Object.fromEntries(texts));
				// Each trial after the baseline changes the next prompt in turn. A candidate replaces the best one only when its
				// mean is higher, so the baseline stays on a tie.
				let best = baseline;
				for (let trial = 1; trial < input.trials; trial++) {
					const name = input.prompts[(trial - 1) % input.prompts.length] as string;
					const text = await reflect(session, input, name, best);
					const next = await evaluateAll(cli, input, { ...best.candidate, [name]: text });
					if (mean(next.scores) > mean(best.scores)) best = next;
				}
				const lines = input.items.map(
					(item, index) =>
						`${item.name}: baseline ${baseline.scores[index]?.toFixed(2)}, best ${best.scores[index]?.toFixed(2)}`,
				);
				const diff = await writeDiff(input, best.candidate, lines);
				await step.finish({ baseline: mean(baseline.scores), best: mean(best.scores), diff });
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
