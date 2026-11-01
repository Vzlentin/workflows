/**
 * What a run shares from the command line: the run ID, the run directory and the Ctrl+C presses. The script task is
 * `scriptTask` in `task.ts`.
 */
import { randomBytes } from "node:crypto";

/** A run ID, `<UTC timestamp>-<8 hex>`, so a sort by name is a sort by start time. */
export function newRunId(): string {
	const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*$/, "");

	return `${stamp}-${randomBytes(4).toString("hex")}`;
}

/** What a run needs from the command line before it starts. */
export type Run = { readonly id: string; readonly directory: string; readonly cwd: string };

/**
 * The Ctrl+C presses of a command. The first detaches the command from its run. A second one stops the run while the
 * command follows a run, also before the command waits for it. Any other press calls `exit`.
 */
export class CtrlC {
	readonly #interrupt = new AbortController();
	readonly #stop = new AbortController();
	readonly #exit: () => void;
	#presses = 0;
	#following = false;

	constructor(exit: () => void) {
		this.#exit = exit;
	}

	/** Aborted by the first press. */
	get interrupt(): AbortSignal {
		return this.#interrupt.signal;
	}

	/** Aborted by a second press while the command follows a run. */
	get stop(): AbortSignal {
		return this.#stop.signal;
	}

	/** Whether the command follows a run, so that a second press stops it. */
	following(active: boolean): void {
		this.#following = active;
	}

	press(): void {
		this.#presses++;

		if (this.#presses === 1) this.#interrupt.abort();
		else if (this.#presses === 2 && this.#following) this.#stop.abort();
		else this.#exit();
	}
}
