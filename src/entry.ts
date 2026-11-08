/**
 * The entry of workflows in the harness host. The host of a project loads it, from harness's `entries.json`, and starts its script task for
 * `workflows <wf>`, so a run executes in the host, with its sessions on the host's children library. It also gives the
 * conversations of the host the `workflow` tool, which runs the `workflows` command of this package as a child process,
 * and the project agent the catch-up hook `workflows.runs`, which tells it about the runs that ended.
 */
import type { Context } from "@earendil-works/chord";
import { defineExtension, defineTool, type ToolExecutionApi } from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { runCli } from "./command.ts";
import { runsCatchUp } from "./run/catchup.ts";
import { TOOL_EXTENSION } from "./run/sessions.ts";
import { scriptTask } from "./run/task.ts";
import type { Host } from "./run/version.ts";
import {
	cliArgs,
	DESCRIPTION,
	OUTCOME,
	outcomeOf,
	outcomeText,
	PARAMETERS,
	savedOutcome,
	type WorkflowCall,
} from "./tool.ts";

/** The `details` of a call: the progress lines that the command drew last, then any other stderr line. */
type WorkflowDetails = { steps: string[] };

const PROGRESS = Type.Object({ progress: Type.Array(Type.Unknown()) });

/** The lines of a `{"progress":[...]}` stderr line of `workflows --json`, or undefined for any other line. */
function progressLines(line: string): string[] | undefined {
	if (!line.startsWith('{"progress":')) return undefined;

	try {
		const parsed = JSON.parse(line);

		return Value.Check(PROGRESS, parsed) ? parsed.progress.map(String) : undefined;
	} catch {
		return undefined;
	}
}

/** The project of the host, which the host gives only to the shell of each conversation. */
async function projectOf(env: ExecutionEnv, context: Context): Promise<string> {
	let printed = "";

	const result = await env.exec(
		["printenv", "HARNESS_PROJECT"],
		{
			onOutput: (text, _context, info) => {
				if (info.stream === "stdout") printed += text;
			},
		},
		context,
	);

	const project = printed.trim();

	if (!result.ok || result.value.exitCode !== 0 || project === "") {
		throw new Error("the shell of this conversation has no HARNESS_PROJECT");
	}

	return project;
}

/**
 * Runs the `workflow` call `params` of the conversation of `api`, with `PI_SESSION_ID` set to that conversation, so the
 * sessions of a new run go under it. A subagent at its depth limit is a leaf of the children library, which has no
 * `workflow` tool.
 */
async function runTool(host: Host, params: WorkflowCall, api: ToolExecutionApi<WorkflowDetails>, context: Context) {
	const { cwd } = await api.agent(context);

	if (api.env === undefined || cwd === undefined) throw new Error("the workflow tool needs a working directory");
	const args = cliArgs(params);

	const env = {
		...process.env,
		HARNESS_PROJECT: await projectOf(api.env, context),
		PI_SESSION_ID: String(api.conversationId),
	};

	let drawn: readonly string[] = [];
	const other: string[] = [];
	let named = false;
	let details = Promise.resolve();

	const output = await runCli(args, cwd, {
		env,
		stdin: params.script,
		signal: context.abortSignal,
		// The run ID comes first, so the result of an aborted or interrupted call, which keeps this output, names the run.
		stdout: (line) => {
			const id = /^run (\S+)$/.exec(line)?.[1];

			if (id === undefined || named) return;
			named = true;
			api.output(
				`run ${id}: if this call stops, the run is detached and goes on in the harness host; follow it with resume: "${id}"\n`,
			);
		},
		stderr: (line) => {
			const lines = progressLines(line);

			if (lines === undefined) other.push(line);
			else drawn = lines;
			const steps = [...drawn, ...other];
			details = details.then(() => api.details({ steps }, context));
			details.catch(() => {});
			api.output(`${lines === undefined ? line : (lines.at(-1)?.trim() ?? "")}\n`);
		},
	});

	await details;

	if (params.save !== undefined) {
		const { text, outcome } = savedOutcome(output, params.save.runId);

		return { output: [{ type: "text" as const, text }], structuredOutput: outcome };
	}

	const outcome = outcomeOf(output);
	const result = { output: [{ type: "text" as const, text: outcomeText(outcome) }], structuredOutput: outcome };

	// The result has no details, so the details of the last progress line stay.
	return outcome.status === "finished" || outcome.status === "started" ? result : { ...result, isError: true };
}

/** The `workflow` tool, in an extension that every conversation of the host selects, and that sessions remove. */
function workflowExtension(host: Host) {
	const tool = defineTool<typeof PARAMETERS, WorkflowDetails>({
		name: "workflow",
		description: DESCRIPTION,
		parameters: PARAMETERS,
		structuredOutputSchema: OUTCOME,
		// A call that a restart interrupted does not run again, so it cannot start a second run.
		replay: "unsafe",
		execute: (params, api, context) => runTool(host, params, api, context),
	});

	return defineExtension({ name: TOOL_EXTENSION, tools: [tool] });
}

export default function workflowsEntry(host: Host) {
	return {
		extensions: [workflowExtension(host)],
		tasks: [scriptTask(host)],
		catchUp: runsCatchUp(host),
		close: async () => {},
	};
}
