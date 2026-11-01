/** `workflows resume <run-id>` and `workflows wait <run-id>`: continue or follow a run. */
import { isDeepStrictEqual, parseArgs } from "node:util";
import type { Client } from "@vzlentin/harness/client";
import type { ScriptInput } from "../../launch/input.ts";
import { callRecords, reading } from "../../records/store.ts";
import { hasEnded, hasResult, runStatus, taskOf } from "../../run/past.ts";
import { UsageError, withUsage } from "../../workflow/find.ts";
import { type Following, follow, outcomeOf, reportOutcome } from "../follow.ts";
import { checkVersion, connectTo, startTask } from "../host.ts";
import type { Terminal } from "../main.ts";
import { checked, inputOf, keysOf, oneRunId, progressOf, type SavedRun, savedRun, tasksOf } from "../saved.ts";
import { programStatus } from "../terminal/redraw.ts";

export const RESUME = "workflows resume <run-id> [--answer <text>] [--background] [--json]";
export const WAIT = "workflows wait <run-id> [--json]";

/**
 * Continues the run of `args`. A finished run prints its result. A run whose last task ended without a result continues
 * in a new task with the same input, and shows the progress from its start. A run that waits for an answer continues
 * in a new task with the answer of `--answer` to its open `input` call. A run whose last task did not end is
 * followed: with its host running, from the start of the task's current execution, else from when the host starts.
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
	const task = checked(taskOf(await tasksOf(run)), run.id, wait ? "be waited for" : "resume");
	const { input: last } = task;
	const status = runStatus(task);
	const waiting = status === "waiting";
	const ended = hasEnded(status);

	if (answer !== undefined && !waiting) throw new UsageError(`run ${run.id} does not wait for an answer`, RESUME);

	if (waiting && answer === undefined && !wait && !json && !background && terminal.readLine !== undefined) {
		terminal.stdout(`run ${run.id}`);
		reportOutcome(last, run.id, task, terminal, json, await progressOf(run), true);

		return answering(run.id, terminal);
	}

	if (ended && answer === undefined && (wait || hasResult(status))) {
		terminal.stdout(`run ${run.id}`);

		return outcomeOf(last, run.id, task, terminal, json, await progressOf(run));
	}

	const input = answer === undefined ? last : { ...last, answer: { call: await openInput(run), text: answer } };
	const keys = await keysOf(run);
	const key = ended ? keys.next : keys.keyOf(task);

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
	const text = await terminal.readLine?.();

	if (text === undefined) {
		const line = `run ${id} waits for an answer; continue with: workflows resume ${id} --answer <text>`;
		terminal.stderr(line);
		terminal.status?.(programStatus("idle", line));

		return 130;
	}

	return resume([id, `--answer=${text}`], terminal, false, false);
}

/** The run ID and the `--answer` of the args of `resume`. */
function resumeArgs(args: readonly string[]) {
	const { values, positionals } = withUsage(
		() => parseArgs({ args: [...args], options: { answer: { type: "string" } }, allowPositionals: true, strict: true }),
		RESUME,
	);

	return { id: oneRunId(positionals, RESUME), answer: values.answer };
}

/** The document key of the `input` call that the run waits for an answer to: the last one that started and did not end. */
async function openInput(run: SavedRun): Promise<string> {
	const records = await reading(run.store, new Map(), (store) => callRecords(store, run.id));

	const open = [...records]
		.filter(([key, record]) => key.startsWith(`${run.id}/`) && record.kind === "input" && record.endedAt === undefined)
		.sort(([, a], [, b]) => a.startedAt.localeCompare(b.startedAt));

	const [key] = open.at(-1) ?? [];

	if (key === undefined) throw new Error(`run ${run.id} has no open input call`);

	return key;
}
