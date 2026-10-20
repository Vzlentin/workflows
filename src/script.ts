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
import { randomInt } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Context, JsonValue } from "@earendil-works/chord";
import { withCancel } from "@earendil-works/chord/context";
import {
	type CodemodeHostCall,
	type CodemodeOutcome,
	type CodemodeResult,
	type CodemodeRun,
	CodemodeSandbox,
} from "@earendil-works/pi-codemode";
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
import { type Static, type TSchema, Type } from "typebox";
import { Value } from "typebox/value";
import { failure, git, run } from "./git.ts";
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

/** The scripts, prompt instructions and profiles of the package and the project, saved by a run before it starts. */
export type Bundle = {
	readonly scripts: Readonly<Record<string, string>>;
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
	/** The conversation whose `workflow` tool started the run, from `PI_SESSION_ID`. */
	readonly session: string | undefined;
	/** Starts the child run of the `run` call `key` and saves it as the result of the call. */
	child(key: string, name: string, args: JsonObject): Promise<Child>;
	/** Starts a new child task with the input of the ended child task `ended`, and saves it as the result of `key`. */
	restart(key: string, ended: TaskId<JsonValue>): Promise<Child>;
};

/** The extension of the `workflow` tool, which the entry gives every conversation of the host but the sessions. */
export const TOOL_EXTENSION = "workflows";

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
 * The `workflows/*.js`, `prompts/*.md` and `agents/*.md` of the package and of `.workflows/` in the Git repository of
 * `cwd`, or in `cwd` outside a repository, read now. Without `cwd`, only the package files. Each `<name>.md` of the
 * folder `prompts` replaces the template of that name.
 */
export async function loadBundle(cwd?: string, prompts?: string): Promise<Bundle> {
	const project = cwd === undefined ? PACKAGE : await projectFolder(cwd);

	const [scripts, merged, profiles] = await Promise.all([
		loadScripts(project),
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

/** The scripts of the package and of the project folder `project`, where a project script replaces the package script of its name. */
export function loadScripts(project: string): Promise<Record<string, string>> {
	return readMerged(project, "workflows", ".js");
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

/** The sandbox functions that are not host calls. */
function prelude(args: JsonObject, prompts: readonly string[], script: ScriptRun): string {
	return `
const args = ${JSON.stringify(args)};
const runId = ${JSON.stringify(script.runId)};
const runDir = ${JSON.stringify(script.runDir)};
const prompts = Object.fromEntries(
	${JSON.stringify(prompts)}.map((name) => [name, (inputs) => __prompt(name, inputs)]),
);
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

/** One session of a run: its run ID, its conversation, and the task that opened it. */
export type OpenedSession = { run: string; conversation: ConversationId; task: number };

/**
 * The sessions of a root run and its child runs, keyed by the root run ID, so the end of a run closes them, also those
 * of an earlier task of the run.
 */
export const SessionsDoc = defineDocFamily<{ sessions: OpenedSession[] }, null>({
	kind: "workflows.sessions",
	version: 1,
	scope: "session",
	family: true,
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

/**
 * One result that the script got, in the order it got them: the VM's ID of the call, the VM clock while the script
 * processed it, and the call's name. A host call that has a record also has its key, and `failed` when it failed.
 */
type Entry = { id: number; at: number; name: string; key?: string; failed?: true };

/**
 * The journal of a run's script: its start time and seed, the fingerprint of its VM, the cuts, and its results in the
 * order the script got them. Given the same start time, seed and results in the same order, the VM makes the same
 * calls with the same IDs, so a new task of the run replays the journal and goes on from there. A cut is the number of
 * calls that the script had made when a new task dropped the failed results and what came after them: a call made
 * after a cut is on another path than the call with its ID before the cut, so it gets another key.
 */
type Journal = { startedAt: number; seed: number; fingerprint?: string; cuts: number[]; entries: Entry[] };

/** The journal of each run, keyed by its run ID. The store keeps it after its task ends, so a new task of the run finds it. */
export const JournalDoc = defineDocFamily<Journal, null>({
	kind: "workflows.journal",
	version: 1,
	scope: "session",
	family: true,
	initial: () => ({ startedAt: 0, seed: 0, cuts: [], entries: [] }),
	checkpointWhen,
});

/** `<generation>.<VM call ID>`, the generation counting the cuts before the call. */
function keyOf(id: number, cuts: readonly number[]): string {
	return `${cuts.filter((cut) => cut < id).length}.${id}`;
}

/** A `phase` or `log` line. */
type Line = { readonly text: string; readonly phase: boolean };

/**
 * The lines of a script that wait for its next call that runs, in order. At most one is a phase line: a new phase line
 * replaces it. `phase` is the current phase line, which each call that starts records.
 */
type Progress = { readonly lines: Line[]; phase: string | null };

function phaseLine(progress: Progress, text: string): void {
	progress.phase = text;
	const { lines } = progress;
	lines.splice(0, lines.length, ...lines.filter((line) => !line.phase), { text, phase: true });
}

/** What the calls of one script execution share. */
type Calls = {
	readonly script: ScriptRun;
	readonly runtime: Runtime;
	readonly context: Context;
	readonly progress: Progress;
	readonly host: Host;
	/** The owner of the run's sessions: the task, in the group of the run ID, so a later task of the run finds them. */
	readonly owner: Owner;
};

/** Takes the waiting lines as progress events of the run. */
function takeLines(calls: Calls): ProgressEvent[] {
	const { runId: run, parent } = calls.script;

	return calls.progress.lines
		.splice(0)
		.map((line) => ({ kind: line.phase ? "phase" : "log", run, parent, text: line.text }) as const);
}

/** What a call records when it starts. */
type Start = { readonly kind: CallKind; readonly args: JsonObject };

/** The script took another path than the journal of its run. */
class Diverged extends Error {}

/**
 * The result of the call `key`: its saved result, or the value of `effect`, which gets the key. The call records its
 * start, with the waiting lines, before `effect`, and its end with the value or the error after it. A stopped call
 * records no end, and a call that throws saves no result, so both run again. A call with a saved result drops the log
 * lines and keeps the phase line, so a resume shows the phase of the first call that runs. A record of another kind or
 * args under the key means that the script took another path.
 */
async function memoized(
	calls: Calls,
	key: string,
	start: Start,
	effect: (key: string) => Promise<JsonValue>,
): Promise<JsonValue> {
	const { runtime, context, progress } = calls;
	const record = await runtime.snapshot(CallDoc, key, context);
	const { lines } = progress;

	if (
		record !== undefined &&
		record.startedAt !== "" &&
		(record.kind !== start.kind || !Value.Equal(record.args, start.args))
	) {
		throw new Diverged(`the script made another ${start.kind} call than the saved call ${key}`);
	}

	const saved = record !== undefined && "result" in record ? record.result : undefined;

	if (saved !== undefined) {
		lines.splice(0, lines.length, ...lines.filter((line) => line.phase));

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
			opened.sessions.push({ run: script.runId, conversation, task: runtime.taskId });
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
		throw new Error(`child run ${runId} failed: ${outcome.error?.message ?? outcome.reason ?? outcome.status}`);
	}

	return { runId, result: outcome.result };
}

const JSON_OBJECT = Type.Record(Type.String(), JSON_VALUE);
const ASK_ARGS = Type.Tuple([Type.Number(), Type.String(), Type.Union([JSON_OBJECT, Type.Null()])]);
const SH_ARGS = Type.Tuple([Type.Union([Type.String(), Type.Array(Type.String())])]);
const RUN_ARGS = Type.Tuple([Type.String(), JSON_OBJECT]);
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
function shellCall(calls: Calls, key: string, cwd: string, cmd: string | string[], check: boolean): Promise<JsonValue> {
	const args = { cmd, check };

	return memoized(calls, key, { kind: check ? "sh" : "ok", args }, () => shell(calls, cwd, cmd, check));
}

/** The owner of the sessions of the run `runId`, whose task `runtime` runs. */
export function ownerOf(runtime: Runtime, runId: string): Owner {
	return { kind: "task", taskId: runtime.taskId, conversation: runtime.conversationId, group: runId };
}

/** A call with args that its host function does not take. It fails the same way each time, so it has no record. */
class BadArguments extends Error {}

/** A host function of the script. A pure one gives the same answer to the same args, and keeps no record. */
type Handler = {
	readonly effect: boolean;
	readonly run: (call: CodemodeHostCall, key: string) => Promise<JsonValue> | JsonValue | void;
};

/** The host function `name`, whose args match `schema`. A call with other args throws `BadArguments`. */
function handler<T extends TSchema>(
	name: string,
	schema: T,
	effect: boolean,
	run: (values: Static<T>, key: string) => Promise<JsonValue> | JsonValue | void,
): Handler {
	return {
		effect,
		run: (call, key) => {
			if (!Value.Check(schema, call.args)) {
				throw new BadArguments(`${name} got bad arguments: ${argumentError(Value.Errors(schema, call.args))}`);
			}

			return run(call.args, key);
		},
	};
}

/**
 * What the script gets for a call: its outcome, the key of a call that has a record, whether that call failed, and the
 * divergence that a saved record of another call showed.
 */
type Answer = {
	readonly outcome: CodemodeOutcome;
	readonly key?: string | undefined;
	readonly failed: boolean;
	readonly diverged?: Diverged;
};

/** The journal of the run `runId`, with its start time and seed set. */
async function startJournal(runtime: Runtime, runId: string, context: Context): Promise<Journal> {
	const saved = await runtime.snapshot(JournalDoc, runId, context);

	if (saved !== undefined && saved.startedAt !== 0) return saved;
	await runtime.commit(async (tx) => {
		const doc = await tx.doc(JournalDoc, runId, null);
		doc.startedAt = Date.now();
		doc.seed = randomInt(2 ** 32);

		return undefined;
	}, context);
	const started = await runtime.snapshot(JournalDoc, runId, context);

	if (started === undefined) throw new Error(`the journal of ${runId} is missing`);

	return started;
}

/** A promise with its settle functions, which the end of the script may reject with nobody waiting. */
function waiter<T>(): PromiseWithResolvers<T> {
	const resolvers = Promise.withResolvers<T>();
	resolvers.promise.catch(() => undefined);

	return resolvers;
}

/**
 * Runs `script.bundle.main` with `script.args` in `cwd` and returns its value. It throws the error of a failed script,
 * or the reason of the abort when a closing store cancels the script.
 *
 * The script runs deterministically in the pi-codemode sandbox: the same start time, seed and results in the same order
 * make the same calls with the same IDs. Each result is added to the journal of the run before the script gets it. A
 * new task of the run replays the journal up to its first failed call, and the calls that the script made after that
 * point get a new generation in their keys. A call that the script made before that point and that has a saved result
 * returns it and does not run again.
 */
export async function runScript(
	runtime: Runtime,
	context: Context,
	cwd: string,
	host: Host,
	script: ScriptRun,
): Promise<JsonValue> {
	const { bundle, args, runId } = script;
	// A module export is a syntax error in the function body that the script runs as.
	const source = bundle.main.replace(META, "$1$2");
	const progress: Progress = { lines: [], phase: null };
	const owner = ownerOf(runtime, runId);
	// The sandbox settles when the script ends and drops the host calls that still run, but they would go on: after the
	// end of the script, the calls are cancelled, and the script ends only once they settled. So a failed run ends its
	// sessions after its last ask was submitted and its last session opened.
	const execution = withCancel(context);
	const calls: Calls = { script, runtime, context: execution.context, progress, host, owner };
	const running = new Set<Promise<unknown>>();
	const journal = await startJournal(runtime, runId, context);
	const failedAt = journal.entries.findIndex((entry) => entry.failed === true);
	const kept = failedAt === -1 ? journal.entries : journal.entries.slice(0, failedAt);
	const replayed = new Set(kept.map((entry) => entry.id));
	const cuts = [...journal.cuts];
	const keyFor = (id: number) => `${runId}/${keyOf(id, cuts)}`;

	const handlers = new Map<string, Handler>([
		[
			"__session",
			handler("session", Type.Tuple([SESSION_ARGS]), true, ([args], key) =>
				memoized(calls, key, { kind: "session", args }, (saved) => sessionOf(calls, saved, cwd, args)),
			),
		],
		[
			"__ask",
			// The sandbox sends a missing schema as null.
			handler("ask", ASK_ARGS, true, ([conversation, prompt, schema], key) =>
				memoized(calls, key, { kind: "ask", args: { conversation, prompt, schema } }, (saved) =>
					askTurn(calls, saved, conversation, prompt, schema),
				),
			),
		],
		["__sh", handler("sh", SH_ARGS, true, ([cmd], key) => shellCall(calls, key, cwd, cmd, true))],
		["__ok", handler("ok", SH_ARGS, true, ([cmd], key) => shellCall(calls, key, cwd, cmd, false))],
		[
			"__run",
			// An unfinished saved child task is waited for again; a failed one gets a new child task.
			handler("run", RUN_ARGS, true, ([name, values], key) =>
				memoized(calls, key, { kind: "run", args: { name, args: values } }, (saved) =>
					childResult(calls, saved, script, name, values),
				),
			),
		],
		["phase", handler("phase", LINE_ARGS, false, ([title]) => phaseLine(progress, String(title)))],
		[
			"log",
			handler("log", LINE_ARGS, false, ([line]) => {
				progress.lines.push({ text: String(line), phase: false });
			}),
		],
		[
			"__prompt",
			handler("prompt", PROMPT_ARGS, false, ([name, inputs]) => {
				const body = bundle.prompts[name];

				if (body === undefined) throw new Error(`no prompt ${name}`);

				return render(body, inputs ?? {});
			}),
		],
	]);

	const answer = async (call: CodemodeHostCall): Promise<Answer> => {
		const found = handlers.get(call.name);

		if (found === undefined)
			return { outcome: { ok: false, message: `${call.name} is not a host function` }, failed: false };
		const key = found.effect ? keyFor(call.id) : undefined;

		try {
			return { outcome: { ok: true, value: await found.run(call, keyFor(call.id)) }, key, failed: false };
		} catch (error) {
			const outcome = { ok: false, message: error instanceof Error ? error.message : String(error) } as const;

			if (error instanceof Diverged) return { outcome, failed: false, diverged: error };

			if (error instanceof BadArguments) return { outcome, failed: false };

			return { outcome, key, failed: found.effect };
		}
	};

	const control = new AbortController();
	let failure: Error | undefined;
	const arrivals = new Map<number, { call: CodemodeHostCall; answer: Promise<Answer> }>();
	const waiting = new Map<number, PromiseWithResolvers<void>>();
	const idle = new Map<number, PromiseWithResolvers<number>>();
	// The calls that the script had made when it processed each result, so a late wait for one still gets it.
	const issuedAt = new Map<number, number>();
	const started = waiter<string>();
	// Results given to the script so far, so the seq of the next one is `delivered + 1`.
	let delivered = 0;

	const fail = (error: Error) => {
		if (failure !== undefined) return;
		failure = error;
		control.abort(failure);

		for (const waiter of [...waiting.values(), ...idle.values(), started]) waiter.reject(failure);
	};

	const arrived = async (id: number) => {
		const known = arrivals.get(id);

		if (known !== undefined) return known;
		const arrival = waiting.get(id) ?? waiter<void>();
		waiting.set(id, arrival);
		await arrival.promise;
		const call = arrivals.get(id);

		if (call === undefined) throw new Error(`the call ${id} is missing`);

		return call;
	};

	const idleAt = async (seq: number) => {
		const known = issuedAt.get(seq);

		if (known !== undefined) return known;
		const processed = idle.get(seq) ?? waiter<number>();
		idle.set(seq, processed);

		return processed.promise;
	};

	// The journal, replayed: each saved result goes to the script in its order, once the script made its call again.
	const replay = async (run: CodemodeRun) => {
		const fingerprint = await started.promise;

		if (journal.fingerprint !== undefined && journal.fingerprint !== fingerprint) {
			throw new Error("the sandbox changed since the run started, so its script cannot replay; start a new run");
		}

		if (journal.fingerprint === undefined) {
			await runtime.commit(async (tx) => {
				(await tx.doc(JournalDoc, runId, null)).fingerprint = fingerprint;

				return undefined;
			}, context);
		}

		for (const entry of kept) {
			const { call, answer: pending } = await arrived(entry.id);

			if (call.name !== entry.name || (entry.key !== undefined && entry.key !== keyFor(call.id))) {
				throw new Diverged(`the script made the call ${call.name} where its run saved ${entry.name}`);
			}

			const { outcome, diverged } = await pending;

			if (diverged !== undefined) throw diverged;
			delivered += 1;
			run.deliver(delivered, entry.at, entry.id, outcome);
		}

		if (failedAt === -1) return;
		// The calls that the script made by now are the ones that it made before the first failed call; later calls are
		// on another path, so they get a new generation.
		const issued = await idleAt(kept.length);
		cuts.push(issued);
		await runtime.commit(async (tx) => {
			const doc = await tx.doc(JournalDoc, runId, null);
			doc.entries.splice(kept.length);
			doc.cuts.push(issued);

			return undefined;
		}, context);
	};

	// A new result: saved in the journal, then given to the script.
	const deliverLive = async (run: CodemodeRun, call: CodemodeHostCall, { outcome, key, failed, diverged }: Answer) => {
		if (diverged !== undefined) fail(diverged);

		if (failure !== undefined || run.finished) return;
		const entry: Entry = { id: call.id, at: Date.now(), name: call.name };

		if (key !== undefined) entry.key = key;

		if (failed) entry.failed = true;
		await runtime.commit(async (tx) => {
			(await tx.doc(JournalDoc, runId, null)).entries.push(entry);

			return undefined;
		}, context);

		if (run.finished) return;
		delivered += 1;
		run.deliver(delivered, entry.at, entry.id, outcome);
	};

	let commits: Promise<void> = Promise.resolve();

	const enqueue = (step: () => Promise<void>) => {
		commits = commits.then(async () => {
			try {
				await step();
			} catch (error) {
				fail(error instanceof Error ? error : new Error(String(error)));
			}
		});
	};

	const sandbox = new CodemodeSandbox({ timeoutMs: Number.POSITIVE_INFINITY });
	const wrapped = `${prelude(args, Object.keys(bundle.prompts), script)}\nreturn await (async () => {\n${source}\n})();`;

	const run = sandbox.start(wrapped, {
		startedAt: journal.startedAt,
		seed: journal.seed,
		globals: [...handlers.keys()].map((name) => ({ name, spread: true })),
		signal: AbortSignal.any([runtime.signal, control.signal]),
		onStarted: (fingerprint) => started.resolve(fingerprint),
		onCall: (call) => {
			const pending = answer(call);
			running.add(pending);
			const settled = () => running.delete(pending);
			pending.then(settled, settled);
			arrivals.set(call.id, { call, answer: pending });
			waiting.get(call.id)?.resolve();

			if (replayed.has(call.id)) return;
			pending.then((value) => enqueue(() => deliverLive(run, call, value)));
		},
		onIdle: (seq, issued) => {
			issuedAt.set(seq, issued);
			idle.get(seq)?.resolve(issued);
			const next = kept[delivered];

			// The script waits for a result that only a call it did not make again could give: it took another path.
			if (seq === delivered && next !== undefined && next.id > issued) {
				fail(new Diverged(`the script did not make again the call ${next.name} of its saved results`));
			}
		},
	});

	enqueue(() => replay(run));
	let result: CodemodeResult;

	try {
		result = await run.result;
	} finally {
		await sandbox.close();
		execution.cancel();

		for (const waiter of [...waiting.values(), ...idle.values(), started]) waiter.reject(new Error("the script ended"));
		await Promise.allSettled(running);
		await commits;
		const events = takeLines(calls);

		// A cancelled task cannot commit; its lines are lost, and a resume shows the phase of its first call again.
		if (events.length > 0 && !runtime.signal.aborted) {
			await runtime.commit(async (tx) => {
				await addProgress(tx, script.root, events);

				return undefined;
			}, context);
		}
	}

	if (failure !== undefined) throw failure;

	if (result.ok) {
		const value = result.value ?? null;

		if (!Value.Check(JSON_VALUE, value)) throw new Error("the script result is not JSON");

		return value;
	}

	if (runtime.signal.aborted) throw runtime.signal.reason;
	throw new Error(result.error.message);
}
