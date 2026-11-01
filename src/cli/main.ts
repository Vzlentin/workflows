/**
 * The `workflows` command line, a client of the harness host of a project. `workflows <workflow> ...` starts a run of a
 * workflow script in the host and follows it, `workflows resume <run-id>` continues or follows one, `workflows wait
 * <run-id>` follows one to its outcome, `workflows stop <run-id>` stops one, `workflows list` prints the runs of the
 * project, `workflows show <run-id>` prints the steps or the calls of one run, `workflows attach <run-id>` opens a
 * session of one run in Pi, and `workflows save <run-id> <name>` keeps the script of one run as a project workflow;
 * `workflows prune` removes the worktrees of the ended runs whose branch GitHub merged. The project store holds the runs; a run directory
 * holds the run's `project` file and whatever the workflow writes there.
 */
import { readFile } from "node:fs/promises";
import type { Models } from "@earendil-works/pi-ai/models";
import type { Client } from "@vzlentin/harness/client";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { USAGE } from "../launch/input.ts";
import { GONE_EXIT } from "../tool.ts";
import { help, type Io, listScripts, parseArgsMessage, UsageError } from "../workflow/find.ts";
import { ATTACH, attach } from "./commands/attach.ts";
import { CHECK, check } from "./commands/check.ts";
import { LIST, list } from "./commands/list.ts";
import { PRUNE, prune } from "./commands/prune.ts";
import { RESUME, resume, WAIT } from "./commands/resume.ts";
import { type CommandName, SAVE, save } from "./commands/save.ts";
import { SHOW, show } from "./commands/show.ts";
import { start } from "./commands/start.ts";
import { STOP, stop } from "./commands/stop.ts";
import { GoneRun } from "./saved.ts";
import type { PickItem } from "./terminal/pick.ts";

/** The part of the `package.json` of workflows that `--version` reads. */
const MANIFEST = Type.Object({ version: Type.String() });

/**
 * A question with `items` to pick one of, on a terminal: the value of the item, or undefined when cancelled. Only an
 * item with a value can be taken, and the cursor starts on the first one. While it waits for a key, it calls `refresh`
 * every second for new items, and keeps the cursor on the same item.
 */
export type Choose = <V>(
	question: string,
	items: readonly PickItem<V>[],
	refresh?: () => Promise<readonly PickItem<V>[]>,
) => Promise<V | undefined>;

export type Terminal = Io & {
	/** Aborted by the first Ctrl+C: the command detaches, and the run goes on in the host. */
	readonly interrupt: AbortSignal;
	/** Aborted by a second Ctrl+C while the command follows a run: the command stops the run. */
	readonly stop: AbortSignal;
	/** Tells whether the command follows a run, so that a second Ctrl+C stops the run rather than exits. */
	readonly following: (active: boolean) => void;
	/** How long a command that Ctrl+C detached waits for a second Ctrl+C. Default 2 s. */
	readonly stopWindowMs?: number;
	/** Writes an OSC 7501 program status report to the terminal, when stderr is one. */
	readonly status?: ((report: string) => void) | undefined;
	/**
	 * Reads one typed line, or gives undefined at Ctrl+C or at the end of input. Given only when stdin and stderr are
	 * terminals.
	 */
	readonly readLine?: (() => Promise<string | undefined>) | undefined;
	/** Asks which of `items` to take, and gives its value, or undefined when cancelled. Given only on a terminal. */
	readonly choose?: Choose | undefined;
	/** Pi's model registry, for `check`. */
	readonly models: () => Promise<Models>;
	/**
	 * Connects to the host of `project`. With `start`, it starts the host when none runs; without, it gives undefined
	 * then. Default: harness's client.
	 */
	readonly connect?: (project: string, start: boolean) => Promise<Client | undefined>;
};

export type Command = (
	args: readonly string[],
	terminal: Terminal,
	json: boolean,
	background: boolean,
) => Promise<number>;

/** The commands by name, one for each of `COMMAND_NAMES`. */
const COMMANDS = new Map<string, Command>(
	Object.entries({
		list,
		resume,
		wait: (args, terminal, json) => resume(args, terminal, json, false, true),
		stop,
		show,
		attach,
		save,
		prune,
		check,
	} satisfies Record<CommandName, Command>),
);

/**
 * The exit code: 0 for a successful result, 1 for any other result or error, 2 for bad usage, 3 for a run that waits
 * for an answer, 130 after Ctrl+C.
 */
export async function main(argv: readonly string[], terminal: Terminal): Promise<number> {
	const usage = [
		`${USAGE} [--background] [--json]`,
		"workflows <workflow> --help",
		RESUME,
		WAIT,
		STOP,
		LIST,
		SHOW,
		ATTACH,
		SAVE,
		PRUNE,
		CHECK,
		"workflows --version",
		"workflows",
	]
		.map((line, index) => `${index === 0 ? "usage: " : "       "}${line}`)
		.join("\n");

	try {
		const dashes = argv.indexOf("--");
		const options = dashes === -1 ? argv.length : dashes;
		const json = argv.slice(0, options).includes("--json");
		const background = argv.slice(0, options).includes("--background");

		const [command, ...args] = argv.filter(
			(arg, index) => index >= options || (arg !== "--json" && arg !== "--background"),
		);

		if (command === undefined) {
			for (const line of await listScripts(terminal)) terminal.stdout(line);

			return 0;
		}

		if (command === "--version") {
			const manifest = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8"));
			terminal.stdout(Value.Parse(MANIFEST, manifest).version);

			return 0;
		}

		const run = COMMANDS.get(command);

		if (run !== undefined) return await run(args, terminal, json, background);
		const flags = args.indexOf("--");

		if (args.slice(0, flags === -1 ? args.length : flags).includes("--help")) {
			for (const line of await help(command, terminal)) terminal.stdout(line);

			return 0;
		}

		return await start([command, ...args], terminal, json, background);
	} catch (error) {
		terminal.stderr(`workflows: ${error instanceof Error ? error.message : String(error)}`);

		if (error instanceof UsageError || parseArgsMessage(error) !== undefined) {
			terminal.stderr(error instanceof UsageError && error.usage !== undefined ? `usage: ${error.usage}` : usage);

			return 2;
		}

		return error instanceof GoneRun ? GONE_EXIT : 1;
	}
}
