import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
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

/** Runs the `workflows` command of the copy in `root` with `args`. */
async function workflows(...args: string[]) {
	try {
		const { stdout, stderr } = await promisify(execFile)(process.execPath, [join(root, "src", "cli.ts"), ...args], {
			cwd: root,
			env: { ...process.env, XDG_STATE_HOME: join(root, "state"), XDG_CONFIG_HOME: join(root, "config") },
		});

		return { code: 0, stdout, stderr };
	} catch (error) {
		const { code, stdout, stderr } = Object.assign({ code: -1, stdout: "", stderr: "" }, error);

		return { code, stdout, stderr };
	}
}

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
