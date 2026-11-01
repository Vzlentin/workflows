/**
 * Workflow scripts. A script is JavaScript that runs in the pi-codemode sandbox in the phase of the run's task, in the
 * harness host of the run's project. Each call it makes saves its result in a document of the project store, keyed by
 * the run ID and the call, so when the script runs again after an interruption or a failure, the finished calls return
 * their saved results and only the rest runs. A call records its kind, args, phase and start time when it starts, and
 * its end time with its result or error when it ends; only a saved result replays, so a failed or stopped call runs
 * again. A failure of the phase ends the task as failed, and a resume runs the script again in a new task of the same
 * run. `run(name, args)` starts a child run as a child task of the caller, with its own run directory, and a resume of
 * the caller continues that child run. Sessions are children of harness's children library, owned by the run's task.
 */
import { createHash } from "node:crypto";
import { once } from "node:events";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Context, JsonValue } from "@earendil-works/chord";
import { withCancel } from "@earendil-works/chord/context";
import { CodemodeSandbox, type CodemodeTool } from "@earendil-works/pi-codemode";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import {
	AgentDoc,
	type CommonDocDefinition,
	type ConversationId,
	defineDocFamily,
	type JsonObject,
	type ModelRef,
	type TaskId,
	type Tx,
} from "@earendil-works/pi-durable";
import type { Children, Failure, Owner, Place, Spec } from "@vzlentin/harness/children";
import type { Overlay } from "@vzlentin/harness/overlay";
import { type Static, type TSchema, Type } from "typebox";
import { Value } from "typebox/value";
import { failure, git, run } from "./git.ts";
import { PAST_OPTIONS, type PastOptions, profileTexts } from "./past.ts";
import { PROGRESS_KIND, type ProgressEvent } from "./progress.ts";
import { instructions, render } from "./prompts.ts";
import type { Runtime } from "./task.ts";

/**
 * An agent profile from `agents/<name>.md`: its model, its thinking level and its body. A session without a model
 * from its call or its profile takes the model of the project agent.
 */
export type Profile = {
	readonly model?: ModelRef;
	readonly thinking?: string;
	readonly instructions: string;
};

/**
 * The scripts, prompt instructions and profiles of the package and the project, and the script lib of the package,
 * saved by a run before it starts.
 */
export type Bundle = {
	readonly scripts: Readonly<Record<string, string>>;
	/** The files of `workflows/lib/` in name order, which the prelude gives every script after the script calls. */
	readonly lib: string;
	readonly prompts: Readonly<Record<string, string>>;
	readonly agents: Readonly<Record<string, Profile>>;
};

/** `T` with fields that a builder sets one by one. */
type Writable<T> = { -readonly [K in keyof T]: T[K] };

/** The bundle of a run and its own script, saved in the run's input. */
export type RunBundle = Bundle & { readonly main: string };

/** What the script task gets from the harness host: the children library and the place of the project's children. */
export type Host = { readonly children: Children; readonly place: Place };

/** A started child run: its task and its run ID. */
export type Child = { readonly task: TaskId<JsonValue>; readonly runId: string };

/** What a script phase runs: its run IDs and directory, bundle and args, and how it starts a child run. */
export type ScriptRun = {
	readonly runId: string;
	/** The run ID of the caller of a child run, or null for a root run. */
	readonly parent: string | null;
	/** The run ID of the root run, which keys the progress of the run and its child runs. */
	readonly root: string;
	readonly runDir: string;
	readonly bundle: RunBundle;
	readonly args: JsonObject;
	/** The files that the sessions of the run see in place of the disk, from the saved input. */
	readonly overlay: Overlay | undefined;
	/** The conversation whose `workflow` tool started the run, from `PI_SESSION_ID`. */
	readonly session: string | undefined;
	/** The answer to the `input` call with the document key `call`, from `resume --answer`. */
	readonly answer: { readonly call: string; readonly text: string } | undefined;
	/** Starts the child run of the `run` call `key` and saves it as the result of the call. */
	child(key: string, name: string, args: JsonObject): Promise<Child>;
	/** Starts a new child task with the input of the ended child task `ended`, and saves it as the result of `key`. */
	restart(key: string, ended: TaskId<JsonValue>): Promise<Child>;
	/** The completed root runs of `workflow` in the store, as the `pastRuns` script call gives them. */
	pastRuns(workflow: string, options: PastOptions): Promise<JsonValue>;
};

/** The extension of the `workflow` tool, which the entry gives every conversation of the host but the sessions. */
export const TOOL_EXTENSION = "workflows";

/** The script side of the package, in the same shape as a project's `.workflows/`. */
const PACKAGE = fileURLToPath(new URL("../workflows/", import.meta.url));

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

/** The profile of the text of `agents/<name>.md`. */
export function profileOf(name: string, text: string): Profile {
	const { frontmatter, body } = parseFrontmatter<{ model?: string; thinking?: string }>(text);
	const { model, thinking } = frontmatter;
	const profile: Writable<Profile> = { instructions: instructions(body) };

	if (model !== undefined) {
		const [provider = "", ...id] = model.split("/");

		if (provider === "" || id.length === 0) throw new Error(`agents/${name}.md: model must be <provider>/<id>`);
		profile.model = { provider, modelId: id.join("/") };
	}

	if (thinking !== undefined) profile.thinking = thinking;

	return profile;
}

/**
 * The `scripts/*.js`, `prompts/*.md` and `agents/*.md` of the package and of `.workflows/` in the Git repository of
 * `cwd`, or in `cwd` outside a repository, read now, and the `lib/*.js` of the package. Without `cwd`, only the
 * package files. Each `<name>.md` of the folder `prompts` replaces the template of that name.
 */
export async function loadBundle(cwd?: string, prompts?: string): Promise<Bundle> {
	const project = cwd === undefined ? PACKAGE : await projectFolder(cwd);

	const [scripts, merged, profiles, lib] = await Promise.all([
		loadScripts(project),
		readMerged(project, "prompts", ".md"),
		readMerged(project, "agents", ".md"),
		readFolder(PACKAGE, "lib", ".js"),
	]);

	const templates = prompts === undefined ? merged : { ...merged, ...(await overrides(prompts, merged)) };

	return {
		scripts,
		lib: Object.values(lib).join("\n"),
		prompts: Object.fromEntries(Object.entries(templates).map(([name, text]) => [name, instructions(text)])),
		agents: Object.fromEntries(Object.entries(profiles).map(([name, text]) => [name, profileOf(name, text)])),
	};
}

/** The scripts of the package and of the project folder `project`, where a project script replaces the package script of its name. */
export function loadScripts(project: string): Promise<Record<string, string>> {
	return readMerged(project, "scripts", ".js");
}

/** `.workflows/` at the root of the Git repository of `cwd`, or in `cwd` outside a repository. */
export async function projectFolder(cwd: string): Promise<string> {
	const root = await git(cwd, "rev-parse", "--show-toplevel").catch(() => cwd);

	return join(root, ".workflows");
}

/** The leading comments and `export const meta =` of a script that declares its `meta`. */
export const META = /^((?:\s|\/\/[^\n]*|\/\*[\s\S]*?\*\/)*)export\s+(const\s+meta\s*=\s*)/;

/** True when a document change is stored as a complete base: after 31 deltas since the last one. */
const checkpointWhen: CommonDocDefinition<JsonObject>["checkpointWhen"] = (_value, _ops, info) =>
	info.deltasSinceBase >= 31;

/** The sandbox functions that are not host calls, and the script lib; `cwd` is the directory of the script calls. */
function prelude(args: JsonObject, prompts: readonly string[], script: ScriptRun, cwd: string): string {
	const agents = profileTexts(script.bundle.agents);

	return `
const args = ${JSON.stringify(args)};
const runId = ${JSON.stringify(script.runId)};
const runDir = ${JSON.stringify(script.runDir)};
const cwd = ${JSON.stringify(cwd)};
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
const agents = Object.freeze(${JSON.stringify(agents)});
function session(options = "default") {
	const { as = "default", provider, model, thinking } = typeof options === "string" ? { as: options } : (options ?? {});
	const spec = { profile: as };
	if (provider !== undefined) spec.provider = provider;
	if (model !== undefined) spec.model = model;
	if (thinking !== undefined) spec.thinking = thinking;
	const id = __session(spec);
	return { ask: async (prompt, options = {}) => __ask(await id, await prompt, options.schema) };
}
const agent = (prompt, { schema, ...options } = {}) => session(options).ask(prompt, { schema });
const sh = async (cmd) => (await __sh(cmd)).stdout.replace(/\\n$/, "");
const ok = async (cmd) => (await __ok(cmd)).code === 0;
const input = (question) => __input(question);
const pastRuns = (workflow, options) => __pastRuns(workflow, options ?? {});
const run = async (name, args = {}) => {
	const { runId: id, result } = await __run(name, args);
	return result !== null && typeof result === "object" && !Array.isArray(result) ? { ...result, runId: id } : result;
};
${script.bundle.lib}`;
}

/** A JSON value. */
export const JSON_VALUE = Type.Cyclic(
	{
		Json: Type.Union([
			Type.Null(),
			Type.Boolean(),
			Type.Number(),
			Type.String(),
			Type.Array(Type.Ref("Json")),
			Type.Record(Type.String(), Type.Ref("Json")),
		]),
	},
	"Json",
);

const CALL_KINDS = Type.Union([
	Type.Literal("session"),
	Type.Literal("ask"),
	Type.Literal("sh"),
	Type.Literal("ok"),
	Type.Literal("run"),
	Type.Literal("input"),
	Type.Literal("pastRuns"),
]);

/** The kinds of script calls. */
export type CallKind = Static<typeof CALL_KINDS>;

/**
 * One script call: its kind, its args, the phase line that was current when it started, its start and end times as ISO
 * strings, and its result or its error. A call that started and did not end has no `endedAt`. The `conversation` of a
 * `session` call is its session, and the `child` of a `run` call is its child run, so a stopped call reuses them.
 */
export const CALL_RECORD = Type.Object({
	kind: CALL_KINDS,
	args: Type.Record(Type.String(), JSON_VALUE),
	phase: Type.Union([Type.String(), Type.Null()]),
	startedAt: Type.String(),
	endedAt: Type.Optional(Type.String()),
	result: Type.Optional(JSON_VALUE),
	error: Type.Optional(Type.String()),
	conversation: Type.Optional(Type.Number()),
	child: Type.Optional(Type.Object({ task: Type.Number(), runId: Type.String() })),
});

/** A call record as the command reads it from the store file, where its IDs are plain numbers. */
export type SavedCall = Static<typeof CALL_RECORD>;

/** A call record, with the pi-durable types of its IDs. */
export type CallRecord = Omit<SavedCall, "conversation" | "child"> & { conversation?: ConversationId; child?: Child };

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
	checkpointWhen,
});

/**
 * The `phase` and `log` lines and the ends of a root run and its child runs, in commit order, keyed by the root run ID.
 * The command reads them from the store file while it follows the run.
 */
export const ProgressDoc = defineDocFamily<{ events: ProgressEvent[] }, null>({
	kind: PROGRESS_KIND,
	version: 1,
	scope: "session",
	family: true,
	initial: () => ({ events: [] }),
	checkpointWhen,
});

/**
 * One session of a run: its run ID, its conversation, the task that opened it, and `label`, the name of the agent profile
 * that opened it. A record that an earlier version saved can have no `label`.
 */
export type OpenedSession = { run: string; conversation: ConversationId; task: number; label?: string };

/**
 * The sessions of a root run and its child runs, keyed by the root run ID, so the end of a run closes them, also those
 * of an earlier task of the run.
 */
export const SessionsDoc = defineDocFamily<{ sessions: OpenedSession[] }, null>({
	kind: "workflows.sessions",
	version: 1,
	scope: "session",
	family: true,
	checkpointWhen: () => false,
	initial: () => ({ sessions: [] }),
});

/** Appends `events` to the progress of the root run `root`. */
export async function addProgress(tx: Tx, root: string, events: readonly ProgressEvent[]): Promise<void> {
	if (events.length === 0) return;
	(await tx.doc(ProgressDoc, root, null)).events.push(...events);
}

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

/** A `phase` or `log` line, with the time of its call in ms since the epoch, or the `title` of the run. */
type Line =
	| { readonly kind: "phase" | "log"; readonly text: string; readonly at: number }
	| { readonly kind: "title"; readonly text: string };

/**
 * The lines of a script that wait for its next call that runs, in order. At most one is a phase line: a new phase line
 * replaces it. `phase` is the current phase line, which each call that starts records.
 */
type Progress = { readonly lines: Line[]; phase: string | null; continued?: boolean };

function phaseLine(progress: Progress, text: string): void {
	progress.phase = text;
	const { lines } = progress;
	lines.splice(0, lines.length, ...lines.filter((line) => line.kind !== "phase"), {
		kind: "phase",
		text,
		at: Date.now(),
	});
}

/** What the calls of one script execution share. */
type Calls = {
	readonly script: ScriptRun;
	readonly runtime: Runtime;
	readonly context: Context;
	readonly counters: Map<string, number>;
	readonly progress: Progress;
	readonly host: Host;
	/** The owner of the run's sessions: the task, in the group of the run ID, so a later task of the run finds them. */
	readonly owner: Owner;
	/** The question of the `input` call that the run waits for an answer to. */
	waiting?: string;
};

/** Takes the waiting lines as progress events of the run. The first phase line of the execution `continues`. */
function takeLines(calls: Calls): ProgressEvent[] {
	const { runId: run, parent } = calls.script;
	const { progress } = calls;

	return progress.lines.splice(0).map((line) => {
		if (line.kind === "title") return { kind: "title", run, text: line.text };

		if (line.kind === "log") return { kind: "log", run, parent, text: line.text, at: line.at };
		const event: ProgressEvent = { kind: "phase", run, parent, text: line.text, at: line.at };

		if (progress.continued === true) return event;
		progress.continued = true;

		return { ...event, continues: true };
	});
}

/** The document key of the call `name` with `args` in this execution: `<run ID>/<call key>`. */
function callKey(calls: Calls, name: string, args: JsonObject): string {
	return `${calls.script.runId}/${keyOf(name, args, calls.counters)}`;
}

/** What a call records when it starts. */
type Start = { readonly kind: CallKind; readonly args: JsonObject };

/**
 * The result of the call `key`: its saved result, or the value of `effect`, which gets the key. The call records its
 * start, with the waiting lines, before `effect`, and its end with the value or the error after it. A stopped call
 * records no end, and a call that throws saves no result, so both run again. A call with a saved result drops the log
 * lines and keeps the phase line, so a resume shows the phase of the first call that runs.
 */
async function memoized(
	calls: Calls,
	key: string,
	start: Start,
	effect: (key: string) => Promise<JsonValue>,
): Promise<JsonValue> {
	const { runtime, context, progress } = calls;
	const saved = await savedCall(runtime, key, context);
	const { lines } = progress;

	if (saved !== undefined) {
		lines.splice(0, lines.length, ...lines.filter((line) => line.kind === "phase"));

		return saved;
	}

	const events = takeLines(calls);
	await runtime.commit(async (tx) => {
		await addProgress(tx, calls.script.root, events);
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

		// A call that the end of its script or task cancelled did not fail, and runs again.
		if (!context.abortSignal?.aborted) await endCall(calls, key, { error: message });
		throw error;
	}

	await endCall(calls, key, { result: value });

	return (await savedCall(runtime, key, context)) ?? value;
}

/** Records the end of the call `key`, with its result, or its error when it failed. */
async function endCall(calls: Calls, key: string, end: { result: JsonValue } | { error: string }): Promise<void> {
	await calls.runtime.commit(async (tx) => {
		const doc = await tx.doc(CallDoc, key, null);
		Object.assign(doc, end);
		doc.endedAt = new Date().toISOString();

		return undefined;
	}, calls.context);
}

/** The args of a `session` call: the profile, and the fields that override it. */
const SESSION_ARGS = Type.Object({
	profile: Type.String(),
	provider: Type.Optional(Type.String()),
	model: Type.Optional(Type.String()),
	thinking: Type.Optional(Type.String()),
});

type SessionArgs = Readonly<Static<typeof SESSION_ARGS>>;

/**
 * Where the sessions of the run sit in the children tree: under the conversation that started the run, when it is the
 * project agent or a conversation of the children library, else in the tree `workflows:<root run ID>`.
 */
async function treeOf(calls: Calls): Promise<{ parent: string } | { root: string }> {
	const { runtime, context, host, script } = calls;
	const { session } = script;

	if (session === undefined) return { root: `workflows:${script.root}` };

	if (session === String(runtime.conversationId)) return { parent: session };
	const lineage = await host.children.lineage(host.place.store, session, context);

	return lineage === undefined ? { root: `workflows:${script.root}` } : { parent: session };
}

/**
 * The session of the call `key`, opened in the children library under the key `wf:<key>` in `cwd`. Each field of
 * `args` overrides the profile, and the profile fills the rest; a field that neither gives comes from the project
 * agent. The session does not get the `workflow` tool. The commit that opens it saves its conversation in the call
 * record and in the sessions of the run. The same key again gives the same session.
 */
async function sessionOf(calls: Calls, key: string, cwd: string, args: SessionArgs): Promise<JsonValue> {
	const { runtime, context, host, script } = calls;
	const profile = script.bundle.agents[args.profile];

	if (profile === undefined) throw new Error(`no agent profile ${args.profile}`);
	const provider = args.provider ?? profile.model?.provider;
	const model = args.model ?? profile.model?.modelId;
	const thinking = args.thinking ?? profile.thinking;

	const spec: Writable<Spec> = { ...(await treeOf(calls)), cwd };

	if (provider !== undefined) spec.provider = provider;

	if (model !== undefined) spec.model = model;

	if (thinking !== undefined) spec.thinking = thinking;

	if (profile.instructions !== "") spec.instructions = profile.instructions;

	if (script.overlay !== undefined) spec.overlay = script.overlay;

	const child = await host.children.open(
		host.place,
		calls.owner,
		`wf:${key}`,
		spec,
		context,
		async (tx, conversation) => {
			// The library has set the object form of the selection, which adds its answer extension to the host default.
			const agent = await tx.doc(AgentDoc, conversation);
			const selection = agent.extensions;

			if (!Array.isArray(selection)) {
				agent.extensions = { ...selection, remove: [...(selection?.remove ?? []), TOOL_EXTENSION] };
			}

			(await tx.doc(CallDoc, key, null)).conversation = conversation;
			const opened = await tx.doc(SessionsDoc, script.root, null);
			const record: OpenedSession = { run: script.runId, conversation, task: runtime.taskId };

			if (args.profile !== "") record.label = args.profile;
			opened.sessions.push(record);
		},
	);

	return child.id;
}

/**
 * One turn in the session `conversation`. The call's key is the request ID, so an interrupted ask continues its turn,
 * and the library sends a failed one again as `<key>#2`, `#3`. A turn without an answer that counts throws.
 */
async function askTurn(
	calls: Calls,
	key: string,
	conversation: number,
	prompt: string,
	schema: JsonObject | null,
): Promise<JsonValue> {
	const { host, context } = calls;
	const child = await host.children.find(host.place, calls.owner, { id: String(conversation) }, context);

	if (child === undefined) throw new Error(`Session ${conversation} is missing`);
	const input = { type: "input", content: prompt, requestId: key } as const;

	if (schema !== null) {
		const answer = await child.ask(input, context, { schema });

		if (answer.status === "ok") return answer.value;

		return failed(key, answer);
	}

	const answer = await child.ask(input, context);

	return answer.status === "ok" ? answer.text : failed(key, answer);
}

/** Throws the error of the turn `key` whose answer does not count. */
function failed(key: string, answer: Failure): never {
	if (answer.reason === "cut") throw new Error(`The ${key} turn stopped: ${answer.stopReason}`);

	if (answer.reason === "no-respond") throw new Error("the answer did not call respond");
	const detail = answer.detail === undefined ? "" : ` ${JSON.stringify(answer.detail)}`;
	throw new Error(`The ${key} turn was not answered: ${answer.cause}${detail}`);
}

/** The result of a shell command in `cwd`. With `check`, a non-zero exit throws. */
async function shell(calls: Calls, cwd: string, cmd: string | string[], check: boolean): Promise<JsonValue> {
	// A string is `sh -c <cmd>`; an array is the program `cmd[0]` with the arguments `cmd.slice(1)` and no shell.
	const [file = "", ...rest] = Array.isArray(cmd) ? cmd : ["sh", "-c", cmd];
	const result = await run(file, rest, cwd, calls.context.abortSignal);

	if (check && result.code !== 0) {
		if (Array.isArray(cmd)) throw new Error(failure(cmd, result));
		const stderr = result.stderr.trim();
		throw new Error(`sh exited with ${result.code}: ${cmd}${stderr === "" ? "" : `\n${stderr}`}`);
	}

	return result;
}

/**
 * The result of the child run of the `run` call `key`: the `child` of its record, or a new child task, run to its end.
 * A saved child task that ended without completing gets a new child task with the same input and run ID. Throws
 * `child run <id> failed: <error>` when the child run fails.
 */
async function childResult(
	calls: Calls,
	key: string,
	script: ScriptRun,
	name: string,
	args: JsonObject,
): Promise<JsonValue> {
	const { runtime, context } = calls;
	const saved = (await runtime.snapshot(CallDoc, key, context))?.child;
	const started = saved ?? (await script.child(key, name, args));
	const { state } = (await runtime.getTask(started.task, context)) ?? {};
	const ended = state?.status === "terminal" && state.outcome.status !== "completed";
	const { task, runId } = ended ? await script.restart(key, started.task) : started;
	const { outcome } = (await runtime.waitForTask(task, context)).state;

	if (outcome.status !== "completed") {
		const cause = outcome.error?.message ?? outcome.reason ?? outcome.status;

		// The error of a nested child run already names the deepest run that failed.
		throw new Error(cause.startsWith("child run ") ? cause : `child run ${runId} failed: ${cause}`);
	}

	return { runId, result: outcome.result };
}

const JSON_OBJECT = Type.Record(Type.String(), JSON_VALUE);
const ASK_ARGS = Type.Tuple([Type.Number(), Type.String(), Type.Union([JSON_OBJECT, Type.Null()])]);
const SH_ARGS = Type.Tuple([Type.Union([Type.String(), Type.Array(Type.String())])]);
const RUN_ARGS = Type.Tuple([Type.String(), JSON_OBJECT]);
const INPUT_ARGS = Type.Tuple([Type.String()]);
const PAST_ARGS = Type.Tuple([Type.String(), PAST_OPTIONS]);
const LINE_ARGS = Type.Array(JSON_VALUE);
const PROMPT_ARGS = Type.Tuple([Type.String(), Type.Union([Type.Record(Type.String(), Type.String()), Type.Null()])]);

type ValidationError = ReturnType<typeof Value.Errors>[number];

/**
 * The deepest of `errors`, as `<path> <problem>`. An `anyOf` error only says that no member matched, so the error of
 * the member that matched deepest is the specific one.
 */
function argumentError(errors: readonly ValidationError[]): string {
	const specific = errors.filter((error) => error.keyword !== "anyOf");

	const deepest = specific.reduce<ValidationError | undefined>(
		(found, error) => (found === undefined || error.instancePath.length > found.instancePath.length ? error : found),
		undefined,
	);

	return `${deepest?.instancePath} ${deepest?.message}`;
}

/** A `sh` call when `check` is true, else an `ok` call. */
function shellCall(calls: Calls, cwd: string, cmd: string | string[], check: boolean): Promise<JsonValue> {
	const args = { cmd, check };

	return memoized(calls, callKey(calls, "sh", args), { kind: check ? "sh" : "ok", args }, () =>
		shell(calls, cwd, cmd, check),
	);
}

/**
 * The `input` call with `question`: the saved answer, or the answer of `resume --answer` to this call. Without one, the
 * first such call stops the script with `stop` and leaves its record open, so `resume --answer` finds its key. A second
 * call that would wait only rejects, so the answer has one call.
 */
async function inputCall(calls: Calls, question: string, stop: AbortController): Promise<JsonValue> {
	const args = { question };
	const key = callKey(calls, "input", args);
	const start = { kind: "input", args } as const;
	const { answer } = calls.script;

	if (answer?.call === key) return memoized(calls, key, start, async () => answer.text);
	const saved = await savedCall(calls.runtime, key, calls.context);

	if (saved !== undefined) return memoized(calls, key, start, async () => saved);

	if (calls.waiting !== undefined) throw new Error(`the run waits for an answer to: ${calls.waiting}`);
	calls.waiting = question;

	// The effect never resolves: it stops the script, and throws once the end of the script cancels the calls, so the
	// call records no error and its record stays open.
	return memoized(calls, key, start, async () => {
		stop.abort();
		const signal = calls.context.abortSignal;

		if (signal !== undefined && !signal.aborted) await once(signal, "abort");
		throw new Error(`the run waits for an answer to: ${question}`);
	});
}

/** The owner of the sessions of the run `runId`, whose task `runtime` runs. */
export function ownerOf(runtime: Runtime, runId: string): Owner {
	return { kind: "task", taskId: runtime.taskId, conversation: runtime.conversationId, group: runId };
}

/**
 * Runs `script.bundle.main` with `script.args` in `cwd` and returns its value. When an `input` call waits for an answer,
 * the value is `{ status: "waiting", question, report: [question] }`. It throws the error of a failed script,
 * or the reason of the abort when a closing store cancels the script.
 */
export async function runScript(
	runtime: Runtime,
	context: Context,
	cwd: string,
	host: Host,
	script: ScriptRun,
): Promise<JsonValue> {
	const { bundle, args } = script;
	// A module export is a syntax error in the function body that the script runs as.
	const source = bundle.main.replace(META, "$1$2");
	const progress: Progress = { lines: [], phase: null };
	const owner = ownerOf(runtime, script.runId);
	// The sandbox settles when the script ends and drops the host calls that still run, but they would go on: after the
	// end of the script, the calls are cancelled, and the script ends only once they settled. So a failed run ends its
	// sessions after its last ask was submitted and its last session opened.
	const execution = withCancel(context);
	const calls: Calls = { script, runtime, context: execution.context, counters: new Map(), progress, host, owner };
	const running = new Set<Promise<unknown>>();
	const stop = new AbortController();

	const global = <T extends TSchema>(
		name: string,
		schema: T,
		execute: (values: Static<T>) => Promise<JsonValue> | JsonValue | void,
	): CodemodeTool => ({
		name,
		spread: true,
		execute: (values) => {
			if (!Value.Check(schema, values)) {
				throw new Error(`${name.replace(/^__/, "")} got bad arguments: ${argumentError(Value.Errors(schema, values))}`);
			}

			const result = execute(values);

			if (result instanceof Promise) {
				running.add(result);
				const settled = () => running.delete(result);
				result.then(settled, settled);
			}

			return result;
		},
	});

	const sandbox = new CodemodeSandbox({
		timeoutMs: Number.POSITIVE_INFINITY,
		globals: [
			global("__session", Type.Tuple([SESSION_ARGS]), ([args]) =>
				memoized(calls, callKey(calls, "session", args), { kind: "session", args }, (key) =>
					sessionOf(calls, key, cwd, args),
				),
			),
			// The sandbox sends a missing schema as null.
			global("__ask", ASK_ARGS, ([conversation, prompt, schema]) => {
				const args = { conversation, prompt, schema };

				return memoized(calls, callKey(calls, "ask", args), { kind: "ask", args }, (key) =>
					askTurn(calls, key, conversation, prompt, schema),
				);
			}),
			global("__sh", SH_ARGS, ([cmd]) => shellCall(calls, cwd, cmd, true)),
			global("__ok", SH_ARGS, ([cmd]) => shellCall(calls, cwd, cmd, false)),
			// The name and the args are in the key, so a resume that reorders different `run` calls keeps each child run.
			// An unfinished saved child task is waited for again; a failed one gets a new child task.
			global("__run", RUN_ARGS, ([name, values]) => {
				const args = { name, args: values };

				return memoized(calls, callKey(calls, "run", args), { kind: "run", args }, (key) =>
					childResult(calls, key, script, name, values),
				);
			}),
			global("__input", INPUT_ARGS, ([question]) => inputCall(calls, question, stop)),
			// A resume replays the saved list, so runs that end later do not change it.
			global("__pastRuns", PAST_ARGS, ([workflow, options]) => {
				const args = { workflow, options };

				return memoized(calls, callKey(calls, "pastRuns", args), { kind: "pastRuns", args }, () =>
					script.pastRuns(workflow, options),
				);
			}),
			global("phase", LINE_ARGS, ([title]) => phaseLine(progress, String(title))),
			global("log", LINE_ARGS, ([line]) => progress.lines.push({ kind: "log", text: String(line), at: Date.now() })),
			global("title", LINE_ARGS, ([text]) => progress.lines.push({ kind: "title", text: String(text) })),
			global("__prompt", PROMPT_ARGS, ([name, inputs]) => {
				const body = bundle.prompts[name];

				if (body === undefined) throw new Error(`no prompt ${name}`);

				return render(body, inputs ?? {});
			}),
		],
	});

	const { signal } = runtime;
	let result: Awaited<ReturnType<CodemodeSandbox["execute"]>>;

	try {
		const wrapped = `${prelude(args, Object.keys(bundle.prompts), script, cwd)}\nreturn await (async () => {\n${source}\n})();`;
		result = await sandbox.execute(wrapped, { signal: AbortSignal.any([signal, stop.signal]) });
	} finally {
		await sandbox.close();
		execution.cancel();
		await Promise.allSettled(running);
		const events = takeLines(calls);

		// A cancelled task cannot commit; its lines are lost, and a resume shows the phase of its first call again.
		if (events.length > 0 && !signal.aborted) {
			await runtime.commit(async (tx) => {
				await addProgress(tx, script.root, events);

				return undefined;
			}, context);
		}
	}

	if (calls.waiting !== undefined) {
		if (signal.aborted) throw signal.reason;
		const question = calls.waiting;

		return { status: "waiting", question, report: [question] };
	}

	if (result.ok) {
		const value = result.value ?? null;

		if (!Value.Check(JSON_VALUE, value)) throw new Error("the script result is not JSON");

		return value;
	}

	if (signal.aborted) throw signal.reason;
	throw new Error(result.error.message);
}
