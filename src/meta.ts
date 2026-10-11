/**
 * `workflows <wf>`: any workflow script as a command. `export const meta = { ... }` at the top of the script declares
 * its arguments, whether it runs in a new worktree, and the exit code of each result status. The meta reader evaluates
 * only that literal, in the sandbox, and never runs the script.
 */
import { readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { Context, JsonValue } from "@earendil-works/chord";
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import { defineTask, type JsonObject, type RunningTask, type TaskRuntime } from "@earendil-works/pi-durable";
import { ensureWorktree, selectRepository } from "./git.ts";
import { instructions } from "./prompts.ts";
import { type Bundle, type ChildRequest, loadBundle, META, type RunBundle, runScriptPhase } from "./script.ts";
import { type Checkpoint, type Io, type Run, type Stored, UsageError } from "./workflow.ts";

/** The first non-empty line of `item`, without leading #. */
function subject(item: string): string {
	const line = item.split("\n").find((candidate) => candidate.trim() !== "") ?? "";
	return line.replace(/^#+/, "").trim();
}

/**
 * The text that `noun` names, such as `work item`: a `.md` file, inline text, or piped stdin. Throws when it has no
 * non-empty line.
 */
async function readItem(argument: string | undefined, io: Io, noun: string): Promise<string> {
	let text: string | undefined;
	if (argument === undefined) {
		text = await io.stdin();
		if (text === undefined) throw new UsageError(`missing ${noun}`);
	} else if (argument.endsWith(".md")) {
		const path = resolve(io.cwd, argument);
		text = await readFile(path, "utf8").catch(() => {
			throw new Error(`cannot read ${noun} ${path}`);
		});
	} else {
		text = argument;
	}
	if (text.trim() === "") throw new Error(`the ${noun} is empty`);
	return text;
}

/**
 * The selected repository and its start commit, and the worktree path of `run` on the branch `<scriptName>/<run-id>`.
 */
async function prepareWorktree(
	scriptName: string,
	args: { readonly repo: string | undefined; readonly base: string },
	run: Run,
): Promise<{ repository: string; start: string; branch: string; worktree: string }> {
	const repository = await selectRepository(run.cwd, args.repo, args.base, join(run.directory, "repository"));
	return {
		repository: repository.path,
		start: repository.start,
		branch: `${scriptName}/${run.id}`,
		worktree: join(run.directory, "worktree"),
	};
}

const TYPES = ["string", "number", "boolean", "text"] as const;

/** One argument of `meta.args`. `number` is a positive integer. `label` names the argument in error messages. */
export type ArgSpec = {
	readonly type: (typeof TYPES)[number];
	readonly default?: string | number | boolean;
	readonly required?: boolean;
	readonly positional?: boolean;
	readonly label?: string;
};

export type Meta = {
	/** One line for `workflows` and `--help`; empty when the script has none. */
	readonly description: string;
	readonly args: Readonly<Record<string, ArgSpec>>;
	/** The run gets `--repo` and `--base`, a worktree on `<wf>/<run-id>`, and `args.start`. */
	readonly worktree: boolean;
	/** The exit code of each `result.status`; any other status exits 0. */
	readonly exit: Readonly<Record<string, number>>;
};

const SPEC_KEYS = new Set(["type", "default", "required", "positional", "label"]);

const isObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

function checkMeta(value: unknown, name: string): Meta {
	const fail = (problem: string) => new Error(`${name}: ${problem}`);
	if (!isObject(value)) throw fail("meta is not an object");
	const { description = "", args = {}, worktree = false, exit = {}, ...rest } = value;
	const [extra] = Object.keys(rest);
	if (extra !== undefined) throw fail(`meta.${extra} is not a meta field`);
	if (typeof description !== "string") throw fail("meta.description is not a string");
	if (!isObject(args)) throw fail("meta.args is not an object");
	if (typeof worktree !== "boolean") throw fail("meta.worktree is not a boolean");
	if (!isObject(exit) || !Object.values(exit).every(Number.isInteger)) {
		throw fail("meta.exit does not map statuses to integer exit codes");
	}
	const reserved = new Set(["prompts", "help", "json", ...(worktree ? ["repo", "base", "start"] : [])]);
	for (const [arg, spec] of Object.entries(args)) {
		const at = `meta.args.${arg}`;
		if (reserved.has(arg)) throw fail(`${at} is a reserved name`);
		if (!isObject(spec) || !TYPES.includes(spec.type as ArgSpec["type"])) {
			throw fail(`${at}.type is not string, number, boolean or text`);
		}
		const [unknown] = Object.keys(spec).filter((key) => !SPEC_KEYS.has(key));
		if (unknown !== undefined) throw fail(`${at}.${unknown} is not an argument field`);
		const { type, default: fallback, required = false, positional = false, label = "" } = spec;
		const expected = type === "text" ? "string" : type;
		if (fallback !== undefined) {
			const ok =
				type === "number" ? Number.isInteger(fallback) && (fallback as number) > 0 : typeof fallback === expected;
			if (!ok) throw fail(`${at}.default is not a ${type === "number" ? "positive integer" : expected}`);
		}
		if (typeof required !== "boolean" || typeof positional !== "boolean" || typeof label !== "string") {
			throw fail(`${at}: required and positional are booleans, and label is a string`);
		}
		if (positional && type === "boolean") throw fail(`${at} is a boolean and cannot be positional`);
	}
	if (Object.values(args).filter((spec) => (spec as ArgSpec).positional).length > 1) {
		throw fail("meta.args has more than one positional argument");
	}
	return { description, args: args as Meta["args"], worktree, exit: exit as Meta["exit"] };
}

/**
 * The `meta` of the script `source`, checked; no arguments for a script without one. The end of the literal is the
 * first `}` after which the text compiles as an expression. Compiling runs nothing; the literal then runs in the sandbox.
 */
export async function readMeta(source: string, name: string): Promise<Meta> {
	const found = META.exec(source);
	if (found === null) return { description: "", args: {}, worktree: false, exit: {} };
	const from = found[0].length;
	let literal: string | undefined;
	if (source.slice(from).trimStart().startsWith("{")) {
		for (let at = source.indexOf("}", from); at !== -1 && literal === undefined; at = source.indexOf("}", at + 1)) {
			const slice = source.slice(from, at + 1);
			try {
				new Function(`return (${slice})`);
				literal = slice;
			} catch {
				// Not the end of the literal yet.
			}
		}
	}
	if (literal === undefined) throw new Error(`${name}: meta is not an object literal`);
	const sandbox = new CodemodeSandbox({ timeoutMs: 5000 });
	try {
		const result = await sandbox.execute(`return (${literal})`);
		if (!result.ok) throw new Error(`${name}: meta: ${result.error.message}`);
		return checkMeta(result.value, name);
	} finally {
		await sandbox.close();
	}
}

const unique = (matches: Iterable<RegExpMatchArray>, group: number) =>
	[...new Set([...matches].map((match) => match[group] ?? ""))].filter((value) => value !== "");

/** The first prompt call `prompts.<name>(` of `source` without a template, or agent profile when `profiles` is set. */
function problem(source: string, name: string, bundle: Bundle, profiles: boolean): string | undefined {
	const prompt = unique(source.matchAll(/\bprompts\.([A-Za-z_$][\w$]*)\s*\(/g), 1).find(
		(p) => !Object.hasOwn(bundle.prompts, p),
	);
	if (prompt !== undefined) return `${name} uses prompts.${prompt}, which has no template`;
	if (!profiles) return undefined;
	const named = [
		...unique(source.matchAll(/\bsession\(\s*(["'`])([^"'`]+)\1/g), 2),
		...unique(source.matchAll(/\bas:\s*(["'`])([^"'`]+)\1/g), 2),
	];
	const profile = named.find((p) => !Object.hasOwn(bundle.agents, p));
	return profile === undefined ? undefined : `${name} uses the agent profile ${profile}, which does not exist`;
}

type Found = { readonly name: string; readonly source: string; readonly bundle: Bundle };

/** `-` for stdin, a `.js` file or a path relative to the current directory, or a script name of the bundle. */
async function findScript(word: string, io: Io): Promise<Found> {
	const bundle = await loadBundle(io.cwd);
	if (word === "-") {
		const source = await io.stdin();
		if (source === undefined) throw new UsageError("missing workflow script on stdin");
		return { name: "stdin", source, bundle };
	}
	if (word.endsWith(".js") || word.includes("/")) {
		const path = resolve(io.cwd, word);
		const source = await readFile(path, "utf8").catch(() => {
			throw new Error(`cannot read workflow ${path}`);
		});
		return { name: basename(word, ".js"), source, bundle };
	}
	const source = Object.hasOwn(bundle.scripts, word) ? bundle.scripts[word] : undefined;
	if (source === undefined) throw new UsageError(`unknown command ${word}`);
	return { name: word, source, bundle };
}

const labelOf = (name: string, spec: ArgSpec) => spec.label ?? name;

function flagUsage(name: string, spec: ArgSpec): string {
	const value = { string: " <value>", number: " <n>", boolean: "", text: ` <${name}.md | text>` }[spec.type];
	const flag = `--${name}${value}`;
	return spec.required ? flag : `[${flag}]`;
}

/** The usage line of the script `name`. */
export function usageOf(name: string, meta: Meta): string {
	const entries = Object.entries(meta.args);
	const words = [`workflows ${name}`];
	for (const [arg, spec] of entries) if (!spec.positional) words.push(flagUsage(arg, spec));
	if (meta.worktree) words.push("[--repo <repository>]", "[--base <branch>]");
	words.push("[--prompts <folder>]");
	for (const [arg, spec] of entries) {
		if (!spec.positional) continue;
		const value = spec.type === "text" ? `<${arg}.md> | <text>` : `<${arg}>`;
		words.push(spec.required && spec.type !== "text" ? value : `[${value}]`);
	}
	words.push("[--json]");
	return words.join(" ");
}

/** The usage and the description of the script `word`, for `workflows <wf> --help`. */
export async function help(word: string, io: Io): Promise<string[]> {
	const found = await findScript(word, io);
	const meta = await readMeta(found.source, found.name);
	return [`usage: ${usageOf(found.name, meta)}`, ...(meta.description === "" ? [] : [meta.description])];
}

/** One line `<name>: <description>`, or `<name>` without a description, for each script of the package and project. */
export async function listScripts(io: Io): Promise<string[]> {
	const { scripts } = await loadBundle(io.cwd);
	return Promise.all(
		Object.entries(scripts).map(async ([name, source]) => {
			const { description } = await readMeta(source, name);
			return description === "" ? name : `${name}: ${description}`;
		}),
	);
}

/** `workflows check <wf>`: reads `meta` and checks the prompts and profiles that the script names; starts no run. */
export async function check(args: readonly string[], io: Io): Promise<number> {
	const [word, ...rest] = args;
	if (word === undefined || rest.length > 0) throw new UsageError("give one workflow to check");
	const found = await findScript(word, io);
	await readMeta(found.source, found.name);
	const failed = problem(found.source, found.name, found.bundle, true);
	if (failed !== undefined) throw new Error(failed);
	io.stdout(`ok ${found.name}`);
	return 0;
}

type Args = {
	readonly name: string;
	readonly args: JsonObject;
	readonly meta: Meta;
	readonly bundle: RunBundle;
	readonly repo: string | undefined;
	readonly base: string;
};

/** Everything a run needs, saved before execution starts. */
export type ScriptInput = Omit<Args, "repo" | "base"> & {
	readonly cwd: string;
	readonly worktree?: {
		readonly repository: string;
		readonly start: string;
		readonly branch: string;
		readonly path: string;
	};
};

/** The checked `meta.args` values of `argv`; texts are read after every other value is checked. */
async function parseValues(meta: Meta, argv: readonly string[], io: Io, usage: string) {
	const entries = Object.entries(meta.args);
	const options: Record<string, { type: "string" | "boolean" }> = {
		prompts: { type: "string" },
		help: { type: "boolean" },
		json: { type: "boolean" },
		...(meta.worktree ? { repo: { type: "string" }, base: { type: "string" } } : {}),
	};
	for (const [arg, spec] of entries) options[arg] = { type: spec.type === "boolean" ? "boolean" : "string" };
	const positional = entries.find(([, spec]) => spec.positional);
	let parsed: { values: Record<string, string | boolean | undefined>; positionals: string[] };
	try {
		parsed = parseArgs({ args: [...argv], options, allowPositionals: positional !== undefined, strict: true });
	} catch (error) {
		const code = (error as { code?: unknown }).code;
		if (typeof code === "string" && code.startsWith("ERR_PARSE_ARGS")) {
			throw new UsageError((error as Error).message, usage);
		}
		throw error;
	}
	const { values } = parsed;
	if (positional !== undefined) {
		const [arg, spec] = positional;
		if (parsed.positionals.length > 1) throw new UsageError(`give the ${labelOf(arg, spec)} as one argument`, usage);
		if (parsed.positionals.length === 1) {
			if (values[arg] !== undefined) throw new UsageError(`give the ${labelOf(arg, spec)} once`, usage);
			values[arg] = parsed.positionals[0];
		}
	}
	const args: JsonObject = {};
	for (const [arg, spec] of entries) {
		const raw = values[arg];
		if (spec.type === "text") continue;
		if (raw === undefined) {
			if (spec.default !== undefined) args[arg] = spec.default;
			else if (spec.type === "boolean") args[arg] = false;
			else if (spec.required) throw new UsageError(`missing ${labelOf(arg, spec)}`, usage);
		} else if (spec.type === "number") {
			const n = Number(raw);
			if (!Number.isInteger(n) || n < 1) throw new UsageError(`--${arg} must be a positive integer`, usage);
			args[arg] = n;
		} else {
			args[arg] = raw;
		}
	}
	for (const [arg, spec] of entries) {
		if (spec.type !== "text") continue;
		const raw = values[arg] as string | undefined;
		args[arg] =
			raw === undefined && spec.default !== undefined ? spec.default : await readItem(raw, io, labelOf(arg, spec));
	}
	return {
		args,
		prompts: values.prompts as string | undefined,
		repo: values.repo as string | undefined,
		base: (values.base as string | undefined) ?? "main",
	};
}

/** The first `text` argument of `input`, whose subject is the run's title. */
function textArg(input: ScriptInput): string | undefined {
	const [arg] = Object.entries(input.meta.args).find(([, spec]) => spec.type === "text") ?? [];
	const value = arg === undefined ? undefined : input.args[arg];
	return typeof value === "string" ? value : undefined;
}

/** The status of a result object, if it has one. */
export function statusOf(result: unknown): string | undefined {
	return isObject(result) && typeof result.status === "string" ? result.status : undefined;
}

export const USAGE = "workflows <workflow | file.js | -> [<text>] [--<arg> <value>]...";

/** The checked arguments of `workflows <wf> ...`; throws `UsageError` or `Error` before a run directory exists. */
export async function parse([word = "", ...argv]: readonly string[], io: Io): Promise<Args> {
	const found = await findScript(word, io);
	const meta = await readMeta(found.source, found.name);
	const { args, prompts, repo, base } = await parseValues(meta, argv, io, usageOf(found.name, meta));
	const bundle = prompts === undefined ? found.bundle : await loadBundle(io.cwd, resolve(io.cwd, prompts));
	const failed = problem(found.source, found.name, bundle, false);
	if (failed !== undefined) throw new Error(failed);
	return { name: found.name, args, meta, bundle: { ...bundle, main: found.source }, repo, base };
}

/** The input saved before execution starts; with `meta.worktree`, it selects the repository of the new worktree. */
export async function prepare({ repo, base, ...args }: Args, run: Run): Promise<ScriptInput> {
	if (!args.meta.worktree) return { ...args, cwd: run.cwd };
	const { worktree, ...prepared } = await prepareWorktree(args.name, { repo, base }, run);
	return { ...args, cwd: run.cwd, worktree: { ...prepared, path: worktree } };
}

/** A short name of the run's subject for output lines: the subject of its first text argument, or the script name. */
export function title(input: ScriptInput): string {
	const text = textArg(input);
	return text === undefined ? input.name : subject(text);
}

/** Prints the result's report lines and returns the exit code of its status. */
export function report(input: ScriptInput, result: unknown, io: Io): number {
	const lines = isObject(result) ? result.report : undefined;
	if (Array.isArray(lines)) for (const line of lines) io.stdout(String(line));
	else io.stdout(typeof result === "string" ? result : JSON.stringify(result));
	const status = statusOf(result);
	return status !== undefined && Object.hasOwn(input.meta.exit, status) ? (input.meta.exit[status] ?? 0) : 0;
}

type Runtime = TaskRuntime<Stored, Checkpoint, JsonValue, object>;

/**
 * The one phase: a runner session runs the script, in the run's worktree when it has one. The phase may run again after
 * an interruption or a failure: answered turns are not sent again, and Git steps must be safe to repeat. A phase that
 * throws fails the run and keeps its checkpoint. A resume starts a new task from that checkpoint, which runs the phase
 * again and sends a failed turn again under a new request ID.
 */
async function runPhase(task: RunningTask<Stored, Checkpoint, JsonValue>, runtime: Runtime, context: Context) {
	const { checkpoint } = task.state;
	const input = task.input.input as ScriptInput;
	try {
		const { worktree } = input;
		if (worktree === undefined) {
			await runScriptPhase(runtime, checkpoint, context, input.cwd, input.bundle, input.args);
		} else {
			await ensureWorktree(worktree.repository, worktree.path, worktree.branch, worktree.start);
			const args = { ...input.args, start: worktree.start };
			await runScriptPhase(runtime, checkpoint, context, worktree.path, input.bundle, args);
		}
	} catch (error) {
		// A closing store cancels the phase; it runs again when the run resumes.
		if (runtime.signal.aborted) throw error;
		const message = error instanceof Error ? error.message : String(error);
		await runtime.commit(
			(_tx, current) => ({
				status: "terminal",
				outcome: { status: "failed", error: { message, detail: { from: current.state.checkpoint } } },
			}),
			context,
		);
	}
}

/** The task of every script run; `list` shows the script name. A run saved by an earlier version cannot resume. */
export const scriptTask = defineTask<Stored, Checkpoint, JsonValue>({
	name: "workflows.run",
	version: 4,
	// No `migrate`: the store does not run a task of an earlier version, and `resume` refuses it.
	initial: (stored) => stored.from ?? { phase: "run" },
	phases: { run: runPhase },
	abort: async (_task, runtime, context) => {
		await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context);
	},
});

/**
 * The input of the child run of `request`: the script `request.name` of the caller's bundle, with the `meta` defaults
 * and the given args. With `meta.worktree` and `repo`, the child gets its own worktree from `repo` and `base`; otherwise
 * it runs in the caller's directory. `prompts` maps prompt names to texts that replace them in this run only. The args
 * are not checked against `meta`.
 */
export async function childInput(request: ChildRequest, run: Run): Promise<ScriptInput> {
	const { name, bundle } = request;
	const source = Object.hasOwn(bundle.scripts, name) ? bundle.scripts[name] : undefined;
	if (source === undefined) throw new Error(`no workflow ${name}`);
	const meta = await readMeta(source, name);
	const { repo, base = "main", prompts = {}, ...given } = request.args;
	if (!isObject(prompts)) throw new Error(`run ${name}: prompts is not an object of prompt texts`);
	const replaced = { ...bundle.prompts };
	for (const [prompt, value] of Object.entries(prompts)) {
		if (!Object.hasOwn(bundle.prompts, prompt)) throw new Error(`run ${name}: no prompt ${prompt}`);
		replaced[prompt] = instructions(String(value));
	}
	const defaults = Object.entries(meta.args).flatMap(([arg, spec]) =>
		spec.default === undefined ? [] : [[arg, spec.default] as const],
	);
	const args = { ...Object.fromEntries(defaults), ...given };
	const input = { name, args, meta, bundle: { ...bundle, prompts: replaced, main: source } };
	if (repo === undefined || !meta.worktree) return { ...input, cwd: run.cwd };
	return prepare({ ...input, repo: String(repo), base: String(base) }, run);
}
