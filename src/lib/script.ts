/**
 * Workflow scripts. A script is JavaScript that runs in the pi-codemode sandbox inside one `workflow` tool call. Each
 * call it makes is a keyed nested call of that tool, so when the tool runs again after an interruption, the finished
 * calls return their saved results and only the rest runs. A script failure does not settle the `workflow` call: the
 * command stops, and a resume runs the same call again.
 *
 * A local runner model starts the root call: it answers the run's input with one `workflow` call, and the tool result
 * with its text.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import type { Context } from "@earendil-works/chord";
import {
	type AssistantMessage,
	type Message,
	type ModelThinkingLevel,
	type TextContent,
	type TSchema,
	Type,
	validateToolArguments,
} from "@earendil-works/pi-ai";
import type { Provider } from "@earendil-works/pi-ai/models";
import {
	type FauxResponseFactory,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { type CodemodeJsonSchema, CodemodeSandbox, type CodemodeTool } from "@earendil-works/pi-codemode";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import {
	type AgentChange,
	type ConversationId,
	configure,
	defineDoc,
	defineExtension,
	defineTool,
	type Extension,
	type JsonObject,
	type ModelRef,
	NestedCallDoc,
	type ToolExecutionApi,
} from "@earendil-works/pi-durable";
import { type AgentChoice, sessionAgent } from "./agents.ts";
import { instructions, render } from "./prompts.ts";
import { sessionOf, textOf } from "./workflow.ts";

/** An agent profile from `agents/<name>.md`. */
export type Profile = {
	readonly model: ModelRef;
	readonly thinkingLevel: ModelThinkingLevel;
	readonly instructions: string;
};

/** The package's scripts, prompt instructions and profiles, saved by a run before it starts. */
export type Bundle = {
	readonly scripts: Readonly<Record<string, string>>;
	readonly prompts: Readonly<Record<string, string>>;
	readonly agents: Readonly<Record<string, Profile>>;
};

/** The arguments of a `workflow` call: the script, its arguments, and the saved bundle that `run()` finds scripts in. */
export type WorkflowCall = Bundle & { readonly source: string; readonly args: JsonObject };

/** What the command gets from running scripts. */
export type ScriptHooks = {
	/** Writes one `phase` or `log` line. */
	log(line: string): void;
	/** A script failed; its `workflow` call stays unsettled until the store closes. */
	fail(message: string): void;
};

const PACKAGE = new URL("../../", import.meta.url);

/** `<folder>/*<extension>` of the package by name; a missing folder has none. */
async function readFolder(folder: string, extension: string): Promise<Record<string, string>> {
	const directory = new URL(`${folder}/`, PACKAGE);
	const files = (await readdir(directory).catch(() => [])).filter((file) => file.endsWith(extension)).sort();
	const entries = await Promise.all(
		files.map(async (file) => [file.slice(0, -extension.length), await readFile(new URL(file, directory), "utf8")]),
	);
	return Object.fromEntries(entries);
}

function profileOf(name: string, text: string): Profile {
	const { frontmatter, body } = parseFrontmatter<{ model?: string; thinking?: ModelThinkingLevel }>(text);
	const [provider = "", ...id] = (frontmatter.model ?? "").split("/");
	if (provider === "" || id.length === 0) throw new Error(`agents/${name}.md: model must be <provider>/<id>`);
	return {
		model: { provider, modelId: id.join("/") },
		thinkingLevel: frontmatter.thinking ?? "medium",
		instructions: instructions(body),
	};
}

/** The package's `workflows/*.js`, `prompts/*.md` and `agents/*.md`, read now. */
export async function loadBundle(): Promise<Bundle> {
	const [scripts, templates, profiles] = await Promise.all([
		readFolder("workflows", ".js"),
		readFolder("prompts", ".md"),
		readFolder("agents", ".md"),
	]);
	return {
		scripts,
		prompts: Object.fromEntries(Object.entries(templates).map(([name, text]) => [name, instructions(text)])),
		agents: Object.fromEntries(Object.entries(profiles).map(([name, text]) => [name, profileOf(name, text)])),
	};
}

const text = (value: string): TextContent[] => [{ type: "text", text: value }];

const SCRIPT = "workflows-script";

/** The JSON Schema of the current ask's answer, per conversation; absent when the ask has no `schema`. */
const AnswerDoc = defineDoc<{ schema?: JsonObject }>({
	kind: "workflows.answer-schema",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "current",
	initial: () => ({}),
});

const respond = defineTool({
	name: "respond",
	description: "Give the answer of this turn in the structured form the prompt asks for. This ends the turn.",
	parameters: Type.Object({ answer: Type.Unknown() }),
	callers: ["model"],
	execute: async (args, api, context) => {
		const schema = (await api.snapshot(AnswerDoc, api.conversationId, context))?.schema;
		if (schema === undefined) return { isError: true, output: text("This turn asks for no structured answer.") };
		const parameters = { type: "object", properties: { answer: schema }, required: ["answer"] } as unknown as TSchema;
		try {
			validateToolArguments(
				{ name: "respond", description: "", parameters },
				{ type: "toolCall", id: api.callId, name: "respond", arguments: args as JsonObject },
			);
		} catch (error) {
			return { isError: true, output: text(error instanceof Error ? error.message : String(error)) };
		}
		return { output: text("Answer recorded."), control: { terminate: true } };
	},
});

/** The `workflow` tool without its runtime, for agent changes that name it. */
const WORKFLOW = defineTool({
	name: "workflow",
	description: "Run a workflow script.",
	parameters: Type.Object({
		source: Type.String(),
		args: Type.Record(Type.String(), Type.Unknown()),
		scripts: Type.Record(Type.String(), Type.String()),
		prompts: Type.Record(Type.String(), Type.String()),
		agents: Type.Record(Type.String(), Type.Unknown()),
	}),
	replay: "safe",
	structuredOutputSchema: Type.Unknown(),
	outputLimits: { maxBytes: Number.MAX_SAFE_INTEGER, maxLines: Number.MAX_SAFE_INTEGER },
	execute: async () => {
		throw new Error("the workflow tool is not installed");
	},
});

const session = defineTool({
	name: "session",
	description: "Open a session of a workflow script.",
	parameters: Type.Object({ profile: Type.String(), agent: Type.Unknown() }),
	callers: ["tools"],
	replay: "safe",
	structuredOutputSchema: Type.Number(),
	execute: async (args, api, context) => {
		const { cwd = "." } = await api.agent(context);
		const profile = args.agent as Profile;
		const id = await api.commit(async (tx) => {
			const created = await tx.createConversation({ ownership: { kind: "ownerless" } });
			await configure(tx, created.id, {
				...sessionAgent(profile, cwd),
				...(profile.instructions === "" ? {} : { instructions: profile.instructions }),
				extensions: { add: [{ name: SCRIPT }] },
				modelTools: { remove: [WORKFLOW, respond] },
			});
			return created.id;
		}, context);
		return { output: text(String(id)), structuredOutput: id };
	},
});

const ask = defineTool({
	name: "ask",
	description: "One turn in a session of a workflow script.",
	parameters: Type.Object({
		conversation: Type.Number(),
		prompt: Type.String(),
		schema: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
	}),
	callers: ["tools"],
	replay: "safe",
	structuredOutputSchema: Type.Unknown(),
	execute: async (args, api, context) => {
		const conversation = args.conversation as ConversationId;
		const { schema } = args;
		await api.commit(async (tx) => {
			const doc = await tx.doc(AnswerDoc, conversation);
			if (schema === undefined) delete doc.schema;
			else doc.schema = schema as JsonObject;
			await configure(tx, conversation, {
				modelTools: { remove: schema === undefined ? [WORKFLOW, respond] : [WORKFLOW] },
			});
			return undefined;
		}, context);
		// The request ID is the nested call ID, so an interrupted ask continues its turn.
		const answer = await sessionOf(api, conversation, context).turn(api.callId, args.prompt);
		if (schema === undefined) {
			const reply = textOf(answer).trim();
			return { output: text(reply), structuredOutput: reply };
		}
		const call = answer.content.findLast((part) => part.type === "toolCall" && part.name === "respond");
		if (call?.type !== "toolCall") throw new Error("the answer did not call respond");
		const value = (call.arguments as { answer?: unknown }).answer ?? null;
		return { output: text(JSON.stringify(value)), structuredOutput: value as JsonObject };
	},
});

type ShellResult = { readonly code: number; readonly stdout: string; readonly stderr: string };

function shell(cmd: string, cwd: string, signal: AbortSignal | undefined): Promise<ShellResult> {
	return new Promise((resolve, reject) => {
		execFile("sh", ["-c", cmd], { cwd, signal, encoding: "utf8", maxBuffer: 1 << 30 }, (error, stdout, stderr) => {
			if (error !== null && typeof error.code !== "number") reject(error);
			else resolve({ code: error === null ? 0 : (error.code as number), stdout, stderr });
		});
	});
}

const sh = defineTool({
	name: "sh",
	description: "Run a shell command of a workflow script.",
	parameters: Type.Object({ cmd: Type.String(), check: Type.Boolean() }),
	callers: ["tools"],
	replay: "safe",
	structuredOutputSchema: Type.Object({ code: Type.Number(), stdout: Type.String(), stderr: Type.String() }),
	execute: async (args, api, context) => {
		const { cwd = "." } = await api.agent(context);
		const result = await shell(args.cmd, cwd, context.abortSignal);
		// A failed check is an error result, so a resume runs the command again.
		if (args.check && result.code !== 0) {
			const stderr = result.stderr.trim();
			throw new Error(`sh exited with ${result.code}: ${args.cmd}${stderr === "" ? "" : `\n${stderr}`}`);
		}
		return { output: text(`exit ${result.code}`), structuredOutput: result };
	},
});

const OWN = new Set([WORKFLOW.name, session.name, ask.name, sh.name, respond.name]);

/** The sandbox functions that are not host calls. */
function prelude(call: WorkflowCall): string {
	return `
const args = ${JSON.stringify(call.args)};
const __unavailable = (name) => function () {
	throw new Error(name + " is not available in workflow scripts");
};
const Date = Object.assign(__unavailable("Date"), { now: __unavailable("Date.now") });
const Math = Object.freeze({
	...Object.fromEntries(Object.getOwnPropertyNames(globalThis.Math).map((name) => [name, globalThis.Math[name]])),
	random: __unavailable("Math.random"),
});
const prompts = Object.fromEntries(
	${JSON.stringify(Object.keys(call.prompts))}.map((name) => [name, (inputs) => __prompt(name, inputs)]),
);
function session(profile = "default") {
	const id = __session(profile);
	return { ask: async (prompt, options = {}) => __ask(await id, await prompt, options.schema) };
}
const agent = (prompt, options = {}) => session(options.as ?? "default").ask(prompt, options);
const sh = async (cmd) => (await __sh(cmd, true)).stdout.replace(/\\n$/, "");
const ok = async (cmd) => (await __sh(cmd, false)).code === 0;
const parallel = (thunks) => Promise.all(thunks.map((thunk) => thunk()));
const pipeline = (items, ...stages) =>
	Promise.all(
		items.map(async (item) => {
			let value = item;
			for (const stage of stages) value = await stage(value);
			return value;
		}),
	);
`;
}

/** `<sha256(name + JSON args), 16 hex>.<n>`, n counting identical calls in this execution. */
function keyOf(name: string, args: JsonObject, counters: Map<string, number>): string {
	const hash = createHash("sha256")
		.update(name + JSON.stringify(args))
		.digest("hex")
		.slice(0, 16);
	const n = (counters.get(hash) ?? 0) + 1;
	counters.set(hash, n);
	return `${hash}.${n}`;
}

/** The key of the nested call whose error stopped the script, per `workflow` call; absent when no such call. */
const RetryDoc = defineDoc<{ key?: string }>({
	kind: "workflows.retry",
	version: 1,
	scope: "task",
	initial: () => ({}),
});

/** One script execution: its key counters, the key to retry, and each error message thrown into the script with the latest key that threw it. */
type Execution = {
	readonly counters: Map<string, number>;
	readonly retry: string | undefined;
	readonly thrown: Map<string, string>;
};

/**
 * The result of nested call `name`. Only the call that stopped the script before is sent again, under the next free key
 * `<key>~<n>`; any other saved error is thrown again. With `Promise.all`, another call that also failed throws its saved
 * error, and is sent again only if it stops the next resume.
 */
async function nested(
	api: ToolExecutionApi,
	context: Context,
	execution: Execution,
	name: string,
	args: JsonObject,
): Promise<unknown> {
	const base = keyOf(name, args, execution.counters);
	const saved = (key: string) => api.snapshot(NestedCallDoc, api.taskId, key, context);
	let key = base;
	for (let n = 2; (await saved(key))?.result?.isError === true; n++) {
		const next = `${base}~${n}`;
		if (key !== execution.retry && (await saved(next)) === undefined) break;
		key = next;
	}
	const result = await api.executeTool(name, args, context, { key });
	if (result.isError) {
		const output = typeof result.structuredOutput === "string" ? [result.structuredOutput] : [];
		const reasons = [...output, ...result.diagnostics.map((diagnostic) => diagnostic.message)];
		const message = reasons.filter((reason) => reason !== "").join("\n") || `${name} failed`;
		execution.thrown.set(message, key);
		throw new Error(message);
	}
	return result.structuredOutput;
}

function global(name: string, execute: (...values: never[]) => unknown): CodemodeTool {
	return { name, spread: true, execute: (values) => execute(...(values as never[])) };
}

/** The script's return value. A script failure is reported to `hooks` and waits for the store to close. */
async function runScript(
	call: WorkflowCall,
	api: ToolExecutionApi,
	context: Context,
	hooks: ScriptHooks,
): Promise<unknown> {
	const retry = (await api.snapshot(RetryDoc, api.taskId, context))?.key;
	const execution: Execution = { counters: new Map(), retry, thrown: new Map() };
	const host = (name: string, args: JsonObject) => nested(api, context, execution, name, args);
	const { callable } = await api.agent(context);
	const sandbox = new CodemodeSandbox({
		timeoutMs: Number.POSITIVE_INFINITY,
		tools: callable
			.filter((tool) => !OWN.has(tool.name))
			.map((tool) => ({
				name: tool.name,
				description: tool.description,
				inputSchema: tool.parameters as CodemodeJsonSchema,
				execute: (args) => host(tool.name, args as JsonObject),
			})),
		globals: [
			global("__session", (profile: string) => {
				const agent = call.agents[profile];
				if (agent === undefined) throw new Error(`no agent profile ${profile}`);
				return host("session", { profile, agent });
			}),
			global("__ask", (conversation: number, prompt: string, schema?: JsonObject) =>
				host("ask", { conversation, prompt, ...(schema === undefined ? {} : { schema }) }),
			),
			global("__sh", (cmd: string, check: boolean) => host("sh", { cmd, check })),
			global("run", (name: string, args?: JsonObject) => {
				const source = call.scripts[name];
				if (source === undefined) throw new Error(`no workflow ${name}`);
				return host("workflow", { ...call, source, args: args ?? {} });
			}),
			global("phase", (title: string) => hooks.log(String(title))),
			global("log", (line: string) => hooks.log(String(line))),
			global("__prompt", (name: string, inputs?: Record<string, string>) => {
				const body = call.prompts[name];
				if (body === undefined) throw new Error(`no prompt ${name}`);
				return render(body, inputs);
			}),
		],
	});
	const signal = context.abortSignal;
	let result: Awaited<ReturnType<CodemodeSandbox["execute"]>>;
	try {
		const source = `${prelude(call)}\nreturn await (async () => {\n${call.source}\n})();`;
		result = await sandbox.execute(source, signal === undefined ? {} : { signal });
	} finally {
		await sandbox.close();
	}
	if (result.ok) return result.value ?? null;
	if (signal?.aborted) throw signal.reason;
	const { message } = result.error;
	// A script that threw its own error, or another one after it caught a call's error, retries no call.
	const stopped = execution.thrown.get(message);
	await api.commit(async (tx) => {
		const doc = await tx.doc(RetryDoc, api.taskId);
		if (stopped === undefined) delete doc.key;
		else doc.key = stopped;
		return undefined;
	}, context);
	hooks.fail(message);
	return new Promise((_, reject) => signal?.addEventListener("abort", () => reject(signal.reason), { once: true }));
}

/** The script tools: `workflow`, its `session`, `ask` and `sh` calls, and the `respond` tool of a `schema` ask. */
export function scriptExtension(hooks: ScriptHooks): Extension {
	const workflow = defineTool({
		...WORKFLOW,
		execute: async (args, api, context) => {
			const value = await runScript(args as WorkflowCall, api, context, hooks);
			return { output: text(JSON.stringify(value)), structuredOutput: value as JsonObject };
		},
	});
	return defineExtension({ name: SCRIPT, tools: [workflow, session, ask, sh, respond] });
}

/** The runner model, which only starts the root `workflow` call. */
export const RUNNER: AgentChoice = { model: { provider: "workflows-runner", modelId: "runner" }, thinkingLevel: "off" };

/** The runner session's agent: the script tools, with only `workflow` offered. */
export const RUNNER_AGENT: AgentChange = { extensions: { add: [{ name: SCRIPT }] }, modelTools: [WORKFLOW] };

function contentText(message: Message | undefined): string {
	if (message === undefined || message.role === "system") return "";
	if (typeof message.content === "string") return message.content;
	return message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
}

/**
 * The runner provider. It answers the run's input, a `WorkflowCall` as JSON, with one `workflow` call, and the tool
 * result with the result's text.
 */
export function runnerProvider(): Provider {
	const faux = fauxProvider({ provider: RUNNER.model.provider, models: [{ id: RUNNER.model.modelId }] });
	const respond: FauxResponseFactory = (context): AssistantMessage => {
		faux.appendResponses([respond]);
		const last = context.messages.findLast((message) => message.role !== "system");
		if (last?.role === "toolResult") {
			const result = contentText(last);
			return last.isError
				? fauxAssistantMessage("", { stopReason: "error", errorMessage: result })
				: fauxAssistantMessage(result);
		}
		return fauxAssistantMessage(fauxToolCall("workflow", JSON.parse(contentText(last))), { stopReason: "toolUse" });
	};
	faux.setResponses([respond]);
	return faux.provider;
}
