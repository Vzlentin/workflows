/**
 * The `workflows` command of this package as a child process, which the `workflow` tool of the host runs, and as one
 * shell string, which a workflow script passes to `sh`.
 */
import { fileURLToPath } from "node:url";

/** The `workflows` command of this package, with the Node of this process: `dist/cli.js`, or `src/cli.ts` in a checkout. */
export const CLI = [
	process.execPath,
	fileURLToPath(new URL(import.meta.url.endsWith(".ts") ? "./cli.ts" : "./cli.js", import.meta.url)),
];

/** The words of `argv` as one POSIX shell string: each word in single quotes, with `'` written as `'\''`. */
export function shellQuote(argv: readonly string[]): string {
	return argv.map((word) => `'${word.replaceAll("'", "'\\''")}'`).join(" ");
}

/** `CLI` as one shell string, for `sh` in a workflow script. */
export const CLI_COMMAND = shellQuote(CLI);
