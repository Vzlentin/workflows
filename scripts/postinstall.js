/**
 * The postinstall of the package. It does something only in a global install (`npm install -g`), so `npm ci` in a
 * checkout and an install as a dependency do nothing:
 *
 * 1. When no harness in the peer range of workflows resolves from this package, it installs one globally with the npm
 *    that runs this install, which keeps its prefix, and checks again. The install fails when it still finds none.
 * 2. It registers the Pi extension in `pi/` with `pi install <path>`. Without `pi` on PATH, it prints the command to
 *    run later. A failure of Pi is only a warning.
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

/** Installs the harness of the range globally with the npm of this install, and fails when it still does not fit. */
async function installHarness() {
	// `dist/` is in the published package; the import comes after the check of a global install, as a checkout has none.
	const { HARNESS, harnessProblem, harnessRange } = await import("../dist/harness.js");

	if (harnessProblem(import.meta.url) === undefined) return;
	const npm = process.env.npm_execpath;
	const spec = `${HARNESS}@${harnessRange()}`;
	console.log(`workflows: installing ${spec}`);
	const args = ["install", "-g", spec];

	if (npm === undefined) spawnSync("npm", args, { stdio: "inherit" });
	else spawnSync(process.execPath, [npm, ...args], { stdio: "inherit" });
	const problem = harnessProblem(import.meta.url);

	if (problem === undefined) return;
	console.error(problem);
	process.exit(1);
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
	await installHarness();
	installPi();
}
