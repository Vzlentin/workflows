/**
 * The postinstall of the package. It does something only in a global install (`npm install -g`), so `npm ci` in a
 * checkout and an install as a dependency do nothing:
 *
 * 1. When no harness in the peer range of workflows resolves from this package, it installs one globally with the npm
 *    that runs this install, which keeps its prefix, and checks again.
 * 2. It sets the entry `workflows` in harness's `entries.json`, so a host that starts before any `workflows` command,
 *    such as one that Pi starts, already runs workflows.
 * 3. It registers the Pi extension in `pi/` with `pi install <path>`.
 *
 * No step fails the install: a failed npm install of a new package leaves its `bin` link with no package. Each step
 * prints what to run instead, and the `workflows` command prints the harness install command too.
 */
import { spawnSync } from "node:child_process";
import { delimiter, join, sep } from "node:path";
import { fileURLToPath } from "node:url";

const PI = fileURLToPath(new URL("../pi", import.meta.url));

// npm puts the `node_modules/.bin` folders first on `PATH`, and a dependency of this package has a `pi` of its own.
// Only the user's Pi must get the extension, so the script looks for `pi` without them.
const USER_PATH = (process.env.PATH ?? "")
	.split(delimiter)
	.filter((entry) => !entry.endsWith(join("node_modules", ".bin")) && !entry.includes(`${sep}node_modules${sep}`))
	.join(delimiter);

/**
 * Installs the harness of the range globally with the npm of this install, through `check`, the module
 * `dist/harness.js`. Returns whether a harness fits then.
 */
function installHarness(check) {
	if (check.harnessProblem(import.meta.url) === undefined) return true;
	const npm = process.env.npm_execpath;
	const spec = `${check.HARNESS}@${check.harnessRange()}`;
	console.log(`workflows: installing ${spec}`);
	const args = ["install", "-g", spec];

	if (npm === undefined) spawnSync("npm", args, { stdio: "inherit" });
	else spawnSync(process.execPath, [npm, ...args], { stdio: "inherit" });
	const problem = check.harnessProblem(import.meta.url);

	if (problem === undefined) return true;
	console.warn(problem);

	return false;
}

/**
 * Sets the entry `workflows` of harness's `entries.json` to `entry`, through the harness of this install. A new Node
 * process imports harness, as this one cached the lookups from before harness was installed.
 */
function setEntry(entry) {
	const script = `import { setEntry } from "@vzlentin/harness/entries";\nsetEntry("workflows", ${JSON.stringify(entry)});`;
	const cwd = fileURLToPath(new URL("..", import.meta.url));
	const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script], { cwd, stdio: "inherit" });

	if (result.error !== undefined || result.status !== 0) {
		console.warn("workflows: could not set the entry of workflows in harness; the first workflows command sets it");
	}
}

/** Registers the Pi extension of this install, or prints how to when Pi is missing or fails. */
function installPi() {
	const later = `pi install ${PI}`;

	const result = spawnSync("pi", ["install", PI], {
		env: { ...process.env, PATH: USER_PATH },
		stdio: "inherit",
		timeout: 120_000,
	});

	if (result.error?.code === "ENOENT") {
		console.warn(`workflows: pi is not on PATH; to get the workflow tool in Pi, run: ${later}`);

		return;
	}

	if (result.error !== undefined || result.status !== 0) {
		const reason = result.error?.message ?? `exit ${result.status}`;
		console.warn(`workflows: pi install failed (${reason}); to get the workflow tool in Pi, run: ${later}`);
	}
}

if (process.env.npm_config_global === "true") {
	// `dist/` is in the published package; the import comes after the check of a global install, as a checkout has none.
	const check = await import("../dist/harness.js");

	if (installHarness(check)) setEntry(check.ENTRY);
	installPi();
}
