/** `workflows save <run-id> <name>`: keeps the script of a run as a project workflow. */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { taskOf } from "../../run/past.ts";
import { loadScripts, projectFolder } from "../../workflow/bundle.ts";
import { UsageError, withUsage } from "../../workflow/find.ts";
import type { Terminal } from "../main.ts";
import { checked, savedRun, tasksOf } from "../saved.ts";

export const SAVE = "workflows save <run-id> <name> [--force]";

/** The names of the commands. No script can have one of these names. */
export const COMMAND_NAMES = ["list", "resume", "wait", "stop", "show", "attach", "save", "prune", "check"] as const;

export type CommandName = (typeof COMMAND_NAMES)[number];

/** Writes the script of a saved run to `workflows/<name>.js` of the project folder, and prints the file's path. */
export async function save(args: readonly string[], terminal: Terminal): Promise<number> {
	const { values, positionals } = withUsage(
		() => parseArgs({ args: [...args], options: { force: { type: "boolean" } }, allowPositionals: true, strict: true }),
		SAVE,
	);

	const [id, name, ...rest] = positionals;

	if (id === undefined || name === undefined || rest.length > 0) {
		throw new UsageError("give one run ID and one name", SAVE);
	}

	if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
		throw new UsageError(`${name} is not a workflow name: use lowercase letters, digits and -`, SAVE);
	}

	if (COMMAND_NAMES.some((command) => command === name))
		throw new Error(`${name} is a command and cannot be a workflow name`);
	const run = await savedRun(id, SAVE);
	const { input } = checked(taskOf(await tasksOf(run)), id, "be saved");
	const project = await projectFolder(terminal.cwd);

	if (!values.force && Object.hasOwn(await loadScripts(project), name)) {
		throw new Error(`a workflow ${name} exists; replace it with --force`);
	}

	const folder = join(project, "scripts");
	const file = join(folder, `${name}.js`);
	await mkdir(folder, { recursive: true });
	await writeFile(file, input.bundle.main);
	terminal.stdout(file);

	return 0;
}
