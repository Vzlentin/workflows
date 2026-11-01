/** `workflows attach <run-id>`: opens a session of a run in Pi. */
import { spawn } from "node:child_process";
import { once } from "node:events";
import { parseArgs } from "node:util";
import { openConversationPane } from "@vzlentin/harness/herdr";
import { cliPath } from "@vzlentin/harness/protocol";
import { herdrPlace } from "../../herdr.ts";
import { agentRows } from "../../records/tree.ts";
import { UsageError, withUsage } from "../../workflow/find.ts";
import { connectTo } from "../host.ts";
import type { Terminal } from "../main.ts";
import { oneRunId, savedRun } from "../saved.ts";
import { readRun } from "./show.ts";

export const ATTACH = "workflows attach <run-id> [--conversation <id>] [--side]";

/**
 * Opens a session of a run in Pi: the session that works now, else the last session to start, or the session of
 * `--conversation` when one is given. In Herdr, it opens Pi in a new tab of the workspace that has the run's worktree
 * open, else of the workspace of this pane; with `--side`, in a new pane to the right of this pane. Else, it runs Pi in
 * this terminal and exits with its code.
 */
export async function attach(args: readonly string[], terminal: Terminal): Promise<number> {
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
	const { input, calls } = await readRun(run, terminal, true, "be attached");

	const list = agentRows(calls, 0, Date.now())
		.flatMap((row) => (row.kind === "agent" ? [row] : []))
		.filter((row) => conversation === undefined || row.conversation === conversation)
		.sort((a, b) => a.startedAt.localeCompare(b.startedAt));

	const session = list.findLast((row) => row.mark === "◉") ?? list.at(-1);

	if (session === undefined) {
		throw new Error(
			`run ${id} has no session${conversation === undefined ? "" : ` with conversation ${conversation}`}`,
		);
	}

	const client = await connectTo(terminal, run.project, true);

	try {
		// The watch fails here for a conversation that the host does not know, and gives the child that Herdr opens.
		const watched = String(session.conversation);
		const { child } = await client.request({ type: "watch", conversation: watched });

		if (process.env.HERDR_ENV) {
			const place = await herdrPlace(input.worktree, values.side === true, process.env.HERDR_PANE_ID || undefined);

			if (place !== undefined) {
				await openConversationPane(child, place, { ...process.env, HARNESS_PROJECT: run.project });

				return 0;
			}
		}

		const argv = [cliPath(), "--project", run.project, "attach", "--conversation", watched];
		const [code]: (number | null)[] = await once(spawn(process.execPath, argv, { stdio: "inherit" }), "exit");

		return code ?? 1;
	} finally {
		client.close();
	}
}
