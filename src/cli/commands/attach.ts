/** `workflows attach <run-id>`: opens a session of a run in Pi. */
import { spawn } from "node:child_process";
import { once } from "node:events";
import { parseArgs } from "node:util";
import { cliPath } from "@vzlentin/harness/protocol";
import { agentRows, runAgent } from "../../records/tree.ts";
import { UsageError, withUsage } from "../../workflow/find.ts";
import { oneRunId, savedRun } from "../saved.ts";
import { readRun } from "./show.ts";

export const ATTACH = "workflows attach <run-id> [--conversation <id>] [--side]";

/**
 * Opens a session of a run in Pi: the session that works now, else the last session to start, or the session of
 * `--conversation` when one is given. It runs `harness attach --conversation` of this install for the project of the
 * run, with `--side` when given, and exits with its code. Harness checks the conversation and opens Pi: in this
 * terminal, or with `--side` in an hc terminal, in a new herdr-app pane to the right of this terminal.
 */
export async function attach(args: readonly string[]): Promise<number> {
	const { values, positionals } = withUsage(
		() =>
			parseArgs({
				args: [...args],
				options: { conversation: { type: "string" }, side: { type: "boolean" } },
				allowPositionals: true,
				strict: true,
			}),
		ATTACH,
	);

	const id = oneRunId(positionals, ATTACH);
	const wanted = values.conversation;

	if (wanted !== undefined && !/^\d+$/.test(wanted)) {
		throw new UsageError(`${wanted} is not a conversation ID`, ATTACH);
	}

	const conversation = wanted === undefined ? undefined : Number(wanted);

	const run = await savedRun(id, ATTACH);
	const { calls } = await readRun(run, true, "be attached");

	const session = runAgent(
		agentRows(calls, 0, Date.now()),
		(found) => conversation === undefined || found === conversation,
	);

	if (session === undefined) {
		throw new Error(
			`run ${id} has no session${conversation === undefined ? "" : ` with conversation ${conversation}`}`,
		);
	}

	const argv = [cliPath(), "--project", run.project, "attach", "--conversation", String(session.conversation)];
	const side = values.side ? ["--side"] : [];

	const [code]: (number | null)[] = await once(
		spawn(process.execPath, [...argv, ...side], { stdio: "inherit" }),
		"exit",
	);

	return code ?? 1;
}
