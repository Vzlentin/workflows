// The globals of a workflow script, for editors. See "The script API" in docs/spec.md.
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
	/**
	 * Adds `--repo`, `--base` and `--branch`, and runs the script in a new worktree on `--branch` or `<wf>/<run-id>`. A
	 * result with a `subject` renames `<wf>/<run-id>` to the name of `subject`.
	 */
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

/** The directory of `sh` and `ok`: the run's worktree, the caller's directory, or the directory of the command. */
declare const cwd: string;

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

/**
 * Asks the user `question`. The first time, the run stops and waits: the command prints the question and exits with 3.
 * `workflows resume <run-id> --answer <text>` runs the script again, and this call returns the text.
 */
declare function input(question: string): Promise<string>;

/** A value that a call of a script gives to the host as JSON, which leaves out an object field that is undefined. */
type Json = null | boolean | number | string | Json[] | { [key: string]: Json | undefined };

/** Runs the script `name` of `workflows/` as a child run and returns its result, with `runId` when it is an object. */
declare function run(name: string, args?: { [key: string]: Json | undefined }): Promise<any>;

/** Runs the functions at once and returns their results. */
declare function parallel<const T extends readonly unknown[]>(thunks: { [K in keyof T]: () => T[K] }): Promise<{ -readonly [K in keyof T]: Awaited<T[K]> }>;

/**
 * Sends each item through the stages in order, and the items at once. Each stage gets the awaited value of the one
 * before. The types cover up to six stages.
 */
declare const pipeline: {
	<T>(items: readonly T[]): Promise<Awaited<T>[]>;
	<T, A>(items: readonly T[], a: (value: T) => A): Promise<Awaited<A>[]>;
	<T, A, B>(items: readonly T[], a: (value: T) => A, b: (value: Awaited<A>) => B): Promise<Awaited<B>[]>;
	<T, A, B, C>(items: readonly T[], a: (value: T) => A, b: (value: Awaited<A>) => B, c: (value: Awaited<B>) => C): Promise<Awaited<C>[]>;
	<T, A, B, C, D>(items: readonly T[], a: (value: T) => A, b: (value: Awaited<A>) => B, c: (value: Awaited<B>) => C, d: (value: Awaited<C>) => D): Promise<Awaited<D>[]>;
	<T, A, B, C, D, E>(items: readonly T[], a: (value: T) => A, b: (value: Awaited<A>) => B, c: (value: Awaited<B>) => C, d: (value: Awaited<C>) => D, e: (value: Awaited<D>) => E): Promise<Awaited<E>[]>;
	<T, A, B, C, D, E, F>(items: readonly T[], a: (value: T) => A, b: (value: Awaited<A>) => B, c: (value: Awaited<B>) => C, d: (value: Awaited<C>) => D, e: (value: Awaited<D>) => E, f: (value: Awaited<E>) => F): Promise<Awaited<F>[]>;
};

/** Starts the progress step `title` on stderr before the script's next call that runs. */
declare function phase(title: string): void;

/** Writes the line `text` under the current step on stderr before the script's next call that runs. */
declare function log(text: string): void;

/** Gives the run the title `text`, in place of the subject of its first text argument, in `list`, `show` and the end lines. */
declare function title(text: string): void;

// The lib: helpers that every script gets. See "The script lib" in docs/spec.md.

/** The subject of a text: its first non-empty line without leading `#`. */
declare function subjectOf(text: string): string;

/** A session whose first prompt starts with the notes of a memory. */
type RememberingSession = {
	ask(prompt: string | Promise<string>, options?: { schema?: object }): Promise<any>;
	/**
	 * Asks for `{ text, notes }` with the answer rule `text is <rule>`, adds the notes under the profile at `round`, and
	 * returns the text.
	 */
	noted(round: number | undefined, prompt: string | Promise<string>, rule: string): Promise<string>;
};

/** Where a run memory is, and the campaign item of its notes. A child run that gets it goes on with the same memory. */
type MemoryRef = {
	readonly path?: string;
	/** The store is the plain file `<path>/notes.txt`, as `memo` was missing when the store opened. */
	readonly plain?: boolean;
	readonly item?: number;
};

/**
 * The run memory of `ref`: an OptMem store, through the user's `$HOME/.optmem/memo`, or a plain store of `#<k> <note>`
 * lines with no summaries. Without `ref.path`, opens the store `<runDir>/memory`, plain when `memo` is missing. A note
 * is the line `[item <item> ]<author>[ r<round>]: <note>`, cut to 280 bytes.
 */
declare function memory(ref?: MemoryRef): Promise<{
	readonly ref: MemoryRef & { readonly path: string; readonly plain: boolean };
	/** Adds each note, and answers each compression that `memo` asks for with a `summarizer` turn. */
	note(author: string, round: number | undefined, notes: readonly string[]): Promise<void>;
	/** A session whose first prompt starts with a `## memory` section of the notes. */
	session(profile: string): RememberingSession;
	/** The notes, one `#<k> <note>` line each. */
	readonly text: Promise<string>;
}>;

/** Stages every change, and commits it as `message` when something is staged. */
declare function commitAll(message: string): Promise<void>;

/** `+12 -3 in 2 files` for the change from `from` to `to` (default `HEAD`), or `no new changes`. */
declare function diffStat(from: string, to?: string): Promise<string>;

/**
 * The change that `target` points at, from the current directory. `target` is nothing (the current branch from its merge
 * base with `base`, default `main`), a PR number (from the merge base with its base branch, fetched as `pull/<n>/head`
 * when its branch is missing), a range `A..B` or `A...B` (from the merge base of `A` and `B` to `B`), or a ref (from its
 * merge base with `HEAD` to `HEAD`). `start` is a commit, and `intent` is `item`, else `# <title>` and the body of the
 * PR, else the commit messages of the change. `checkout` is the branch of a change on a branch that no worktree has.
 * `dirty` says that the checkout has changes that are not committed; with `wip`, a change that ends here commits them
 * first as `wip`. Throws `no change from <base>` on an empty change, and when the branch of the change is checked out
 * in another worktree or the change does not end on a branch.
 */
declare function changeOf(
	target: string | undefined,
	options?: { base?: string; item?: string; wip?: boolean },
): Promise<{ start: string; intent: string; checkout?: string; dirty: boolean }>;

/**
 * Runs the script `name` again as a child run on the branch `change.checkout`, with `args` and the `item` and `start` of
 * the change, and returns its result with the last report line `worktree <path>`.
 */
declare function inCheckout(
	name: string,
	change: { start: string; intent: string; checkout?: string },
	args: { [key: string]: Json | undefined },
): Promise<any>;

/** Throws when the checkout has changes that are not committed. */
declare function assertClean(): Promise<void>;
