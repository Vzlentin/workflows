import { existsSync } from "node:fs";
import { chmod, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord/json";
import { createRegistry, defineDoc, Harness, ROOT_CONVERSATION_ID, type TaskId } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { request } from "@vzlentin/harness/client";
import { StartedTasks } from "@vzlentin/harness/tasks";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { TASK } from "../src/run/version.ts";
import { catchUps, hostModel, piSettings, sandbox, startHost, storeOf, tellAgent, workflows } from "./support.ts";

/** The `harness.seen` document of the project agent, version 2, as harness writes it. */
const Seen = defineDoc<{ mainSha: string | null; catchups: number; hooks: Record<string, JsonValue> }>({
	kind: "harness.seen",
	version: 2,
	scope: "conversation",
	history: "latest",
	checkpointWhen: () => false,
	fork: "initial",
	initial: () => ({ mainSha: null, catchups: 0, hooks: {} }),
});

let root: string;

beforeEach(async () => {
	root = await sandbox();
	await piSettings(root, [], { defaultProvider: "anthropic", defaultModel: "claude-haiku-5" });
	// `./gate.sh <name>` waits until `<name>.open` exists, after it creates `<name>.reached`.
	await writeFile(
		join(root, "gate.sh"),
		'#!/bin/sh\ntouch "$1.reached"\nwhile [ ! -f "$1.open" ]; do [ -d "$PWD" ] || exit 1; sleep 0.02; done\n',
	);
	await chmod(join(root, "gate.sh"), 0o755);
});

afterEach(() => rm(root, { recursive: true, force: true }));

async function reached(name: string): Promise<void> {
	while (!existsSync(join(root, `${name}.reached`))) await new Promise((resolve) => setTimeout(resolve, 10));
}

/** Opens the `main` store with no host, and gives what `use` gives of it. */
async function withStore<T>(use: (harness: Harness) => Promise<T>): Promise<T> {
	const storage = await openNodeSqliteStorage(storeOf());
	const options = { models: hostModel().models, registry: createRegistry() };
	const harness = await Harness.open(storage, options, BACKGROUND_CONTEXT);

	try {
		return await use(harness);
	} finally {
		await harness.close(BACKGROUND_CONTEXT);
	}
}

/** What the `workflows.runs` hook said the project agent saw, in the `main` store. */
function seenRuns(): Promise<JsonValue | undefined> {
	return withStore(
		async (harness) =>
			(await harness.snapshot(Seen, ROOT_CONVERSATION_ID, BACKGROUND_CONTEXT))?.hooks["workflows.runs"],
	);
}

describe("the catch-up of workflows runs", () => {
	it("tells the project agent once about each run that ended, with its sessions", async () => {
		const host = await startHost("main", hostModel().models);

		try {
			await tellAgent("Script: First");
			await writeFile(
				join(root, "a.js"),
				'export const meta = { exit: { finished: 0 } }\nawait agent("Script: one")\nreturn { status: "finished", subject: "Add the parser", head: "abc1234", divergence: "none", lessons: ["Keep it small"] }',
			);
			const a = await workflows(["a.js"], { cwd: root, host });
			expect(a.code).toBe(0);
			await writeFile(
				join(root, "b.js"),
				'await agent("Script: one", { as: "planner" })\nawait session({ as: "reviewer" }).ask("Script: two")\nawait sh("./gate.sh g")\nreturn { subject: "Fix the lexer" }',
			);
			const pending = workflows(["b.js"], { cwd: root, host });
			await reached("g");

			await tellAgent("Script: Second");
			const [second, ...none] = await catchUps();
			expect(none).toEqual([]);
			const [, aConversation] = /sessions: \[run \S+: default #(\d+)\]/.exec(second?.text ?? "") ?? [];
			expect(second?.text).toBe(
				[
					"Catch-up since your last input.",
					"Workflow runs that ended:",
					`- ${a.id} (a): finished; subject: Add the parser; branch: abc1234; divergence: none; lessons: ["Keep it small"]; sessions: [run ${a.id}: default #${aConversation}]`,
				].join("\n"),
			);

			await writeFile(join(root, "g.open"), "");
			const b = await pending;
			expect(b.code).toBe(0);
			await tellAgent("Script: Third");
			const [, third, ...more] = await catchUps();
			expect(more).toEqual([]);
			const [, planner, reviewer] = /\[run \S+: planner #(\d+), reviewer #(\d+)\]/.exec(third?.text ?? "") ?? [];
			expect(third).toEqual({
				text: [
					"Catch-up since your last input.",
					"Workflow runs that ended:",
					`- ${b.id} (b): completed; subject: Fix the lexer; sessions: [run ${b.id}: planner #${planner}, reviewer #${reviewer}]`,
				].join("\n"),
				data: {
					hooks: {
						"workflows.runs": {
							runs: [
								{
									task: expect.any(Number),
									runId: b.id,
									workflow: "b",
									status: "completed",
									subject: "Fix the lexer",
									sessions: [
										{ run: b.id, conversation: Number(planner), key: expect.stringMatching(/^wf:/), label: "planner" },
										{
											run: b.id,
											conversation: Number(reviewer),
											key: expect.stringMatching(/^wf:/),
											label: "reviewer",
										},
									],
								},
							],
						},
					},
				},
			});

			await tellAgent("Script: Fourth");
			expect(await catchUps()).toHaveLength(2);
		} finally {
			await host.close();
		}

		expect(await seenRuns()).toEqual({ lastTaskId: expect.any(Number), pending: [] });
	});

	it("tells the project agent about a run whose record is gone and a run whose input is not a run input", async () => {
		let host = await startHost("main", hostModel().models);
		let bad = 0;

		try {
			await tellAgent("Script: First");
			const key = "wf:run-bad#1";
			const input = { runId: "run-bad", name: 42 };
			await request({ type: "start", kind: TASK.name, version: TASK.version, input, key }, { start: false });
			await request({ type: "wait-task", key }, { start: false });
		} finally {
			await host.close();
		}

		await withStore((harness) =>
			harness.commit(async (tx) => {
				const started = await tx.doc(StartedTasks);
				bad = started.tasks["wf:run-bad#1"] ?? 0;
				// SAFETY: 999 is a task ID that the store does not have, which is the case under test.
				started.tasks.gone = 999 as TaskId<JsonValue>;
				const seen = await tx.doc(Seen, ROOT_CONVERSATION_ID);
				seen.hooks = { ...seen.hooks, "workflows.runs": { lastTaskId: 0, pending: [999] } };
			}, BACKGROUND_CONTEXT),
		);

		host = await startHost("main", hostModel().models);

		try {
			await tellAgent("Script: Second");
		} finally {
			await host.close();
		}

		expect((await catchUps()).map(({ data }) => data)).toEqual([
			{
				hooks: {
					"workflows.runs": {
						runs: [],
						lost: [
							{ task: bad, reason: "its input is not a workflows run input" },
							{ task: 999, reason: "its task record is gone" },
						],
					},
				},
			},
		]);
		expect(await seenRuns()).toEqual({ lastTaskId: 999, pending: [] });
	});
});
