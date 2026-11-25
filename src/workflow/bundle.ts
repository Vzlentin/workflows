/**
 * The bundle of a run: the scripts and prompt templates of the package and the project, the texts that the project adds
 * after a prompt, the merged agents tables, and the script lib of the package. Each Pi prompt template in `prompts/` is
 * frontmatter, the instructions, then a last line `$@`, where interactive Pi puts its arguments. The engine sends the
 * instructions followed by its named inputs.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Overlay } from "@vzlentin/harness/overlay";
import { git } from "../git.ts";
import { isCommand } from "../tool.ts";
import { mergeRoles, type Roles, readRoles, userTablePath } from "./roles.ts";

/**
 * The scripts and prompt instructions of the package and the project, the merged agents tables, and the script lib of
 * the package, saved by a run before it starts.
 */
export type Bundle = {
	readonly scripts: Readonly<Record<string, string>>;
	/**
	 * The files of `workflows/lib/` in name order, wrapped in a function that returns the names that
	 * `workflows/script.d.ts` declares, which the prelude gives every script after the script calls. The other names of
	 * the lib files are not globals of a script.
	 */
	readonly lib: string;
	/** The instructions of each prompt, without the text of its `<name>.after.md`. */
	readonly prompts: Readonly<Record<string, string>>;
	/**
	 * The instructions of each file `prompts/<name>.after.md`, by prompt name, which `promptText` adds at the end of the
	 * prompt `<name>`.
	 */
	readonly after: Readonly<Record<string, string>>;
	/** The `agents.json` tables of the project, the user and the package, merged by `mergeRoles`. */
	readonly agents: Roles;
};

/** `T` with fields that a builder sets one by one. */
export type Writable<T> = { -readonly [K in keyof T]: T[K] };

/** The bundle of a run and its own script, saved in the run's input. */
export type RunBundle = Bundle & { readonly main: string };

/** The script side of the package, in the same shape as a project's `.workflows/`. */
const PACKAGE = fileURLToPath(new URL("../../workflows/", import.meta.url));

/** `<base>/<folder>/*<extension>` by name; a missing folder has none. */
export async function readFolder(base: string, folder: string, extension: string): Promise<Record<string, string>> {
	const directory = join(base, folder);
	const files = (await readdir(directory).catch(() => [])).filter((file) => file.endsWith(extension)).sort();

	const entries = await Promise.all(
		files.map(async (file) => [file.slice(0, -extension.length), await readFile(join(directory, file), "utf8")]),
	);

	return Object.fromEntries(entries);
}

/** `<folder>/*<extension>` of the package, merged with the project files `local`, which replace those of their name. */
async function readMerged(
	folder: string,
	extension: string,
	local: Promise<Record<string, string>>,
): Promise<Record<string, string>> {
	const [own, mine] = await Promise.all([readFolder(PACKAGE, folder, extension), local]);

	return { ...own, ...mine };
}

/** The `*.md` files of the folder `folder` of `--prompts` by name; a missing folder throws. */
async function promptsFolder(folder: string): Promise<Record<string, string>> {
	const found = await stat(folder).then(
		(entry) => entry.isDirectory(),
		() => false,
	);

	if (!found) throw new Error(`no prompts folder ${folder}`);

	return readFolder(folder, ".", ".md");
}

/** A file `<name>.after.md`: its path and its text. */
type AfterFile = { readonly path: string; readonly text: string };

/** A prompts folder: its templates by name, and its files `<name>.after.md` by prompt name. */
type SplitFolder = { readonly templates: Record<string, string>; readonly after: Record<string, AfterFile> };

/** The suffix of the name of a prompts file that adds text at the end of the prompt of its name. */
const AFTER = ".after";

/**
 * The files `files` of the prompts folder `folder` split into the templates by name and the files
 * `<name>.after.md` by prompt name, each with its path.
 */
function splitAfter(folder: string, files: Readonly<Record<string, string>>): SplitFolder {
	const templates: Record<string, string> = {};
	const after: Record<string, AfterFile> = {};

	for (const [name, text] of Object.entries(files)) {
		if (!name.endsWith(AFTER)) templates[name] = text;
		else after[name.slice(0, -AFTER.length)] = { path: join(folder, `${name}.md`), text };
	}

	return { templates, after };
}

/**
 * The `scripts/*.js` and `prompts/*.md` of the package and of `.workflows/` in the Git repository of `cwd`, or in `cwd`
 * outside a repository, read now, and the `lib/*.js` of the package. The agents table is the one of `readAgents` for
 * that `.workflows/`. Without `cwd`, only the package files. Each `<name>.md` of the folder `prompts` replaces the
 * template of that name. Each `<name>.after.md` of `.workflows/prompts/`, or of the folder `prompts`, which wins for
 * the same name, gives the text that `promptText` adds to the prompt `<name>`, and fails when there is no prompt of that
 * name.
 */
export async function loadBundle(cwd?: string, prompts?: string): Promise<Bundle> {
	const project = cwd === undefined ? PACKAGE : await projectFolder(cwd);

	const [scripts, own, local, given, agents, lib, declarations] = await Promise.all([
		loadScripts(project),
		readFolder(PACKAGE, "prompts", ".md"),
		readFolder(project, "prompts", ".md"),
		prompts === undefined ? {} : promptsFolder(prompts),
		readAgents(cwd === undefined ? undefined : project),
		readFolder(PACKAGE, "lib", ".js"),
		readFile(join(PACKAGE, "script.d.ts"), "utf8"),
	]);

	const mine = splitAfter(join(project, "prompts"), local);
	const overrides = splitAfter(prompts ?? "", given);
	const merged = { ...own, ...mine.templates };

	for (const name of Object.keys(overrides.templates)) {
		if (merged[name] === undefined) throw new Error(`${prompts}/${name}.md replaces no prompt of the package`);
	}

	const templates = { ...merged, ...overrides.templates };
	const after: Record<string, string> = {};

	for (const [name, { path, text }] of Object.entries({ ...mine.after, ...overrides.after })) {
		if (templates[name] === undefined) throw new Error(`${path} adds to no prompt`);
		after[name] = instructions(text);
	}

	return {
		scripts,
		lib: wrapLib(Object.values(lib).join("\n"), declarations),
		prompts: Object.fromEntries(Object.entries(templates).map(([name, text]) => [name, instructions(text)])),
		after,
		agents,
	};
}

/**
 * The prompt `name` of `bundle`: its instructions, then the text of its `<name>.after.md` after an empty line, or
 * undefined when the bundle has no prompt `name`. Every prompt of a run comes from it, so a prompt that a `run()` call
 * replaces keeps its added text.
 */
export function promptText(bundle: Pick<Bundle, "prompts" | "after">, name: string): string | undefined {
	if (!Object.hasOwn(bundle.prompts, name)) return undefined;
	const added = Object.hasOwn(bundle.after, name) ? bundle.after[name] : undefined;

	return [bundle.prompts[name], added].filter((text) => text !== undefined && text !== "").join("\n\n");
}

/**
 * The merge of the `agents.json` tables of the project folder `project`, of the user and of the package, in that order,
 * read now. Without `project`, only the table of the package.
 */
export async function readAgents(project: string | undefined): Promise<Roles> {
	const own = join(PACKAGE, "agents.json");
	const tables = project === undefined ? [own] : [join(project, "agents.json"), userTablePath(), own];

	return mergeRoles(await Promise.all(tables.map(readRoles)));
}

/** A global that `workflows/script.d.ts` declares. */
const DECLARED = /^declare (?:const|function) (\w+)/gm;

/** A name that a lib file declares at its top level. */
const LIB_NAME = /^(?:async function|function|const|let|class) (\w+)/gm;

/**
 * The lib code `code` in a function that returns the names of `declarations` that it declares, in the order of
 * `declarations`, as constants of the same names.
 */
function wrapLib(code: string, declarations: string): string {
	const own = new Set(Array.from(code.matchAll(LIB_NAME), ([, name]) => name));
	const names = Array.from(declarations.matchAll(DECLARED), ([, name]) => name).filter((name) => own.has(name));
	const list = names.join(", ");

	return `const { ${list} } = (() => {\n${code}\nreturn { ${list} };\n})();`;
}

/**
 * The scripts of the package and of the project folder `project`, where a project script replaces the package script
 * of its name. Throws for a project script with the name of a command.
 */
export function loadScripts(project: string): Promise<Record<string, string>> {
	return readMerged("scripts", ".js", projectScripts(project));
}

/** The scripts of the project folder `project`. Throws for a script with the name of a command. */
async function projectScripts(project: string): Promise<Record<string, string>> {
	const local = await readFolder(project, "scripts", ".js");
	const clash = Object.keys(local).find(isCommand);

	if (clash !== undefined) {
		throw new Error(
			`${join(project, "scripts", `${clash}.js`)} has the name of the command ${clash}; rename the script`,
		);
	}

	return local;
}

/** `.workflows/` at the root of the Git repository of `cwd`, or in `cwd` outside a repository. */
export async function projectFolder(cwd: string): Promise<string> {
	const root = await git(cwd, "rev-parse", "--show-toplevel").catch(() => cwd);

	return join(root, ".workflows");
}

/** The leading comments and `export const meta =` of a script that declares its `meta`. */
export const META = /^((?:\s|\/\/[^\n]*|\/\*[\s\S]*?\*\/)*)export\s+(const\s+meta\s*=\s*)/;

/** The instructions of `prompts/<name>.md`: its body without frontmatter or the last `$@`. */
export function instructions(template: string): string {
	const body = template.startsWith("---\n") ? template.slice(template.indexOf("\n---\n", 4) + 5) : template;
	const trimmed = body.trim();

	return (trimmed.endsWith("$@") ? trimmed.slice(0, -2) : trimmed).trim();
}

/** The instructions, then each non-empty input as a `## <name>` section. */
export function render(body: string, inputs: Record<string, string> = {}): string {
	const sections = Object.entries(inputs)
		.map(([name, value]) => [name, value.trim()] as const)
		.filter(([, value]) => value !== "")
		.map(([name, value]) => `## ${name}\n${value}`);

	return [body, ...sections].join("\n\n");
}

/** The overlay key of a prompt template, `prompts/<name>.md`. */
const PROMPT_KEY = /^prompts\/([^/]+)\.md$/;

/** The prompts of a bundle after the edits of a `run()` call, and the overlay files of the call. */
export type BundleEdits = {
	readonly prompts: RunBundle["prompts"];
	readonly files: Overlay;
};

/**
 * The prompts and overlay files of the `run()` call of the script `name` with `bundle`. `prompts` replaces the texts
 * of prompts by name. `overlay` replaces or removes templates (`prompts/<name>.md`), and wins over `prompts` for the
 * same template; its other keys are files merged over `base`. An overlay key `prompts/<name>.after.md` fails, because
 * the edits do not change `bundle.after`: `promptText` adds the text of `<name>.after.md` to a replaced prompt too.
 */
export function editBundle(
	name: string,
	bundle: RunBundle,
	prompts: Readonly<Record<string, string>>,
	overlay: Readonly<Record<string, string | null>>,
	base: Overlay | undefined,
): BundleEdits {
	const replaced = { ...bundle.prompts };
	const files: Writable<Overlay> = { ...base };
	// The `prompts` edits come first, so the overlay wins for the same template.
	const edits: [string, string | null][] = Object.entries(prompts);

	for (const [key, value] of Object.entries(overlay)) {
		const item = PROMPT_KEY.exec(key)?.[1];

		if (item === undefined) files[key] = value;
		else if (item.endsWith(AFTER)) throw new Error(`run ${name}: ${key}: an overlay cannot replace a .after text`);
		else edits.push([item, value]);
	}

	for (const [item, text] of edits) {
		if (!Object.hasOwn(bundle.prompts, item)) throw new Error(`run ${name}: no prompt ${item}`);

		if (text === null) delete replaced[item];
		else replaced[item] = instructions(text);
	}

	return { prompts: replaced, files };
}
