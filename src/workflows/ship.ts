/**
 * `workflows ship`: a work item is planned, then implemented and reviewed for at most a few rounds, then judged and
 * squashed into one commit on `ship/<run-id>`.
 */
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { AgentChoice } from "../lib/agents.ts";
import { ensureWorktree, git, gitSucceeds, selectRepository } from "../lib/git.ts";
import { loadPrompts, render } from "../lib/prompts.ts";
import { defineWorkflow, type Io, type SessionCheckpoint, type Step, UsageError } from "../lib/workflow.ts";

const PROMPTS = ["plan", "challenge", "handoff", "implement", "review", "judge"] as const;
type Role = "plan" | "implement" | "review" | "judge";

const OPUS = { provider: "cursor", modelId: "claude-opus-5-5" };

export const AGENTS: Readonly<Record<Role, AgentChoice>> = {
	plan: { model: OPUS, thinkingLevel: "medium" },
	implement: { model: OPUS, thinkingLevel: "medium" },
	review: { model: OPUS, thinkingLevel: "medium" },
	judge: { model: OPUS, thinkingLevel: "medium" },
};

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
	readonly directory: string;
	readonly rounds: number;
	readonly prompts: Readonly<Record<(typeof PROMPTS)[number], string>>;
	readonly agents: Readonly<Record<Role, AgentChoice>>;
};

export type Verdict = { readonly score: number; readonly findings: readonly string[] };

export type ShipResult =
	| {
			readonly status: "shipped";
			readonly rounds: number;
			readonly head: string;
			readonly verdict?: Verdict;
			readonly judgeError?: string;
	  }
	| { readonly status: "blocked"; readonly rounds: number; readonly reply: string }
	| { readonly status: "stopped"; readonly rounds: number };

type Round = { readonly round: number; readonly plan: string };
type ShipCheckpoint =
	| { readonly phase: "setup" }
	| ({ readonly phase: "plan" } & SessionCheckpoint)
	| ({ readonly phase: "implement"; readonly before: string } & Round & SessionCheckpoint)
	| ({ readonly phase: "stage"; readonly before: string; readonly reply: string } & Round)
	| ({ readonly phase: "review"; readonly reply: string; readonly change: readonly string[] } & Round &
			SessionCheckpoint)
	| ({ readonly phase: "judge"; readonly round: number } & SessionCheckpoint)
	| { readonly phase: "finish"; readonly round: number; readonly verdict?: Verdict; readonly judgeError?: string };

type ShipStep<P extends ShipCheckpoint["phase"]> = Step<
	ShipInput,
	Extract<ShipCheckpoint, { phase: P }>,
	ShipCheckpoint,
	ShipResult
>;

const ENDING = "End with one line: SHIP if nothing needs to change, FIX otherwise.";
const ANSWER = /^([1-8])[.):]?\s+(PASS|FAIL)\b/;

/** The first non-empty line of `item`, without leading #. */
export function subject(item: string): string {
	const line = item.split("\n").find((candidate) => candidate.trim() !== "") ?? "";
	return line.replace(/^#+/, "").trim();
}

/** The squashed commit message: subject, work item, judge findings, then the trailers. */
export function message(item: string, rounds: number, verdict?: Verdict): string {
	const paragraphs = [subject(item), item.trim()];
	const trailers = [`Rounds: ${rounds}`];
	if (verdict !== undefined) {
		if (verdict.findings.length > 0) paragraphs.push(verdict.findings.join("\n"));
		trailers.push(`Judge: ${verdict.score.toFixed(2)}`);
	}
	return [...paragraphs, trailers.join("\n")].join("\n\n");
}

/** Zero when question 1 or 2 fails, else the passing fraction of questions 3 to 8; throws when one is unanswered. */
export function verdict(reply: string): Verdict {
	const answers = new Map<number, { readonly pass: boolean; readonly line: string }>();
	for (const raw of reply.split("\n")) {
		const line = raw
			.replace(/[*`]/g, "")
			.trim()
			.replace(/^[-+> ]+/, "")
			.trim();
		const match = ANSWER.exec(line);
		if (match !== null) answers.set(Number(match[1]), { pass: match[2] === "PASS", line });
	}
	const questions = [1, 2, 3, 4, 5, 6, 7, 8];
	const missing = questions.filter((n) => !answers.has(n));
	if (missing.length > 0) throw new Error(`judge reply has no answer to ${missing.join(", ")}:\n${reply}`);
	const passed = (n: number) => answers.get(n)?.pass === true;
	const score = passed(1) && passed(2) ? questions.slice(2).filter(passed).length / 6 : 0;
	return { score, findings: questions.filter((n) => !passed(n)).map((n) => answers.get(n)?.line ?? "") };
}

/** Whether a challenge reply ends with SHIP; any other ending asks for another round. */
function ships(reply: string): boolean {
	const last = reply.trim().split("\n").at(-1) ?? "";
	return last.replace(/^[*`. ]+|[*`. ]+$/g, "") === "SHIP";
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

/** Writes `git diff --binary <from> HEAD` of the worktree to `<directory>/<name>` and returns that path. */
async function writePatch(worktree: string, directory: string, name: string, from: string): Promise<string> {
	const path = join(directory, name);
	await writeFile(path, `${await git(worktree, "diff", "--binary", from, "HEAD")}\n`);
	return path;
}

export const ship = defineWorkflow<Args, ShipInput, ShipCheckpoint, ShipResult>({
	name: "ship",
	usage: "workflows ship [--repo <repository>] [--base <branch>] [--rounds <n>] [<item.md> | <text>]",
	parse: async (args, io) => {
		let parsed: ReturnType<typeof parseShip>;
		try {
			parsed = parseShip(args);
		} catch (error) {
			throw error instanceof UsageError ? error : new UsageError((error as Error).message);
		}
		return { ...parsed, item: await readItem(parsed.item, io) };
	},
	prepare: async (args, run) => {
		const repository = await selectRepository(run.cwd, args.repo, args.base, join(run.directory, "repository"));
		return {
			item: args.item,
			repository: repository.path,
			start: repository.start,
			branch: `ship/${run.id}`,
			worktree: join(run.directory, "worktree"),
			directory: run.directory,
			rounds: args.rounds,
			prompts: await loadPrompts(PROMPTS),
			agents: AGENTS,
		};
	},
	title: (input) => subject(input.item),
	initial: () => ({ phase: "setup" }),
	phases: {
		setup: async ({ input, advance }: ShipStep<"setup">) => {
			await ensureWorktree(input.repository, input.worktree, input.branch, input.start);
			await advance({ phase: "plan" });
		},
		plan: async ({ input, session, log, advance }: ShipStep<"plan">) => {
			const plan = await session(input.agents.plan, input.worktree);
			if (plan === undefined) return;
			log("plan");
			await plan.say("plan", render(input.prompts.plan, { item: input.item }));
			await plan.say("challenge", render(input.prompts.challenge));
			const handoff = await plan.say("handoff", render(input.prompts.handoff));
			await advance({ phase: "implement", round: 1, plan: handoff, before: input.start });
		},
		implement: async ({ input, checkpoint, session, log, advance }: ShipStep<"implement">) => {
			const implement = await session(input.agents.implement, input.worktree);
			if (implement === undefined) return;
			const { round, plan, before } = checkpoint;
			log(`round ${round}: implement`);
			const reply = await implement.say("implement", render(input.prompts.implement, { plan }));
			await advance({ phase: "stage", round, plan, before, reply });
		},
		stage: async ({ input, checkpoint, advance, finish }: ShipStep<"stage">) => {
			const { round, plan, before, reply } = checkpoint;
			const cwd = input.worktree;
			await git(cwd, "add", "-A");
			if (await gitSucceeds(cwd, "diff", "--cached", "--quiet", input.start)) {
				return finish({ status: "blocked", rounds: round, reply });
			}
			if (!(await gitSucceeds(cwd, "diff", "--cached", "--quiet"))) await git(cwd, "commit", "-m", `round ${round}`);
			const change = [await writePatch(cwd, input.directory, `round-${round}.patch`, input.start)];
			if (round > 1) change.push(await writePatch(cwd, input.directory, `round-${round}-fix.patch`, before));
			await advance({ phase: "review", round, plan, reply, change });
		},
		review: async ({ input, checkpoint, session, log, advance, finish }: ShipStep<"review">) => {
			const review = await session(input.agents.review, input.worktree);
			if (review === undefined) return;
			const { round, plan, reply, change } = checkpoint;
			log(`round ${round}: review`);
			const inputs = { item: input.item, plan, change: change.join("\n"), reply };
			await review.say("review", render(input.prompts.review, inputs));
			if (ships(await review.say("challenge", `${render(input.prompts.challenge)}\n\n${ENDING}`))) {
				return advance({ phase: "judge", round });
			}
			if (round === input.rounds) return finish({ status: "stopped", rounds: round });
			const next = await review.say("handoff", render(input.prompts.handoff));
			const before = await git(input.worktree, "rev-parse", "HEAD");
			await advance({ phase: "implement", round: round + 1, plan: next, before });
		},
		judge: async ({ input, checkpoint, session, log, advance }: ShipStep<"judge">) => {
			const judge = await session(input.agents.judge, input.worktree);
			if (judge === undefined) return;
			log("judge");
			const head = await git(input.worktree, "rev-parse", "HEAD");
			const content = render(input.prompts.judge, { item: input.item, base: input.start, head });
			let outcome: { readonly verdict: Verdict } | { readonly judgeError: string };
			try {
				outcome = { verdict: verdict(await judge.say("judge", content)) };
			} catch (error) {
				outcome = { judgeError: error instanceof Error ? error.message : String(error) };
			}
			await advance({ phase: "finish", round: checkpoint.round, ...outcome });
		},
		finish: async ({ input, checkpoint, finish }: ShipStep<"finish">) => {
			const { round, verdict: found, judgeError } = checkpoint;
			await git(input.worktree, "reset", "--soft", input.start);
			await git(input.worktree, "commit", "-m", message(input.item, round, found));
			await finish({
				status: "shipped",
				rounds: round,
				head: await git(input.worktree, "rev-parse", "--short", "HEAD"),
				...(found === undefined ? {} : { verdict: found }),
				...(judgeError === undefined ? {} : { judgeError }),
			});
		},
	},
	report: (input, result, io) => {
		const name = subject(input.item);
		switch (result.status) {
			case "shipped": {
				if (result.judgeError !== undefined) io.stderr(`judge failed on ${name}: ${result.judgeError}`);
				const score = result.verdict === undefined ? "failed" : result.verdict.score.toFixed(2);
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
