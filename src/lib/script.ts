/**
 * Workflow scripts. A script is JavaScript that runs in the pi-codemode sandbox inside one `workflow` tool call. Each
 * call it makes is a keyed nested call of that tool, so when the tool runs again after an interruption, the finished
 * calls return their saved results and only the rest runs. A script failure does not settle the `workflow` call: the
 * command stops, and a resume runs the same call again.
 *
 * The runner conversation holds the run's bundle, and a local runner model starts the root call: it answers the run's
 * input with one `workflow` call, and the tool result with its text.
 */
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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
	type Tx,
} from "@earendil-works/pi-durable";
import { type AgentChoice, sessionAgent } from "./agents.ts";
import { failure, git, run } from "./git.ts";
import { instructions, render } from "./prompts.ts";
import { type ExtensionHost, type SessionCheckpoint, type Step, sessionOf, textOf } from "./workflow.ts";

/** An agent profile from `agents/<name>.md`. */
export type Profile = {
	readonly model: ModelRef;
	readonly thinkingLevel: ModelThinkingLevel;
	readonly instructions: string;
};

/** The scripts, prompt instructions and profiles of the package and the project, saved by a run before it starts. */
export type Bundle = {
	readonly scripts: Readonly<Record<string, string>>;
	readonly prompts: Readonly<Record<string, string>>;
	readonly agents: Readonly<Record<string, Profile>>;
};

/** The bundle of a run and its own script, kept in the runner conversation. */
export type RunBundle = Bundle & { readonly main: string };

const BundleDoc = defineDoc<RunBundle>({
	kind: "workflows.bundle",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "current",
	initial: () => ({ main: "", scripts: {}, prompts: {}, agents: {} }),
});

const PACKAGE = fileURLToPath(new URL("../../", import.meta.url));

/** `<base>/<folder>/*<extension>` by name; a missing folder has none. */
async function readFolder(base: string, folder: string, extension: string): Promise<Record<string, string>> {
	const directory = join(base, folder);
	const files = (await readdir(directory).catch(() => [])).filter((file) => file.endsWith(extension)).sort();
	const entries = await Promise.all(
		files.map(async (file) => [file.slice(0, -extension.length), await readFile(join(directory, file), "utf8")]),
	);
	return Object.fromEntries(entries);
}

/** `<folder>/*<extension>` of the package, and of the project, whose files replace the package files of their name. */
async function readMerged(project: string, folder: string, extension: string): Promise<Record<string, string>> {
	const [own, local] = await Promise.all([
		readFolder(PACKAGE, folder, extension),
		readFolder(project, folder, extension),
	]);
	return { ...own, ...local };
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

/**
 * The `workflows/*.js`, `prompts/*.md` and `agents/*.md` of the package and of `.workflows/` in the Git repository of
 * `cwd`, or in `cwd` outside a repository, read now. Without `cwd`, only the package files.
 */
export async function loadBundle(cwd?: string): Promise<Bundle> {
	const root = cwd === undefined ? undefined : await git(cwd, "rev-parse", "--show-toplevel").catch(() => cwd);
	const project = root === undefined ? PACKAGE : join(root, ".workflows");
	const [scripts, templates, profiles] = await Promise.all([
		readMerged(project, "workflows", ".js"),
		readMerged(project, "prompts", ".md"),
		readMerged(project, "agents", ".md"),
	]);
	return {
		scripts,
		prompts: Object.fromEntries(Object.entries(templates).map(([name, text]) => [name, instructions(text)])),
		agents: Object.fromEntries(Object.entries(profiles).map(([name, text]) => [name, profileOf(name, text)])),
	};
}

const text = (value: string): TextContent[] => [{ type: "text", text: value }];

const SCRIPT = "workflows-script";
const ANSWER = "workflows-answer";

/** The JSON Schema of the current ask's answer, per conversation; absent when the ask has no `schema`. */
const AnswerDoc = defineDoc<{ schema?: JsonObject }>({
	kind: "workflows.answer-schema",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "current",
	initial: () => ({}),
});

/** The bundle of the runner conversation that the calling script runs in. */
async function bundleOf(api: ToolExecutionApi, context: Context): Promise<RunBundle> {
	const bundle = await api.snapshot(BundleDoc, api.conversationId, context);
	if (bundle === undefined) throw new Error("workflow scripts run only in a runner session");
	return bundle;
}

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
		/** A script of the bundle; absent for the run's own script. */
		script: Type.Optional(Type.String()),
		args: Type.Record(Type.String(), Type.Unknown()),
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
	parameters: Type.Object({ profile: Type.String() }),
	callers: ["tools"],
	replay: "safe",
	structuredOutputSchema: Type.Number(),
	execute: async (args, api, context) => {
		const { cwd = "." } = await api.agent(context);
		const profile = (await bundleOf(api, context)).agents[args.profile];
		if (profile === undefined) throw new Error(`no agent profile ${args.profile}`);
		const id = await api.commit(async (tx) => {
			const created = await tx.createConversation({ ownership: { kind: "ownerless" } });
			await configure(tx, created.id, {
				...sessionAgent(profile, cwd),
				...(profile.instructions === "" ? {} : { instructions: profile.instructions }),
				extensions: { add: [{ name: ANSWER }] },
				modelTools: { remove: [respond] },
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
				extensions: { add: [{ name: ANSWER }], remove: [{ name: SCRIPT }] },
				modelTools: { remove: schema === undefined ? [respond] : [] },
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

const sh = defineTool({
	name: "sh",
	description: "Run a shell command of a workflow script.",
	parameters: Type.Object({
		cmd: Type.Union([Type.String(), Type.Array(Type.String(), { minItems: 1 })]),
		check: Type.Boolean(),
	}),
	callers: ["tools"],
	replay: "safe",
	structuredOutputSchema: Type.Object({ code: Type.Number(), stdout: Type.String(), stderr: Type.String() }),
	execute: async (args, api, context) => {
		const { cwd = "." } = await api.agent(context);
		// A string is `sh -c <cmd>`; an array is the program `cmd[0]` with the arguments `cmd.slice(1)` and no shell.
		const [file = "", ...rest] = typeof args.cmd === "string" ? ["sh", "-c", args.cmd] : args.cmd;
		const result = await run(file, rest, cwd, context.abortSignal);
		// A failed check is an error result, so a resume runs the command again.
		if (args.check && result.code !== 0) {
			if (typeof args.cmd !== "string") throw new Error(failure(args.cmd, result));
			const stderr = result.stderr.trim();
			throw new Error(`sh exited with ${result.code}: ${args.cmd}${stderr === "" ? "" : `\n${stderr}`}`);
		}
		return { output: text(`exit ${result.code}`), structuredOutput: result };
	},
});

const OWN = new Set([WORKFLOW.name, session.name, ask.name, sh.name]);

/** The sandbox functions that are not host calls. */
function prelude(args: JsonObject, prompts: readonly string[], host: ExtensionHost): string {
	return `
const args = ${JSON.stringify(args)};
const runId = ${JSON.stringify(host.runId)};
const runDir = ${JSON.stringify(host.runDir)};
const __unavailable = (name) => function () {
	throw new Error(name + " is not available in workflow scripts");
};
const Date = Object.assign(__unavailable("Date"), { now: __unavailable("Date.now") });
const Math = Object.freeze({
	...Object.fromEntries(Object.getOwnPropertyNames(globalThis.Math).map((name) => [name, globalThis.Math[name]])),
	random: __unavailable("Math.random"),
});
const prompts = Object.fromEntries(
	${JSON.stringify(prompts)}.map((name) => [name, (inputs) => __prompt(name, inputs)]),
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

/** A `phase` or `log` line. */
type Line = { readonly text: string; readonly phase: boolean };

/**
 * The lines of a script that wait for its next call that runs, in order, and where they print. At most one is a phase
 * line: a new phase line replaces it.
 */
type Progress = { readonly lines: Line[]; readonly log: (line: string) => void };

function phaseLine(progress: Progress, text: string): void {
	const { lines } = progress;
	lines.splice(0, lines.length, ...lines.filter((line) => !line.phase), { text, phase: true });
}

function print(progress: Progress): void {
	for (const line of progress.lines.splice(0)) progress.log(line.text);
}

/**
 * The result of nested call `name`. A call whose saved result is an error runs again, under the next free key
 * `<key>~<n>`. The waiting lines print when the call runs. A call with a saved result drops the log lines and keeps
 * the phase line, so a resume prints the phase of the first call that runs.
 */
async function nested(
	api: ToolExecutionApi,
	context: Context,
	counters: Map<string, number>,
	progress: Progress,
	name: string,
	args: JsonObject,
): Promise<unknown> {
	const base = keyOf(name, args, counters);
	let key = base;
	let saved = await api.snapshot(NestedCallDoc, api.taskId, key, context);
	for (let n = 2; saved?.result?.isError === true; n++) {
		key = `${base}~${n}`;
		saved = await api.snapshot(NestedCallDoc, api.taskId, key, context);
	}
	const { lines } = progress;
	if (saved?.result === undefined) print(progress);
	else lines.splice(0, lines.length, ...lines.filter((line) => line.phase));
	const result = await api.executeTool(name, args, context, { key });
	if (result.isError) {
		const output = typeof result.structuredOutput === "string" ? [result.structuredOutput] : [];
		const reasons = [...output, ...result.diagnostics.map((diagnostic) => diagnostic.message)];
		throw new Error(reasons.filter((reason) => reason !== "").join("\n") || `${name} failed`);
	}
	return result.structuredOutput;
}

function global(name: string, execute: (...values: never[]) => unknown): CodemodeTool {
	return { name, spread: true, execute: (values) => execute(...(values as never[])) };
}

/**
 * The return value of the script `script` of the bundle, or of the run's own script. A script failure is reported to
 * `host` and waits for the store to close.
 */
async function runScript(
	script: string | undefined,
	args: JsonObject,
	api: ToolExecutionApi,
	context: Context,
	host: ExtensionHost,
): Promise<unknown> {
	const bundle = await bundleOf(api, context);
	const source = script === undefined ? bundle.main : bundle.scripts[script];
	if (source === undefined) throw new Error(`no workflow ${script}`);
	const counters = new Map<string, number>();
	const progress: Progress = { lines: [], log: host.log };
	const call = (name: string, values: JsonObject) => nested(api, context, counters, progress, name, values);
	const { callable } = await api.agent(context);
	const sandbox = new CodemodeSandbox({
		timeoutMs: Number.POSITIVE_INFINITY,
		tools: callable
			.filter((tool) => !OWN.has(tool.name))
			.map((tool) => ({
				name: tool.name,
				description: tool.description,
				inputSchema: tool.parameters as CodemodeJsonSchema,
				execute: (values) => call(tool.name, values as JsonObject),
			})),
		globals: [
			global("__session", (profile: string) => call("session", { profile })),
			global("__ask", (conversation: number, prompt: string, schema?: JsonObject) =>
				call("ask", { conversation, prompt, ...(schema === undefined ? {} : { schema }) }),
			),
			global("__sh", (cmd: string | string[], check: boolean) => call("sh", { cmd, check })),
			global("run", (name: string, values?: JsonObject) => call("workflow", { script: name, args: values ?? {} })),
			global("phase", (title: string) => phaseLine(progress, String(title))),
			global("log", (line: string) => progress.lines.push({ text: String(line), phase: false })),
			global("__prompt", (name: string, inputs?: Record<string, string> | null) => {
				const body = bundle.prompts[name];
				if (body === undefined) throw new Error(`no prompt ${name}`);
				return render(body, inputs ?? {});
			}),
		],
	});
	const signal = context.abortSignal;
	let result: Awaited<ReturnType<CodemodeSandbox["execute"]>>;
	try {
		const wrapped = `${prelude(args, Object.keys(bundle.prompts), host)}\nreturn await (async () => {\n${source}\n})();`;
		result = await sandbox.execute(wrapped, signal === undefined ? {} : { signal });
	} finally {
		await sandbox.close();
		print(progress);
	}
	if (result.ok) return result.value ?? null;
	if (signal?.aborted) throw signal.reason;
	// A failed task would not do: its resume starts a new task, and the saved nested calls belong to this one. So the
	// call stays open, the command stops, and a resume runs this call again.
	host.fail(result.error.message);
	return new Promise((_, reject) => signal?.addEventListener("abort", () => reject(signal.reason), { once: true }));
}

/**
 * Two extensions, one per consumer. `workflows-script` is for the runner: its `workflow` tool, and the `session`, `ask`
 * and `sh` calls that a script makes inside that call. `workflows-answer` is for script sessions: the `respond` tool of
 * a `schema` ask.
 */
function scriptExtensions(host: ExtensionHost): Extension[] {
	const workflow = defineTool({
		...WORKFLOW,
		execute: async (args, api, context) => {
			const value = await runScript(args.script, args.args as JsonObject, api, context, host);
			return { output: text(JSON.stringify(value)), structuredOutput: value as JsonObject };
		},
	});
	return [
		defineExtension({ name: SCRIPT, tools: [workflow, session, ask, sh] }),
		defineExtension({ name: ANSWER, tools: [respond] }),
	];
}

/**
 * The runner model, which only starts the root `workflow` call. It exists because a pi-durable task cannot call a tool
 * itself: `TaskRuntime` has no `executeTool`.
 */
const RUNNER: AgentChoice = { model: { provider: "workflows-runner", modelId: "runner" }, thinkingLevel: "off" };

/**
 * Makes `conversation` the runner session of `bundle`: it selects `workflows-script`, offers only `workflow` to the
 * model, and keeps the bundle that its scripts read.
 */
async function openRunner(tx: Tx, conversation: ConversationId, bundle: RunBundle): Promise<void> {
	await configure(tx, conversation, { extensions: { add: [{ name: SCRIPT }] }, modelTools: [WORKFLOW] });
	Object.assign(await tx.doc(BundleDoc, conversation), bundle);
}

function contentText(message: Message | undefined): string {
	if (message === undefined || message.role === "system") return "";
	if (typeof message.content === "string") return message.content;
	return message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
}

/**
 * The runner provider. It answers the run's input, the arguments of the root `workflow` call as JSON, with that call,
 * and the tool result with the result's text.
 */
function runnerProvider(): Provider {
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

/** The checkpoint of a workflow that runs one script. */
export type ScriptCheckpoint = { readonly phase: "run" } & SessionCheckpoint;

/**
 * What every workflow that runs one script declares: its first checkpoint, and the script runtime, which the store
 * installs once for all of them.
 */
export const scriptWorkflow = {
	initial: (): ScriptCheckpoint => ({ phase: "run" }),
	extensions: scriptExtensions,
	providers: [runnerProvider()],
};

/** The script phase: a runner session in `cwd` runs `bundle.main` with `args`, and its value is the run's result. */
export async function scriptPhase(
	step: Step<unknown, ScriptCheckpoint, ScriptCheckpoint, unknown>,
	cwd: string,
	bundle: RunBundle,
	args: JsonObject,
): Promise<void> {
	const runner = await step.session(RUNNER, cwd, (tx, conversation) => openRunner(tx, conversation, bundle));
	if (runner === undefined) return;
	await step.finish(JSON.parse(await runner.say("run", JSON.stringify({ args }))));
}
