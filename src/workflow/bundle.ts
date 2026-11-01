/**
 * The bundle of a run: the scripts, prompt templates and agent profiles of the package and the project, and the script
 * lib of the package. Each Pi prompt template in `prompts/` is frontmatter, the instructions, then a last line `$@`,
 * where interactive Pi puts its arguments. The engine sends the instructions followed by its named inputs.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import type { ModelRef } from "@earendil-works/pi-durable";
import type { Overlay } from "@vzlentin/harness/overlay";
import { git } from "../git.ts";

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

/** The overlay key of a bundle item, `<kind>/<name>.md`, as `prompts/<name>.md` or `agents/<name>.md`. */
const BUNDLE_KEY = /^[^/]+\/[^/]+\.md$/;

/** A kind of bundle item that a `run()` call can replace or remove: its name in errors, the bundle's items, the setter. */
interface BundleKind {
	readonly label: string;
	readonly source: RunBundle["prompts"] | RunBundle["agents"];
	readonly set: (item: string, text: string | null) => void;
}

/** The prompts and profiles of a bundle after the edits of a `run()` call, and the overlay files of the call. */
export type BundleEdits = {
	readonly prompts: RunBundle["prompts"];
	readonly agents: RunBundle["agents"];
	readonly files: Overlay;
};

/**
 * The prompts, profiles and overlay files of the `run()` call of the script `name` with `bundle`. `prompts` replaces
 * the texts of prompts by name. `overlay` replaces or removes templates (`prompts/<name>.md`) and profiles
 * (`agents/<name>.md`), and wins over `prompts` for the same template; its other keys are files merged over `base`.
 */
export function editBundle(
	name: string,
	bundle: RunBundle,
	prompts: Readonly<Record<string, string>>,
	overlay: Readonly<Record<string, string | null>>,
	base: Overlay | undefined,
): BundleEdits {
	const replaced = { ...bundle.prompts };
	const agents = { ...bundle.agents };
	const files: Writable<Overlay> = { ...base };

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
		([item, text]) => ({ kind: prompt, item, value: text }),
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

	return { prompts: replaced, agents, files };
}
