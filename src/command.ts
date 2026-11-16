/** The `workflows` command of this package as a child process, which the `workflow` tool of the host runs. */
import { fileURLToPath } from "node:url";

/** The `workflows` command of this package, with the Node of this process: `dist/cli.js`, or `src/cli.ts` in a checkout. */
export const CLI = [
	process.execPath,
	fileURLToPath(new URL(import.meta.url.endsWith(".ts") ? "./cli.ts" : "./cli.js", import.meta.url)),
];
