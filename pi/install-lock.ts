/**
 * The wait on the install lock of workflows, `$XDG_STATE_HOME/workflows/install.lock`: a folder that one process at a
 * time holds while it installs. Its take and release follow the section "Install lock" of the harness spec. It imports
 * only Node modules, because the extension loads it before it finds workflows.
 */
import { readFileSync, type Stats, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";

const POLL_MS = 200;
const STALE_MS = 10_000;

/** The folder of the install lock. */
function lockPath(): string {
	return join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "workflows", "install.lock");
}

/** The stat of `path`, or undefined when it does not exist. */
function statOf(path: string): Stats | undefined {
	try {
		return statSync(path);
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
		throw error;
	}
}

/** The text of the `pid` file of the lock, or undefined when there is none. */
function readHolder(lock: string): string | undefined {
	try {
		return readFileSync(join(lock, "pid"), "utf8");
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
		throw error;
	}
}

/**
 * True when the holder `text` of a lock folder with the mtime `mtimeMs` is dead. Only ESRCH proves that a process is
 * gone. A missing or bad pid counts as held for 10 s after the mtime of the folder.
 */
function isDead(text: string | undefined, mtimeMs: number): boolean {
	const pid = text !== undefined && /^\d+$/.test(text.trim()) ? Number(text.trim()) : 0;

	if (pid <= 0) return Date.now() - mtimeMs > STALE_MS;

	try {
		process.kill(pid, 0);

		return false;
	} catch (error) {
		return error instanceof Error && "code" in error && error.code === "ESRCH";
	}
}

/** Waits until the install lock is free: the folder is gone or its holder is dead. It does not take the lock. */
export async function waitInstallLockFree(): Promise<void> {
	const lock = lockPath();

	for (;;) {
		const stat = statOf(lock);

		if (stat === undefined || isDead(readHolder(lock), stat.mtimeMs)) return;
		await setTimeout(POLL_MS);
	}
}
