import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { harnessProblem, harnessRange, inRange } from "../src/harness.ts";

const CHECKOUT = fileURLToPath(new URL("..", import.meta.url));

let root: string;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "workflows-harness-test-"));
});

afterEach(() => rm(root, { recursive: true, force: true }));

/** Puts a harness of `version` in `node_modules` of `root`. */
async function installHarness(version: string) {
	const dir = join(root, "node_modules", "@vzlentin", "harness");
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, "package.json"), JSON.stringify({ name: "@vzlentin/harness", version }));
}

/**
 * A copy of the checkout's `src/` and `package.json` in `root`, with every package of the checkout's `node_modules`
 * except `@vzlentin`, so harness resolves only when a test installs it.
 */
async function copyCheckout() {
	await cp(join(CHECKOUT, "src"), join(root, "src"), { recursive: true });
	await cp(join(CHECKOUT, "package.json"), join(root, "package.json"));
	await mkdir(join(root, "node_modules"));

	for (const name of await readdir(join(CHECKOUT, "node_modules"))) {
		if (name !== "@vzlentin") await symlink(join(CHECKOUT, "node_modules", name), join(root, "node_modules", name));
	}
}

/** Runs `node <script> ...args` in `root` with `env` added to the environment, and returns its exit code and output. */
async function node(script: string, args: readonly string[], env: Readonly<Record<string, string>>) {
	try {
		const { stdout, stderr } = await promisify(execFile)(process.execPath, [script, ...args], {
			cwd: root,
			env: { ...process.env, XDG_STATE_HOME: join(root, "state"), XDG_CONFIG_HOME: join(root, "config"), ...env },
		});

		return { code: 0, stdout, stderr };
	} catch (error) {
		const { code, stdout, stderr } = Object.assign({ code: -1, stdout: "", stderr: "" }, error);

		return { code, stdout, stderr };
	}
}

/** Runs the `workflows` command of the copy in `root` with `args`. */
const workflows = (...args: string[]) => node(join(root, "src", "cli.ts"), args, {});

/**
 * A copy of the published layout in `root`: `package.json`, `dist/` built from the checkout, `scripts/postinstall.js`,
 * and the checkout's `node_modules` except `@vzlentin`. `bin/` has only `node`, so no `pi` is on `PATH`.
 */
async function copyPackage() {
	await copyCheckout();
	await cp(join(CHECKOUT, "scripts"), join(root, "scripts"), { recursive: true });
	const tsc = join(CHECKOUT, "node_modules", ".bin", "tsc");
	await promisify(execFile)(tsc, ["-p", join(CHECKOUT, "tsconfig.build.json"), "--outDir", join(root, "dist")]);
	await mkdir(join(root, "bin"));
	await symlink(process.execPath, join(root, "bin", "node"));
}

/** Links the checkout's harness into `node_modules` of `root`. */
async function linkHarness() {
	await mkdir(join(root, "node_modules", "@vzlentin"));
	const harness = join(CHECKOUT, "node_modules", "@vzlentin", "harness");
	await symlink(harness, join(root, "node_modules", "@vzlentin", "harness"));
}

/** Runs the postinstall of the copy in `root` as a global install, with `env` added to the environment. */
function postinstall(env: Readonly<Record<string, string>> = {}) {
	return node(join(root, "scripts", "postinstall.js"), [], {
		npm_config_global: "true",
		PATH: join(root, "bin"),
		...env,
	});
}

const entries = async () => JSON.parse(await readFile(join(root, "config", "harness", "entries.json"), "utf8"));

describe("the harness range", () => {
	it("is the peer dependency of the package", () => {
		expect(harnessRange()).toBe("^0.2.0");
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
});

describe("the harness check", () => {
	it("says how to install harness when none resolves, or when its version is out of the range", async () => {
		const from = join(root, "dist", "cli.js");
		expect(harnessProblem(from)).toBe(
			"workflows needs @vzlentin/harness ^0.2.0: npm install -g @vzlentin/harness@^0.2.0",
		);

		await installHarness("0.1.0");
		expect(harnessProblem(from)).toBe(
			"workflows needs @vzlentin/harness ^0.2.0, found 0.1.0: npm install -g @vzlentin/harness@^0.2.0",
		);

		await installHarness("0.2.3");
		expect(harnessProblem(from)).toBeUndefined();
	});

	it("stops the command before it loads harness", async () => {
		await copyCheckout();
		expect(await workflows("list")).toEqual({
			code: 1,
			stdout: "",
			stderr: "workflows needs @vzlentin/harness ^0.2.0: npm install -g @vzlentin/harness@^0.2.0\n",
		});

		await installHarness("0.1.0");
		expect(await workflows("list")).toEqual({
			code: 1,
			stdout: "",
			stderr: "workflows needs @vzlentin/harness ^0.2.0, found 0.1.0: npm install -g @vzlentin/harness@^0.2.0\n",
		});
	});
});

describe("the postinstall", () => {
	it("does nothing outside a global install", async () => {
		await copyPackage();
		await linkHarness();

		expect(await postinstall({ npm_config_global: "" })).toEqual({ code: 0, stdout: "", stderr: "" });
		await expect(entries()).rejects.toThrow("ENOENT");
	});

	it("sets the entry of workflows in harness, and says how to add the Pi extension when pi is missing", async () => {
		await copyPackage();
		await linkHarness();
		const installed = await realpath(root);

		expect(await postinstall()).toEqual({
			code: 0,
			stdout: "",
			stderr: `workflows: pi is not on PATH; to get the workflow tool in Pi, run: pi install ${join(installed, "pi")}\n`,
		});
		expect(await entries()).toEqual({ workflows: join(installed, "dist", "entry.js") });
	});

	it("installs harness with the npm of the install, then sets the entry with it", async () => {
		await copyPackage();
		const npm = join(root, "npm.js");
		const harness = join(CHECKOUT, "node_modules", "@vzlentin", "harness");
		await writeFile(
			npm,
			[
				'import { appendFileSync, mkdirSync, symlinkSync } from "node:fs";',
				'appendFileSync("npm.log", process.argv.slice(2).join(" "));',
				'mkdirSync("node_modules/@vzlentin");',
				`symlinkSync(${JSON.stringify(harness)}, "node_modules/@vzlentin/harness");`,
			].join("\n"),
		);
		const installed = await realpath(root);

		expect(await postinstall({ npm_execpath: npm })).toEqual({
			code: 0,
			stdout: "workflows: installing @vzlentin/harness@^0.2.0\n",
			stderr: `workflows: pi is not on PATH; to get the workflow tool in Pi, run: pi install ${join(installed, "pi")}\n`,
		});
		expect(await readFile(join(root, "npm.log"), "utf8")).toBe("install -g @vzlentin/harness@^0.2.0");
		expect(await entries()).toEqual({ workflows: join(installed, "dist", "entry.js") });
	});

	it("does not fail the install when harness stays missing", async () => {
		await copyPackage();
		const npm = join(root, "npm.js");
		await writeFile(npm, "process.exit(1);\n");
		const installed = await realpath(root);

		expect(await postinstall({ npm_execpath: npm })).toEqual({
			code: 0,
			stdout: "workflows: installing @vzlentin/harness@^0.2.0\n",
			stderr:
				"workflows needs @vzlentin/harness ^0.2.0: npm install -g @vzlentin/harness@^0.2.0\n" +
				`workflows: pi is not on PATH; to get the workflow tool in Pi, run: pi install ${join(installed, "pi")}\n`,
		});
		await expect(entries()).rejects.toThrow("ENOENT");
	});
});
