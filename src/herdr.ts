/** The hc commands of workflows: the removal of the hc terminals of a run. */
import { hc } from "@vzlentin/harness/herdr";
import { Type } from "typebox";
import { Value } from "typebox/value";

/** The part of the output of `hc ls --json` that has the addresses of the terminals. */
const TERMINALS = Type.Object({ terminals: Type.Array(Type.Object({ address: Type.String() })) });

/** The error message of an hc command that is not installed. harness's `hc` keeps only the message. */
const HC_MISSING = "spawn hc ENOENT";

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
