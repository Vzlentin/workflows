import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, cp, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { harnessProblem, harnessRange, inRange, newerThanRange } from "../src/harness.ts";

const CHECKOUT = fileURLToPath(new URL("..", import.meta.url));
const HARNESS = join(CHECKOUT, "node_modules", "@vzlentin", "harness");

/**
 * A fake npm: it logs its arguments, prints `npm_config_prefix` or else `NPM_GLOBAL_PREFIX` for `prefix`, as npm does,
 * and copies `NPM_INSTALLS` on install.
 */
const FAKE_NPM = `import { appendFileSync, cpSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
appendFileSync(process.env.NPM_LOG, args.join(" ") + "\\n");
if (args[0] === "prefix") console.log(process.env.npm_config_prefix ?? process.env.NPM_GLOBAL_PREFIX);
if (args[0] === "install") {
	if (process.env.NPM_INSTALLS === undefined) process.exit(1);
	cpSync(process.env.NPM_INSTALLS, join(args[3], "lib", "node_modules", "@vzlentin", "harness"), { recursive: true });
}
`;

let root: string;
let built: string;

beforeAll(async () => {
	built = await mkdtemp(join(tmpdir(), "workflows-harness-dist-"));
	const tsc = join(CHECKOUT, "node_modules", ".bin", "tsc");
	await promisify(execFile)(tsc, ["-p", join(CHECKOUT, "tsconfig.build.json"), "--outDir", built]);
});

afterAll(() => rm(built, { recursive: true, force: true }));

beforeEach(async (context) => {
	root = await realpath(await mkdtemp(join(tmpdir(), "workflows-harness-test-")));
	context.onTestFinished(() => rm(root, { recursive: true, force: true }));
	await mkdir(join(root, "bin"));
	await symlink(process.execPath, join(root, "bin", "node"));
	await writeFile(join(root, "bin", "pi"), '#!/bin/sh\necho "$@" >> "$PI_LOG"\n[ -z "$PI_FAIL" ]\n');
	await chmod(join(root, "bin", "pi"), 0o755);
	await writeFile(join(root, "bin", "npm-cli.js"), FAKE_NPM);
});

const PREFIX = () => join(root, "prefix");
const LIB = () => join(PREFIX(), "lib", "node_modules");

/** Runs `node <script> ...args` in `root` with a clean environment plus `env`, and returns its exit code and output. */
async function node(script: string, args: readonly string[], env: Readonly<Record<string, string>>) {
	const base = {
		PATH: join(root, "bin"),
		HOME: join(root, "home"),
		XDG_STATE_HOME: join(root, "state"),
		XDG_CONFIG_HOME: join(root, "config"),
		PI_CODING_AGENT_DIR: join(root, "pi-agent"),
		PI_LOG: join(root, "pi.log"),
		NPM_LOG: join(root, "npm.log"),
		NPM_GLOBAL_PREFIX: "/usr/local",
		npm_execpath: join(root, "bin", "npm-cli.js"),
	};

	try {
		const { stdout, stderr } = await promisify(execFile)(process.execPath, [script, ...args], {
			cwd: root,
			env: { ...base, ...env },
		});

		return { code: 0, stdout, stderr };
	} catch (error) {
		const { code, stdout, stderr } = Object.assign({ code: -1, stdout: "", stderr: "" }, error);

		return { code, stdout, stderr };
	}
}

/** The lines of the log file `name` in `root`, or none. */
async function log(name: string): Promise<string[]> {
	try {
		return (await readFile(join(root, name), "utf8")).trimEnd().split("\n");
	} catch {
		return [];
	}
}

const entries = async () => JSON.parse(await readFile(join(root, "config", "harness", "entries.json"), "utf8"));

/** Links the checkout's dependencies, except `@vzlentin`, into `dir`. */
async function linkDependencies(dir: string) {
	await mkdir(dir, { recursive: true });

	for (const name of await readdir(join(CHECKOUT, "node_modules"))) {
		if (name !== "@vzlentin" && name !== ".bin") {
			await symlink(join(CHECKOUT, "node_modules", name), join(dir, name));
		}
	}
}

/**
 * A global install of workflows at `at` in the `lib/node_modules` of the prefix `root/prefix`, as npm installs the
 * published package, with the checkout's dependencies next to it. Returns the folder of the package.
 */
async function installWorkflows(at = join("@vzlentin", "workflows")) {
	if (!existsSync(LIB())) await linkDependencies(LIB());
	const dir = join(LIB(), at);
	await mkdir(dir, { recursive: true });

	for (const name of ["package.json", "pi", "scripts"])
		await cp(join(CHECKOUT, name), join(dir, name), { recursive: true });
	await cp(built, join(dir, "dist"), { recursive: true });

	return dir;
}

/** A global install of the checkout's harness next to workflows. */
const installHarness = () => cp(HARNESS, join(LIB(), "@vzlentin", "harness"), { recursive: true });

/** Runs the postinstall of the package in `dir` with `env`, by default the one that npm gives a global install. */
const postinstall = (
	dir: string,
	env: Readonly<Record<string, string>> = {
		npm_config_global: "true",
		npm_config_prefix: PREFIX(),
		npm_lifecycle_event: "postinstall",
	},
) => node(join(dir, "scripts", "postinstall.js"), [], env);

/** Runs the installed `workflows` command of the package in `dir`. */
const workflows = (dir: string, env: Readonly<Record<string, string>>, ...args: string[]) =>
	node(join(dir, "dist", "cli.js"), args, env);

describe("the harness range", () => {
	it("is the peer dependency of the package", () => {
		expect(harnessRange()).toBe("^0.3.1");
	});

	it("takes the versions of a caret range as npm does", () => {
		const cases: [string, string, boolean][] = [
			["0.2.0", "^0.2.0", true],
			["0.2.7", "^0.2.0", true],
			["0.2.0", "^0.2.1", false],
			["0.3.0", "^0.2.0", false],
			["0.1.9", "^0.2.0", false],
			["1.2.0", "^0.2.0", false],
			["1.4.2", "^1.2.0", true],
			["1.1.9", "^1.2.0", false],
			["2.0.0", "^1.2.0", false],
			["0.0.3", "^0.0.3", true],
			["0.0.4", "^0.0.3", false],
			["0.2.1-beta.1", "^0.2.0", false],
			["main", "^0.2.0", false],
		];

		expect(cases.map(([version, range]) => inRange(version, range))).toEqual(cases.map(([, , fits]) => fits));
		expect(() => inRange("0.2.0", "0.2.0")).toThrow("0.2.0 is not a caret range of a version");
	});

	it("finds the versions that are newer than a caret range, also prereleases", () => {
		const cases: [string, string, boolean][] = [
			["0.3.0", "^0.2.0", true],
			["0.3.0-rc.1", "^0.2.0", true],
			["1.0.0-beta.2+build.5", "^0.2.0", true],
			["0.2.9", "^0.2.0", false],
			["0.2.1-rc.1", "^0.2.0", false],
			["0.1.9", "^0.2.0", false],
			["0.0.4", "^0.0.3", true],
			["1.9.0", "^1.2.0", false],
			["2.0.0-rc.1", "^1.2.0", true],
			["main", "^0.2.0", false],
		];

		expect(cases.map(([version, range]) => newerThanRange(version, range))).toEqual(cases.map(([, , newer]) => newer));
	});
});

describe("the harness check", () => {
	/** Puts a harness of `version` in `node_modules` of `root`. */
	const fakeHarness = async (version: string) => {
		const dir = join(root, "node_modules", "@vzlentin", "harness");
		await mkdir(dir, { recursive: true });
		await writeFile(join(dir, "package.json"), JSON.stringify({ name: "@vzlentin/harness", version }));
	};

	it("says how to install harness when none is found, or when its version is out of the range", async () => {
		const dir = join(root, "package");
		expect(harnessProblem(dir)).toBe(
			"workflows needs @vzlentin/harness ^0.3.1: npm install -g @vzlentin/harness@^0.3.1",
		);
		expect(harnessProblem(dir, "/p")).toBe(
			"workflows needs @vzlentin/harness ^0.3.1: npm install -g --prefix /p @vzlentin/harness@^0.3.1",
		);

		await fakeHarness("0.1.0");
		expect(harnessProblem(dir)).toBe(
			"workflows needs @vzlentin/harness ^0.3.1, found 0.1.0: npm install -g @vzlentin/harness@^0.3.1",
		);

		await fakeHarness("0.3.3");
		expect(harnessProblem(dir)).toBeUndefined();

		await fakeHarness("0.4.0");
		expect(harnessProblem(dir)).toBe(
			"workflows needs @vzlentin/harness ^0.3.1, found 0.4.0, which is newer. Update workflows: npm install -g @vzlentin/workflows",
		);
	});

	it("stops the command of a checkout before it loads harness", async () => {
		await cp(join(CHECKOUT, "src"), join(root, "src"), { recursive: true });
		await cp(join(CHECKOUT, "package.json"), join(root, "package.json"));
		await linkDependencies(join(root, "node_modules"));
		const cli = join(root, "src", "cli.ts");

		expect(await node(cli, ["list"], {})).toEqual({
			code: 1,
			stdout: "",
			stderr: "workflows needs @vzlentin/harness ^0.3.1: npm install -g @vzlentin/harness@^0.3.1\n",
		});

		await fakeHarness("0.1.0");
		expect(await node(cli, ["list"], {})).toEqual({
			code: 1,
			stdout: "",
			stderr: "workflows needs @vzlentin/harness ^0.3.1, found 0.1.0: npm install -g @vzlentin/harness@^0.3.1\n",
		});
		expect(await log("npm.log")).toEqual([]);
	});
});

describe("the setup", () => {
	it("does nothing outside a top-level global install", async () => {
		const top = await installWorkflows();
		const nested = await installWorkflows(join("other", "node_modules", "@vzlentin", "workflows"));
		await installHarness();

		expect(await postinstall(top, {})).toEqual({ code: 0, stdout: "", stderr: "" });
		expect(await postinstall(nested)).toEqual({ code: 0, stdout: "", stderr: "" });
		expect(await log("pi.log")).toEqual([]);
		expect(await log("npm.log")).toEqual([]);
		await expect(entries()).rejects.toThrow("ENOENT");
	});

	it("sets up harness, the entry and Pi from the postinstall", async () => {
		const dir = await installWorkflows();
		await installHarness();

		expect(await postinstall(dir)).toEqual({ code: 0, stdout: "", stderr: "" });
		expect(await log("pi.log")).toEqual([
			`install ${join(LIB(), "@vzlentin", "harness", "pi")}`,
			`install ${join(dir, "pi")}`,
		]);
		expect(await entries()).toEqual({ workflows: join(dir, "dist", "entry.js") });
		expect(await log("npm.log")).toEqual([]);

		// The postinstall wrote the stamp, so the first command does not set up again.
		expect(await workflows(dir, {}, "list")).toEqual({ code: 0, stdout: "", stderr: "" });
		expect(await log("pi.log")).toHaveLength(2);
	});

	it("installs a missing harness from the first command, and sets up once per version", async () => {
		const dir = await installWorkflows();
		const env = { NPM_INSTALLS: HARNESS };

		expect(await workflows(dir, env, "list")).toEqual({
			code: 0,
			stdout: "",
			stderr: `workflows: installing @vzlentin/harness: npm install -g --prefix ${PREFIX()} @vzlentin/harness@^0.3.1\n`,
		});
		expect(await log("npm.log")).toEqual([`install -g --prefix ${PREFIX()} @vzlentin/harness@^0.3.1`]);
		const once = [`install ${join(LIB(), "@vzlentin", "harness", "pi")}`, `install ${join(dir, "pi")}`];
		expect(await log("pi.log")).toEqual(once);
		expect(await entries()).toEqual({ workflows: join(dir, "dist", "entry.js") });

		expect(await workflows(dir, env, "list")).toEqual({ code: 0, stdout: "", stderr: "" });
		expect(await log("pi.log")).toEqual(once);

		const json = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
		const next = json.version.replace(/\d+$/, (patch: string) => String(Number(patch) + 1));
		await writeFile(join(dir, "package.json"), JSON.stringify({ ...json, version: next }));
		expect(await workflows(dir, env, "list")).toEqual({ code: 0, stdout: "", stderr: "" });
		expect(await log("pi.log")).toEqual([...once, `install ${join(dir, "pi")}`]);
	});

	it("tries the Pi steps again on the next command when pi failed", async () => {
		const dir = await installWorkflows();
		await installHarness();
		const extension = join(LIB(), "@vzlentin", "harness", "pi");

		expect(await workflows(dir, { PI_FAIL: "1" }, "list")).toEqual({
			code: 0,
			stdout: "",
			stderr:
				`harness: pi install failed (exit 1). To add the Pi extension of harness, run: pi install ${extension}\n` +
				`workflows: pi install failed (exit 1). To add the Pi extension of workflows, run: pi install ${join(dir, "pi")}\n`,
		});
		expect(await entries()).toEqual({ workflows: join(dir, "dist", "entry.js") });

		const installs = [`install ${extension}`, `install ${join(dir, "pi")}`];
		expect(await workflows(dir, {}, "list")).toEqual({ code: 0, stdout: "", stderr: "" });
		expect(await workflows(dir, {}, "list")).toEqual({ code: 0, stdout: "", stderr: "" });
		expect(await log("pi.log")).toEqual([...installs, ...installs]);
	});

	it("gives the prefix of the install in the fix command when it is not npm's global prefix", async () => {
		const dir = await installWorkflows();
		const installing = `workflows: installing @vzlentin/harness: npm install -g --prefix ${PREFIX()} @vzlentin/harness@^0.3.1\n`;

		expect(await workflows(dir, {}, "list")).toEqual({
			code: 1,
			stdout: "",
			stderr: `${installing}workflows needs @vzlentin/harness ^0.3.1: npm install -g --prefix ${PREFIX()} @vzlentin/harness@^0.3.1\n`,
		});

		expect(await workflows(dir, { NPM_GLOBAL_PREFIX: PREFIX() }, "list")).toEqual({
			code: 1,
			stdout: "",
			stderr: `${installing}workflows needs @vzlentin/harness ^0.3.1: npm install -g @vzlentin/harness@^0.3.1\n`,
		});
		expect(await log("pi.log")).toEqual([]);
	});

	it("never replaces a harness that is newer than the range", async () => {
		const dir = await installWorkflows();
		await installHarness();
		const manifest = join(LIB(), "@vzlentin", "harness", "package.json");
		const json = JSON.parse(await readFile(manifest, "utf8"));
		await writeFile(manifest, JSON.stringify({ ...json, version: "0.4.0" }));

		expect(await workflows(dir, { NPM_INSTALLS: HARNESS }, "list")).toEqual({
			code: 1,
			stdout: "",
			stderr: `workflows needs @vzlentin/harness ^0.3.1, found 0.4.0, which is newer. Update workflows: npm install -g --prefix ${PREFIX()} @vzlentin/workflows\n`,
		});

		await writeFile(manifest, JSON.stringify({ ...json, version: "0.4.0-rc.1" }));
		expect(await workflows(dir, { NPM_INSTALLS: HARNESS }, "list")).toEqual({
			code: 1,
			stdout: "",
			stderr: `workflows needs @vzlentin/harness ^0.3.1, found 0.4.0-rc.1, which is newer. Update workflows: npm install -g --prefix ${PREFIX()} @vzlentin/workflows\n`,
		});
		expect(await log("npm.log")).toEqual(["prefix -g", "prefix -g"]);
	});

	it("does not fail the install when harness stays missing", async () => {
		const dir = await installWorkflows();

		expect(await postinstall(dir)).toEqual({
			code: 0,
			stdout: "",
			stderr:
				`workflows: installing @vzlentin/harness: npm install -g --prefix ${PREFIX()} @vzlentin/harness@^0.3.1\n` +
				`workflows needs @vzlentin/harness ^0.3.1: npm install -g --prefix ${PREFIX()} @vzlentin/harness@^0.3.1\n`,
		});
		await expect(entries()).rejects.toThrow("ENOENT");
	});
});
