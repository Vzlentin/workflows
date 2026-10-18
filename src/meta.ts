/**
 * `workflows <wf>`: any workflow script as a command. `export const meta = { ... }` at the top of the script declares
 * its arguments, whether it runs in a new worktree, and the exit code of each result status. The meta reader evaluates
 * only that literal, in the sandbox, and never runs the script.
 */
import { readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { Models } from "@earendil-works/pi-ai/models";
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import type { JsonObject } from "@earendil-works/pi-durable";
import { selectRepository } from "./git.ts";
import { instructions } from "./prompts.ts";
import { type Io, type Run, UsageError, withUsage } from "./run.ts";
import { type Bundle, loadBundle, META, type RunBundle } from "./script.ts";

/** The first non-empty line of `item`, without leading #. */
function subject(item: string): string {
	const line = item.split("\n").find((candidate) => candidate.trim() !== "") ?? "";
	return line.replace(/^#+/, "").trim();
}

/**
 * The text that `noun` names, such as `work item`: a `.md` file, inline text, or piped stdin. Throws when it has no
 * non-empty line. It is undefined without an argument and without stdin.
 */
async function readItem(argument: string | undefined, io: Io, noun: string): Promise<string | undefined> {
	let text: string | undefined;
	if (argument === undefined) {
		text = await io.stdin();
		if (text === undefined) return undefined;
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

export const isObject = (value: unknown): value is Record<string, unknown> =>
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

export const CHECK = "workflows check <workflow>";

/** The fields of an object literal that a session call reads: a string literal gives its text, any other value null. */
type Fields = { readonly provider?: string | null; readonly model?: string | null; readonly as?: string | null };

/** `fields` of the text of one brace block, whose strings are `"<n>"` with their texts in `strings`. */
function fieldsOf(text: string, strings: readonly string[]): Fields | undefined {
	const fields: Record<string, string | null> = {};
	for (const name of ["provider", "model", "as"]) {
		if (!new RegExp(String.raw`(?:^|[,\s])${name}\s*(?::|,|$)`).test(text)) continue;
		const literal = new RegExp(String.raw`(?:^|[,\s])${name}\s*:\s*"(\d+)"\s*(?:,|$)`).exec(text)?.[1];
		fields[name] = literal === undefined ? null : (strings[Number(literal)] ?? null);
	}
	return Object.keys(fields).length === 0 ? undefined : fields;
}

/**
 * The fields of each object literal that `source` passes directly to `session(...)` or `agent(...)`, at the object's
 * own level. Comments, strings and nested objects do not count, and an object with a spread is left out, because its
 * fields are not all known.
 */
function sessionFields(source: string): Fields[] {
	const found: Fields[] = [];
	const strings: string[] = [];
	// The open brackets. An object keeps its text at its own level: each string as `"<n>"`, a template with `${` as `x`,
	// and an inner object as `{}`.
	const open: ({ readonly call: string } | { text: string; readonly session: boolean })[] = [];
	const add = (text: string) => {
		const object = open.findLast((entry) => "text" in entry);
		if (object !== undefined && "text" in object) object.text += text;
	};
	for (let at = 0; at < source.length; at++) {
		const char = source[at] ?? "";
		const rest = source.slice(at, at + 2);
		if (rest === "//" || rest === "/*") {
			const end = source.indexOf(rest === "//" ? "\n" : "*/", at + 2);
			at = end === -1 ? source.length : end + (rest === "//" ? 0 : 1);
			continue;
		}
		if (char === '"' || char === "'" || char === "`") {
			let text = "";
			let computed = false;
			for (at++; at < source.length && source[at] !== char; at++) {
				if (source[at] === "\\") at++;
				else if (char === "`" && source.slice(at, at + 2) === "${") computed = true;
				text += source[at] ?? "";
			}
			strings.push(text);
			add(computed ? "x" : `"${strings.length - 1}"`);
		} else if (char === "(") {
			open.push({ call: /([A-Za-z_$][\w$]*)\s*$/.exec(source.slice(0, at))?.[1] ?? "" });
			add(char);
		} else if (char === ")") {
			if (open.at(-1) !== undefined && "call" in (open.at(-1) ?? {})) open.pop();
			add(char);
		} else if (char === "{") {
			const top = open.at(-1);
			add("{}");
			open.push({ text: "", session: top !== undefined && "call" in top && ["session", "agent"].includes(top.call) });
		} else if (char === "}") {
			const top = open.at(-1);
			if (top === undefined || !("text" in top)) continue;
			open.pop();
			const fields = top.session && !top.text.includes("...") ? fieldsOf(top.text, strings) : undefined;
			if (fields !== undefined) found.push(fields);
		} else {
			add(char);
		}
	}
	return found;
}

/**
 * The first model, as `<provider>/<id>`, that a session call of `source` names with a literal `provider` or `model`,
 * with the profile of its `as` (default `default`) for the other field, and that `models` does not have. A call with a
 * computed field, or without a provider or a model after its profile, is left to the start of the session.
 */
async function unknownModel(
	source: string,
	bundle: Bundle,
	models: () => Promise<Models>,
): Promise<string | undefined> {
	const named = sessionFields(source).flatMap(({ provider, model, as }) => {
		if (provider === null || model === null || as === null) return [];
		if (provider === undefined && model === undefined) return [];
		const profile = bundle.agents[as ?? "default"]?.model;
		const found = { provider: provider ?? profile?.provider, model: model ?? profile?.modelId };
		return found.provider === undefined || found.model === undefined ? [] : [found];
	});
	if (named.length === 0) return undefined;
	const registry = await models();
	const unknown = named.find(({ provider, model }) => registry.getModel(provider ?? "", model ?? "") === undefined);
	return unknown === undefined ? undefined : `${unknown.provider}/${unknown.model}`;
}

/**
 * `workflows check <wf>`: reads `meta` and checks the prompts and profiles that the script names, and the literal
 * models of its calls against Pi's model registry; starts no run.
 */
export async function check(
	args: readonly string[],
	io: Io & { readonly models: () => Promise<Models> },
): Promise<number> {
	const [word, ...rest] = args;
	if (word === undefined || rest.length > 0) throw new UsageError("give one workflow to check", CHECK);
	const found = await findScript(word, io);
	await readMeta(found.source, found.name);
	const failed = problem(found.source, found.name, found.bundle, true);
	if (failed !== undefined) throw new Error(failed);
	const model = await unknownModel(found.source, found.bundle, io.models);
	if (model !== undefined)
		throw new Error(`${found.name} uses the model ${model}, which Pi's model registry does not have`);
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
	readonly runId: string;
	/** The run ID of the root run: the run itself, or the root run of the caller of a child run. */
	readonly root: string;
	readonly runDir: string;
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
	const parsed = withUsage(
		() => parseArgs({ args: [...argv], options, allowPositionals: positional !== undefined, strict: true }),
		usage,
	);
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
		const label = labelOf(arg, spec);
		const value = raw === undefined && spec.default !== undefined ? spec.default : await readItem(raw, io, label);
		if (value !== undefined) args[arg] = value;
		else if (spec.required) throw new UsageError(`missing ${label}`);
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
export async function prepare(
	{ repo, base, ...args }: Args,
	run: Run & { readonly root?: string },
): Promise<ScriptInput> {
	const own = { ...args, runId: run.id, root: run.root ?? run.id, runDir: run.directory, cwd: run.cwd };
	if (!args.meta.worktree) return own;
	const { worktree, ...prepared } = await prepareWorktree(args.name, { repo, base }, run);
	return { ...own, worktree: { ...prepared, path: worktree } };
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

/**
 * The input of the child run `run` of a `run(name, args)` call: the script `name` of the caller's `bundle`, with the
 * `meta` defaults and the given args. With `meta.worktree` and `repo`, the child gets its own worktree from `repo` and
 * `base`; otherwise it runs in the caller's directory. `prompts` maps prompt names to texts that replace them in this
 * run only. The args are not checked against `meta`.
 */
export async function childInput(
	request: { readonly name: string; readonly args: JsonObject; readonly bundle: RunBundle },
	run: Run & { readonly root: string },
): Promise<ScriptInput> {
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
	if (repo === undefined || !meta.worktree) {
		return { ...input, runId: run.id, root: run.root, runDir: run.directory, cwd: run.cwd };
	}
	return prepare({ ...input, repo: String(repo), base: String(base) }, run);
}
