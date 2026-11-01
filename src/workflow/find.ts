/**
 * Find a workflow script, list the scripts, and the usage and help of a script. Usage errors and the terminal input and
 * output of a command are here too.
 */
import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { type Bundle, loadBundle } from "./bundle.ts";
import { type ArgSpec, type Meta, readMeta } from "./meta.ts";

/** Bad command-line usage: the command prints `usage`, or its own usage, and exits 2. */
export class UsageError extends Error {
	readonly usage: string | undefined;

	constructor(message: string, usage?: string) {
		super(message);
		this.usage = usage;
	}
}

const CODED = Type.Object({ code: Type.String(), message: Type.String() });

/** The message of `cause` when it is an error of `parseArgs`, which is bad usage. */
export function parseArgsMessage(cause: unknown): string | undefined {
	return Value.Check(CODED, cause) && cause.code.startsWith("ERR_PARSE_ARGS") ? cause.message : undefined;
}

/** The result of `parse`, a call of `parseArgs`, whose errors become bad usage that prints `usage`. */
export function withUsage<T>(parse: () => T, usage: string): T {
	try {
		return parse();
	} catch (error) {
		const message = parseArgsMessage(error);

		if (message !== undefined) throw new UsageError(message, usage);

		throw error;
	}
}

export type Io = {
	readonly cwd: string;
	/** The piped stdin, or undefined when stdin is a terminal. */
	readonly stdin: () => Promise<string | undefined>;
	readonly stdout: (line: string) => void;
	readonly stderr: (line: string) => void;
	/** Draws the progress lines of a run again in place, when stderr is a terminal. */
	readonly redraw?: ((lines: readonly string[]) => void) | undefined;
};

const unique = (matches: Iterable<RegExpMatchArray>, group: number) =>
	[...new Set([...matches].map((match) => match[group] ?? ""))].filter((value) => value !== "");

/** The first prompt call `prompts.<name>(` of `source` without a template, or agent profile when `profiles` is set. */
export function problem(source: string, name: string, bundle: Bundle, profiles: boolean): string | undefined {
	const prompt = unique(source.matchAll(/\bprompts\.([A-Za-z_$][\w$]*)\s*\(/g), 1).find(
		(p) => !Object.hasOwn(bundle.prompts, p),
	);

	if (prompt !== undefined) return `${name} uses prompts.${prompt}, which has no template`;

	if (!profiles) return undefined;
	const profile = namedProfiles(source).find((p) => !Object.hasOwn(bundle.agents, p));

	return profile === undefined ? undefined : `${name} uses the agent profile ${profile}, which does not exist`;
}

/** The agent profiles of each literal `session("<profile>")` and `as: "<profile>"` of `source`. */
export function namedProfiles(source: string): string[] {
	return [
		...unique(source.matchAll(/\bsession\(\s*(["'`])([^"'`]+)\1/g), 2),
		...unique(source.matchAll(/\bas:\s*(["'`])([^"'`]+)\1/g), 2),
	];
}

type Found = { readonly name: string; readonly source: string; readonly bundle: Bundle };

/** `-` for stdin, a `.js` file or a path relative to the current directory, or a script name of the bundle. */
export async function findScript(word: string, io: Io): Promise<Found> {
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

export const labelOf = (name: string, spec: ArgSpec) => spec.label ?? name;

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
