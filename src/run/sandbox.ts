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
import type { Context, JsonValue } from "@earendil-works/chord";
import { withCancel } from "@earendil-works/chord/context";
import { CodemodeSandbox, type CodemodeTool } from "@earendil-works/pi-codemode";
import type { JsonObject } from "@earendil-works/pi-durable";
import { type Static, type TSchema, Type } from "typebox";
import { Value } from "typebox/value";
import { JSON_VALUE } from "../tool.ts";
import { META, render } from "../workflow/bundle.ts";
import { CallDoc, type Calls, callKey, inputCall, memoized, pastRunsCall, type ScriptRun, shellCall } from "./calls.ts";
import { childResult } from "./child.ts";
import { PAST_OPTIONS, profileTexts } from "./past.ts";
import { addProgress, type PhaseLines, phaseLine, takeLines } from "./progress.ts";
import { askTurn, ownerOf, SESSION_ARGS, sessionOf } from "./sessions.ts";
import type { Host, Runtime } from "./version.ts";

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
	};

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
					childResult(calls, cwd, key, name, values),
				);
			}),
			global("__input", INPUT_ARGS, ([question]) => inputCall(calls, question, stop)),
			global("__pastRuns", PAST_ARGS, ([workflow, options]) => pastRunsCall(calls, workflow, options)),
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

	// An answer to a question that this execution did not ask would be lost: the run fails, and a resume without the
	// answer asks again.
	if (script.answer !== undefined && calls.answered !== true && (calls.waiting !== undefined || result.ok)) {
		const asked = (await runtime.snapshot(CallDoc, script.answer.call, context))?.args.question;
		throw new Error(`resume --answer answered ${JSON.stringify(asked)}, which the run did not ask`);
	}

	if (calls.waiting !== undefined) {
		const question = calls.waiting;

		return { status: "waiting", question, report: [question] };
	}

	if (result.ok) {
		const value = result.value ?? null;

		if (!Value.Check(JSON_VALUE, value)) throw new Error("the script result is not JSON");

		return value;
	}

	throw new Error(result.error.message);
}
