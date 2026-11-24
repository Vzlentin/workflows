/**
 * The state of the change of each ended run that `list --json` gives: its pull request on the Git host and its conflict
 * with the base, as Git and the Git host say it now, and the head and merge commit of a merged pull request. It keeps
 * the state of each repository for 60 s in a file of the state folder, so that `list` calls in that time ask no Git
 * host, and it bounds the work of one call.
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

const LOCAL = Type.Object({ state: Type.Literal("local"), conflict: CONFLICT }, { additionalProperties: false });

const OPEN = Type.Object(
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
);

const CLOSED = Type.Object(
	{ state: Type.Literal("closed"), kind: KIND, number: Type.Integer(), url: Type.String() },
	{ additionalProperties: false },
);

const MERGED_FIELDS = { state: Type.Literal("merged"), kind: KIND, number: Type.Integer(), url: Type.String() };

/**
 * The state of the change of a run: `local` when its branch has no pull request, else the state of its newest pull
 * request, with the kind of the Git host, its number and its URL. Only a branch with no pull request or with an open
 * one has a conflict, and only an open one has a check and a review.
 */
export const CHANGE = Type.Union([LOCAL, OPEN, CLOSED, Type.Object(MERGED_FIELDS, { additionalProperties: false })]);

/**
 * The change of a branch in the kept file: a `change`, where a merged pull request also has its head, which a GitLab
 * merge request can lack, and the commit of its merge on the base.
 */
const KEPT_CHANGE = Type.Union([
	LOCAL,
	OPEN,
	CLOSED,
	Type.Object(
		{ ...MERGED_FIELDS, head: Type.Union([Type.String(), Type.Null()]), commit: Type.String() },
		{ additionalProperties: false },
	),
]);

/**
 * The kept file of a repository: its path, whether its origin is on a Git host, and the change of each branch that the
 * last read asked for.
 */
const KEPT = Type.Object(
	{ repository: Type.String(), hosted: Type.Boolean(), branches: Type.Record(Type.String(), KEPT_CHANGE) },
	{ additionalProperties: false },
);

type Kept = Static<typeof KEPT>;

/** What a read gives for the branches of a repository: the kept change of each one. */
type Read = Kept["branches"];

/** A merged pull request of the branch `branch`: its head, or null, and the commit of its merge on the base. */
export type Merge = { readonly branch: string; readonly head: string | null; readonly commit: string };

/** A row of `withChanges`, and the merge of its branch when its change is a merged pull request. */
export type Changed = { readonly row: Row; readonly merge: Merge | undefined };

/**
 * The Git host work of one `list` call: its time bound, its warnings, and whether a read failed. After a failure, the
 * call asks no Git host again, so it gives one warning and not one per repository.
 */
type Reading = { readonly signal: AbortSignal; readonly warn: (line: string) => void; failed: boolean };

/**
 * `rows` with the `change` of each ended run that has a repository and a branch and that no sweep removed, and the
 * merge of the branch when its change is `merged`. A repository whose origin is on no Git host gives no `change`. When
 * a read fails, `warn` gets one line, and the rows of that repository and of the later ones get the last kept state,
 * also an old one, or no `change`.
 */
export async function withChanges(rows: readonly Row[], warn: (line: string) => void): Promise<Changed[]> {
	const pairs = rows.map((row) => [row, askedChange(row)] as const);
	const branches = new Map<string, Set<string>>();

	for (const [, asked] of pairs)
		if (asked !== null) branches.set(asked.repository, (branches.get(asked.repository) ?? new Set()).add(asked.branch));

	const reading: Reading = { signal: AbortSignal.timeout(TIMEOUT_MS), warn, failed: false };
	const reads = new Map<string, Read>();

	for (const [repository, asked] of branches)
		reads.set(repository, await repositoryChanges(repository, asked, reading));

	return pairs.map(([row, asked]) => {
		const kept = asked === null ? undefined : reads.get(asked.repository)?.[asked.branch];

		if (asked === null || kept === undefined) return { row, merge: undefined };

		if (kept.state !== "merged") return { row: { ...row, change: kept }, merge: undefined };
		const { head, commit, ...change } = kept;

		return { row: { ...row, change }, merge: { branch: asked.branch, head, commit } };
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
async function repositoryChanges(repository: string, asked: ReadonlySet<string>, reading: Reading): Promise<Read> {
	const file = join(changesDirectory(), `${createHash("sha256").update(repository).digest("hex").slice(0, 32)}.json`);
	const kept = await keptOf(file, repository);

	if (kept !== null && (!kept.hosted || [...asked].every((branch) => branch in kept.branches)) && kept.fresh) {
		return kept.branches;
	}

	if (reading.failed) return kept?.branches ?? {};

	let read: Kept;

	try {
		read = await readChanges(repository, asked, reading.signal);
	} catch (error) {
		reading.failed = true;
		reading.warn(
			`cannot read the state of the changes of ${repository}: ${error instanceof Error ? error.message : String(error)}`,
		);

		return kept?.branches ?? {};
	}

	try {
		await keep(file, read);
	} catch (error) {
		reading.warn(
			`cannot keep the state of the changes of ${repository}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}

	return read.branches;
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

	if (host === null) return { repository, hosted: false, branches: {} };
	const fetch = ["fetch", "--quiet", "origin"];
	const fetched = await run("git", fetch, repository, signal);

	if (fetched.code !== 0) throw new Error(failure(["git", ...fetch], fetched));
	const branches: Read = {};

	for (const branch of asked) branches[branch] = await branchChange(host, branch, signal);

	return { repository, hosted: true, branches };
}

/**
 * The kept change of the branch `branch` on `host`, from its newest pull request, with the head and the merge commit of
 * a merged one, and its conflict with the base.
 */
async function branchChange(host: GitHost, branch: string, signal: AbortSignal): Promise<Read[string]> {
	const pull = await branchPullRequest(host, branch, signal);

	if (pull === null) return { state: "local", conflict: await conflictOf(host.cwd, DEFAULT_BASE, branch) };
	const { kind, number, url } = pull;

	if (pull.state === "merged") return { state: "merged", kind, number, url, head: pull.head, commit: pull.mergeCommit };

	if (pull.state === "closed") return { state: "closed", kind, number, url };
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
