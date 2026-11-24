/**
 * The state of the change of each ended run that `list --json` gives: its pull request on the Git host and its conflict
 * with the base, as Git and the Git host say it now. It keeps the state of each repository for 60 s in a file of the
 * state folder, so that `list` calls in that time ask no Git host, and it bounds the work of one call.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { failure, gitSucceeds, run } from "../git.ts";
import { branchPullRequest, type GitHost, gitHostOf, hasConflict } from "../githost.ts";
import { hasEnded } from "../run/past.ts";
import { changesDirectory } from "./host.ts";
import type { Row } from "./saved.ts";

/** How long a kept state of a repository answers with no Git host call. */
const KEPT_MS = 60_000;

/** The most time that the Git host work of one `list` call takes, the fetches included. */
const TIMEOUT_MS = 10_000;

/** The base of a branch that has no pull request. */
const DEFAULT_BASE = "main";

const KIND = Type.Union([Type.Literal("github"), Type.Literal("gitlab")]);

const CHECK = Type.Union([
	Type.Literal("none"),
	Type.Literal("running"),
	Type.Literal("passed"),
	Type.Literal("failed"),
]);

/** Whether the branch conflicts with `origin/<base>`, or null when Git cannot tell. */
const CONFLICT = Type.Union([Type.Boolean(), Type.Null()]);

/**
 * The state of the change of a run: `local` when its branch has no pull request, else the state of its newest pull
 * request, with the kind of the Git host, its number and its URL. Only a branch with no pull request or with an open
 * one has a conflict, and only an open one has a check and a review.
 */
export const CHANGE = Type.Union([
	Type.Object({ state: Type.Literal("local"), conflict: CONFLICT }, { additionalProperties: false }),
	Type.Object(
		{
			state: Type.Literal("open"),
			kind: KIND,
			number: Type.Integer(),
			url: Type.String(),
			check: CHECK,
			changesRequested: Type.Boolean(),
			conflict: CONFLICT,
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{ state: Type.Literal("closed"), kind: KIND, number: Type.Integer(), url: Type.String() },
		{ additionalProperties: false },
	),
	Type.Object(
		{ state: Type.Literal("merged"), kind: KIND, number: Type.Integer(), url: Type.String() },
		{ additionalProperties: false },
	),
]);

export type Change = Static<typeof CHANGE>;

/**
 * The kept file of a repository: its path, whether its origin is on a Git host, and the change of each branch that the
 * last read asked for.
 */
const KEPT = Type.Object(
	{ repository: Type.String(), hosted: Type.Boolean(), changes: Type.Record(Type.String(), CHANGE) },
	{ additionalProperties: false },
);

type Kept = Static<typeof KEPT>;

/**
 * The Git host work of one `list` call: its time bound, its warnings, and whether a read failed. After a failure, the
 * call asks no Git host again, so it gives one warning and not one per repository.
 */
type Reading = { readonly signal: AbortSignal; readonly warn: (line: string) => void; failed: boolean };

/**
 * `rows` with the `change` of each ended run that has a repository and a branch and that no sweep removed. A repository
 * whose origin is on no Git host gives no `change`. When a read fails, `warn` gets one line, and the rows of that
 * repository and of the later ones get the last kept state, also an old one, or no `change`.
 */
export async function withChanges(rows: readonly Row[], warn: (line: string) => void): Promise<Row[]> {
	const pairs = rows.map((row) => [row, askedChange(row)] as const);
	const branches = new Map<string, Set<string>>();

	for (const [, asked] of pairs)
		if (asked !== null) branches.set(asked.repository, (branches.get(asked.repository) ?? new Set()).add(asked.branch));

	const reading: Reading = { signal: AbortSignal.timeout(TIMEOUT_MS), warn, failed: false };
	const changes = new Map<string, Kept["changes"]>();

	for (const [repository, asked] of branches)
		changes.set(repository, await repositoryChanges(repository, asked, reading));

	return pairs.map(([row, asked]) => {
		const change = asked === null ? undefined : changes.get(asked.repository)?.[asked.branch];

		return change === undefined ? row : { ...row, change };
	});
}

/**
 * The repository and the branch of the change of `row` when it is a run that ended and that no sweep removed. A waiting
 * run is left out, because it can still change its branch.
 */
function askedChange(row: Row): { readonly repository: string; readonly branch: string } | null {
	const { state, repository, branch, swept } = row;

	return hasEnded(state) && state !== "waiting" && repository !== null && branch !== undefined && swept === undefined
		? { repository, branch }
		: null;
}

/**
 * The changes of the branches `asked` of `repository`: from its kept file when it is fresh, else from Git and the Git
 * host, and then kept. After a failed read, the kept file at any age, or none. A failed write of the kept file only
 * warns: it still gives what it read, and the later repositories still ask their Git host.
 */
async function repositoryChanges(
	repository: string,
	asked: ReadonlySet<string>,
	reading: Reading,
): Promise<Kept["changes"]> {
	const file = join(changesDirectory(), `${createHash("sha256").update(repository).digest("hex").slice(0, 32)}.json`);
	const kept = await keptOf(file, repository);

	if (kept !== null && (!kept.hosted || [...asked].every((branch) => branch in kept.changes)) && kept.fresh) {
		return kept.changes;
	}

	if (reading.failed) return kept?.changes ?? {};

	let read: Kept;

	try {
		read = await readChanges(repository, asked, reading.signal);
	} catch (error) {
		reading.failed = true;
		reading.warn(
			`cannot read the state of the changes of ${repository}: ${error instanceof Error ? error.message : String(error)}`,
		);

		return kept?.changes ?? {};
	}

	try {
		await keep(file, read);
	} catch (error) {
		reading.warn(
			`cannot keep the state of the changes of ${repository}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}

	return read.changes;
}

/** The kept file `file` of `repository`, and whether it is fresh, or null when it is missing or not valid. */
async function keptOf(file: string, repository: string): Promise<(Kept & { readonly fresh: boolean }) | null> {
	try {
		const [text, { mtimeMs }] = await Promise.all([readFile(file, "utf8"), stat(file)]);
		const value = JSON.parse(text);

		if (!Value.Check(KEPT, value) || value.repository !== repository) return null;

		return { ...value, fresh: Date.now() - mtimeMs < KEPT_MS };
	} catch {
		return null;
	}
}

/** Writes `kept` to `file` through a temporary file, so that a reader never sees half a file. */
async function keep(file: string, kept: Kept): Promise<void> {
	await mkdir(changesDirectory(), { recursive: true });
	const temporary = `${file}.${process.pid}.tmp`;
	await writeFile(temporary, `${JSON.stringify(kept)}\n`);
	await rename(temporary, file);
}

/** Reads the changes of the branches `asked` of `repository` from Git and the Git host: one fetch, then each branch. */
async function readChanges(repository: string, asked: ReadonlySet<string>, signal: AbortSignal): Promise<Kept> {
	const host = await gitHostOf(repository, signal);

	if (host === null) return { repository, hosted: false, changes: {} };
	const fetch = ["fetch", "--quiet", "origin"];
	const fetched = await run("git", fetch, repository, signal);

	if (fetched.code !== 0) throw new Error(failure(["git", ...fetch], fetched));
	const changes: Kept["changes"] = {};

	for (const branch of asked) changes[branch] = await branchChange(host, branch, signal);

	return { repository, hosted: true, changes };
}

/** The change of the branch `branch` on `host`, from its newest pull request and its conflict with the base. */
async function branchChange(host: GitHost, branch: string, signal: AbortSignal): Promise<Change> {
	const pull = await branchPullRequest(host, branch, signal);

	if (pull === null) return { state: "local", conflict: await conflictOf(host.cwd, DEFAULT_BASE, branch) };
	const { kind, number, url } = pull;

	if (pull.state !== "open") return { state: pull.state, kind, number, url };
	const { check, changesRequested } = pull;

	return {
		state: "open",
		kind,
		number,
		url,
		check,
		changesRequested,
		conflict: await conflictOf(host.cwd, pull.base, branch),
	};
}

/** Whether `branch` of `cwd` conflicts with `origin/<base>`, or null when one of the two refs is missing. */
async function conflictOf(cwd: string, base: string, branch: string): Promise<boolean | null> {
	const refs = [`refs/remotes/origin/${base}`, `refs/heads/${branch}`] as const;

	for (const ref of refs)
		if (!(await gitSucceeds(cwd, "rev-parse", "--verify", "--quiet", `${ref}^{commit}`))) return null;

	return hasConflict(cwd, ...refs);
}
