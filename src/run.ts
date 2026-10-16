/**
 * What a run shares from the command line: the run ID, usage errors, the run directory and the terminal input and
 * output. The script task is `scriptTask` in `task.ts`.
 */
import { randomBytes } from "node:crypto";

/** A run ID, `<UTC timestamp>-<8 hex>`, so a sort by name is a sort by start time. */
export function newRunId(): string {
	const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*$/, "");
	return `${stamp}-${randomBytes(4).toString("hex")}`;
}

/** Bad command-line usage: the command prints `usage`, or its own usage, and exits 2. */
export class UsageError extends Error {
	readonly usage: string | undefined;

	constructor(message: string, usage?: string) {
		super(message);
		this.usage = usage;
	}
}

/** The result of `parse`, a call of `parseArgs`, whose errors become bad usage that prints `usage`. */
export function withUsage<T>(parse: () => T, usage: string): T {
	try {
		return parse();
	} catch (error) {
		const code = (error as { code?: unknown }).code;
		if (typeof code === "string" && code.startsWith("ERR_PARSE_ARGS")) {
			throw new UsageError((error as Error).message, usage);
		}
		throw error;
	}
}

/** What a run needs from the command line before it starts. */
export type Run = { readonly id: string; readonly directory: string; readonly cwd: string };

export type Io = {
	readonly cwd: string;
	/** The piped stdin, or undefined when stdin is a terminal. */
	readonly stdin: () => Promise<string | undefined>;
	readonly stdout: (line: string) => void;
	readonly stderr: (line: string) => void;
	/** Draws the progress lines of a run again in place, when stderr is a terminal. */
	readonly redraw?: ((lines: readonly string[]) => void) | undefined;
};
