/**
 * `workflows <wf>`: any workflow script as a command. `export const meta = { ... }` at the top of the script declares
 * its arguments, whether it runs in a new worktree, and the exit code of each result status. The meta reader evaluates
 * only that literal, in the sandbox, and never runs the script.
 */
import { readFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { JsonValue } from "@earendil-works/chord";
import type { Models } from "@earendil-works/pi-ai/models";
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import type { JsonObject } from "@earendil-works/pi-durable";
import type { Overlay } from "@vzlentin/harness/overlay";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { git, gitSucceeds, selectRepository } from "./git.ts";
import type { ProgressEvent } from "./progress.ts";
import { instructions } from "./prompts.ts";
import { type Io, type Run, UsageError, withUsage } from "./run.ts";
import { type Bundle, loadBundle, META, profileOf, type RunBundle } from "./script.ts";

/** The first non-empty line of `item`, without leading #, as `subjectOf` of `workflows/lib/text.js`, which the engine cannot import. */
function subject(item: string): string {
	const line = item.split("\n").find((candidate) => candidate.trim() !== "") ?? "";

	return line.replace(/^#+/, "").trim();
}

/**
 * The text that `noun` names, such as `work item`: a `.md` file, inline text, or piped stdin. Throws when it has no
 * non-empty line. It is undefined without an argument and without stdin, and also with blank stdin when it is
 * `optional`, because the `workflow` tool pipes an empty stdin.
 */
async function readItem(
	argument: string | undefined,
	io: Io,
	noun: string,
	optional: boolean,
): Promise<string | undefined> {
	let text: string | undefined;

	if (argument === undefined) {
		text = await io.stdin();

		if (text === undefined || (optional && text.trim() === "")) return undefined;
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
 * The selected repository and its start commit, and the worktree path of `run` on the new branch `args.branch`, or
 * `<scriptName>/<run-id>`. The worktree is `.worktrees/<repository name>/<run-id>` next to the repository.
 */
async function prepareWorktree(
	scriptName: string,
	args: { readonly repo: string | undefined; readonly base: string; readonly branch: string | undefined },
	run: Run,
): Promise<{ repository: string; start: string; branch: string; worktree: string }> {
	const repository = await selectRepository(run.cwd, args.repo, args.base, join(run.directory, "repository"));
	const { branch = `${scriptName}/${run.id}` } = args;

	if (!(await gitSucceeds(repository.path, "check-ref-format", "--branch", branch))) {
		throw new UsageError(`--branch ${branch} is not a valid branch name`);
	}

	if (await gitSucceeds(repository.path, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`)) {
		throw new UsageError(`--branch ${branch} exists`);
	}

	const worktree = join(dirname(repository.path), ".worktrees", basename(repository.path), run.id);

	return { repository: repository.path, start: repository.start, branch, worktree };
}

const ARG_TYPE = Type.Union([
	Type.Literal("string"),
	Type.Literal("number"),
	Type.Literal("boolean"),
	Type.Literal("text"),
]);

/** One argument of `meta.args`. `number` is a positive integer. `label` names the argument in error messages. */
export type ArgSpec = {
	readonly type: Static<typeof ARG_TYPE>;
	readonly default?: string | number | boolean;
	readonly required?: boolean;
	readonly positional?: boolean;
	readonly label?: string;
};

export type Meta = {
	/** One line for `workflows` and `--help`; empty when the script has none. */
	readonly description: string;
	readonly args: Readonly<Record<string, ArgSpec>>;
	/**
	 * The run gets `--repo`, `--base` and `--branch`, a worktree on `--branch` or `<wf>/<run-id>`, and `args.start`. A
	 * result with a `subject` renames `<wf>/<run-id>`.
	 */
	readonly worktree: boolean;
	/** The exit code of each `result.status`; any other status exits 0. */
	readonly exit: Readonly<Record<string, number>>;
};

const META_KEYS = new Set(["description", "args", "worktree", "exit"]);
const SPEC_KEYS = new Set(["type", "default", "required", "positional", "label"]);
const OBJECT = Type.Object({});
const DESCRIPTION = Type.Object({ description: Type.Optional(Type.String()) });
const ARGS = Type.Object({ args: Type.Optional(Type.Record(Type.String(), Type.Unknown())) });
const WORKTREE = Type.Object({ worktree: Type.Optional(Type.Boolean()) });
const EXIT = Type.Object({ exit: Type.Optional(Type.Record(Type.String(), Type.Integer())) });
const SPEC_TYPE = Type.Object({ type: ARG_TYPE });
const START = Type.Object({ start: Type.Optional(Type.String()) });
const OVERLAY = Type.Record(Type.String(), Type.Union([Type.String(), Type.Null()]));

/** The shape of the overlay key of a bundle item, `<kind>/<name>.md`, as `prompts/<name>.md` or `agents/<name>.md`. */
const BUNDLE_KEY = /^[^/]+\/[^/]+\.md$/;

/** A kind of bundle item that a `run()` call can replace or remove: its name in errors, the bundle's items, the setter. */
interface BundleKind {
	readonly label: string;
	readonly source: RunBundle["prompts"] | RunBundle["agents"];
	readonly set: (item: string, text: string | null) => void;
}

/** The arguments that `meta.worktree` gives a script. */
const WORKTREE_ARGS = ["repo", "base", "branch", "start"];

const SPEC_FLAGS = Type.Object({
	required: Type.Optional(Type.Boolean()),
	positional: Type.Optional(Type.Boolean()),
	label: Type.Optional(Type.String()),
});

/** The `default` of each argument type. */
const DEFAULTS = {
	string: Type.Object({ default: Type.Optional(Type.String()) }),
	number: Type.Object({ default: Type.Optional(Type.Integer({ minimum: 1 })) }),
	boolean: Type.Object({ default: Type.Optional(Type.Boolean()) }),
	text: Type.Object({ default: Type.Optional(Type.String()) }),
};

/** Throws the first problem of `value` as the `meta` of the script `name`. */
function checkMeta(value: unknown, name: string): asserts value is Partial<Meta> {
	const fail = (problem: string) => new Error(`${name}: ${problem}`);

	if (!Value.Check(OBJECT, value)) throw fail("meta is not an object");
	const [extra] = Object.keys(value).filter((key) => !META_KEYS.has(key));

	if (extra !== undefined) throw fail(`meta.${extra} is not a meta field`);

	if (!Value.Check(DESCRIPTION, value)) throw fail("meta.description is not a string");

	if (!Value.Check(ARGS, value)) throw fail("meta.args is not an object");

	if (!Value.Check(WORKTREE, value)) throw fail("meta.worktree is not a boolean");

	if (!Value.Check(EXIT, value)) throw fail("meta.exit does not map statuses to integer exit codes");
	const worktreeArgs = value.worktree === true ? WORKTREE_ARGS : [];
	const reserved = new Set(["prompts", "overlay", "checkout", "help", "json", ...worktreeArgs]);
	let positionals = 0;

	for (const [arg, spec] of Object.entries(value.args ?? {})) {
		const at = `meta.args.${arg}`;

		if (reserved.has(arg)) throw fail(`${at} is a reserved name`);

		if (!Value.Check(SPEC_TYPE, spec)) throw fail(`${at}.type is not string, number, boolean or text`);
		const [unknown] = Object.keys(spec).filter((key) => !SPEC_KEYS.has(key));

		if (unknown !== undefined) throw fail(`${at}.${unknown} is not an argument field`);
		const { type } = spec;
		const expected = type === "text" ? "string" : type;

		if (!Value.Check(DEFAULTS[type], spec)) {
			throw fail(`${at}.default is not a ${type === "number" ? "positive integer" : expected}`);
		}

		if (!Value.Check(SPEC_FLAGS, spec)) {
			throw fail(`${at}: required and positional are booleans, and label is a string`);
		}

		if (spec.positional === true && type === "boolean") throw fail(`${at} is a boolean and cannot be positional`);

		if (spec.positional === true) positionals++;
	}

	if (positionals > 1) throw fail("meta.args has more than one positional argument");
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
		const { value } = result;
		checkMeta(value, name);
		const { description = "", args = {}, worktree = false, exit = {} } = value;

		return { description, args, worktree, exit };
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
	const profile = namedProfiles(source).find((p) => !Object.hasOwn(bundle.agents, p));

	return profile === undefined ? undefined : `${name} uses the agent profile ${profile}, which does not exist`;
}

/** The agent profiles of each literal `session("<profile>")` and `as: "<profile>"` of `source`. */
function namedProfiles(source: string): string[] {
	return [
		...unique(source.matchAll(/\bsession\(\s*(["'`])([^"'`]+)\1/g), 2),
		...unique(source.matchAll(/\bas:\s*(["'`])([^"'`]+)\1/g), 2),
	];
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

	if (meta.worktree) words.push("[--repo <repository>]", "[--base <branch>]", "[--branch <name>]");
	words.push("[--prompts <folder>]");

	for (const [arg, spec] of entries) {
		if (!spec.positional) continue;
		const value = spec.type === "text" ? `<${arg}.md> | <text>` : `<${arg}>`;
		words.push(spec.required && spec.type !== "text" ? value : `[${value}]`);
	}

	words.push("[--background] [--json]");

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
 * Whether the `/` at `at` of `source`, which starts no comment, starts a regular expression literal: after an operator,
 * an opening bracket, a separator or a keyword such as `return`, a value comes, and a `/` there is not a division.
 */
function regexStarts(source: string, at: number): boolean {
	const before = source.slice(0, at).trimEnd();

	if (before === "") return true;

	if (/[([{,;:=!&|?+\-*%<>~^]$/.test(before)) return true;

	return /\b(?:return|typeof|case|do|else|in|of|new|delete|void|throw|yield|await)$/.test(before);
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

	let inClass = false;

	for (let at = 0; at < source.length; at++) {
		const char = source[at] ?? "";
		const rest = source.slice(at, at + 2);

		if (rest === "//" || rest === "/*") {
			const end = source.indexOf(rest === "//" ? "\n" : "*/", at + 2);
			at = end === -1 ? source.length : end + (rest === "//" ? 0 : 1);
			continue;
		}

		if (char === "/" && regexStarts(source, at)) {
			// A quote in a regular expression literal does not start a string.
			for (at++, inClass = false; at < source.length; at++) {
				const inner = source[at];

				if (inner === "\\") at++;
				else if (inner === "[") inClass = true;
				else if (inner === "]") inClass = false;
				else if (inner === "/" && !inClass) break;
				else if (inner === "\n") break;
			}

			add("x");
		} else if (char === '"' || char === "'" || char === "`") {
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
 * The first agent profile that `source` uses, by name or as `default` for a session or an agent without one, whose
 * `model:` line names a model that `models` does not have, with that model as `<provider>/<id>`.
 */
async function unknownProfileModel(
	source: string,
	bundle: Bundle,
	models: () => Promise<Models>,
): Promise<{ readonly profile: string; readonly model: string } | undefined> {
	const names = new Set(namedProfiles(source));

	if (/\b(?:session|agent)\s*\(/.test(source)) names.add("default");

	const used = [...names].flatMap((profile) => {
		const model = bundle.agents[profile]?.model;

		return model === undefined ? [] : [{ profile, model }];
	});

	if (used.length === 0) return undefined;
	const registry = await models();
	const found = used.find(({ model }) => registry.getModel(model.provider, model.modelId) === undefined);

	return found && { profile: found.profile, model: `${found.model.provider}/${found.model.modelId}` };
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
	const profile = await unknownProfileModel(found.source, found.bundle, io.models);

	if (profile !== undefined) {
		throw new Error(
			`${found.name} uses the agent profile ${profile.profile}, whose model ${profile.model} Pi's model registry does not have`,
		);
	}

	io.stdout(`ok ${found.name}`);

	return 0;
}

type Args = {
	readonly name: string;
	readonly args: JsonObject;
	readonly meta: Meta;
	readonly bundle: RunBundle;
	/** The files that the run's sessions see in place of the disk, by path: see `Spec.overlay` of the children library. */
	readonly overlay?: Overlay;
	readonly repo: string | undefined;
	readonly base: string;
	readonly branch: string | undefined;
};

/** Everything a run needs, saved before execution starts. */
export type ScriptInput = Omit<Args, "repo" | "base" | "branch"> & {
	readonly runId: string;
	/** The run ID of the root run: the run itself, or the root run of the caller of a child run. */
	readonly root: string;
	readonly runDir: string;
	readonly cwd: string;
	/** The conversation whose `workflow` tool started the run, from `PI_SESSION_ID`; a child run has its caller's. */
	readonly parent?: string;
	/** Set by `--background`: the end of the run posts its outcome as a message to the conversation `parent`. */
	readonly notify?: true;
	/** Set when the CLI runs in Herdr (`HERDR_ENV`): Herdr creates the worktree; a child run has its caller's. */
	readonly herdr?: true;
	/** Set by `resume --answer`: the answer `text` to the `input` call with the document key `call`. */
	readonly answer?: { readonly call: string; readonly text: string };
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

	const options: Record<string, { type: "string" | "boolean" }> = {};
	options.prompts = { type: "string" };
	options.help = { type: "boolean" };
	options.json = { type: "boolean" };

	if (meta.worktree) {
		options.repo = { type: "string" };
		options.base = { type: "string" };
		options.branch = { type: "string" };
	}

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
		const raw = stringOption(values[arg]);
		const label = labelOf(arg, spec);
		const optional = spec.required !== true;

		const value =
			raw === undefined && spec.default !== undefined ? spec.default : await readItem(raw, io, label, optional);

		if (value !== undefined) args[arg] = value;
		else if (spec.required) throw new UsageError(`missing ${label}`);
	}

	return {
		args,
		prompts: stringOption(values.prompts),
		repo: stringOption(values.repo),
		base: stringOption(values.base) ?? "main",
		branch: stringOption(values.branch),
	};
}

/** The value of a `parseArgs` option of the type `string`, which is never a boolean. */
function stringOption(value: string | boolean | undefined): string | undefined {
	return value === true || value === false ? undefined : value;
}

/** The first `text` argument of `input`, whose subject is the run's title. */
function textArg(input: ScriptInput): string | undefined {
	const [arg] = Object.entries(input.meta.args).find(([, spec]) => spec.type === "text") ?? [];
	const value = arg === undefined ? undefined : input.args[arg];

	return Value.Check(Type.String(), value) ? value : undefined;
}

const STATUS = Type.Object({ status: Type.String() });
const REPORT = Type.Object({ report: Type.Array(Type.Unknown()) });

/** The status of a result object, if it has one. */
export function statusOf(result: JsonValue): string | undefined {
	return Value.Check(STATUS, result) ? result.status : undefined;
}

export const USAGE = "workflows <workflow | file.js | -> [<text>] [--<arg> <value>]...";

/** The checked arguments of `workflows <wf> ...`; throws `UsageError` or `Error` before a run directory exists. */
export async function parse([word = "", ...argv]: readonly string[], io: Io): Promise<Args> {
	const found = await findScript(word, io);
	const meta = await readMeta(found.source, found.name);
	const { args, prompts, repo, base, branch } = await parseValues(meta, argv, io, usageOf(found.name, meta));
	const bundle = prompts === undefined ? found.bundle : await loadBundle(io.cwd, resolve(io.cwd, prompts));
	const failed = problem(found.source, found.name, bundle, false);

	if (failed !== undefined) throw new Error(failed);

	return { name: found.name, args, meta, bundle: { ...bundle, main: found.source }, repo, base, branch };
}

/** The input saved before execution starts; with `meta.worktree`, it selects the repository of the new worktree. */
export async function prepare(
	{ repo, base, branch, ...args }: Args,
	run: Run & { readonly root?: string },
): Promise<ScriptInput> {
	const own = { ...args, runId: run.id, root: run.root ?? run.id, runDir: run.directory, cwd: run.cwd };

	if (!args.meta.worktree) return own;
	const { worktree, ...prepared } = await prepareWorktree(args.name, { repo, base, branch }, run);

	return { ...own, worktree: { ...prepared, path: worktree } };
}

/**
 * A short name of the run's subject for output lines: the last `title` of the run in its progress `events`, else the
 * subject of its first text argument, or the script name.
 */
export function title(input: ScriptInput, events: readonly ProgressEvent[]): string {
	const given = events.findLast((event) => event.kind === "title" && event.run === input.runId);

	if (given?.kind === "title") return given.text;
	const text = textArg(input);

	return text === undefined ? input.name : subject(text);
}

/** Prints the result's report lines and returns the exit code of its status: 3 for `waiting`, whatever `meta.exit` says. */
export function report(input: ScriptInput, result: JsonValue, io: Io): number {
	if (Value.Check(REPORT, result)) for (const line of result.report) io.stdout(String(line));
	else io.stdout(Value.Check(Type.String(), result) ? result : JSON.stringify(result));
	const status = statusOf(result);

	if (status === "waiting") return 3;

	return status !== undefined && Object.hasOwn(input.meta.exit, status) ? (input.meta.exit[status] ?? 0) : 0;
}

/**
 * The worktree of the child run `run` of the script `name` on the existing branch `branch` of the repository of
 * `run.cwd`, at `.worktrees/<repository name>/<run-id>` next to the repository, as `prepareWorktree` places it. Its
 * `start` is the caller's `start`, the commit that the change on the branch starts from.
 */
async function checkoutWorktree(
	name: string,
	branch: string,
	start: string,
	run: Run,
): Promise<NonNullable<ScriptInput["worktree"]>> {
	const repository = await git(run.cwd, "rev-parse", "--show-toplevel");

	if (!(await gitSucceeds(repository, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`))) {
		throw new Error(`run ${name}: no branch ${branch}`);
	}

	const path = join(dirname(repository), ".worktrees", basename(repository), run.id);

	return { repository, start, branch, path };
}

/**
 * The input of the child run `run` of a `run(name, args)` call: the script `name` of the caller's `bundle`, with the
 * `meta` defaults and the given args. With `meta.worktree`, `repo`, `base` and `branch` are not args: with `repo`, the
 * child gets its own worktree from `repo` and `base`, and otherwise it runs in the caller's directory, as a script
 * without `meta.worktree` does. A script without `meta.worktree` gets with `checkout` a worktree on that existing branch
 * of the caller's repository, and then needs `start` as a string. The args are not checked against `meta`, but a
 * `meta.worktree` script gets `start` as a string or not at all. `prompts` replaces the texts of prompts of the bundle
 * by name. `overlay` replaces or removes the templates (`prompts/<name>.md`) and profiles (`agents/<name>.md`) of the
 * bundle, and wins over `prompts` for the same template; its other keys are files that the run's sessions see, merged
 * over the caller's `overlay`.
 */
export async function childInput(
	request: {
		readonly name: string;
		readonly args: JsonObject;
		readonly bundle: RunBundle;
		readonly overlay?: Overlay | undefined;
	},
	run: Run & { readonly root: string },
): Promise<ScriptInput> {
	const { name, bundle } = request;
	const source = Object.hasOwn(bundle.scripts, name) ? bundle.scripts[name] : undefined;

	if (source === undefined) throw new Error(`no workflow ${name}`);
	const meta = await readMeta(source, name);
	const { prompts = {}, overlay = {}, checkout, ...given } = request.args;

	if (!Value.Check(OBJECT, prompts)) throw new Error(`run ${name}: prompts is not an object of prompt texts`);

	if (!Value.Check(OVERLAY, overlay)) {
		throw new Error(`run ${name}: overlay is not an object of path to text or null`);
	}

	const replaced = { ...bundle.prompts };
	const agents = { ...bundle.agents };
	const files = { ...request.overlay };

	const prompt: BundleKind = {
		label: "prompt",
		source: bundle.prompts,
		set: (key: string, text: string | null) => {
			if (text === null) delete replaced[key];
			else replaced[key] = instructions(text);
		},
	};

	const kinds = new Map<string, BundleKind>([
		["prompts", prompt],
		[
			"agents",
			{
				label: "agent profile",
				source: bundle.agents,
				set: (key: string, text: string | null) => {
					if (text === null) delete agents[key];
					else agents[key] = profileOf(key, text);
				},
			},
		],
	]);

	// The `prompts` edits come first, so the overlay wins for the same template.
	const edits: { kind: BundleKind; item: string; value: string | null }[] = Object.entries(prompts).map(
		([item, text]) => ({ kind: prompt, item, value: String(text) }),
	);

	for (const [key, value] of Object.entries(overlay)) {
		const slash = key.indexOf("/");
		const kind = BUNDLE_KEY.test(key) ? kinds.get(key.slice(0, slash)) : undefined;

		if (kind === undefined) files[key] = value;
		else edits.push({ kind, item: key.slice(slash + 1, -".md".length), value });
	}

	for (const { kind, item, value } of edits) {
		if (!Object.hasOwn(kind.source, item)) throw new Error(`run ${name}: no ${kind.label} ${item}`);
		kind.set(item, value);
	}

	const defaults = Object.entries(meta.args).flatMap(([arg, spec]) =>
		spec.default === undefined ? [] : [[arg, spec.default] as const],
	);

	const bundled = { name, meta, bundle: { ...bundle, prompts: replaced, agents, main: source } };
	const script = Object.keys(files).length === 0 ? bundled : { ...bundled, overlay: files };

	const here = { runId: run.id, root: run.root, runDir: run.directory, cwd: run.cwd };

	if (checkout !== undefined && !Value.Check(Type.String(), checkout)) {
		throw new Error(`run ${name}: checkout is not a branch name`);
	}

	if (!meta.worktree) {
		const input = { ...script, args: { ...Object.fromEntries(defaults), ...given }, ...here };

		if (checkout === undefined) return input;

		if (!Value.Check(Type.String(), given.start)) throw new Error(`run ${name}: checkout needs start as a string`);

		return { ...input, worktree: await checkoutWorktree(name, checkout, given.start, run) };
	}

	if (checkout !== undefined) throw new Error(`run ${name}: checkout is for a script without meta.worktree`);

	// `repo`, `base` and `branch` place a `meta.worktree` run; any other script gets them as args.
	const { repo, base = "main", branch, ...own } = given;

	if (!Value.Check(START, own)) throw new Error(`run ${name}: start is not a string`);
	const input = { ...script, args: { ...Object.fromEntries(defaults), ...own } };

	if (repo === undefined) return { ...input, ...here };

	return prepare(
		{ ...input, repo: String(repo), base: String(base), branch: branch === undefined ? branch : String(branch) },
		run,
	);
}
