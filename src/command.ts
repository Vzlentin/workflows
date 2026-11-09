/** The `workflows` command of this package as a child process, which the `workflow` tool of the host runs. */
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type { Output } from "./tool.ts";

/** The `workflows` command of this package, with the Node of this process: `dist/cli.js`, or `src/cli.ts` in a checkout. */
export const CLI = [
	process.execPath,
	fileURLToPath(new URL(import.meta.url.endsWith(".ts") ? "./cli.ts" : "./cli.js", import.meta.url)),
];

/**
 * Runs the command with `args` in `cwd` and `env`; each stdout line goes to `stdout` and each stderr line to `stderr`,
 * and `signal` sends SIGINT, which detaches.
 */
export async function runCli(
	args: readonly string[],
	cwd: string,
	options: {
		readonly env: NodeJS.ProcessEnv;
		readonly stdin: string | undefined;
		readonly signal: AbortSignal | undefined;
		readonly stdout: (line: string) => void;
		readonly stderr: (line: string) => void;
	},
): Promise<Output> {
	const [program = "", ...prefix] = CLI;
	const child = spawn(program, [...prefix, ...args], { cwd, env: options.env, stdio: ["pipe", "pipe", "pipe"] });
	child.stdin.on("error", () => {});
	const stdout: string[] = [];
	const stderr: string[] = [];
	const out = createInterface({ input: child.stdout });
	const err = createInterface({ input: child.stderr });
	out.on("line", (line) => {
		stdout.push(line);
		options.stdout(line);
	});
	err.on("line", (line) => {
		stderr.push(line);
		options.stderr(line);
	});
	const interrupt = () => child.kill("SIGINT");
	options.signal?.addEventListener("abort", interrupt, { once: true });

	try {
		child.stdin.end(options.stdin ?? "");
		await Promise.all([once(child, "close"), once(out, "close"), once(err, "close")]);

		return { code: child.exitCode, stdout, stderr };
	} finally {
		options.signal?.removeEventListener("abort", interrupt);
	}
}
