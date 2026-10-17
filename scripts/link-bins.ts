// Links the workflows and harness commands into ~/.local/bin, as the postinstall of a Pi git install. One install
// owns the links. Another install fails and names the owner. On `pi install`, Pi then removes its clone.
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	renameSync,
	symlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
// pi-coding-agent is an optional dependency, so the script also runs without it.
const harness = await import("../src/harness.ts").catch(() => undefined);
const piGitRoot = join(agentDir(), "git");
const scriptRoot = join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "workflows");
const binDir = resolve(process.env.WORKFLOWS_BIN_DIR || join(homedir(), ".local", "bin"));

const bins: Record<string, string> = {
	workflows: join(root, "src", "cli.ts"),
	harness: join(root, "node_modules", "harness", "bin", "harness.mjs"),
};

/** Pi's agent directory, as Pi finds it: `PI_CODING_AGENT_DIR` with `~` expanded, or `~/.pi/agent`. */
function agentDir(): string {
	const dir = process.env.PI_CODING_AGENT_DIR;
	if (!dir) return join(homedir(), ".pi", "agent");
	return dir === "~" ? homedir() : dir.startsWith("~/") ? join(homedir(), dir.slice(2)) : dir;
}

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

function kindOf(path: string): "pi-git" | "script" | "checkout" {
	if (inside(path, piGitRoot)) return "pi-git";
	if (inside(path, scriptRoot)) return "script";
	return "checkout";
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

if (kindOf(root) === "checkout" && process.env.WORKFLOWS_LINK_BINS !== "1") {
	console.log("workflows: checkout, bins not linked (set WORKFLOWS_LINK_BINS=1 to link them)");
	process.exit(0);
}

// Check every link before changing any, so a refused install leaves the links as they were.
const plan: [string, string][] = [];
for (const [name, target] of Object.entries(bins)) {
	const link = join(binDir, name);
	let current: string | undefined;
	try {
		const stat = lstatSync(link, { throwIfNoEntry: false });
		if (stat !== undefined && !stat.isSymbolicLink()) fail(`${link} exists and is not a link. Remove it first`);
		current = stat === undefined ? undefined : realpathSync(link);
	} catch (error) {
		// A dangling link is left over from a removed install, for example after `pi remove`.
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") fail(`cannot read ${link}: ${(error as Error).message}`);
	}
	if (current === undefined) {
		plan.push([link, target]);
		continue;
	}
	const owner = packageOf(current);
	const ownerKind = owner === undefined ? undefined : kindOf(owner.dir);
	// The installs of install.sh are versions of one install, so a new version takes the links over.
	const same =
		owner !== undefined && (real(owner.dir) === root || (ownerKind === "script" && kindOf(root) === "script"));
	if (owner?.name === "workflows" && same) {
		plan.push([link, target]);
		continue;
	}
	if (owner?.name === "harness" && ownerKind === "pi-git") {
		plan.push([link, target]);
		continue;
	}
	const shown = resolve(binDir, readlinkSync(link));
	if (owner?.name === "workflows" && ownerKind === "checkout") {
		fail(`${link} points to ${shown}, a workflows checkout. Remove it first`);
	}
	if (owner?.name !== "workflows")
		fail(`${link} points to ${shown}, which is not a workflows install. Remove it first`);
	if (ownerKind === "script")
		fail(`already installed at ${owner.dir}. To use it from Pi, run: pi install ${owner.dir}`);
	fail(`already installed through Pi at ${owner.dir}. To update it, run: pi update --extensions`);
}

try {
	mkdirSync(binDir, { recursive: true });
	// A new link replaces the old one in one rename, so the command is never missing.
	for (const [link, target] of plan) {
		const temporary = `${link}.${process.pid}.tmp`;
		symlinkSync(target, temporary);
		renameSync(temporary, link);
		console.log(`workflows: linked ${link} -> ${target}`);
	}
} catch (error) {
	fail(`cannot link into ${binDir}: ${(error as Error).message}`);
}

const separate = await harness?.separateHarness(process.cwd(), root).catch(() => undefined);
if (harness !== undefined && separate !== undefined) {
	console.log(
		`workflows: harness is included now. Pi skips its subagent tool from workflows until you run: ${harness.removeCommand(separate)}`,
	);
}
const path = (process.env.PATH ?? "").split(":").map((dir) => resolve(dir || "."));
if (!path.includes(binDir)) console.log(`workflows: add ${binDir} to PATH`);
