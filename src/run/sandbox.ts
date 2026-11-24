/**
 * Workflow scripts. A script is JavaScript that runs in the pi-codemode sandbox in the phase of the run's task, in the
 * harness host of the run. Each call it makes saves its result in a document of the host store, keyed by
 * the run ID and the call, so when the script runs again after an interruption or a failure, the finished calls return
 * their saved results and only the rest runs. A call records its kind, args, phase and start time when it starts, and
 * its end time with its result or error when it ends; only a saved result replays, so a failed or stopped call runs
 * again. A failure of the phase ends the task as failed, and a resume runs the script again in a new task of the same
 * run. `run(name, args)` starts a child run as a child task of the caller, with its own run directory, and a resume of
 * the caller continues that child run. Sessions are children of harness's children library, owned by the run's task.
 */
import { withCancel, type Context } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord/json";
import { CodemodeSandbox, type CodemodeTool } from "@earendil-works/pi-codemode";
import { TodoState } from "@vzlentin/harness/todo";
import { type Static, type TSchema, Type } from "typebox";
import { Value } from "typebox/value";
import { CLI_COMMAND } from "../command.ts";
import { JSON_VALUE } from "../tool.ts";
import { type Bundle, META, render } from "../workflow/bundle.ts";
import {
	type Calls,
	callKey,
	digest,
	GIT_HOST_ARGS,
	gitHostCall,
	harnessCall,
	inputCall,
	JSON_OBJECT,
	memoized,
	pastRunsCall,
	type ScriptRun,
	SESSION_ARGS,
	settleArgs,
	shCall,
	okCall,
	todoCall,
} from "./calls.ts";
import { childResult } from "./child.ts";
import { PAST_OPTIONS } from "./past.ts";
import { addProgress, type PhaseLines, phaseLine, takeLines } from "./progress.ts";
import { HARNESS_ARGS } from "./requests.ts";
import { RESULT, statusOf } from "./result.ts";
import { askTurn, ownerOf, sessionOf } from "./sessions.ts";
import type { Host, Runtime } from "./version.ts";

/** The sandbox functions that are not host calls, and the script lib; `cwd` is the directory of the script calls. */
export function prelude(
	script: Pick<ScriptRun, "runId" | "runDir" | "args"> & { readonly bundle: Bundle },
	cwd: string,
): string {
	return `
const args = ${JSON.stringify(script.args)};
const runId = ${JSON.stringify(script.runId)};
const runDir = ${JSON.stringify(script.runDir)};
const cwd = ${JSON.stringify(cwd)};
const workflowsCommand = ${JSON.stringify(CLI_COMMAND)};
const __unavailable = (name) => function () {
	throw new Error(name + " is not available in workflow scripts");
};
const __replaced = (real, overrides) =>
	Object.freeze(Object.create(Object.getPrototypeOf(real), { ...Object.getOwnPropertyDescriptors(real), ...overrides }));
const Date = Object.assign(__unavailable("Date"), { now: __unavailable("Date.now") });
const Math = __replaced(Function("return Math")(), { random: { value: __unavailable("Math.random") } });
const globalThis = __replaced(Function("return globalThis")(), {
	Date: { value: Date },
	Math: { value: Math },
	globalThis: { get: () => globalThis },
});
const prompts = Object.fromEntries(
	${JSON.stringify(Object.keys(script.bundle.prompts))}.map((name) => [name, (inputs) => __prompt(name, inputs)]),
);
function session(options = "default") {
	const { as = "default", provider, model, thinking, key } =
		typeof options === "string" ? { as: options } : (options ?? {});
	const spec = { profile: as };
	if (provider !== undefined) spec.provider = provider;
	if (model !== undefined) spec.model = model;
	if (thinking !== undefined) spec.thinking = thinking;
	if (key !== undefined) spec.key = key;
	const id = __session(spec);
	return {
		ask: async (prompt, options = {}) => __ask(await id, await prompt, options.schema, options.settle ?? false),
	};
}
const agent = async (prompt, { schema, settle, ...options } = {}) => {
	const text = await prompt;
	return session({ ...options, key: text }).ask(text, { schema, settle });
};
const sh = async (cmd, options = {}) => {
	const result = await __sh(cmd, options.settle ?? false);
	return "error" in result ? result : result.stdout.replace(/\\n$/, "");
};
const ok = async (cmd) => (await __ok(cmd)).code === 0;
const input = (question) => {
	const answer = __input(question);
	Promise.resolve().then(() => __turnEnd());
	return answer;
};
const pastRuns = (workflow, options) => __pastRuns(workflow, options ?? {});
const harness = (request) => __harness(request);
const gitHost = Object.freeze({
	create: (branch, base, title, body) => __gitHost({ action: "create", branch, base, title, body }),
	state: (change, options) => {
		const args = typeof change === "string" ? { action: "state", branch: change } : { action: "state", number: change };
		return __gitHost(options?.settle ? { ...args, settle: true } : args);
	},
	merge: (number) => __gitHost({ action: "merge", number }),
	issue: (number) => __gitHost({ action: "issue", number }),
	ci: (dir, commit, branch, wait) => __gitHost({ action: "ci", dir, commit, branch, wait }),
});
const todo = Object.freeze({
	add: (text) => __todoAdd(text),
	set: (id, state, text) => __todoSet(id, state, text ?? null),
	list: () => __todoList(),
});
const run = async (name, args = {}) => {
	const { runId: id, result } = await __run(name, args);
	return result !== null && typeof result === "object" && !Array.isArray(result) ? { ...result, runId: id } : result;
};
${script.bundle.lib}`;
}

const ASK_ARGS = Type.Tuple([Type.Number(), Type.String(), Type.Union([JSON_OBJECT, Type.Null()]), Type.Boolean()]);
const SHELL_CMD = Type.Union([Type.String(), Type.Array(Type.String())]);
const SH_ARGS = Type.Tuple([SHELL_CMD, Type.Boolean()]);
const OK_ARGS = Type.Tuple([SHELL_CMD]);
const RUN_ARGS = Type.Tuple([Type.String(), JSON_OBJECT]);
const INPUT_ARGS = Type.Tuple([Type.String()]);
const PAST_ARGS = Type.Tuple([Type.Union([Type.String(), Type.Null()]), PAST_OPTIONS]);
const TODO_ADD_ARGS = Type.Tuple([Type.String()]);
const TODO_SET_ARGS = Type.Tuple([Type.Integer({ minimum: 1 }), TodoState, Type.Union([Type.String(), Type.Null()])]);
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
	const { bundle } = script;
	// A module export is a syntax error in the function body that the script runs as.
	const source = bundle.main.replace(META, "$1$2");
	const progress: PhaseLines = { run: script.runId, parent: script.parent, lines: [], phase: null };
	const owner = ownerOf(runtime, script.runId);
	// The sandbox settles when the script ends and drops the host calls that still run, but they would go on: after the
	// end of the script, the calls are cancelled, and the script ends only once they settled. So a failed run ends its
	// sessions after its last ask was submitted and its last session opened.
	const execution = withCancel(context);

	const calls: Calls = {
		script,
		runtime,
		context: execution.context,
		phase: context,
		counters: new Map(),
		progress,
		host,
		owner,
		inputs: Promise.resolve(),
	};

	const running = new Set<Promise<unknown>>();
	const stop = new AbortController();
	// Resolves when the code that called `input` reaches its next `await`, so that the `input` calls of that code reach
	// the host before a waiting call stops the script, which drops the messages that come later.
	let turnEnd = Promise.withResolvers<void>();

	// `call` names the call in the error of bad arguments.
	const global = <T extends TSchema>(
		name: string,
		schema: T,
		execute: (values: Static<T>) => Promise<JsonValue> | JsonValue | void,
		call = name.replace(/^__/, ""),
	): CodemodeTool => ({
		name,
		spread: true,
		execute: (values) => {
			if (!Value.Check(schema, values)) {
				throw new Error(`${call} got bad arguments: ${argumentError(Value.Errors(schema, values))}`);
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
			// The record keeps a digest of the key, which can be a whole prompt.
			global("__session", Type.Tuple([SESSION_ARGS]), ([given]) => {
				const args = given.key === undefined ? given : { ...given, key: digest(given.key) };

				return memoized(calls, callKey(calls, "session", args), { kind: "session", args }, (key) =>
					sessionOf(calls, key, cwd, args),
				);
			}),
			// The sandbox sends a missing schema as null.
			global("__ask", ASK_ARGS, ([conversation, prompt, schema, settle]) => {
				const args = settleArgs({ conversation, prompt, schema }, settle);

				return memoized(calls, callKey(calls, "ask", args), { kind: "ask", args }, (key) =>
					askTurn(calls, key, conversation, prompt, schema),
				);
			}),
			global("__sh", SH_ARGS, ([cmd, settle]) => shCall(calls, cwd, cmd, settle)),
			global("__ok", OK_ARGS, ([cmd]) => okCall(calls, cwd, cmd)),
			// The name and the args are in the key, so a resume that reorders different `run` calls keeps each child run.
			// An unfinished saved child task is waited for again; a failed one gets a new child task.
			global("__run", RUN_ARGS, ([name, values]) => {
				const args = { name, args: values };

				return memoized(calls, callKey(calls, "run", args), { kind: "run", args }, (key) =>
					childResult(calls, cwd, key, name, values),
				);
			}),
			global("__input", INPUT_ARGS, ([question]) => {
				const turn = turnEnd.promise;

				return inputCall(calls, question, () => void turn.then(() => stop.abort()));
			}),
			global("__turnEnd", Type.Tuple([]), () => {
				turnEnd.resolve();
				turnEnd = Promise.withResolvers<void>();
			}),
			global("__pastRuns", PAST_ARGS, ([workflow, options]) => pastRunsCall(calls, workflow, options)),
			// A text is any string, so an empty text fails with the error of harness.
			global("__todoAdd", TODO_ADD_ARGS, ([text]) => todoCall(calls, { action: "add", text }), "todo"),
			// The sandbox sends a missing text as null, and the args leave it out.
			global(
				"__todoSet",
				TODO_SET_ARGS,
				([id, state, text]) =>
					todoCall(calls, text === null ? { action: "set", id, state } : { action: "set", id, state, text }),
				"todo",
			),
			global("__todoList", Type.Tuple([]), () => todoCall(calls, { action: "list" }), "todo"),
			global("__harness", Type.Tuple([HARNESS_ARGS]), ([args]) => harnessCall(calls, args), "harness"),
			global("__gitHost", Type.Tuple([GIT_HOST_ARGS]), ([args]) => gitHostCall(calls, cwd, args), "gitHost"),
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
		const wrapped = `${prelude(script, cwd)}\nreturn await (async () => {\n${source}\n})();`;
		result = await sandbox.execute(wrapped, { signal: AbortSignal.any([signal, stop.signal]) });
	} finally {
		await sandbox.close();
		execution.cancel();
		await Promise.allSettled(running);
		const events = takeLines(progress);

		// A cancelled task cannot commit; its lines are lost, and a resume shows the phase of its first call again.
		if (events.length > 0 && !signal.aborted) {
			await runtime.commit(async (tx) => {
				await addProgress(tx, script.root, events);

				return undefined;
			}, context);
		}
	}

	if (signal.aborted && (calls.waiting !== undefined || !result.ok)) throw signal.reason;

	// A second `input` call that would wait fails the run, also when the script caught its error.
	if (calls.secondInput !== undefined) throw calls.secondInput;

	if (calls.waiting !== undefined) {
		const question = calls.waiting;

		return { status: "waiting", question, report: [question] };
	}

	if (result.ok) {
		const value = result.value ?? null;

		if (!Value.Check(RESULT, value))
			throw new Error(`the script result has a bad field: ${argumentError(Value.Errors(RESULT, value))}`);

		// Only an open `input` call makes a run wait.
		if (statusOf(value) === "waiting")
			throw new Error("the script returned the status waiting, but no input() call waits");

		return value;
	}

	throw new Error(result.error.message);
}
