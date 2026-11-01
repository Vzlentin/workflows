/** The Ctrl+C presses of the command line. */

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
