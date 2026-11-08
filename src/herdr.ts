/** The hc commands of workflows: the pick loop of a run in herdr-app, and the removal of the terminals of a run. */
import { hc } from "@vzlentin/harness/herdr";
import { Type } from "typebox";
import { Value } from "typebox/value";

/** The part of the output of `hc ls --json` that has the addresses of the terminals. */
const TERMINALS = Type.Object({ terminals: Type.Array(Type.Object({ address: Type.String() })) });

/** The error message of an hc command that is not installed. harness's `hc` keeps only the message. */
const HC_MISSING = "spawn hc ENOENT";

/**
 * Starts the loop of `show --pick` and `attach --side` on the run `runId` in a background hc terminal in `worktree`,
 * labeled with the space and the tab `runId`, so herdr-app shows the agents of the run beside its step tree. Any
 * failure leaves the run as it is.
 */
export async function startPickLoop(worktree: string, runId: string): Promise<void> {
	const loop = `while c=$(workflows show ${runId} --pick); do workflows attach ${runId} --conversation "$c" --side; done`;
	const labels = ["--label", `herdr.space=${runId}`, "--label", `herdr.tab=${runId}`];

	try {
		await hc(
			["run", "--bg", "--keep", "--no-parent", "--cwd", worktree, ...labels, "--", "sh", "-c", loop],
			process.env,
		);
	} catch {
		// The loop is a help: the run goes on without it.
	}
}

/**
 * Kills and removes the hc terminals labeled with the space `runId`. Without the hc command, it does nothing. It throws
 * when hc fails otherwise, or prints something else than its list of terminals.
 */
export async function removeTerminals(runId: string): Promise<void> {
	let stdout: string;

	try {
		stdout = await hc(["ls", "--all", "--json", "--label", `herdr.space=${runId}`], process.env);
	} catch (error) {
		if (error instanceof Error && error.message === HC_MISSING) return;
		throw error;
	}

	let parsed: unknown;

	try {
		parsed = JSON.parse(stdout);
	} catch {
		parsed = undefined;
	}

	if (!Value.Check(TERMINALS, parsed)) throw new Error(`hc ls printed ${stdout}`.trim());

	for (const { address } of parsed.terminals) {
		await hc(["kill", address], process.env);
		await hc(["rm", address], process.env);
	}
}
