/**
 * Workflow scripts. A script is JavaScript that runs in the pi-codemode sandbox in the phase of the run's task. Each
 * call it makes saves its result in a document of the store, keyed by the run ID and the call, so when the script runs
 * again after an interruption or a failure, the finished calls return their saved results and only the rest runs. A call
 * records its kind, args, phase and start time when it starts, and its end time with its result or error when it ends;
 * only a saved result replays, so a failed or stopped call runs again. A failure of the phase ends the task as failed, and a resume runs the script again in a new
 * task of the same run. `run(name, args)` starts a child run as a child task of the caller in the caller's store, with
 * its own run directory, and a resume of the caller continues that child run.
 */
import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Context, JsonValue } from "@earendil-works/chord";
import {
	type AssistantMessage,
	type ModelThinkingLevel,
	type TextContent,
	type TSchema,
	Type,
	validateToolArguments,
} from "@earendil-works/pi-ai";
import { CodemodeSandbox, type CodemodeTool } from "@earendil-works/pi-codemode";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import {
	AssistantEntry,
	type ConversationId,
	configure,
	defineDoc,
	defineDocFamily,
	defineExtension,
	defineTool,
	type JsonObject,
	type ModelRef,
	section,
	type TaskId,
} from "@earendil-works/pi-durable";
import { sessionAgent } from "./agents.ts";
import { failure, git, run } from "./git.ts";
import { instructions, render } from "./prompts.ts";
import type { Runtime } from "./task.ts";

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

/** The bundle of a run and its own script, saved in the run's input. */
export type RunBundle = Bundle & { readonly main: string };

/** What a script run gets from the command. */
export type ExtensionHost = {
	/** Writes one progress line. */
	log(line: string): void;
};

/** A started child run: its task and its run ID. */
export type Child = { readonly task: TaskId<JsonValue>; readonly runId: string };

/** What a script phase runs: its run ID and directory, bundle and args, and how it starts a child run. */
export type ScriptRun = {
	readonly runId: string;
	readonly runDir: string;
	readonly bundle: RunBundle;
	readonly args: JsonObject;
	/** Starts the child run of the `run` call `key` and saves it as the result of the call. */
	child(key: string, name: string, args: JsonObject): Promise<Child>;
	/** Starts a new child task with the input of the ended child task `ended`, and saves it as the result of `key`. */
	restart(key: string, ended: TaskId<JsonValue>): Promise<Child>;
};

const PACKAGE = fileURLToPath(new URL("../", import.meta.url));

/** `<base>/<folder>/*<extension>` by name; a missing folder has none. */
export async function readFolder(base: string, folder: string, extension: string): Promise<Record<string, string>> {
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

/** The `<name>.md` files of `folder`, each of which must replace a template of `templates`. */
async function overrides(folder: string, templates: Record<string, string>): Promise<Record<string, string>> {
	const found = await stat(folder).then(
		(entry) => entry.isDirectory(),
		() => false,
	);
	if (!found) throw new Error(`no prompts folder ${folder}`);
	const own = await readFolder(folder, ".", ".md");
	for (const name of Object.keys(own)) {
		if (templates[name] === undefined) throw new Error(`${folder}/${name}.md replaces no prompt of the package`);
	}
	return own;
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
 * `cwd`, or in `cwd` outside a repository, read now. Without `cwd`, only the package files. Each `<name>.md` of the
 * folder `prompts` replaces the template of that name.
 */
export async function loadBundle(cwd?: string, prompts?: string): Promise<Bundle> {
	const root = cwd === undefined ? undefined : await git(cwd, "rev-parse", "--show-toplevel").catch(() => cwd);
	const project = root === undefined ? PACKAGE : join(root, ".workflows");
	const [scripts, merged, profiles] = await Promise.all([
		readMerged(project, "workflows", ".js"),
		readMerged(project, "prompts", ".md"),
		readMerged(project, "agents", ".md"),
	]);
	const templates = prompts === undefined ? merged : { ...merged, ...(await overrides(prompts, merged)) };
	return {
		scripts,
		prompts: Object.fromEntries(Object.entries(templates).map(([name, text]) => [name, instructions(text)])),
		agents: Object.fromEntries(Object.entries(profiles).map(([name, text]) => [name, profileOf(name, text)])),
	};
}

/** The leading comments and `export const meta =` of a script that declares its `meta`. */
export const META = /^((?:\s|\/\/[^\n]*|\/\*[\s\S]*?\*\/)*)export\s+(const\s+meta\s*=\s*)/;

const text = (value: string): TextContent[] => [{ type: "text", text: value }];

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

/**
 * The answer of `args` checked against `schema`, as `validateToolArguments` returns it. A string answer that does not
 * match is parsed as JSON, and an object or array is checked again, because a model can send it as its JSON text. Any
 * other string throws the first error.
 */
function checkedAnswer(schema: JsonObject, args: JsonObject, id: string): unknown {
	const parameters = { type: "object", properties: { answer: schema }, required: ["answer"] } as unknown as TSchema;
	const check = (answer: unknown) =>
		validateToolArguments(
			{ name: "respond", description: "", parameters },
			{ type: "toolCall", id, name: "respond", arguments: { answer } as JsonObject },
		).answer;
	try {
		return check(args.answer);
	} catch (error) {
		if (typeof args.answer !== "string") throw error;
		let parsed: unknown;
		try {
			parsed = JSON.parse(args.answer);
		} catch {
			throw error;
		}
		if (typeof parsed !== "object" || parsed === null) throw error;
		return check(parsed);
	}
}

const respond = defineTool({
	name: "respond",
	description: "Give the answer of this turn in the structured form the prompt asks for. This ends the turn.",
	parameters: Type.Object({
		answer: Type.Unknown({
			description: "The answer value itself, in the form the prompt asks for. Do not give its JSON text as a string.",
		}),
	}),
	callers: ["model"],
	execute: async (args, api, context) => {
		const schema = (await api.snapshot(AnswerDoc, api.conversationId, context))?.schema;
		if (schema === undefined) return { isError: true, output: text("This turn asks for no structured answer.") };
		try {
			checkedAnswer(schema, args as JsonObject, api.callId);
		} catch (error) {
			return { isError: true, output: text(error instanceof Error ? error.message : String(error)) };
		}
		return { output: text("Answer recorded."), control: { terminate: true } };
	},
});

/** The sandbox functions that are not host calls. */
function prelude(args: JsonObject, prompts: readonly string[], script: ScriptRun): string {
	return `
const args = ${JSON.stringify(args)};
const runId = ${JSON.stringify(script.runId)};
const runDir = ${JSON.stringify(script.runDir)};
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
	return { ask: async (prompt, options = {}) => __ask(await id, await prompt, options.schema, profile) };
}
const agent = async (prompt, options = {}) => __agent(options.as ?? "default", await prompt, options.schema);
const sh = async (cmd) => (await __sh(cmd, true)).stdout.replace(/\\n$/, "");
const ok = async (cmd) => (await __sh(cmd, false)).code === 0;
const run = async (name, args = {}) => {
	const { runId: id, result } = await __run(name, args);
	return result !== null && typeof result === "object" && !Array.isArray(result) ? { ...result, runId: id } : result;
};
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

/**
 * One script call: its kind, its args, the phase line that was current when it started, its start and end times as ISO
 * strings, and its result or its error. A call that started and did not end has no `endedAt`. The `conversation` of a
 * `session` or `agent` call is its session, so a stopped call reuses it and a stopped `agent` call continues its turn.
 */
export type CallRecord = {
	kind: CallKind;
	args: JsonObject;
	phase: string | null;
	startedAt: string;
	endedAt?: string;
	result?: JsonValue;
	error?: string;
	conversation?: ConversationId;
};

/** The kinds of script calls. */
export type CallKind = "session" | "ask" | "agent" | "sh" | "ok" | "run";

/** The document kind of the call records. */
export const CALL_KIND = "workflows.call";

/**
 * The record of each script call, keyed `<run ID>/<call key>`. The store keeps it after its task ends, so a new task of
 * the run finds it. Each write gets the record with `tx.doc(CallDoc, key, null)` and changes its fields.
 */
export const CallDoc = defineDocFamily<CallRecord, null>({
	kind: CALL_KIND,
	version: 1,
	scope: "session",
	family: true,
	initial: () => ({ kind: "sh", args: {}, phase: null, startedAt: "" }),
});

/** The saved result of the call `key`, if it has one. */
export async function savedCall(runtime: Runtime, key: string, context: Context): Promise<JsonValue | undefined> {
	const record = await runtime.snapshot(CallDoc, key, context);
	return record !== undefined && "result" in record ? record.result : undefined;
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
 * line: a new phase line replaces it. `phase` is the current phase line, which each call that starts records.
 */
type Progress = { readonly lines: Line[]; readonly log: (line: string) => void; phase: string | null };

function phaseLine(progress: Progress, text: string): void {
	progress.phase = text;
	const { lines } = progress;
	lines.splice(0, lines.length, ...lines.filter((line) => !line.phase), { text, phase: true });
}

function print(progress: Progress): void {
	for (const line of progress.lines.splice(0)) progress.log(line.text);
}

export function textOf(message: AssistantMessage): string {
	return message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
}

/** The answer message to `content` in `conversation`. A turn answered before returns its saved answer. */
async function turn(
	runtime: Runtime,
	conversation: ConversationId,
	context: Context,
	requestId: string,
	content: string,
): Promise<AssistantMessage> {
	const handle = await runtime.conversation(conversation, context);
	if (handle === undefined) throw new Error(`Session ${conversation} is missing`);
	// A turn that failed before is sent again under the next free request ID.
	let attempt = requestId;
	await runtime.commit(async (tx) => {
		for (let n = 2; (await tx.submissionByRequest(conversation, attempt))?.status === "unanswered"; n++) {
			attempt = `${requestId}#${n}`;
		}
		return undefined;
	}, context);
	const submission = await handle.submit({ type: "input", content, requestId: attempt }, context);
	const settled = await submission.wait(context);
	if (settled.type !== "input" || settled.status !== "done") {
		const detail = settled.detail === undefined ? "" : ` ${JSON.stringify(settled.detail)}`;
		throw new Error(`The ${requestId} turn was not answered: ${settled.reason ?? settled.status}${detail}`);
	}
	let answer: AssistantMessage | undefined;
	await runtime.commit(async (tx) => {
		answer = (await tx.entry(AssistantEntry, settled.answer))?.model?.[0] as AssistantMessage | undefined;
		return undefined;
	}, context);
	if (answer === undefined) throw new Error(`The ${requestId} answer ${settled.answer} is missing`);
	return answer;
}

/** What the calls of one script execution share. */
type Calls = {
	readonly runId: string;
	readonly runtime: Runtime;
	readonly context: Context;
	readonly counters: Map<string, number>;
	readonly progress: Progress;
};

/** The document key of the call `name` with `args` in this execution: `<run ID>/<call key>`. */
function callKey(calls: Calls, name: string, args: JsonObject): string {
	return `${calls.runId}/${keyOf(name, args, calls.counters)}`;
}

/** What a call records when it starts. */
type Start = { readonly kind: CallKind; readonly args: JsonObject };

/**
 * The result of the call `key`: its saved result, or the value of `effect`, which gets the key. The call records its
 * start before `effect`, and its end with the value or the error after it. With `ends` false, `effect` saves the value
 * itself and the caller records the end. A stopped call records no end, and a call that throws saves no result, so both
 * run again. The waiting lines print when the call runs. A call with a saved result drops the log lines and keeps the
 * phase line, so a resume prints the phase of the first call that runs.
 */
async function memoized(
	calls: Calls,
	key: string,
	start: Start,
	effect: (key: string) => Promise<JsonValue>,
	ends = true,
): Promise<JsonValue> {
	const { runtime, context, progress } = calls;
	const saved = await savedCall(runtime, key, context);
	const { lines } = progress;
	if (saved !== undefined) {
		lines.splice(0, lines.length, ...lines.filter((line) => line.phase));
		return saved;
	}
	print(progress);
	await runtime.commit(async (tx) => {
		const doc = await tx.doc(CallDoc, key, null);
		Object.assign(doc, { ...start, phase: progress.phase, startedAt: new Date().toISOString() });
		delete doc.endedAt;
		delete doc.error;
		return undefined;
	}, context);
	let value: JsonValue;
	try {
		value = await effect(key);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (!runtime.signal.aborted) await endCall(calls, key, { error: message });
		throw error;
	}
	if (ends) await endCall(calls, key, { result: value });
	return (await savedCall(runtime, key, context)) ?? value;
}

/** Records the end of the call `key`, with its result, or its error when it failed. */
async function endCall(calls: Calls, key: string, end: { result?: JsonValue; error?: string }): Promise<void> {
	await calls.runtime.commit(async (tx) => {
		const doc = await tx.doc(CallDoc, key, null);
		Object.assign(doc, end);
		doc.endedAt = new Date().toISOString();
		return undefined;
	}, calls.context);
}

/**
 * The session of the call `key`: the `conversation` of its record, or a new session of the agent profile `name` in
 * `cwd`, which is saved there in the same commit. The task owns its conversation.
 */
async function sessionOf(
	calls: Calls,
	key: string,
	cwd: string,
	bundle: RunBundle,
	name: string,
): Promise<ConversationId> {
	const { runtime, context } = calls;
	const saved = (await runtime.snapshot(CallDoc, key, context))?.conversation;
	if (saved !== undefined) return saved;
	const profile = bundle.agents[name];
	if (profile === undefined) throw new Error(`no agent profile ${name}`);
	await runtime.commit(async (tx) => {
		const created = await tx.createConversation({ ownership: { kind: "task", taskId: runtime.taskId } });
		await configure(tx, created.id, {
			...sessionAgent(profile, cwd),
			...(profile.instructions === "" ? {} : { instructions: profile.instructions }),
			extensions: { add: [{ name: ANSWER }] },
			modelTools: { remove: [respond] },
		});
		const doc = await tx.doc(CallDoc, key, null);
		doc.conversation = created.id;
		return undefined;
	}, context);
	const id = (await runtime.snapshot(CallDoc, key, context))?.conversation;
	if (id === undefined) throw new Error(`the session of ${key} is missing`);
	return id;
}

/** One turn in `conversation`; the call's key is the request ID, so an interrupted ask continues its turn. */
async function askTurn(
	calls: Calls,
	key: string,
	conversation: ConversationId,
	prompt: string,
	schema: JsonObject | null,
): Promise<JsonValue> {
	const { runtime, context } = calls;
	await runtime.commit(async (tx) => {
		const doc = await tx.doc(AnswerDoc, conversation);
		if (schema === null) delete doc.schema;
		else doc.schema = schema;
		await configure(tx, conversation, {
			extensions: { add: [{ name: ANSWER }] },
			modelTools: { remove: schema === null ? [respond] : [] },
		});
		return undefined;
	}, context);
	const answer = await turn(runtime, conversation, context, key, prompt);
	if (schema === null) return textOf(answer).trim();
	const call = answer.content.findLast((part) => part.type === "toolCall" && part.name === "respond");
	if (call?.type !== "toolCall") throw new Error("the answer did not call respond");
	return checkedAnswer(schema, call.arguments as JsonObject, call.id) as JsonValue;
}

/** The result of a shell command in `cwd`. With `check`, a non-zero exit throws. */
async function shell(calls: Calls, cwd: string, cmd: string | string[], check: boolean): Promise<JsonValue> {
	// A string is `sh -c <cmd>`; an array is the program `cmd[0]` with the arguments `cmd.slice(1)` and no shell.
	const [file = "", ...rest] = typeof cmd === "string" ? ["sh", "-c", cmd] : cmd;
	const result = await run(file, rest, cwd, calls.runtime.signal);
	if (check && result.code !== 0) {
		if (typeof cmd !== "string") throw new Error(failure(cmd, result));
		const stderr = result.stderr.trim();
		throw new Error(`sh exited with ${result.code}: ${cmd}${stderr === "" ? "" : `\n${stderr}`}`);
	}
	return result;
}

/**
 * The result of the child run of the `run` call: the saved child task, or a new one, run to its end. A saved child task
 * that ended without completing gets a new child task with the same input and run ID. Throws
 * `child run <id> failed: <error>` when the child run fails.
 */
async function childResult(calls: Calls, script: ScriptRun, name: string, args: JsonObject): Promise<JsonValue> {
	const { runtime, context } = calls;
	const key = callKey(calls, "run", { name, args });
	const start = { kind: "run" as const, args: { name, args } };
	// The child task is the result of the call; the call ends when the child run ends.
	const started = (await memoized(calls, key, start, () => script.child(key, name, args), false)) as Child;
	const { state } = (await runtime.getTask(started.task, context)) ?? {};
	const ended = state?.status === "terminal" && state.outcome.status !== "completed";
	const { task, runId } = ended ? await script.restart(key, started.task) : started;
	const { outcome } = (await runtime.waitForTask(task, context)).state;
	const ending = (await runtime.snapshot(CallDoc, key, context))?.endedAt === undefined;
	if (outcome.status !== "completed") {
		const error = new Error(`child run ${runId} failed: ${outcome.error?.message ?? outcome.reason ?? outcome.status}`);
		if (ending) await endCall(calls, key, { error: error.message });
		throw error;
	}
	if (ending) await endCall(calls, key, {});
	return { runId, result: outcome.result };
}

function global(name: string, execute: (...values: never[]) => unknown): CodemodeTool {
	return { name, spread: true, execute: (values) => execute(...(values as never[])) };
}

/**
 * `workflows-answer` is for script sessions: the `respond` tool of a `schema` ask, and the `answer_schema` section that
 * shows the schema to the model.
 */
export const answerExtension = defineExtension({
	name: ANSWER,
	tools: [respond],
	sections: [
		section("answer_schema", async ({ read, conversationId }, context) => {
			const schema = (await read.snapshot(AnswerDoc, conversationId, context))?.schema;
			return schema && `The answer of respond must match this JSON Schema:\n${JSON.stringify(schema)}`;
		}),
	],
});

/**
 * Runs `script.bundle.main` with `script.args` in `cwd` and returns its value. It throws the error of a failed script,
 * or the reason of the abort when a closing store cancels the script.
 */
export async function runScript(
	runtime: Runtime,
	context: Context,
	cwd: string,
	host: ExtensionHost,
	script: ScriptRun,
): Promise<JsonValue> {
	const { bundle, args } = script;
	// A module export is a syntax error in the function body that the script runs as.
	const source = bundle.main.replace(META, "$1$2");
	const progress: Progress = { lines: [], log: host.log, phase: null };
	const calls: Calls = { runId: script.runId, runtime, context, counters: new Map(), progress };
	const sandbox = new CodemodeSandbox({
		timeoutMs: Number.POSITIVE_INFINITY,
		globals: [
			global("__session", (profile: string) => {
				const args = { profile };
				return memoized(calls, callKey(calls, "session", args), { kind: "session", args }, (key) =>
					sessionOf(calls, key, cwd, bundle, profile),
				);
			}),
			// The sandbox sends a missing schema as null.
			global("__ask", (conversation: ConversationId, prompt: string, schema: JsonObject | null, profile: string) => {
				const args = { conversation, prompt, schema, profile };
				return memoized(calls, callKey(calls, "ask", args), { kind: "ask", args }, (key) =>
					askTurn(calls, key, conversation, prompt, schema),
				);
			}),
			global("__agent", (profile: string, prompt: string, schema: JsonObject | null) => {
				const args = { profile, prompt, schema };
				return memoized(calls, callKey(calls, "agent", args), { kind: "agent", args }, async (key) =>
					askTurn(calls, key, await sessionOf(calls, key, cwd, bundle, profile), prompt, schema),
				);
			}),
			global("__sh", (cmd: string | string[], check: boolean) => {
				const args = { cmd, check };
				return memoized(calls, callKey(calls, "sh", args), { kind: check ? "sh" : "ok", args }, () =>
					shell(calls, cwd, cmd, check),
				);
			}),
			// The name and the args are in the key, so a resume that reorders different `run` calls keeps each child run.
			// The saved child task is waited for again; a failed one gets a new child task.
			global("__run", (name: string, values: JsonObject) => childResult(calls, script, name, values)),
			global("phase", (title: string) => phaseLine(progress, String(title))),
			global("log", (line: string) => progress.lines.push({ text: String(line), phase: false })),
			global("__prompt", (name: string, inputs?: Record<string, string> | null) => {
				const body = bundle.prompts[name];
				if (body === undefined) throw new Error(`no prompt ${name}`);
				return render(body, inputs ?? {});
			}),
		],
	});
	const { signal } = runtime;
	let result: Awaited<ReturnType<CodemodeSandbox["execute"]>>;
	try {
		const wrapped = `${prelude(args, Object.keys(bundle.prompts), script)}\nreturn await (async () => {\n${source}\n})();`;
		result = await sandbox.execute(wrapped, { signal });
	} finally {
		await sandbox.close();
		print(progress);
	}
	if (result.ok) return (result.value ?? null) as JsonValue;
	if (signal.aborted) throw signal.reason;
	throw new Error(result.error.message);
}
