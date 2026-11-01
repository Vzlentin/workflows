/** `workflows list`: the runs of the project of the current directory. */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { resolveProject } from "@vzlentin/harness/projects";
import { statePaths } from "@vzlentin/harness/protocol";
import { type Mark, Progress } from "../../records/steps.ts";
import { inputWorktree, progressEvents, reading, runTasks, type Store } from "../../records/store.ts";
import { title as titleOf } from "../../run/result.ts";
import { current } from "../../run/version.ts";
import { UsageError } from "../../workflow/find.ts";
import { runsDirectory, STORE_FILE } from "../host.ts";
import type { Choose, Terminal } from "../main.ts";
import { runStatus, savedBy, taskOf } from "../saved.ts";
import type { PickItem } from "../terminal/pick.ts";

export const LIST = "workflows list [--pick] [--json]";

type Listed = {
	readonly runId: string;
	readonly workflow: string;
	readonly title: string;
	readonly status: string;
	readonly repository: string | null;
};

/**
 * Prints the runs of the project of the current directory that have a run directory, newest run ID first. It reads the
 * project store only.
 */
export async function list(args: readonly string[], terminal: Terminal, json: boolean): Promise<number> {
	const pick = args[0] === "--pick";

	if (args.length > Number(pick)) throw new UsageError("list takes no arguments but --pick", LIST);

	if (pick) {
		if (terminal.choose === undefined) throw new UsageError("--pick needs a terminal on stdin and stderr", LIST);
		const run = await pickRun(terminal, terminal.choose);

		if (run === undefined) return 130;
		terminal.stdout(run);

		return 0;
	}

	const listed = await reading(
		join(statePaths(await resolveProject(process.env, terminal.cwd)).dir, STORE_FILE),
		[],
		listedRuns,
	);

	if (json) terminal.stdout(JSON.stringify(listed));
	else for (const run of listed) terminal.stdout(`${run.runId} ${run.workflow} ${run.status} ${run.title}`);

	return 0;
}

/** The runs of the open project store `store` that have a run directory, newest run ID first. */
async function listedRuns(store: Store): Promise<Listed[]> {
	const runs = await runTasks(store);
	const listed: Listed[] = [];

	for (const [id, tasks] of [...runs].sort(([a], [b]) => b.localeCompare(a))) {
		const task = taskOf(tasks);

		if (task === undefined || !existsSync(join(runsDirectory(), id, "project"))) continue;
		const status = runStatus(task);
		const repository = inputWorktree(task.input)?.repository ?? null;

		if (current(task)) {
			const title = titleOf(task.input, await progressEvents(store, id));
			listed.push({ runId: id, workflow: task.input.name, title, status, repository });
		} else listed.push({ runId: id, workflow: savedBy(task).name, title: savedBy(task).name, status, repository });
	}

	return listed;
}

/**
 * Asks on the terminal which run of the project of the current directory to take, and gives its run ID, or undefined
 * when the person cancels. The runs that have not ended come first, each with the steps that run now. While it waits,
 * it reads the runs again every second.
 */
async function pickRun(terminal: Terminal, choose: Choose): Promise<string | undefined> {
	const items = await runItems(terminal);

	if (items.length === 0) throw new Error(`no runs in the project of ${terminal.cwd}`);

	return choose("Pick a run:", items, () => runItems(terminal));
}

/** The items of the run picker, from the project store of the current directory, each with its run ID as its value. */
async function runItems(terminal: Terminal): Promise<PickItem<string>[]> {
	const empty = { runs: [], steps: new Map<string, string>() };

	const { runs, steps } = await reading(
		join(statePaths(await resolveProject(process.env, terminal.cwd)).dir, STORE_FILE),
		empty,
		async (store) => {
			const live = (run: Listed) => run.status === "running" || run.status === "waiting";
			// A stable sort keeps the newest first within each group.
			const sorted = (await listedRuns(store)).toSorted((a, b) => Number(live(b)) - Number(live(a)));
			const found = new Map<string, string>();

			for (const run of sorted.filter((each) => each.status === "running")) {
				const progress = new Progress();

				for (const event of await progressEvents(store, run.runId)) progress.add(event);
				const status = progress.status();

				if (status !== undefined) found.set(run.runId, status);
			}

			return { runs: sorted, steps: found };
		},
	);

	return runs.map((run) => {
		const step = steps.get(run.runId);
		const text = `${markOf(run.status)} ${run.title}  ${run.workflow} ${run.status}${step === undefined ? "" : `: ${step}`}`;

		return { text, value: run.runId };
	});
}

/** The mark of a run in the picker by its status: `◉` running, `?` waiting for an answer, `✗` failed, else `·`. */
function markOf(status: string): Mark | "?" | "·" {
	if (status === "running") return "◉";

	if (status === "waiting") return "?";

	return status === "failed" || status === "faulted" ? "✗" : "·";
}
