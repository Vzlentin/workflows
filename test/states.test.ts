import type { JsonValue } from "@earendil-works/chord/json";
import type { TaskOutcome } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vite-plus/test";
import { endedOutcome, outcomeFrom, runOutcome, runStatus } from "../src/run/past.ts";
import { TASK } from "../src/run/version.ts";
import { outcomeText } from "../src/tool.ts";

const input = { runId: "r1", name: "x", args: {}, meta: { args: {}, exit: { rejected: 1 } } };

/** Task outcomes that give each state of a run that ended: done, waiting, failed, aborted and orphaned. */
const ENDS: readonly TaskOutcome<JsonValue>[] = [
	{ status: "completed", result: { status: "shipped" } },
	{ status: "completed", result: { status: "rejected" } },
	{ status: "completed", result: { status: "failed" } },
	{ status: "completed", result: { status: "waiting", question: "which one?" } },
	{ status: "failed", error: { message: "boom" } },
	{ status: "faulted", error: { message: "crash" } },
	{ status: "aborted" },
	{ status: "orphaned", reason: "no handler" },
];

describe("the state of a run in each output", () => {
	it.each(ENDS)("is the state of runStatus for a task that ended $status", (outcome) => {
		const task = { kind: TASK.name, version: TASK.version, outcome };
		const state = runStatus(task);
		// The JSON outcome of a command that follows or resumes the run, and the outcome that a background run posts.
		const followed = runOutcome(input, task);
		const posted = outcomeFrom(input, outcome);

		expect([followed.state, posted.state]).toEqual([state, state]);

		// The `workflow` tool text names the state, except for a run that waits, which gives its question.
		if (state !== "waiting") expect(outcomeText(followed)).toMatch(new RegExp(`^run r1 ${state}\\b`));

		// The JSON of `workflows stop`, for a task that ended without a result.
		if (outcome.status !== "completed") expect(endedOutcome(input.runId, outcome).state).toBe(state);
	});
});
