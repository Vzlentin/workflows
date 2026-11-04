/**
 * The bundle of a run: the scripts and prompt templates of the package and the project, the merged agents tables, and
 * the script lib of the package. Each Pi prompt template in `prompts/` is frontmatter, the instructions, then a last
 * line `$@`, where interactive Pi puts its arguments. The engine sends the instructions followed by its named inputs.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Overlay } from "@vzlentin/harness/overlay";
import { git } from "../git.ts";
import { mergeRoles, type Roles, readRoles, userTablePath } from "./roles.ts";

/**
 * The scripts and prompt instructions of the package and the project, the merged agents tables, and the script lib of
 * the package, saved by a run before it starts.
 */
export type Bundle = {
	readonly scripts: Readonly<Record<string, string>>;
	/** The files of `workflows/lib/` in name order, which the prelude gives every script after the script calls. */
	readonly lib: string;
	readonly prompts: Readonly<Record<string, string>>;
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

/**
 * The `scripts/*.js` and `prompts/*.md` of the package and of `.workflows/` in the Git repository of `cwd`, or in `cwd`
 * outside a repository, read now, and the `lib/*.js` of the package. The agents table is the merge of the
 * `agents.json` of that `.workflows/`, of the user and of the package, in that order. Without `cwd`, only the package
 * files. Each `<name>.md` of the folder `prompts` replaces the template of that name.
 */
export async function loadBundle(cwd?: string, prompts?: string): Promise<Bundle> {
	const project = cwd === undefined ? PACKAGE : await projectFolder(cwd);

	const own = join(PACKAGE, "agents.json");
	const tables = cwd === undefined ? [own] : [join(project, "agents.json"), userTablePath(), own];

	const [scripts, merged, layers, lib] = await Promise.all([
		loadScripts(project),
		readMerged(project, "prompts", ".md"),
		Promise.all(tables.map(readRoles)),
		readFolder(PACKAGE, "lib", ".js"),
	]);

	const templates = prompts === undefined ? merged : { ...merged, ...(await overrides(prompts, merged)) };

	return {
		scripts,
		lib: Object.values(lib).join("\n"),
		prompts: Object.fromEntries(Object.entries(templates).map(([name, text]) => [name, instructions(text)])),
		agents: mergeRoles(layers),
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
 * same template; its other keys are files merged over `base`.
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
		else edits.push([item, value]);
	}

	for (const [item, text] of edits) {
		if (!Object.hasOwn(bundle.prompts, item)) throw new Error(`run ${name}: no prompt ${item}`);

		if (text === null) delete replaced[item];
		else replaced[item] = instructions(text);
	}

	return { prompts: replaced, files };
}
