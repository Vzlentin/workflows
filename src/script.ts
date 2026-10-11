/**
 * Workflow scripts. A script is JavaScript that runs in the pi-codemode sandbox in the phase of the run's task. Each
 * call it makes saves its result as a keyed memo of the task, so when the phase runs again after an interruption, the
 * finished calls return their saved results and only the rest runs. A call that fails saves nothing. A script failure
 * keeps the task pending: the command stops, and a resume runs the script again. `run(name, args)` starts a child run
 * with its own run directory and store, and a resume of the caller continues that child run.
 */
import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Context, JsonValue } from "@earendil-works/chord";
import {
	type ModelThinkingLevel,
	type TextContent,
	type TSchema,
	Type,
	validateToolArguments,
} from "@earendil-works/pi-ai";
import { CodemodeSandbox, type CodemodeTool } from "@earendil-works/pi-codemode";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import {
	type ConversationId,
	configure,
	defineDoc,
	defineExtension,
	defineTool,
	type JsonObject,
	type ModelRef,
	section,
	type TaskRuntime,
} from "@earendil-works/pi-durable";
import { sessionAgent } from "./agents.ts";
import { failure, git, run } from "./git.ts";
import { instructions, render } from "./prompts.ts";
import { type Checkpoint, newRunId, type Stored, sessionOf, textOf } from "./workflow.ts";

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

/** A `run(name, args)` call of a workflow script: its child run ID, and the bundle and directory of the caller. */
export type ChildRequest = {
	readonly id: string;
	readonly name: string;
	readonly args: JsonObject;
	readonly bundle: RunBundle;
	readonly cwd: string;
};

/** What a script run gets from the command. */
export type ExtensionHost = {
	/** The run ID, which is the base name of `runDir`. */
	readonly runId: string;
	/** The run directory. */
	readonly runDir: string;
	/** Writes one progress line. */
	log(line: string): void;
	/** Stops the command with `message` as a resumable failure; the run's task stays pending. */
	fail(message: string): void;
	/**
	 * The result of the child run `request.id`. The first call starts the run, and a later call continues it. Throws
	 * `child run <id> failed: <error>` when the run fails.
	 */
	child(request: ChildRequest, signal: AbortSignal): Promise<JsonValue>;
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
const run = async (name, args = {}) => {
	const id = await __newRun(name, args);
	const result = await __child(id, name, args);
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

type Runtime = TaskRuntime<Stored, Checkpoint, JsonValue, object>;

/** What the calls of one script execution share. */
type Calls = {
	readonly runtime: Runtime;
	readonly context: Context;
	readonly counters: Map<string, number>;
	readonly progress: Progress;
};

/**
 * The result of the call `name` with `args`: its saved memo, or the value of `effect`, which gets the call's key and
 * whose value is saved. A call that throws saves nothing, so it runs again. The waiting lines print when the call runs.
 * A call with a saved result drops the log lines and keeps the phase line, so a resume prints the phase of the first
 * call that runs.
 *
 * Each memo commit rewrites the task record with all its memos, so the saved output costs O(n^2) to write over a run.
 * When that is too slow, save each call as its own doc.
 */
async function memoized(
	calls: Calls,
	name: string,
	args: JsonObject,
	effect: (key: string) => Promise<JsonValue>,
): Promise<JsonValue> {
	const { runtime, context, progress } = calls;
	const key = keyOf(name, args, calls.counters);
	const saved = await runtime.memo<JsonValue>(key, context);
	const { lines } = progress;
	if (saved !== undefined) {
		lines.splice(0, lines.length, ...lines.filter((line) => line.phase));
		return saved;
	}
	print(progress);
	return runtime.memo(key, await effect(key), context);
}

/** Opens a session of the agent profile `name` in `cwd`; the task owns its conversation. */
async function openSession(calls: Calls, cwd: string, bundle: RunBundle, name: string): Promise<JsonValue> {
	const profile = bundle.agents[name];
	if (profile === undefined) throw new Error(`no agent profile ${name}`);
	const { runtime, context } = calls;
	let id: ConversationId | undefined;
	await runtime.commit(async (tx) => {
		const created = await tx.createConversation({ ownership: { kind: "task", taskId: runtime.taskId } });
		await configure(tx, created.id, {
			...sessionAgent(profile, cwd),
			...(profile.instructions === "" ? {} : { instructions: profile.instructions }),
			extensions: { add: [{ name: ANSWER }] },
			modelTools: { remove: [respond] },
		});
		id = created.id;
		return undefined;
	}, context);
	return id as ConversationId;
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
	const answer = await sessionOf(runtime, conversation, context).turn(key, prompt);
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
 * Runs `bundle.main` with `args` in `cwd`, and commits its value as the run's result. A script failure is reported to
 * `host`, and the phase waits for the store to close: a failed task would drop the saved calls, so the task stays
 * pending and a resume runs the script again.
 */
export async function runScriptPhase(
	runtime: Runtime,
	context: Context,
	cwd: string,
	bundle: RunBundle,
	args: JsonObject,
	host: ExtensionHost,
): Promise<void> {
	// A module export is a syntax error in the function body that the script runs as.
	const source = bundle.main.replace(META, "$1$2");
	const progress: Progress = { lines: [], log: host.log };
	const calls: Calls = { runtime, context, counters: new Map(), progress };
	const sandbox = new CodemodeSandbox({
		timeoutMs: Number.POSITIVE_INFINITY,
		globals: [
			global("__session", (profile: string) =>
				memoized(calls, "session", { profile }, () => openSession(calls, cwd, bundle, profile)),
			),
			// The sandbox sends a missing schema as null.
			global("__ask", (conversation: number, prompt: string, schema: JsonObject | null) =>
				memoized(calls, "ask", { conversation, prompt, schema }, (key) =>
					askTurn(calls, key, conversation as ConversationId, prompt, schema),
				),
			),
			global("__sh", (cmd: string | string[], check: boolean) =>
				memoized(calls, "sh", { cmd, check }, () => shell(calls, cwd, cmd, check)),
			),
			// The name and the args are in the key, so a resume that reorders different `run` calls keeps each child run.
			// The saved `new_run` keeps the child's ID, also for a `child` call that fails and runs again.
			global("__newRun", (name: string, values: JsonObject) =>
				memoized(calls, "new_run", { name, args: values }, async () => newRunId()),
			),
			global("__child", (id: string, name: string, values: JsonObject) =>
				memoized(calls, "child", { id, name, args: values }, () =>
					host.child({ id, name, args: values, bundle, cwd }, runtime.signal),
				),
			),
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
		const wrapped = `${prelude(args, Object.keys(bundle.prompts), host)}\nreturn await (async () => {\n${source}\n})();`;
		result = await sandbox.execute(wrapped, { signal });
	} finally {
		await sandbox.close();
		print(progress);
	}
	if (result.ok) {
		const value = (result.value ?? null) as JsonValue;
		await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: value } }), context);
		return;
	}
	if (signal.aborted) throw signal.reason;
	host.fail(result.error.message);
	await new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
}
