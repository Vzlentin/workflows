/**
 * The setup of a top-level global install of workflows. The postinstall runs it when npm runs install scripts, and the
 * installed command runs it on each start, as npm 12 runs no install script by default.
 * Harness modules load here only through dynamic imports, after the harness check.
 */
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { basename, dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
	ENTRY,
	HARNESS,
	harnessDir,
	harnessProblem,
	harnessRange,
	harnessVersion,
	installCommand,
	newerThanRange,
} from "./harness.ts";

const NAME = join("@vzlentin", "workflows");

/** The real folder of this install: the parent of `src/` or `dist/`. */
export const PACKAGE = realpathSync(fileURLToPath(new URL("..", import.meta.url)));

/**
 * The npm prefix of the package in `dir` when it is a top-level global install, `<prefix>/lib/node_modules/@vzlentin/
 * workflows` (`<prefix>/node_modules/...` on Windows), or undefined. npm also sets `npm_config_global` for the
 * dependencies of a global package, so the setup checks the path.
 */
export function globalPrefix(dir: string): string | undefined {
	if (!dir.endsWith(`${sep}${NAME}`)) return undefined;
	const root = dir.slice(0, -NAME.length - 1);
	const segments = root.split(sep);

	if (segments.at(-1) !== "node_modules" || segments.indexOf("node_modules") !== segments.length - 1) return undefined;

	if (process.platform === "win32") return dirname(root);

	return segments.at(-2) === "lib" ? dirname(dirname(root)) : undefined;
}

/**
 * Runs npm with `args`, and keeps its output: in an install script the npm of the install (`npm_execpath`), otherwise
 * the `npm` on `PATH`.
 */
function runNpm(args: readonly string[], env: NodeJS.ProcessEnv = process.env) {
	const execpath = process.env.npm_execpath;
	const own = execpath !== undefined && basename(execpath) === "npm-cli.js";
	const [program, rest] = own ? [process.execPath, [execpath, ...args]] : ["npm", args];

	return spawnSync(program, rest, { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", timeout: 600_000, env });
}

/**
 * The prefix that the fix commands of the package in `dir` need: its prefix when that is not npm's global prefix. In
 * an install script, npm sets `npm_config_prefix` to the `--prefix` of the install, so the global prefix is read
 * without it.
 */
export function fixPrefix(dir: string): string | undefined {
	const prefix = globalPrefix(dir);

	if (prefix === undefined) return undefined;
	const { npm_config_prefix: _, ...outside } = process.env;
	const result = runNpm(["prefix", "-g"], process.env.npm_lifecycle_event === undefined ? process.env : outside);

	try {
		return realpathSync(result.stdout.trim()) === prefix ? undefined : prefix;
	} catch {
		return prefix;
	}
}

/**
 * Checks harness for the package in `dir`. When it is missing or older than the range and `dir` is a top-level global
 * install, it installs harness into the prefix of `dir` and checks again. A newer harness is never replaced. Returns
 * the error line that remains, or undefined when harness fits.
 */
export function ensureHarness(dir: string): string | undefined {
	if (harnessProblem(dir) === undefined) return undefined;
	const prefix = globalPrefix(dir);
	const version = harnessVersion(dir);

	if (prefix !== undefined && (version === undefined || !newerThanRange(version, harnessRange()))) {
		const command = installCommand(harnessRange(), prefix);
		process.stderr.write(`workflows: installing ${HARNESS}: ${command}\n`);
		const result = runNpm(["install", "-g", "--prefix", prefix, `${HARNESS}@${harnessRange()}`]);

		if (result.status !== 0) process.stderr.write(`${result.stdout ?? ""}${result.stderr ?? ""}`);
	}

	return harnessProblem(dir) === undefined ? undefined : harnessProblem(dir, fixPrefix(dir));
}

/**
 * Sets up the package in `dir` when it is a top-level global install: it ensures harness, runs harness's setup, which
 * installs the Pi package `@vzlentin/pi-agents` at the version of harness, sets the entry `workflows` in harness's
 * `entries.json`, so a host that starts before any `workflows` command runs workflows, and runs harness's setup for
 * `dir`, which installs the Pi package `@vzlentin/pi-workflows` at the version of `dir`. harness's setup skips a Pi
 * package that Pi already lists, keeps a stamp for each package version and path, and writes it only when `pi` worked,
 * so a later run is cheap and a failed one tries again. It never throws: an error is a warning.
 */
export async function setup(dir: string): Promise<void> {
	try {
		if (globalPrefix(dir) === undefined) return;
		const problem = ensureHarness(dir);

		if (problem !== undefined) {
			process.stderr.write(`${problem}\n`);

			return;
		}

		const harness = harnessDir(dir);

		if (harness === undefined) return;
		const pi = await import("@vzlentin/harness/setup");
		const entries = await import("@vzlentin/harness/entries");
		pi.setupOnce(harness, "@vzlentin/pi-agents");
		entries.setEntry("workflows", ENTRY);
		pi.setupOnce(dir, "@vzlentin/pi-workflows");
	} catch (error) {
		process.stderr.write(`workflows: setup failed: ${error instanceof Error ? error.message : String(error)}\n`);
	}
}
