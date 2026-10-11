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

/** One turn in a new session of profile `as` (default `default`). Returns the reply text, or the answer with `schema`. */
declare function agent(prompt: string, options?: { as?: string; schema?: object }): Promise<any>;

/** A new session of `profile` (default `default`). `.ask(prompt, { schema })` is one turn in it. */
declare function session(profile?: string): { ask(prompt: string, options?: { schema?: object }): Promise<any> };

/**
 * Runs `sh -c <cmd>` in the current directory of the start. Returns stdout without the last newline, and throws on a
 * nonzero exit code. With an array `[program, ...arguments]`, runs the program with no shell.
 */
declare function sh(cmd: string | string[]): Promise<string>;

/** Runs `cmd` as `sh` does. Returns true when the exit code is 0. */
declare function ok(cmd: string | string[]): Promise<boolean>;

/** Runs the script `name` of `workflows/` as a child run and returns its result, with `runId` when it is an object. */
declare function run(name: string, args?: Record<string, unknown>): Promise<any>;

/** Runs the functions at once and returns their results. */
declare function parallel<T>(thunks: Array<() => T | Promise<T>>): Promise<T[]>;

/** Sends each item through the stages in order, and the items at once. */
declare function pipeline(items: unknown[], ...stages: Array<(value: any) => unknown>): Promise<any[]>;

/** Writes the phase line `title` on stderr before the script's next call that runs. */
declare function phase(title: string): void;

/** Writes the line `text` on stderr before the script's next call that runs. */
declare function log(text: string): void;
