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
import { findScript, type Io, problem, UsageError, usageOf } from "../workflow/find.ts";
import { type Meta, OBJECT, readMeta } from "../workflow/meta.ts";
import { mergeRoles, type Roles } from "../workflow/roles.ts";
import { checkArgs, parseValues, runArgs } from "./args.ts";
import { checkoutWorktree, prepareWorktree, repositoryAt, type Worktree } from "./worktree.ts";

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

/** The args that place a `meta.worktree` child run, and its `start`. */
const WORKTREE_PLACEMENT: Meta["args"] = {
	repo: { type: "string" },
	base: { type: "string" },
	branch: { type: "string" },
	start: { type: "string" },
};

/** The values that `WORKTREE_PLACEMENT` lets through. */
type WorktreePlacement = {
	readonly repo?: string;
	readonly base?: string;
	readonly branch?: string;
	readonly start?: string;
};

/** Throws as `checkArgs` when a key of `WORKTREE_PLACEMENT` in `given` is not a string. */
function checkWorktreePlacement(name: string, given: JsonObject): asserts given is JsonObject & WorktreePlacement {
	checkArgs(name, WORKTREE_PLACEMENT, given);
}

/** The arg that places a `meta.repo` child run. */
const REPO: Meta["args"] = { repo: { type: "string" } };

/** Throws as `checkArgs` when `repo` in `given` is not a string. */
function checkRepo(name: string, given: JsonObject): asserts given is JsonObject & { readonly repo?: string } {
	checkArgs(name, REPO, given);
}

/**
 * The directory and the args of a child run of the script `name` without `meta.worktree`. With `meta.repo`, `repo` is
 * not an arg: it places the child at the top level of that local repository, resolved from the caller's `cwd`. Without
 * `repo`, or without `meta.repo`, the child runs in the caller's `cwd`.
 */
async function placeChild(name: string, meta: Meta, given: JsonObject, cwd: string) {
	if (meta.placement !== "repo") return { args: given, cwd };
	checkRepo(name, given);
	const { repo, ...args } = given;

	if (repo === undefined) return { args, cwd };
	const top = await repositoryAt(resolve(cwd, repo));

	if (top === undefined) throw new Error(`run ${name}: repo ${repo} is not the top level of a Git repository`);

	return { args, cwd: top };
}

const OVERLAY = Type.Record(Type.String(), Type.Union([Type.String(), Type.Null()]));

type Args = {
	readonly name: string;
	readonly args: JsonObject;
	readonly meta: Meta;
	readonly bundle: RunBundle;
	/** The run layer of the roles, from `--agents`, which `bundle.agents` already has above the tables. */
	readonly agents: Roles;
	/** The files that the run's sessions see in place of the disk, by path: see `Spec.overlay` of the children library. */
	readonly overlay?: Overlay;
	/**
	 * `--repo`: with `meta.worktree`, the repository of the new worktree; with `meta.repo`, the run's directory; undefined
	 * for any other script.
	 */
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
	/**
	 * The directory of the run: the directory of the command or of the caller, or the top level of the repository of
	 * `--repo` or of `repo` with `meta.repo`. A run with `worktree` runs in the worktree in its place.
	 */
	readonly cwd: string;
	/** The conversation whose `workflow` tool started the run, from `PI_SESSION_ID`; a child run has its caller's. */
	readonly parent?: string;
	/** Set by `--background`: the end of the run posts its outcome as a message to the conversation `parent`. */
	readonly notify?: true;
	/** The hc terminal of the command that started the root run, from `HC_TERMINAL_ID`; a child run has its caller's. */
	readonly caller?: string;
	/** Set by `resume --answer`: the answer `text` to the `input` call with the document key `call`. */
	readonly answer?: { readonly call: string; readonly text: string };
	readonly worktree?: Worktree;
};

export const USAGE = "workflows <workflow | file.js | -> [<text>] [--<arg> <value>]...";

/** The checked arguments of `workflows <wf> ...`; throws `UsageError` or `Error` before a run directory exists. */
export async function parse([word = "", ...argv]: readonly string[], io: Io): Promise<Args> {
	const found = await findScript(word, io);
	const meta = await readMeta(found.source, found.name);
	const { args, prompts, agents, repo, base, branch } = await parseValues(meta, argv, io, usageOf(found.name, meta));
	const bundle = prompts === undefined ? found.bundle : await loadBundle(io.cwd, resolve(io.cwd, prompts));
	const failed = problem(found.source, found.name, bundle);

	if (failed !== undefined) throw new Error(failed);

	const resolved = { ...bundle, agents: mergeRoles([agents, bundle.agents]), main: found.source };

	return { name: found.name, args, meta, bundle: resolved, agents, repo, base, branch };
}

/**
 * The input saved before execution starts. With `meta.worktree`, it selects the repository of the new worktree. With
 * `meta.repo` and `repo`, the run's directory is the top level of the local repository `repo`, resolved from
 * `run.cwd`; any other `repo` throws `UsageError` with the usage of the script.
 */
export async function prepare(
	{ repo, base, branch, ...args }: Args,
	run: Run & { readonly root?: string },
): Promise<ScriptInput> {
	const own = { ...args, runId: run.id, root: run.root ?? run.id, runDir: run.directory, cwd: run.cwd };

	switch (args.meta.placement) {
		case "here":
			return own;

		case "repo": {
			if (repo === undefined) return own;
			const top = await repositoryAt(resolve(run.cwd, repo));

			if (top === undefined) {
				const usage = usageOf(args.name, args.meta);

				throw new UsageError(`--repo ${repo} is not the top level of a Git repository`, usage);
			}

			return { ...own, cwd: top };
		}

		case "worktree": {
			const clone = join(run.directory, "repository");
			const worktree = await prepareWorktree(args.name, { repo, base, branch }, run.id, run.cwd, clone);

			return { ...own, worktree };
		}
	}
}

/**
 * The input of the child run `run` of a `run(name, args)` call: the script `name` of the caller's `bundle`, with the
 * `meta` defaults and the given args. With `meta.worktree`, `repo`, `base` and `branch` are not args: with `repo`, the
 * child gets its own worktree from `repo` and `base`, and otherwise it runs in the caller's directory, as a script
 * without `meta.worktree` does. With `meta.repo`, `repo` is not an arg either: it places the child as `placeChild` says.
 * A script without `meta.worktree` gets with `checkout` a worktree on that existing branch of the repository of its
 * directory, and then needs `start` as a string. `runArgs` checks the declared args against `meta` before any worktree
 * exists. With `meta.worktree`, `checkArgs` first checks `repo`, `base`, `branch` and `start` as optional strings, with
 * the same wording. `prompts` and `overlay` edit the bundle as `editBundle` says. The child keeps `agents`, the caller's
 * run layer.
 */
export async function childInput(
	request: {
		readonly name: string;
		readonly args: JsonObject;
		readonly bundle: RunBundle;
		readonly agents: Roles;
		readonly overlay?: Overlay | undefined;
	},
	run: Run & { readonly root: string },
): Promise<ScriptInput> {
	const { name, bundle, agents } = request;
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

	const bundled = {
		name,
		meta,
		bundle: { ...bundle, prompts: edited.prompts, main: source },
		agents,
	};

	const script = Object.keys(edited.files).length === 0 ? bundled : { ...bundled, overlay: edited.files };

	const here = { runId: run.id, root: run.root, runDir: run.directory, cwd: run.cwd };

	if (checkout !== undefined && !Value.Check(Type.String(), checkout)) {
		throw new Error(`run ${name}: checkout is not a branch name`);
	}

	if (meta.placement !== "worktree") {
		const placed = await placeChild(name, meta, given, run.cwd);
		const input = { ...script, args: runArgs(name, meta, placed.args), ...here, cwd: placed.cwd };

		if (checkout === undefined) return input;

		if (!Value.Check(Type.String(), given.start)) throw new Error(`run ${name}: checkout needs start as a string`);

		return { ...input, worktree: await checkoutWorktree(name, checkout, given.start, run.id, placed.cwd) };
	}

	if (checkout !== undefined) throw new Error(`run ${name}: checkout is for a script without meta.worktree`);

	// `repo`, `base` and `branch` place a `meta.worktree` run; any other script gets them as args.
	checkWorktreePlacement(name, given);
	const { repo, base = "main", branch, ...own } = given;
	const input = { ...script, args: runArgs(name, meta, own) };

	if (repo === undefined) return { ...input, ...here };

	return prepare({ ...input, repo, base, branch }, run);
}
