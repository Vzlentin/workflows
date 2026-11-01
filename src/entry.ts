/**
 * The entry of workflows in the harness host. The host of a project loads it, from harness's `entries.json`, and starts its script task for
 * `workflows <wf>`, so a run executes in the host, with its sessions on the host's children library. It also gives the
 * conversations of the host the `workflow` tool, which runs the `workflows` command of this package as a child process.
 */
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type { Context } from "@earendil-works/chord";
import { defineExtension, defineTool, type ToolExecutionApi } from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { TOOL_EXTENSION } from "./run/sessions.ts";
import { OUTCOME, outcomeText, scriptTask, type WorkflowOutcome } from "./run/task.ts";
import type { Host } from "./run/version.ts";

const SAVE = Type.Object(
	{
		runId: Type.String(),
		name: Type.String({ description: "Lowercase letters, digits and -" }),
		force: Type.Optional(Type.Boolean({ description: "Replace a workflow of that name" })),
	},
	{ description: "Writes the script of the run to .workflows/scripts/<name>.js of the project" },
);

const PARAMETERS = Type.Object({
	name: Type.Optional(Type.String({ description: "`ship`, `campaign`, `optimize`, or the name of a workflow script" })),
	script: Type.Optional(Type.String({ description: "An inline workflow script" })),
	resume: Type.Optional(Type.String({ description: "The ID of a run to continue" })),
	answer: Type.Optional(Type.String({ description: "With `resume`: the answer to the question of a waiting run" })),
	save: Type.Optional(SAVE),
	args: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
	background: Type.Optional(
		Type.Boolean({
			description:
				"With `name`, `script` or `resume`: start the run and return at once; its result comes as a message in this conversation",
		}),
	),
});

type WorkflowCall = Static<typeof PARAMETERS>;

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

/** The `workflows` command of this package, with the Node of the host: `dist/cli.js`, or `src/cli.ts` in a checkout. */
const CLI = [
	process.execPath,
	fileURLToPath(new URL(import.meta.url.endsWith(".ts") ? "./cli.ts" : "./cli.js", import.meta.url)),
];

/**
 * The `workflows` arguments of a tool call, with each arg as a flag, and `--json` for a run. The command rejects a flag
 * it does not know, so a mistyped arg fails before a run exists.
 */
function cliArgs({ name, script, resume, answer, save, args = {}, background }: WorkflowCall): string[] {
	const given = [name, script, resume, save].filter((value) => value !== undefined).length;

	if (given !== 1) throw new Error("give exactly one of name, script, resume or save");

	if (answer !== undefined && resume === undefined) throw new Error("answer works only with resume");

	if (background && save !== undefined) throw new Error("background works only with name, script or resume");
	const json = background ? ["--background", "--json"] : ["--json"];

	if (resume !== undefined) return ["resume", resume, ...(answer === undefined ? [] : [`--answer=${answer}`]), ...json];

	if (save !== undefined) return ["save", save.runId, save.name, ...(save.force ? ["--force"] : [])];

	const flags = Object.entries(args).flatMap(([key, flag]) => {
		if (flag === false) return [];

		if (flag === true) return [`--${key}`];

		return [`--${key}=${Value.Check(Type.String(), flag) ? flag : JSON.stringify(flag)}`];
	});

	return [name ?? "-", ...flags, ...json];
}

type Output = { readonly code: number | null; readonly stdout: readonly string[]; readonly stderr: readonly string[] };

/**
 * Runs the command with `args` in `cwd` and `env`; each stdout line goes to `stdout` and each stderr line to `stderr`,
 * and `signal` sends SIGINT, which detaches.
 */
async function runCli(
	args: readonly string[],
	cwd: string,
	options: {
		readonly env: NodeJS.ProcessEnv;
		readonly stdin: string | undefined;
		readonly signal: AbortSignal | undefined;
		readonly stdout: (line: string) => void;
		readonly stderr: (line: string) => void;
	},
): Promise<Output> {
	const [program = "", ...prefix] = CLI;
	const child = spawn(program, [...prefix, ...args], { cwd, env: options.env, stdio: ["pipe", "pipe", "pipe"] });
	child.stdin.on("error", () => {});
	const stdout: string[] = [];
	const stderr: string[] = [];
	const out = createInterface({ input: child.stdout });
	const err = createInterface({ input: child.stderr });
	out.on("line", (line) => {
		stdout.push(line);
		options.stdout(line);
	});
	err.on("line", (line) => {
		stderr.push(line);
		options.stderr(line);
	});
	const interrupt = () => child.kill("SIGINT");
	options.signal?.addEventListener("abort", interrupt, { once: true });

	try {
		child.stdin.end(options.stdin ?? "");
		await Promise.all([once(child, "close"), once(out, "close"), once(err, "close")]);

		return { code: child.exitCode, stdout, stderr };
	} finally {
		options.signal?.removeEventListener("abort", interrupt);
	}
}

/** The outcome line after `run <run-id>`; throws the stderr text when the command stopped without one. */
function outcomeOf(output: Output): WorkflowOutcome {
	const [, line] = output.stdout;

	if (line === undefined) throw new Error(output.stderr.join("\n") || `workflows exited with ${output.code}`);
	const outcome = JSON.parse(line);

	if (!Value.Check(OUTCOME, outcome)) throw new Error(`workflows printed an outcome that is not valid: ${line}`);

	return outcome;
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
 * sessions of a new run go under it. A subagent at its depth limit is refused, as the sessions would be deeper.
 */
async function runTool(host: Host, params: WorkflowCall, api: ToolExecutionApi<WorkflowDetails>, context: Context) {
	const lineage = await host.children.lineage(host.place.store, String(api.conversationId), context);

	if (lineage !== undefined && lineage.depth >= lineage.limit) {
		throw new Error(
			`a subagent at depth ${lineage.depth} cannot use workflow: the sessions of a run would be deeper than the depth limit ${lineage.limit}`,
		);
	}

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
		const file = output.stdout.at(-1);

		if (output.code !== 0 || file === undefined) {
			throw new Error(output.stderr.join("\n") || `workflows exited with ${output.code}`);
		}

		const { runId } = params.save;
		const text = `saved the script of run ${runId} as ${file}`;

		return {
			output: [{ type: "text" as const, text }],
			structuredOutput: { runId, status: "finished", result: { file }, report: [file] },
		};
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
		description:
			"Run a durable workflow and wait for its result. Give exactly one of: `name` (a workflow script such as " +
			"`ship`, `campaign` or `optimize`), `script` (the body of an inline workflow script), `resume` (a run " +
			"ID), or `save` (keeps the script of a run as a named workflow of the project). `args` are the arguments of " +
			"`name` or `script`, each passed as `--<key>`; a script's `meta` declares them. For " +
			"`ship`: `item` (the work item), and optional `repo`, `base`, `rounds` and `prompts`. For `campaign`, which " +
			"splits a goal into work items and ships each one as a commit on one branch: `goal`, and optional `repo`, " +
			"`base`, `rounds` and `prompts`. For `optimize`, which proposes edits to the ship prompts, profiles, skills " +
			"and `AGENTS.md` from past ship runs and keeps them when a blind judge prefers their diffs: `workflow` " +
			"(`ship`), and optional `runs`, `limit`, `items` and `always-on-max` (the most characters of `AGENTS.md`). " +
			"Each `run()` call of a " +
			"script starts a child run, which a resume of its caller continues. A run goes on in the harness host of the " +
			"project: Esc detaches from it, and `resume` follows it again. A failed or stopped run stays resumable. With " +
			"`background: true`, the call returns at once and the result of the run comes later as a message in this " +
			"conversation: use it for long runs such as `campaign` or `optimize`, or for work that can go on while the " +
			"conversation continues. `input(question)` stops the run, and the tool gives a `waiting` result with the " +
			"question; answer it with `workflow` `resume: <run-id>` and `answer`, and `input` then returns the answer.",
		parameters: PARAMETERS,
		structuredOutputSchema: Type.Object({
			runId: Type.String(),
			status: Type.Union([
				Type.Literal("finished"),
				Type.Literal("started"),
				Type.Literal("failed"),
				Type.Literal("detached"),
				Type.Literal("stopped"),
				Type.Literal("host-stopped"),
			]),
			result: Type.Optional(Type.Unknown()),
			report: Type.Optional(Type.Array(Type.String())),
			error: Type.Optional(Type.String()),
			workflow: Type.Optional(Type.String()),
		}),
		// A call that a restart interrupted does not run again, so it cannot start a second run.
		replay: "unsafe",
		execute: (params, api, context) => runTool(host, params, api, context),
	});

	return defineExtension({ name: TOOL_EXTENSION, tools: [tool] });
}

export default function workflowsEntry(host: Host) {
	return { extensions: [workflowExtension(host)], tasks: [scriptTask(host)], close: async () => {} };
}
