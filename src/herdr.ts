/** The Herdr commands of workflows: the worktree of a run, the pick loop, and where `attach` opens Pi. */
import { existsSync } from "node:fs";
import { mkdir, realpath } from "node:fs/promises";
import { dirname } from "node:path";
import { herdr } from "@vzlentin/harness/herdr";
import { type Static, type TSchema, Type } from "typebox";
import { Value } from "typebox/value";
import type { ScriptInput } from "./meta.ts";

type Worktree = NonNullable<ScriptInput["worktree"]>;

/** The part of the output of `herdr worktree create` that has the workspace that it opened. */
const WORKTREE_CREATED = Type.Object({
	result: Type.Object({ workspace: Type.Object({ workspace_id: Type.String() }) }),
});

/** The part of the output of `herdr pane list` that has the panes. */
const PANES = Type.Object({ result: Type.Object({ panes: Type.Array(Type.Object({ pane_id: Type.String() })) }) });

/** The part of the output of `herdr pane get` that has the workspace of the pane. */
const PANE = Type.Object({ result: Type.Object({ pane: Type.Object({ workspace_id: Type.String() }) }) });

/** The worktrees that `herdr worktree list` prints, with the workspace that has each one open. */
const WORKTREES = Type.Object({
	result: Type.Object({
		worktrees: Type.Array(
			Type.Object({ path: Type.String(), open_workspace_id: Type.Optional(Type.Union([Type.String(), Type.Null()])) }),
		),
	}),
});

/** The output of `herdr <argv>`, as JSON that matches `schema`. It throws when herdr fails or prints something else. */
async function herdrJson<T extends TSchema>(schema: T, argv: readonly string[]): Promise<Static<T>> {
	const stdout = await herdr(argv, process.env);
	let parsed: unknown;

	try {
		parsed = JSON.parse(stdout);
	} catch {
		parsed = undefined;
	}

	if (!Value.Check(schema, parsed)) throw new Error(`herdr ${argv.slice(0, 2).join(" ")} printed ${stdout}`.trim());

	return parsed;
}

/**
 * Creates the worktree at `path` on `branch` from `start` with `herdr worktree create`, so it shows in Herdr. It gives
 * the ID of the workspace that Herdr opened on it, and undefined when Herdr fails.
 */
export async function herdrWorktree(
	repository: string,
	path: string,
	branch: string,
	start: string,
): Promise<string | undefined> {
	try {
		await mkdir(dirname(path), { recursive: true });
		const create = ["worktree", "create", "--cwd", repository, "--path", path, "--branch", branch, "--base", start];

		return (await herdrJson(WORKTREE_CREATED, [...create, "--no-focus"])).result.workspace.workspace_id;
	} catch {
		return undefined;
	}
}

/**
 * Types the loop of `show --pick` and `attach --side` on the run `runId` in the first pane of the Herdr workspace
 * `workspace`, so the agents of the run can be opened beside the step tree. Any failure leaves the pane as it is.
 */
export async function typePickLoop(workspace: string, runId: string): Promise<void> {
	try {
		const pane = (await herdrJson(PANES, ["pane", "list", "--workspace", workspace])).result.panes[0]?.pane_id;

		if (pane === undefined) return;
		const loop = `while c=$(workflows show ${runId} --pick); do workflows attach ${runId} --conversation "$c" --side; done`;
		await herdr(["pane", "run", pane, loop], process.env);
	} catch {
		// The loop is a help: the run goes on without it.
	}
}

/** The ID of the Herdr workspace that has `worktree` open, if any. It throws when herdr fails. */
async function herdrWorkspace(worktree: Worktree): Promise<string | undefined> {
	const listed = await herdrJson(WORKTREES, ["worktree", "list", "--cwd", worktree.path]);
	const path = await realpath(worktree.path);

	for (const entry of listed.result.worktrees) {
		const workspace = entry.open_workspace_id;

		if (workspace && (await realpath(entry.path).catch(() => undefined)) === path) return workspace;
	}

	return undefined;
}

/**
 * Where `attach` opens Pi in Herdr: with `side`, a pane to the right of `pane`; else a tab of the workspace that has
 * `worktree` open, else of the workspace of `pane`. Undefined without a place: Pi runs in this terminal. It throws when
 * herdr fails.
 */
export async function herdrPlace(
	worktree: Worktree | undefined,
	side: boolean,
	pane: string | undefined,
): Promise<{ pane: string } | { workspace: string } | undefined> {
	if (side && pane !== undefined) return { pane };
	const workspace = worktree !== undefined && existsSync(worktree.path) ? await herdrWorkspace(worktree) : undefined;

	if (workspace !== undefined) return { workspace };

	return pane === undefined
		? undefined
		: { workspace: (await herdrJson(PANE, ["pane", "get", pane])).result.pane.workspace_id };
}

/** Whether Herdr removed `worktree` with the workspace that has it open. Outside Herdr, or when herdr fails, false. */
export async function removedByHerdr(worktree: Worktree): Promise<boolean> {
	if (!process.env.HERDR_ENV) return false;

	try {
		const workspace = await herdrWorkspace(worktree);

		if (workspace === undefined) return false;
		await herdr(["worktree", "remove", "--workspace", workspace], process.env);

		return true;
	} catch {
		return false;
	}
}
