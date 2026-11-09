/**
 * `@vzlentin/workflows/runs`: the runs of a project for a program, such as a web app, that reads them as the command
 * line does. It lists the runs and the workflows of a project, reads one run with its steps, calls and footer, and runs
 * the `workflows` command as a child process for an action on a run. It reads the project store read-only, as `list` and
 * `show` do.
 */
export { type ListedRun, projectRuns } from "./cli/commands/list.ts";

export { COMMAND_NAMES } from "./cli/commands/save.ts";

export { readRun, type ShownRun, shownLines } from "./cli/commands/show.ts";

export { ENTRY, runsDirectory, STORE_FILE } from "./cli/host.ts";

export {
	GoneRun,
	OtherVersion,
	type ReadableTask,
	readable,
	type SavedRun,
	savedRun,
	shownStatus,
} from "./cli/saved.ts";

export { runCli } from "./command.ts";

export { type Shown, showEntries, type TreeEntry } from "./records/tree.ts";

export type { RunStatus, RunTask } from "./run/past.ts";

export {
	cliArgs,
	GONE_EXIT,
	type Output,
	outcomeOf,
	summary,
	type WorkflowCall,
	type WorkflowOutcome,
} from "./tool.ts";

export { type ListedScript, scriptsOf, UsageError } from "./workflow/find.ts";
