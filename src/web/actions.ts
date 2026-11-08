/**
 * The actions of `workflows web` on runs: start, stop, resume and prune, and `directoryOf`, the directory of an action
 * or of the workflow list. Each action runs the `workflows` command of this package as a child process, so it does what
 * the command does, with its checks and its exit codes.
 */
import { stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { checkProject, projectDir } from "@vzlentin/harness/projects";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { COMMAND_NAMES } from "../cli/commands/save.ts";
import { runCli } from "../command.ts";
import {
	cliArgs,
	GONE_EXIT,
	type Output,
	outcomeOf,
	summary,
	type WorkflowCall,
	type WorkflowOutcome,
} from "../tool.ts";
import { HttpError } from "./http.ts";

/**
 * The variables of the environment of the server that a child command does not get: the project follows the directory
 * of the command, and a run that a browser starts has no conversation to post its outcome to and no hc terminal.
 */
const DROPPED = new Set(["HARNESS_PROJECT", "PI_SESSION_ID", "HC_TERMINAL_ID"]);

/**
 * Where an action runs, as `directoryOf` finds it: in a project, or in an absolute path of a directory. Without both, it
 * runs in the server's directory.
 */
const WHERE = {
	project: Type.Optional(Type.String({ minLength: 1 })),
	cwd: Type.Optional(Type.String({ minLength: 1 })),
};

export const StartBody = Type.Object({
	workflow: Type.String({ minLength: 1 }),
	args: Type.Optional(Type.Array(Type.String())),
	...WHERE,
});

export const StopBody = Type.Object({});

export const ResumeBody = Type.Object({ answer: Type.Optional(Type.String()) });

export const PruneBody = Type.Object({ runIds: Type.Optional(Type.Array(Type.String())), ...WHERE });

/** What `workflows prune --json` prints: the pruned runs. */
const PRUNED = Type.Array(Type.Object({ runId: Type.String() }));

/** Runs `workflows <args>` in `cwd`, with the environment of the server without the `DROPPED` variables. */
function command(args: readonly string[], cwd: string): Promise<Output> {
	const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !DROPPED.has(name)));

	return runCli(args, cwd, { env, stdin: undefined, signal: undefined, stdout: () => {}, stderr: () => {} });
}

/** The HTTP status of a command that exited with `code` and no outcome: 400 for bad usage, 404 for a gone run, else 500. */
function failedStatus(code: number | null): number {
	if (code === 2) return 400;

	return code === GONE_EXIT ? 404 : 500;
}

/** The error of a command that failed: its stderr, with the status of its exit code. */
function failure(output: Output): HttpError {
	return new HttpError(failedStatus(output.code), output.stderr.join("\n") || `workflows exited with ${output.code}`);
}

/** The outcome line of `output`. Without one, it throws the error of the command, with the status of its exit code. */
function outcomeOrFailure(output: Output): WorkflowOutcome {
	try {
		return outcomeOf(output);
	} catch (cause) {
		throw new HttpError(failedStatus(output.code), cause instanceof Error ? cause.message : String(cause));
	}
}

/** `project` when it is `main` or a project. Otherwise it throws a 400 error. */
export function projectOrBad(project: string): string {
	try {
		return checkProject(project);
	} catch (cause) {
		throw new HttpError(400, cause instanceof Error ? cause.message : String(cause));
	}
}

/**
 * The directory of `project` (the home directory for `main`), or `cwd`, or `home` without both. Both, a project that is
 * not `main` or a project, and a project directory or a `cwd` that is not an absolute path of a directory are 400 errors.
 */
export async function directoryOf(
	{ project, cwd }: { readonly project?: string | undefined; readonly cwd?: string | undefined },
	home: string,
): Promise<string> {
	if (project !== undefined && cwd !== undefined) throw new HttpError(400, "Use project or cwd, not both");

	const candidate = project === undefined ? cwd : projectDir(projectOrBad(project));

	if (candidate === undefined) return home;

	const directory =
		isAbsolute(candidate) &&
		(await stat(candidate).then(
			(info) => info.isDirectory(),
			() => false,
		));

	if (!directory) throw new HttpError(400, `Not an absolute path of a directory: ${candidate}`);

	return candidate;
}

/**
 * Starts a run of `workflow` with `args` in the background, as `workflows --background --json <workflow> <args>` in
 * the directory that `directoryOf` gives. A command name or a word that starts with `-` is not a workflow.
 */
export async function startRun(
	{ workflow, args = [], ...where }: Static<typeof StartBody>,
	home: string,
): Promise<{ runId: string; status: "started" }> {
	if (workflow.startsWith("-") || COMMAND_NAMES.some((name) => name === workflow)) {
		throw new HttpError(400, `${workflow} is not a workflow`);
	}

	// The flags come first, so that a `--` in `args` does not make them positionals.
	const output = await command(["--background", "--json", workflow, ...args], await directoryOf(where, home));
	const outcome = outcomeOrFailure(output);

	if (outcome.status !== "started") throw new HttpError(500, summary(outcome));

	return { runId: outcome.runId, status: outcome.status };
}

/** Stops the run `id`, as `workflows stop <id>`. */
export async function stopRun(id: string, home: string): Promise<{ ok: true }> {
	const output = await command(["stop", id, "--json"], home);

	if (output.code !== 0) throw failure(output);

	return { ok: true };
}

/**
 * Resumes the run `id` in the background, as `workflows resume <id> [--answer=<text>] --background --json`. A run that
 * the command does not start again, such as a finished run, is a 409 error with the summary of its outcome.
 */
export async function resumeRun(
	id: string,
	{ answer }: Static<typeof ResumeBody>,
	home: string,
): Promise<{ ok: true }> {
	const call: WorkflowCall = { resume: id, background: true };

	if (answer !== undefined) call.answer = answer;
	const outcome = outcomeOrFailure(await command(cliArgs(call), home));

	if (outcome.status !== "started") throw new HttpError(409, summary(outcome));

	return { ok: true };
}

/**
 * Prunes the runs `runIds`, or the runs on a merged branch without them, as `workflows prune --yes` in the directory
 * that `directoryOf` gives, and gives the IDs of the pruned runs.
 */
export async function pruneRuns(
	{ runIds = [], ...where }: Static<typeof PruneBody>,
	home: string,
): Promise<{ pruned: string[] }> {
	// After `--`, a run ID is never an option.
	const output = await command(["prune", "--yes", "--json", "--", ...runIds], await directoryOf(where, home));

	if (output.code !== 0) throw failure(output);
	let printed: unknown;

	try {
		printed = JSON.parse(output.stdout.at(-1) ?? "");
	} catch {
		printed = undefined;
	}

	if (!Value.Check(PRUNED, printed))
		throw new HttpError(500, `workflows prune printed no list: ${output.stdout.join("\n")}`);

	return { pruned: printed.map(({ runId }) => runId) };
}
