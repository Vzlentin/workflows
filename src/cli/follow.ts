/** How the command line follows a run to its outcome, and the Ctrl+C presses of the command line. */

import { join } from "node:path";
import type { JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Client } from "@vzlentin/harness/client";
import { statePaths, type TaskInfo } from "@vzlentin/harness/protocol";
import type { ScriptInput } from "../launch/input.ts";
import { endMark } from "../records/steps.ts";
import { openReadOnly, progressEvents } from "../records/store.ts";
import { hasEnded, hasResult, type RunTask, runStatus, type TaskEnd, taskOutcome } from "../run/past.ts";
import type { ProgressEvent } from "../run/progress.ts";
import { reportOf, title as titleOf } from "../run/result.ts";
import type { OutcomeStatus } from "../tool.ts";
import { abortRun, hostStopped, STORE_FILE } from "./host.ts";
import type { Terminal } from "./main.ts";
import { display, programStatus } from "./terminal/redraw.ts";

/** How often the command reads the progress of a run that it follows. */
const POLL_MS = 500;

/** How long a command that Ctrl+C detached waits for a second Ctrl+C, which stops the run. */
const STOP_WINDOW_MS = 2000;

/**
 * The Ctrl+C presses of a command. The first detaches the command from its run. A second one stops the run while the
 * command follows a run, also before the command waits for it. Any other press calls `exit`.
 */
export class CtrlC {
	readonly #interrupt = new AbortController();
	readonly #stop = new AbortController();
	readonly #exit: () => void;
	#presses = 0;
	#following = false;

	constructor(exit: () => void) {
		this.#exit = exit;
	}

	/** Aborted by the first press. */
	get interrupt(): AbortSignal {
		return this.#interrupt.signal;
	}

	/** Aborted by a second press while the command follows a run. */
	get stop(): AbortSignal {
		return this.#stop.signal;
	}

	/** Whether the command follows a run, so that a second press stops it. */
	following(active: boolean): void {
		this.#following = active;
	}

	press(): void {
		this.#presses++;

		if (this.#presses === 1) this.#interrupt.abort();
		else if (this.#presses === 2 && this.#following) this.#stop.abort();
		else this.#exit();
	}
}

/**
 * How a run that ended without a result ends: its footer lines, the error that `show` prints, the fields of its JSON
 * outcome line, and its exit code.
 */
type Ended = {
	readonly lines: string[];
	readonly error?: string;
	readonly outcome: { readonly status: OutcomeStatus; readonly error?: string };
	readonly code: number;
};

/**
 * How the run `id` whose task is `task` ended, when it ended without a result. It throws for a run that has a result,
 * or has not ended. It reads the fields of the outcome, whose `failed` and `faulted` are the run status `failed`.
 */
export function endOf(task: RunTask | TaskEnd, title: string, id: string): Ended {
	const resume = `continue with: workflows resume ${id}`;
	const outcome = taskOutcome(task);

	switch (outcome?.status) {
		case "failed":
		case "faulted": {
			const error = outcome.error.message;

			return { lines: [`failed ${title}: ${error}`, resume], error, outcome: { status: "failed", error }, code: 1 };
		}

		case "orphaned": {
			const error = `the task was orphaned: ${outcome.reason}`;

			return { lines: [`orphaned ${title}: ${outcome.reason}`, resume], outcome: { status: "failed", error }, code: 1 };
		}

		case "aborted":
			return { lines: [`stopped ${title}; ${resume}`], outcome: { status: "stopped" }, code: 130 };
		case "completed":
		case undefined:
			throw new Error(`run ${id} did not end without a result`);
	}
}

/** Prints the report of the finished run `id` with `result`, or its JSON outcome line, and gives its exit code. */
function finished(input: ScriptInput, id: string, result: JsonValue, terminal: Terminal, json: boolean): number {
	const { lines, code } = reportOf(input, result);

	if (json) terminal.stdout(JSON.stringify({ runId: id, status: "finished", result, report: lines }));
	else for (const line of lines) terminal.stdout(line);

	return code;
}

/** True when `signal` aborts within `ms`. */
export function abortedWithin(signal: AbortSignal, ms: number): Promise<boolean> {
	if (signal.aborted) return Promise.resolve(true);

	return new Promise((resolve) => {
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", done);
			resolve(false);
		}, ms);

		const done = () => {
			clearTimeout(timer);
			resolve(true);
		};

		signal.addEventListener("abort", done, { once: true });
	});
}

/** Resolves when `signal` aborts. */
function aborted(signal: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal.aborted) resolve();
		else signal.addEventListener("abort", () => resolve(), { once: true });
	});
}

/** A run that the command follows: the task of `key` in the host of `client`, with the progress after `from`. */
export type Following = {
	readonly id: string;
	readonly project: string;
	readonly key: string;
	readonly input: ScriptInput;
	readonly client: Client;
	/** The number of progress events of the run before the ones that the command shows. */
	readonly from: number;
};

/** How a followed run ended: the exit code, and whether the run waits for an answer that this terminal reads. */
export type Followed = { readonly code: number; readonly asking: boolean };

/**
 * Shows the progress of the run until its task ends, and reports its outcome. Ctrl+C detaches and leaves the run to
 * the host; a second Ctrl+C, also one that came before the window, stops it. A host that stops leaves the run pending.
 * A run that waits for an answer that the terminal can read gives `asking`, after the client and the store close.
 */
export async function follow(
	run: Following,
	terminal: Terminal,
	json: boolean,
	background: boolean,
): Promise<Followed> {
	const { id, input, client } = run;

	if (background) {
		client.close();
		terminal.following(false);

		if (json) terminal.stdout(JSON.stringify({ runId: id, status: "started", workflow: input.name }));

		return { code: 0, asking: false };
	}

	terminal.following(true);
	const shown = display(terminal, json);

	const tell = (state: "idle" | "working" | "done" | "error", message: string) => {
		if (!json) terminal.status?.(programStatus(state, message));
	};

	// With `--json`, the outcome line replaces the footer lines on stderr, so each stderr line is a progress line.
	const end = (status: OutcomeStatus, rest: { error?: string }, ...footer: string[]) => {
		if (json) terminal.stdout(JSON.stringify({ runId: id, status, ...rest }));
		else for (const line of footer) terminal.stderr(line);
	};

	const opened = await openReadOnly(join(statePaths(run.project).dir, STORE_FILE)).catch((cause: unknown) => {
		client.close();
		terminal.following(false);
		throw cause;
	});

	const store = opened?.store;

	// The host only appends events (`addProgress` pushes and never trims), so `seen` counts the events shown.
	let seen = run.from;
	// Set from a failed read to the next good one, so that a series of failures prints one warning.
	let failing = false;

	/**
	 * The progress events of the run. A read that fails, such as one that waited too long for a lock, gives none, and
	 * the first failure of a series prints a warning; the next good read catches up.
	 */
	const read = async (): Promise<readonly ProgressEvent[]> => {
		if (store === undefined) return [];

		try {
			const events = await progressEvents(store, id);
			failing = false;

			return events;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);

			if (!failing) terminal.stderr(`warning: cannot read the progress of run ${id}: ${message}`);
			failing = true;

			return [];
		}
	};

	const poll = async () => {
		const events = await read();

		for (const event of events.slice(seen)) {
			shown.event(event);

			if (event.kind === "phase") tell("working", event.text);
		}

		seen = Math.max(seen, events.length);
	};

	const polled = new AbortController();

	const polling = (async () => {
		while (!polled.signal.aborted) {
			await poll();
			await abortedWithin(polled.signal, POLL_MS);
		}
	})();

	/** Stops the reads, then reads the events that came after the last one. */
	const stopPolling = async () => {
		polled.abort();
		await polling;
		await poll();
	};

	// Set by `report` when the command asks for the answer of a waiting run.
	let asking = false;
	const code = await watch();

	return { code, asking };

	async function watch(): Promise<number> {
		try {
			const waited = client.request({ type: "wait-task", key: run.key });
			// A detached command closes the connection, which ends the wait.
			waited.catch(() => undefined);
			const info = await Promise.race([waited, aborted(terminal.interrupt).then(() => undefined)]);

			if (info !== undefined) return await report(info);
			await stopPolling();
			const next = `Follow it with: workflows resume ${id}. Stop it with: workflows stop ${id}`;

			const line = `detached; run ${id} goes on. ${next}`;

			if (!json) terminal.stderr(line);
			tell("idle", line);

			// A run that ends in the window reports its outcome. A wait that fails leaves the run to the host.
			const ended = waited.then(
				(done) => ({ done }),
				() => new Promise<never>(() => {}),
			);

			const stopping = abortedWithin(terminal.stop, terminal.stopWindowMs ?? STOP_WINDOW_MS);
			const second = await Promise.race([stopping.then((stopped) => ({ stopped })), ended]);

			if ("done" in second) return await report(second.done);

			if (!second.stopped) {
				if (json) end("detached", {});

				return 130;
			}

			return await report(await abortRun(terminal, run.project, run.key));
		} catch (error) {
			await stopPolling();

			if (hostStopped(error)) {
				const line = `the host stopped; the run continues when it starts again: workflows resume ${id}`;
				end("host-stopped", {}, line);

				return 1;
			}

			shown.stop("✗");
			end("failed", { error: error instanceof Error ? error.message : String(error) });
			throw error;
		} finally {
			polled.abort();
			client.close();
			terminal.following(false);
			await store?.close(BACKGROUND_CONTEXT);
		}
	}

	async function report(info: TaskInfo | TaskEnd): Promise<number> {
		await stopPolling();
		const status = runStatus(info);

		shown.stop(endMark(status));

		if (info.outcome === undefined) throw new Error(`run ended ${status}`);

		const events = await read();
		asking = status === "waiting" && terminal.readLine !== undefined && !json && !terminal.interrupt.aborted;

		return reportOutcome(input, id, info, terminal, json, events, asking);
	}
}

/**
 * Prints the outcome of the run `id` as `outcomeOf` does, and gives its exit code. It sets the program status to the
 * first line that it prints, the message of the last report: blocked on a question when `asking`, else done or error.
 */
export function reportOutcome(
	input: ScriptInput,
	id: string,
	task: RunTask | TaskEnd,
	terminal: Terminal,
	json: boolean,
	events: readonly ProgressEvent[],
	asking: boolean,
): number {
	let first: string | undefined;

	const keep = (print: (line: string) => void) => (line: string) => {
		first ??= line;
		print(line);
	};

	const shownTo = { ...terminal, stdout: keep(terminal.stdout), stderr: keep(terminal.stderr) };
	const code = outcomeOf(input, id, task, shownTo, json, events);

	if (asking) terminal.status?.(programStatus("blocked", first ?? "", "question"));
	else if (!json) terminal.status?.(programStatus(code === 0 ? "done" : "error", first ?? ""));

	return code;
}

/**
 * Prints how the run `id` whose task is `task` ended: the report of a finished run, else the footer lines on stderr,
 * or one JSON outcome line. It gives the exit code.
 */
export function outcomeOf(
	input: ScriptInput,
	id: string,
	task: RunTask | TaskEnd,
	terminal: Terminal,
	json: boolean,
	events: readonly ProgressEvent[],
): number {
	const status = runStatus(task);

	if (hasResult(status)) return finished(input, id, taskOutcome(task)?.result ?? null, terminal, json);

	if (!hasEnded(status)) throw new Error(`run ${id} has not ended`);
	const ended = endOf(task, titleOf(input, events), id);

	if (json) terminal.stdout(JSON.stringify({ runId: id, ...ended.outcome }));
	else for (const line of ended.lines) terminal.stderr(line);

	return ended.code;
}
