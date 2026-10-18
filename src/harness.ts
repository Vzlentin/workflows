/**
 * The harness install that workflows needs. workflows has no copy of harness: `@vzlentin/harness` is an optional peer
 * dependency, and a global install of workflows finds the global install of harness next to it. The command and the
 * postinstall check it here, before anything imports a harness module.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

export const HARNESS = "@vzlentin/harness";

/**
 * The entry of workflows that the harness host loads: `dist/entry.js`, or `src/entry.ts` in a checkout. The command and
 * the postinstall set it in harness's `entries.json`.
 */
export const ENTRY = fileURLToPath(
	new URL(import.meta.url.endsWith(".ts") ? "./entry.ts" : "./entry.js", import.meta.url),
);

const MANIFEST = Type.Object({
	version: Type.String(),
	peerDependencies: Type.Optional(Type.Record(Type.String(), Type.String())),
});

type Manifest = Static<typeof MANIFEST>;

/** The `package.json` at `url`, or undefined when it is missing or not a manifest. */
function manifest(url: string | URL): Manifest | undefined {
	try {
		const parsed = JSON.parse(readFileSync(url, "utf8"));

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

/** The version of the harness that a module at `from` (a path or file URL) imports, or undefined when none resolves. */
export function harnessVersion(from: string | URL): string | undefined {
	let path: string;

	try {
		path = createRequire(from).resolve(`${HARNESS}/package.json`);
	} catch {
		return undefined;
	}

	return manifest(path)?.version;
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

/** The command that installs a harness in `range`. */
export function installCommand(range: string): string {
	return `npm install -g ${HARNESS}@${range}`;
}

/**
 * The error line when the module at `from` (a path or file URL) cannot import a harness in the range of workflows, or
 * undefined when it can.
 */
export function harnessProblem(from: string | URL): string | undefined {
	const range = harnessRange();
	const version = harnessVersion(from);

	if (version === undefined) return `workflows needs ${HARNESS} ${range}: ${installCommand(range)}`;

	if (inRange(version, range)) return undefined;

	return `workflows needs ${HARNESS} ${range}, found ${version}: ${installCommand(range)}`;
}
