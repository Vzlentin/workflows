/** `workflows resume <run-id>` and `workflows wait <run-id>`: continue or follow a run. */
import { isDeepStrictEqual, parseArgs } from "node:util";
import type { Client } from "@vzlentin/harness/client";
import type { ScriptInput } from "../../launch/input.ts";
import { checkWorktree } from "../../launch/worktree.ts";
import { callRecords, reading, type Store } from "../../records/store.ts";
import { answerAsk, type Asks, readAsk } from "../../run/asks.ts";
import { hasEnded, runStatus } from "../../run/past.ts";
import { UsageError, withUsage } from "../../workflow/find.ts";
import { type Following, follow, outcomeOf, reportOutcome } from "../follow.ts";
import { checkVersion, connectTo, startTask } from "../host.ts";
import type { Terminal } from "../main.ts";
import { checked, GoneRun, inputOf, lastTaskIn, oneRunId, progressOf, savedRun } from "../saved.ts";
import { programStatus } from "../terminal/redraw.ts";

export const RESUME = "workflows resume <run-id> [--answer <text>] [--background] [--json]";
export const WAIT = "workflows wait <run-id> [--json]";

/**
 * Continues the run of `args`. A finished run prints its result. A run whose last task ended without a result continues
 * in a new task with the same input, and shows the progress from its start. A run that waits for an answer gives the
 * answer of `--answer` to the ask of its open `input` call, and continues in a new task with the same input, which
 * reads the answer from the ask. A waiting run whose ask got its answer elsewhere, or was dropped, continues without
 * `--answer`. A run whose last task did not end is followed: with its host running, from the start of the task's
 * current execution, else from when the host starts.
 * With `wait`, an ended run prints its outcome from the store, and Ctrl+C never stops the run.
 */
export async function resume(
	args: readonly string[],
	terminal: Terminal,
	json: boolean,
	background: boolean,
	wait = false,
): Promise<number> {
	const usage = wait ? WAIT : RESUME;
	const { id, answer } = wait ? { id: oneRunId(args, usage), answer: undefined } : resumeArgs(args);
	const run = await savedRun(id, usage);

	// The ask of the open input call comes from the same read as the task and its keys.
	const read = await reading(run.store, undefined, async (store) => ({
		...(await lastTaskIn(store, run.id)),
		ask: await openAsk(store, run.id),
	}));

	if (read === undefined) throw new GoneRun(`run ${run.id} has no workflow`);

	const task = checked(read.latest, run.id, wait ? "be waited for" : "resume");
	const { input } = task;
	const status = runStatus(task);
	const ended = hasEnded(status);

	if (answer !== undefined && status !== "waiting") {
		throw new UsageError(`run ${run.id} does not wait for an answer`, RESUME);
	}

	// A waiting run whose ask is not open, after this command answered it or after an answer or a drop elsewhere, ended
	// without a result, so it continues in a new task with the same input. A wait never reads the ask.
	const waiting = status === "waiting" && (wait || (await settleAsk(terminal, run, read.ask, answer)));

	if (waiting && answer === undefined && !wait && !json && !background && terminal.readLine !== undefined) {
		terminal.stdout(`run ${run.id}`);
		reportOutcome(input, task, terminal, json, await progressOf(run), true);

		return answering(run.id, terminal);
	}

	if (ended && (wait || waiting || status === "done")) {
		terminal.stdout(`run ${run.id}`);

		return outcomeOf(input, task, terminal, json, await progressOf(run));
	}

	const key = ended ? read.keys.next : read.keys.keyOf(task);

	// A wait never tells the terminal that it follows a run, so a second Ctrl+C exits rather than stops the run. It
	// never asks for the answer of a waiting run.
	const followed: Terminal = wait
		? { ...terminal, following: () => {}, stopWindowMs: 0, readLine: undefined }
		: terminal;

	followed.following(true);
	let client: Client | undefined;
	let from: number;

	try {
		if (ended) {
			// The new task is never the first task of the run, so it refuses what its phase would refuse.
			if (input.worktree !== undefined) await checkWorktree(run.id, input.worktree, false);
			from = (await progressOf(run)).length;
			client = await connectTo(terminal, run.project, true);
			// The new task posts its outcome only when this resume runs in the background, whatever the last task did.
			const { notify: _ended, ...saved } = input;
			const sent: ScriptInput = background ? { ...saved, notify: true } : saved;
			const started = await startTask(client, run.project, sent, key);

			// Another resume of the run that took the same key first started its task, which this one then follows.
			if (!isDeepStrictEqual(await inputOf(run, started.id), JSON.parse(JSON.stringify(sent)))) {
				throw new Error(
					`run ${run.id} was resumed by another command with another input: follow it with workflows wait ${run.id}`,
				);
			}
		} else {
			const before = (await progressOf(run)).length;
			client = await connectTo(terminal, run.project, false);

			if (client === undefined) {
				from = before;
				client = await connectTo(terminal, run.project, true);
			} else {
				const events = await progressOf(run);
				const started = events.findLastIndex((event) => event.kind === "start" && event.run === run.id);
				from = started === -1 ? events.length : started;
			}

			checkVersion(client, run.project, await client.request({ type: "task", key }));
		}
	} catch (error) {
		client?.close();
		followed.following(false);
		throw error;
	}

	terminal.stdout(`run ${run.id}`);

	// A wait shows every step of the run, from its first execution.
	return followAnswering(
		{ id: run.id, project: run.project, key, input, client, from: wait ? 0 : from },
		followed,
		json,
		background,
	);
}

/**
 * Follows the run as `follow` does, and gives its exit code. When the run waits for an answer that the terminal can
 * read, it reads the answer and continues the run with it.
 */
export async function followAnswering(
	run: Following,
	terminal: Terminal,
	json: boolean,
	background: boolean,
): Promise<number> {
	const { code, asking } = await follow(run, terminal, json, background);

	return asking ? answering(run.id, terminal) : code;
}

/**
 * Reads the answer of the waiting run `id` on the terminal, and continues the run with it. Without an answer, at
 * Ctrl+C or at the end of input, it prints how to continue and exits 130.
 */
async function answering(id: string, terminal: Terminal): Promise<number> {
	let text = await terminal.readLine?.();

	// An answer needs a text that is not blank.
	while (text !== undefined && text.trim() === "") text = await terminal.readLine?.();

	if (text === undefined) {
		const line = `run ${id} waits for an answer; continue with: workflows resume ${id} --answer <text>`;
		terminal.stderr(line);
		terminal.status?.(programStatus("idle", line));

		return 130;
	}

	return resume([id, `--answer=${text}`], terminal, false, false);
}

/** The run ID and the `--answer` of the args of `resume`. A blank answer is bad usage. */
function resumeArgs(args: readonly string[]) {
	const { values, positionals } = withUsage(
		() => parseArgs({ args: [...args], options: { answer: { type: "string" } }, allowPositionals: true, strict: true }),
		RESUME,
	);

	if (values.answer?.trim() === "") throw new UsageError("--answer needs a text that is not blank", RESUME);

	return { id: oneRunId(positionals, RESUME), answer: values.answer };
}

/**
 * The ask of the `input` call that the run `id` waits for an answer to, in the call records of `store`: the ask of the
 * last open `input` call, or undefined when there is none or its record has no ask.
 */
async function openAsk(store: Store, id: string): Promise<number | undefined> {
	const open = [...(await callRecords(store, id))]
		.flatMap(([key, record]) =>
			key.startsWith(`${id}/`) && record.kind === "input" && record.end === undefined ? [record] : [],
		)
		.sort((a, b) => a.startedAt.localeCompare(b.startedAt));

	return open.at(-1)?.ask;
}

/**
 * Whether the waiting run `run` still waits for its ask `ask`, which the host of its project keeps. With `answer`, it
 * first answers the ask, and the run no longer waits.
 */
async function settleAsk(
	terminal: Terminal,
	run: { readonly id: string; readonly project: string },
	ask: number | undefined,
	answer: string | undefined,
): Promise<boolean> {
	const client = await connectTo(terminal, run.project, true);
	const asks: Asks = (sent) => client.request(sent);

	try {
		if (answer === undefined) return await isOpen(asks, ask);

		await answerOpen(asks, run.id, ask, answer);

		return false;
	} finally {
		client.close();
	}
}

/** Whether the ask `ask` is open. An `input` call without an ask has no open ask. */
async function isOpen(asks: Asks, ask: number | undefined): Promise<boolean> {
	return ask !== undefined && (await readAsk(asks, ask)).state === "open";
}

/**
 * Answers the open ask `ask` of the run `id` with `answer`, as the run. It refuses an ask that is not open, and an
 * `input` call without an ask: the run reads the answer that the ask has.
 */
async function answerOpen(asks: Asks, id: string, ask: number | undefined, answer: string): Promise<void> {
	const read = ask === undefined ? undefined : await readAsk(asks, ask);

	if (read?.state !== "open") {
		const state = read === undefined ? "its input has no ask" : `ask ${read.id} is ${read.state}`;
		throw new Error(`run ${id}: ${state}; continue with: workflows resume ${id}`);
	}

	await answerAsk(asks, id, read.id, answer);
}
