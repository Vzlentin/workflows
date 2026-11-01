/**
 * `workflows <wf>`: any workflow script as a command. The checked arguments of a run, the input that it saves before it
 * starts, and its title and report.
 */
import { readFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { JsonValue } from "@earendil-works/chord";
import type { JsonObject } from "@earendil-works/pi-durable";
import type { Overlay } from "@vzlentin/harness/overlay";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { git, gitSucceeds, selectRepository } from "./git.ts";
import type { ProgressEvent } from "./progress.ts";
import type { Run } from "./run.ts";
import { instructions, loadBundle, profileOf, type RunBundle } from "./workflow/bundle.ts";
import { findScript, type Io, labelOf, problem, UsageError, usageOf, withUsage } from "./workflow/find.ts";
import { type Meta, OBJECT, readMeta } from "./workflow/meta.ts";

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
