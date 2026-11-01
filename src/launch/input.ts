/**
 * `workflows <wf>`: any workflow script as a command. The checked arguments of a run, its run ID, and the input that it
 * saves before it starts.
 */
import { randomBytes } from "node:crypto";
import { join, resolve } from "node:path";
import type { JsonObject } from "@earendil-works/pi-durable";
import type { Overlay } from "@vzlentin/harness/overlay";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { editBundle, loadBundle, type RunBundle } from "../workflow/bundle.ts";
import { findScript, type Io, problem, usageOf } from "../workflow/find.ts";
import { type Meta, OBJECT, readMeta } from "../workflow/meta.ts";
import { parseValues } from "./args.ts";
import { checkoutWorktree, prepareWorktree, type Worktree } from "./worktree.ts";

/** A run ID, `<UTC timestamp>-<8 hex>`, so a sort by name is a sort by start time. */
export function newRunId(): string {
	const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*$/, "");

	return `${stamp}-${randomBytes(4).toString("hex")}`;
}

/** What a run needs from the command line before it starts. */
export type Run = { readonly id: string; readonly directory: string; readonly cwd: string };

/** The first non-empty line of `item`, without leading #, as `subjectOf` of `workflows/lib/text.js`, which the engine cannot import. */
export function subject(item: string): string {
	const line = item.split("\n").find((candidate) => candidate.trim() !== "") ?? "";

	return line.replace(/^#+/, "").trim();
}

const START = Type.Object({ start: Type.Optional(Type.String()) });
const OVERLAY = Type.Record(Type.String(), Type.Union([Type.String(), Type.Null()]));

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
	readonly worktree?: Worktree;
};

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
	const clone = join(run.directory, "repository");

	return { ...own, worktree: await prepareWorktree(args.name, { repo, base, branch }, run.id, run.cwd, clone) };
}

/**
 * The input of the child run `run` of a `run(name, args)` call: the script `name` of the caller's `bundle`, with the
 * `meta` defaults and the given args. With `meta.worktree`, `repo`, `base` and `branch` are not args: with `repo`, the
 * child gets its own worktree from `repo` and `base`, and otherwise it runs in the caller's directory, as a script
 * without `meta.worktree` does. A script without `meta.worktree` gets with `checkout` a worktree on that existing branch
 * of the caller's repository, and then needs `start` as a string. The args are not checked against `meta`, but a
 * `meta.worktree` script gets `start` as a string or not at all. `prompts` and `overlay` edit the bundle as
 * `editBundle` says.
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

	const texts = Object.fromEntries(Object.entries(prompts).map(([item, text]) => [item, String(text)]));
	const edited = editBundle(name, bundle, texts, overlay, request.overlay);

	const defaults = Object.entries(meta.args).flatMap(([arg, spec]) =>
		spec.default === undefined ? [] : [[arg, spec.default] as const],
	);

	const bundled = {
		name,
		meta,
		bundle: { ...bundle, prompts: edited.prompts, agents: edited.agents, main: source },
	};

	const script = Object.keys(edited.files).length === 0 ? bundled : { ...bundled, overlay: edited.files };

	const here = { runId: run.id, root: run.root, runDir: run.directory, cwd: run.cwd };

	if (checkout !== undefined && !Value.Check(Type.String(), checkout)) {
		throw new Error(`run ${name}: checkout is not a branch name`);
	}

	if (!meta.worktree) {
		const input = { ...script, args: { ...Object.fromEntries(defaults), ...given }, ...here };

		if (checkout === undefined) return input;

		if (!Value.Check(Type.String(), given.start)) throw new Error(`run ${name}: checkout needs start as a string`);

		return { ...input, worktree: await checkoutWorktree(name, checkout, given.start, run.id, run.cwd) };
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
