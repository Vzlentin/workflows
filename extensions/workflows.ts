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

type WorkflowOutcome = {
	readonly runId: string;
	readonly status: "finished" | "failed" | "interrupted";
	readonly result?: JsonValue;
	readonly error?: string;
};

const CLI = [process.execPath, fileURLToPath(new URL("../dist/cli.js", import.meta.url))];

const text = (value: unknown) => (typeof value === "string" ? value : JSON.stringify(value));

/** The `workflows` arguments of a tool call, always with `--json`. */
function cliArgs(call: WorkflowCall): string[] {
	const given = [call.name, call.script, call.resume].filter((value) => value !== undefined);
	if (given.length !== 1) throw new Error("give exactly one of name, script or resume");
	const args = call.args ?? {};
	const pairs = Object.entries(args).map(([key, value]) => `--arg=${key}=${text(value)}`);
	if (call.resume !== undefined) return ["resume", call.resume, "--json"];
	if (call.script !== undefined) return ["run", "-", ...pairs, "--json"];
	if (call.name === "ship") {
		const flags = (["repo", "base", "rounds"] as const).flatMap((key) =>
			args[key] === undefined ? [] : [`--${key}`, text(args[key])],
		);
		const item = args.item === undefined ? [] : ["--", text(args.item)];
		return ["ship", ...flags, "--json", ...item];
	}
	return ["run", ...given, ...pairs, "--json"];
}

type Output = { readonly code: number | null; readonly stdout: readonly string[]; readonly stderr: readonly string[] };

/** Runs `command` with `args` in `cwd`; each stderr line goes to `progress`, and `signal` sends SIGINT. */
async function runCli(
	command: readonly string[],
	args: readonly string[],
	cwd: string,
	options: { stdin?: string; signal?: AbortSignal | undefined; progress?: (line: string) => void },
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

/** The outcome of a run's output; throws when the command failed before a run existed. */
function outcomeOf(output: Output): WorkflowOutcome {
	const runId = output.stdout[0]?.match(/^run (\S+)$/)?.[1];
	if (runId === undefined) throw new Error(output.stderr.join("\n") || `workflows exited with ${output.code}`);
	const line = output.stdout[1];
	if (line !== undefined) return { runId, status: "finished", result: JSON.parse(line) as JsonValue };
	if (output.code === 130) return { runId, status: "interrupted" };
	const error = output.stderr.findLast((candidate) => !candidate.startsWith("continue with:"));
	return { runId, status: "failed", ...(error === undefined ? {} : { error }) };
}

function summary(outcome: WorkflowOutcome): string {
	switch (outcome.status) {
		case "finished":
			return `run ${outcome.runId} finished: ${JSON.stringify(outcome.result)}`;
		case "failed":
			return `run ${outcome.runId} failed: ${outcome.error ?? "unknown error"}; continue it with resume: "${outcome.runId}"`;
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
	const start = (call: WorkflowCall, cwd: string, signal: AbortSignal | undefined, progress: (line: string) => void) =>
		runCli(command, cliArgs(call), cwd, {
			...(call.script === undefined ? {} : { stdin: call.script }),
			signal,
			progress,
		}).then(outcomeOf);

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
			const outcome = await start(params, ctx.cwd, signal, (line) =>
				onUpdate?.({ content: [{ type: "text", text: line }], details: undefined }),
			);
			return resultOf(outcome);
		},
	});

	pi.registerCommand("workflows", {
		description: "List the workflow runs, or continue one with: resume <run-id>",
		handler: async (args, ctx) => {
			const send = (content: string) => pi.sendMessage({ customType: "workflows", content, display: true });
			const [verb, id, ...rest] = args.trim().split(/\s+/).filter(Boolean);
			try {
				if (verb === undefined) {
					const output = await runCli(command, ["list"], ctx.cwd, {});
					if (output.code !== 0) throw new Error(output.stderr.join("\n"));
					send(output.stdout.join("\n") || "no runs");
				} else if (verb === "resume" && id !== undefined && rest.length === 0) {
					const outcome = await start({ resume: id }, ctx.cwd, ctx.signal, send);
					pi.sendMessage({ customType: "workflows", content: summary(outcome), display: true, details: outcome });
				} else {
					send("usage: /workflows [resume <run-id>]");
				}
			} catch (error) {
				send(error instanceof Error ? error.message : String(error));
			}
		},
	});
}
