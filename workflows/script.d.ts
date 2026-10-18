// The globals of a workflow script, for editors. See "The script API" in README.md.
// The sandbox replaces Date and Math: `Date`, `Date.now()` and `Math.random()` throw, so that a script makes the
// same calls each time it runs.

/** The command line of a script, as `export const meta = { ... }`. A script uses it with the JSDoc tag `@type {Meta}`. */
type Meta = {
	/** One line for `workflows` and `--help`. */
	description?: string;
	/** The arguments, by name. */
	args?: Record<
		string,
		{
			type: "string" | "number" | "boolean" | "text";
			default?: string | number | boolean;
			required?: boolean;
			positional?: boolean;
			label?: string;
		}
	>;
	/** Adds `--repo` and `--base`, and runs the script in a new worktree. */
	worktree?: boolean;
	/** The exit code of each `result.status`. Any other status exits 0. */
	exit?: Record<string, number>;
};

/** The argument values of `meta.args`, and `start` with `worktree: true`. */
declare const args: any;

/** The run ID. A script that `run()` starts gets its own value. */
declare const runId: string;

/** The run directory. A script that `run()` starts gets its own value. */
declare const runDir: string;

/** `prompts.<name>(inputs)`: the instructions of `prompts/<name>.md`, then each non-empty input as a `## <name>` section. */
declare const prompts: Record<string, (inputs?: Record<string, string>) => string>;

/**
 * The model of a session. `as` names the agent profile `agents/<as>.md` (default `default`). `provider`, `model` and
 * `thinking` override the profile, and a field that neither gives comes from the project agent.
 */
type SessionOptions = { as?: string; provider?: string; model?: string; thinking?: string };

/** One turn in a new session. Returns the reply text, or the answer with `schema`. */
declare function agent(prompt: string, options?: SessionOptions & { schema?: object }): Promise<any>;

/** A new session of a profile name or of `options` (default `default`). `.ask(prompt, { schema })` is one turn in it. */
declare function session(
	options?: string | SessionOptions,
): { ask(prompt: string, options?: { schema?: object }): Promise<any> };

/**
 * Runs `sh -c <cmd>` in the current directory of the start. Returns stdout without the last newline, and throws on a
 * nonzero exit code. With an array `[program, ...arguments]`, runs the program with no shell.
 */
declare function sh(cmd: string | readonly string[]): Promise<string>;

/** Runs `cmd` as `sh` does. Returns true when the exit code is 0. */
declare function ok(cmd: string | readonly string[]): Promise<boolean>;

/** Runs the script `name` of `workflows/` as a child run and returns its result, with `runId` when it is an object. */
declare function run(name: string, args?: Record<string, unknown>): Promise<any>;

/** Runs the functions at once and returns their results. */
declare function parallel<const T extends readonly (() => unknown)[]>(thunks: T): Promise<{ -readonly [K in keyof T]: Awaited<ReturnType<T[K]>> }>;

/** Sends each item through the stages in order, and the items at once. */
declare function pipeline(items: readonly unknown[], ...stages: Array<(value: any) => unknown>): Promise<any[]>;

/** Starts the progress step `title` on stderr before the script's next call that runs. */
declare function phase(title: string): void;

/** Writes the line `text` under the current step on stderr before the script's next call that runs. */
declare function log(text: string): void;
