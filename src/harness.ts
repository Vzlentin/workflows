/**
 * The harness install that workflows needs. workflows has no copy of harness: `@vzlentin/harness` is an optional peer
 * dependency, and a global install of workflows finds the global install of harness next to it. The command and the
 * setup check it here, before anything imports a harness module.
 */
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

export const HARNESS = "@vzlentin/harness";

/**
 * The entry of workflows that the harness host loads: `dist/entry.js`, or `src/entry.ts` in a checkout. The command and
 * the setup set it in harness's `entries.json`.
 */
export const ENTRY = fileURLToPath(
	new URL(import.meta.url.endsWith(".ts") ? "./entry.ts" : "./entry.js", import.meta.url),
);

const MANIFEST = Type.Object({
	version: Type.String(),
	peerDependencies: Type.Optional(Type.Record(Type.String(), Type.String())),
});

type Manifest = Static<typeof MANIFEST>;

/** The `package.json` at `path`, or undefined when it is missing or not a manifest. */
export function manifest(path: string | URL): Manifest | undefined {
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8"));

		return Value.Check(MANIFEST, parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

/** The range of harness versions that workflows works with: its peer dependency in the `package.json` of workflows. */
export function harnessRange(): string {
	const range = manifest(new URL("../package.json", import.meta.url))?.peerDependencies?.[HARNESS];

	if (range === undefined) throw new Error(`the package.json of workflows has no peer dependency ${HARNESS}`);

	return range;
}

/**
 * The folder of the harness that the package in `dir` imports, as Node looks it up in the `node_modules` folders of
 * `dir` and its parents, or undefined. It reads the folders without Node's resolver, which keeps what it did not find,
 * so an import after a harness install in the same process still finds harness.
 */
export function harnessDir(dir: string): string | undefined {
	for (let parent = dir; ; parent = dirname(parent)) {
		const candidate = join(parent, "node_modules", HARNESS);

		if (basename(parent) !== "node_modules" && existsSync(join(candidate, "package.json"))) return candidate;

		if (dirname(parent) === parent) return undefined;
	}
}

const VERSION = /^(\d+)\.(\d+)\.(\d+)$/;

/**
 * Whether `version` is in the caret range `range`, such as `^0.2.0`, as npm reads it: the same leftmost nonzero part,
 * and no older. A prerelease version is never in the range.
 */
export function inRange(version: string, range: string): boolean {
	const low = VERSION.exec(range.slice(1));

	if (!range.startsWith("^") || low === null) throw new Error(`${range} is not a caret range of a version`);
	const found = VERSION.exec(version);

	if (found === null) return false;
	const [want, have] = [low.slice(1).map(Number), found.slice(1).map(Number)];
	// The parts up to the first nonzero part of the range must be equal, then the version must not be older.
	const fixed = want.findIndex((part) => part !== 0);
	const equal = fixed === -1 ? 3 : fixed + 1;

	for (let index = 0; index < 3; index++) {
		const [a = 0, b = 0] = [have[index], want[index]];

		if (index < equal && a !== b) return false;

		if (a !== b) return a > b;
	}

	return true;
}

/** A version, also a prerelease or one with build metadata, such as `0.3.0-rc.1`. */
const ANY_VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/**
 * Whether `version` is newer than every version in the caret range `range`, such as `0.3.0` or `0.3.0-rc.1` for
 * `^0.2.0`: one of the parts that the range keeps fixed is larger.
 */
export function newerThanRange(version: string, range: string): boolean {
	const [low, found] = [VERSION.exec(range.slice(1)), ANY_VERSION.exec(version)];

	if (low === null || found === null) return false;
	const [want, have] = [low.slice(1).map(Number), found.slice(1).map(Number)];
	const fixed = want.findIndex((part) => part !== 0);
	const equal = fixed === -1 ? 3 : fixed + 1;
	const index = want.findIndex((part, at) => at < equal && part !== have[at]);

	return index !== -1 && (have[index] ?? 0) > (want[index] ?? 0);
}

/** The version of the harness that the package in `dir` imports, or undefined when there is none. */
export function harnessVersion(dir: string): string | undefined {
	const found = harnessDir(dir);

	return found === undefined ? undefined : manifest(join(found, "package.json"))?.version;
}

/** The command that installs a harness in `range`, with `--prefix <prefix>` when `prefix` is given. */
export function installCommand(range: string, prefix: string | undefined): string {
	return `npm install -g ${prefix === undefined ? "" : `--prefix ${prefix} `}${HARNESS}@${range}`;
}

/**
 * The error line when the package in `dir` cannot import a harness in the range of workflows, or undefined when it
 * can. The install command has `--prefix <prefix>` when `prefix` is given.
 */
export function harnessProblem(dir: string, prefix?: string): string | undefined {
	const range = harnessRange();
	const version = harnessVersion(dir);

	if (version === undefined) return `workflows needs ${HARNESS} ${range}: ${installCommand(range, prefix)}`;

	if (inRange(version, range)) return undefined;

	if (newerThanRange(version, range)) {
		const update = `npm install -g ${prefix === undefined ? "" : `--prefix ${prefix} `}@vzlentin/workflows`;

		return `workflows needs ${HARNESS} ${range}, found ${version}, which is newer. Update workflows: ${update}`;
	}

	return `workflows needs ${HARNESS} ${range}, found ${version}: ${installCommand(range, prefix)}`;
}
