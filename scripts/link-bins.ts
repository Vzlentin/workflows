// Links the workflows and harness commands into ~/.local/bin, as the postinstall of a Pi git install. One install
// owns the links. Another install fails and names the owner, and Pi then removes its clone.
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	symlinkSync,
	unlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const home = homedir();
const piGitRoot = join(process.env.PI_CODING_AGENT_DIR ?? join(home, ".pi", "agent"), "git");
const scriptRoot = join(process.env.XDG_DATA_HOME ?? join(home, ".local", "share"), "workflows");
const binDir = process.env.WORKFLOWS_BIN_DIR ?? join(home, ".local", "bin");

const bins: Record<string, string> = {
	workflows: join(root, "src", "cli.ts"),
	harness: join(root, "node_modules", "harness", "bin", "harness.mjs"),
};

function real(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}

function inside(path: string, dir: string): boolean {
	const [p, d] = [real(path), real(dir)];
	return p === d || p.startsWith(d + sep);
}

function kindOf(path: string): "pi-git" | "script" | "dev" {
	if (inside(path, piGitRoot)) return "pi-git";
	if (inside(path, scriptRoot)) return "script";
	return "dev";
}

/** The nearest package above `path`, skipping packages that are installed in `node_modules`. */
function packageOf(path: string): { readonly dir: string; readonly name: string } | undefined {
	for (let dir = dirname(path); dir !== dirname(dir); dir = dirname(dir)) {
		const manifest = join(dir, "package.json");
		if (!existsSync(manifest) || basename(dirname(dir)) === "node_modules") continue;
		return { dir, name: (JSON.parse(readFileSync(manifest, "utf8")) as { name?: string }).name ?? "" };
	}
	return undefined;
}

function fail(message: string): never {
	console.error(`workflows: ${message}`);
	process.exit(1);
}

if (kindOf(root) === "dev" && process.env.WORKFLOWS_LINK_BINS !== "1") {
	console.log("workflows: dev checkout, bins not linked (set WORKFLOWS_LINK_BINS=1 to link them)");
	process.exit(0);
}

// Check every link before changing any, so a refused install leaves the links as they were.
const plan: [string, string][] = [];
for (const [name, target] of Object.entries(bins)) {
	const link = join(binDir, name);
	const stat = lstatSync(link, { throwIfNoEntry: false });
	if (stat !== undefined && !stat.isSymbolicLink()) fail(`${link} exists and is not a link. Remove it first`);
	const current = stat === undefined ? undefined : resolve(binDir, readlinkSync(link));
	// A dangling link is left over from a removed install, for example after `pi remove`.
	if (current === undefined || !existsSync(current)) {
		plan.push([link, target]);
		continue;
	}
	const owner = packageOf(current);
	if (owner?.name === "workflows" && real(owner.dir) === real(root)) {
		plan.push([link, target]);
		continue;
	}
	if (owner?.name === "harness" && kindOf(owner.dir) === "pi-git") {
		console.log(
			`workflows: ${link} pointed to the separate harness install at ${owner.dir}, which workflows now includes. Remove it from Pi with pi remove and its source from pi list`,
		);
		plan.push([link, target]);
		continue;
	}
	if (owner?.name !== "workflows" || kindOf(owner.dir) === "dev") {
		fail(`${link} points to ${current}, which is not a workflows install. Remove it first`);
	}
	if (kindOf(owner.dir) === "script") {
		fail(`already installed at ${owner.dir}. To use it from Pi, run: pi install ${owner.dir}`);
	}
	fail(`already installed through Pi at ${owner.dir}. To update it, run: pi update`);
}

mkdirSync(binDir, { recursive: true });
for (const [link, target] of plan) {
	if (lstatSync(link, { throwIfNoEntry: false }) !== undefined) unlinkSync(link);
	symlinkSync(target, link);
	console.log(`workflows: linked ${link} -> ${target}`);
}
if (!(process.env.PATH ?? "").split(":").includes(binDir)) console.log(`workflows: add ${binDir} to PATH`);
