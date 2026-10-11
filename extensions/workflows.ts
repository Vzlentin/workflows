/**
 * The Pi extension: the `workflow` tool and the `/workflows` command. Each run is a child process of this package's
 * `workflows` command, so a run started in Pi is a normal run that `workflows resume` also continues.
 */
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type { JsonValue } from "@earendil-works/chord";
import { Type } from "@earendil-works/pi-ai";
import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";

type WorkflowCall = {
	readonly name?: string;
	readonly script?: string;
	readonly resume?: string;
	readonly args?: Readonly<Record<string, unknown>>;
};

/** The stdout line of `workflows --json` after `run <run-id>`. */
type WorkflowOutcome =
	| { readonly runId: string; readonly status: "finished"; readonly result: JsonValue }
	| { readonly runId: string; readonly status: "failed"; readonly error: string }
	| { readonly runId: string; readonly status: "interrupted" };

const CLI = [process.execPath, fileURLToPath(new URL("../src/cli.ts", import.meta.url))];

const text = (value: unknown) => (typeof value === "string" ? value : JSON.stringify(value));

/** The `workflows` arguments of a tool call, always with `--json`. */
function cliArgs({ name, script, resume, args = {} }: WorkflowCall): string[] {
	const given = [name, script, resume].filter((value) => value !== undefined).length;
	if (given !== 1) throw new Error("give exactly one of name, script or resume");
	if (resume !== undefined) return ["resume", resume, "--json"];
	if (name === "ship") {
		// `ship` rejects a flag it does not know, so a mistyped arg fails before a run exists.
		const { item, ...flags } = args;
		const options = Object.entries(flags).map(([key, value]) => `--${key}=${text(value)}`);
		return ["ship", ...options, "--json", ...(item === undefined ? [] : ["--", text(item)])];
	}
	const pairs = Object.entries(args).map(([key, value]) => `--arg=${key}=${text(value)}`);
	return ["run", name ?? "-", ...pairs, "--json"];
}

type Output = { readonly code: number | null; readonly stdout: readonly string[]; readonly stderr: readonly string[] };

/** Runs `command` with `args` in `cwd`; each stderr line goes to `progress`, and `signal` sends SIGINT. */
async function runCli(
	command: readonly string[],
	args: readonly string[],
	cwd: string,
	options: { stdin?: string | undefined; signal?: AbortSignal | undefined; progress?: (line: string) => void },
): Promise<Output> {
	const [program = "", ...prefix] = command;
	const child = spawn(program, [...prefix, ...args], { cwd, stdio: ["pipe", "pipe", "pipe"] });
	child.stdin.on("error", () => {});
	const stdout: string[] = [];
	const stderr: string[] = [];
	const out = createInterface({ input: child.stdout });
	const err = createInterface({ input: child.stderr });
	out.on("line", (line) => stdout.push(line));
	err.on("line", (line) => {
		stderr.push(line);
		options.progress?.(line);
	});
	const interrupt = () => child.kill("SIGINT");
	options.signal?.addEventListener("abort", interrupt, { once: true });
	try {
		child.stdin.end(options.stdin ?? "");
		const [[code]] = await Promise.all([once(child, "close"), once(out, "close"), once(err, "close")]);
		return { code: code as number | null, stdout, stderr };
	} finally {
		options.signal?.removeEventListener("abort", interrupt);
	}
}

/** The outcome line after `run <run-id>`; throws the stderr text when the command stopped without one. */
function outcomeOf(output: Output): WorkflowOutcome {
	const [, line] = output.stdout;
	if (line === undefined) throw new Error(output.stderr.join("\n") || `workflows exited with ${output.code}`);
	return JSON.parse(line) as WorkflowOutcome;
}

function summary(outcome: WorkflowOutcome): string {
	switch (outcome.status) {
		case "finished":
			return `run ${outcome.runId} finished: ${JSON.stringify(outcome.result)}`;
		case "failed":
			return `run ${outcome.runId} failed: ${outcome.error}; continue it with resume: "${outcome.runId}"`;
		case "interrupted":
			return `run ${outcome.runId} interrupted; continue it with resume: "${outcome.runId}"`;
	}
}

function resultOf(outcome: WorkflowOutcome): AgentToolResult<undefined> {
	return {
		content: [{ type: "text", text: summary(outcome) }],
		details: undefined,
		structuredContent: outcome,
		...(outcome.status === "finished" ? {} : { isError: true }),
	};
}

export default function workflows(pi: ExtensionAPI, command: readonly string[] = CLI) {
	pi.registerTool({
		name: "workflow",
		label: "Workflow",
		description:
			"Run a durable workflow and wait for its result. Give exactly one of: `name` (`ship`, or a saved workflow script), " +
			"`script` (the body of an inline workflow script), or `resume` (a run ID). `args` are the workflow's arguments; " +
			"for `ship`: `item` (the work item), and optional `repo`, `base` and `rounds`. A failed or interrupted run stays " +
			"resumable.",
		parameters: Type.Object({
			name: Type.Optional(Type.String({ description: "`ship`, or the name of a workflow script" })),
			script: Type.Optional(Type.String({ description: "An inline workflow script" })),
			resume: Type.Optional(Type.String({ description: "The ID of a run to continue" })),
			args: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
		}),
		outputSchema: Type.Object({
			runId: Type.String(),
			status: Type.Union([Type.Literal("finished"), Type.Literal("failed"), Type.Literal("interrupted")]),
			result: Type.Optional(Type.Unknown()),
			error: Type.Optional(Type.String()),
		}),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const output = await runCli(command, cliArgs(params), ctx.cwd, {
				stdin: params.script,
				signal,
				progress: (line) => onUpdate?.({ content: [{ type: "text", text: line }], details: undefined }),
			});
			return resultOf(outcomeOf(output));
		},
	});

	pi.registerCommand("workflows", {
		description: "List the workflow runs, or ask the agent to continue one with: resume <run-id>",
		handler: async (args, ctx) => {
			const send = (content: string) => pi.sendMessage({ customType: "workflows", content, display: true });
			const [verb, id, ...rest] = args.trim().split(/\s+/).filter(Boolean);
			try {
				if (verb === undefined) {
					const output = await runCli(command, ["list"], ctx.cwd, {});
					if (output.code !== 0) throw new Error(output.stderr.join("\n"));
					send(output.stdout.join("\n") || "no runs");
				} else if (verb === "resume" && id !== undefined && rest.length === 0) {
					// A tool call, so that Esc and the progress updates work as for any other run.
					const message = `Continue the workflow run ${id} with the workflow tool: resume: "${id}".`;
					pi.sendUserMessage(message, ctx.isIdle() ? undefined : { deliverAs: "followUp" });
				} else {
					send("usage: /workflows [resume <run-id>]");
				}
			} catch (error) {
				send(error instanceof Error ? error.message : String(error));
			}
		},
	});
}
