/** Git and other processes: run a command, and the trimmed output of a Git command. */
import { execFile } from "node:child_process";

export type Result = { readonly code: number; readonly stdout: string; readonly stderr: string };

/** The exit code and output of `command <args>` in `cwd`, with no shell. */
export function run(command: string, args: readonly string[], cwd: string, signal?: AbortSignal): Promise<Result> {
	return new Promise((done, fail) => {
		execFile(command, args, { cwd, signal, maxBuffer: 1 << 30 }, (error, stdout, stderr) => {
			// A string code, such as ENOENT, means that the command did not run.
			if (error === null) done({ code: 0, stdout, stderr });
			else if (Number.isInteger(error.code)) done({ code: Number(error.code), stdout, stderr });
			else fail(error);
		});
	});
}

/** The error text of the failed command `argv`: its first two words and its output. */
export function failure(argv: readonly string[], result: Result): string {
	return `${argv.slice(0, 2).join(" ")} failed: ${result.stdout}${result.stderr}`.trim();
}

/** The trimmed stdout of `git <args>` in `cwd`; throws with the command output when git fails. */
export async function git(cwd: string, ...args: string[]): Promise<string> {
	const result = await run("git", args, cwd);

	if (result.code !== 0) throw new Error(failure(["git", ...args], result));

	return result.stdout.replace(/\n$/, "");
}

/** Whether `git <args>` exits 0; any other exit is false. */
export async function gitSucceeds(cwd: string, ...args: string[]): Promise<boolean> {
	return (await run("git", args, cwd)).code === 0;
}
