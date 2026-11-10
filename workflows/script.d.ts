// The script API: the globals of a workflow script, for editors and for the agent that writes a script. See "The script
// API" in docs/spec.md of the workflows repository.
// A script is the body of an async function, so top-level `await` and `return` work. A call that runs something,
// also a lib helper, returns a promise, so write `await` before it, as in `JSON.parse(await sh(cmd))`. `session`,
// `phase`, `log` and `title` need no `await`.
// A script has no file system, network, modules or timers, so its effects go through `sh` and `ok`. The sandbox
// replaces Date and Math: `Date`, `Date.now()` and `Math.random()` throw, so that a script makes the same calls each
// time it runs.
// A resume runs the script again from the top: a saved call returns its result, and a command that did not finish runs
// again, so keep `sh` and `ok` commands safe to repeat.
// To keep a script as a named workflow of the project, call the `workflow` tool with `save: { runId, name }` after its
// run. `force: true` replaces a workflow of that name.

/**
 * The command line and the outline of a script, as `export const meta = { ... }`: optional, at the top of the script,
 * after its leading comments. A script uses it with the JSDoc tag `@type {Meta}`.
 */
type Meta = {
	/** One line for `workflows` and `--help`. */
	description?: string;
	/** The arguments, by name. The tool's `args`, or the `--<name>` flags, fill `args.<name>`. */
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
	/**
	 * Adds `--repo`, the top level of a local Git repository, and runs the script in that checkout. `run(name, { repo })`
	 * does the same for a child run. A script with `worktree` cannot have it.
	 */
	repo?: boolean;
	/** The exit code of each `result.status`. Any other status exits 1, and a result without a status exits 0. */
	exit?: Record<string, number>;
	/** The steps that a user sees in the progress of the script, in order, for the map of the script before a run. */
	outline?: OutlineStep[];
};

/**
 * One step of `meta.outline`: a turn of the role `role`, a child run of the workflow `workflow`, or steps that repeat.
 * `role`, `workflow` and `label` are non-empty strings with no line break, and a step has no other field.
 */
type OutlineStep =
	| { kind: "agent"; role: string; label: string }
	| { kind: "run"; workflow: string; label: string }
	| { kind: "loop"; label: string; steps: [OutlineStep, ...OutlineStep[]] };

/**
 * The argument values of `meta.args`, and `start` with `worktree: true`. The tool's `args`, or the `--<name>` flags,
 * fill `args.<name>`.
 */
declare const args: any;

/** The run ID. A script that `run()` starts gets its own value. */
declare const runId: string;

/** The run directory. A script that `run()` starts gets its own value. */
declare const runDir: string;

/**
 * The directory of `sh` and `ok`: the run's worktree, the repository of `--repo`, the caller's directory, or the
 * directory of the command.
 */
declare const cwd: string;

/** `prompts.<name>(inputs)`: the instructions of `prompts/<name>.md`, then each non-empty input as a `## <name>` section. */
declare const prompts: Record<string, (inputs?: Record<string, string>) => Promise<string>>;

/**
 * The model of a session. `as` is the role name, any name (default `default`). The run's `agents` arg (`--agents`),
 * then the `agents.json` tables, `<repo>/.workflows/agents.json` first, then `$XDG_CONFIG_HOME/workflows/agents.json`
 * (default `~/.config/workflows/agents.json`), then `workflows/agents.json` of the package, give the model and thinking
 * of each name or of `"*"`. `provider`, `model` and `thinking` override them all. A field that none gives comes from
 * the project agent: the Pi default model and thinking level.
 */
type SessionOptions = { as?: string; provider?: string; model?: string; thinking?: string };

/** One turn in a new session. Returns the reply text, or with `schema` the answer checked against that JSON Schema. */
declare function agent(prompt: string | Promise<string>, options?: SessionOptions & { schema?: object }): Promise<any>;

/**
 * A new session of a role name or of `options` (default `default`). Returns at once, and the session keeps its history:
 * `.ask(prompt, { schema })` is one turn in it.
 */
declare function session(
	options?: string | SessionOptions,
): { ask(prompt: string | Promise<string>, options?: { schema?: object }): Promise<any> };

/**
 * Runs `sh -c <cmd>` in the current directory of the start. Returns stdout without the last newline, and throws on a
 * nonzero exit code. With an array `[program, ...arguments]`, runs the program with no shell.
 */
declare function sh(cmd: string | readonly string[]): Promise<string>;

/** Runs `cmd` as `sh` does. Returns true when the exit code is 0. */
declare function ok(cmd: string | readonly string[]): Promise<boolean>;

/**
 * Asks the user `question`. The first time, the run stops and waits: the command prints the question and exits with 3,
 * and the `workflow` tool gives a `waiting` result with the question. `workflows resume <run-id> --answer <text>`, or
 * the tool with `resume: <run-id>` and `answer`, runs the script again, and this call returns the answer.
 */
declare function input(question: string): Promise<string>;

/** A value that a call of a script gives to the host as JSON, which leaves out an object field that is undefined. */
type Json = null | boolean | number | string | Json[] | { [key: string]: Json | undefined };

/**
 * Runs the script `name` of `workflows/` as a child run and returns its result, with `runId` when it is an object. The
 * args that its `meta.args` declares are checked before the child starts. The reserved arg `from: <run-id>` gives the
 * child the prompts and agents table of that saved run.
 */
declare function run(name: string, args?: { [key: string]: Json | undefined }): Promise<any>;

/** A completed root run of the project store, as `pastRuns` gives it. */
type PastRun = {
	readonly runId: string;
	/** The `item` arg of the run, or null. */
	readonly item: string | null;
	/** The repository and the start commit of the run's worktree, or null. */
	readonly repository: string | null;
	readonly start: string | null;
	/** The saved template texts, by prompt name. */
	readonly prompts: { readonly [name: string]: string };
	/** The result of the run. */
	readonly result: any;
};

/**
 * The completed root runs of the workflow `workflow` in the project store, newest first: up to `limit`, or the runs
 * `runs` in that order. A run of `runs` that is not a completed root run of `workflow` throws.
 */
declare function pastRuns(workflow: string, options?: { runs?: readonly string[]; limit?: number }): Promise<PastRun[]>;

/** A todo of the list of the run: a line of intent with a state. Its ID is its place in the list: 1, 2, 3 and so on. */
type Todo = { readonly id: number; readonly text: string; readonly state: "open" | "doing" | "done" | "dropped" };

/**
 * The list of todos of the run, which every task of the run uses. A child run has its own list. Each verb is a call
 * that saves its result, so a resume does not add a todo twice. An empty text and an unknown ID throw.
 */
declare const todo: {
	/** Adds a todo with the state `open` and the next ID, and returns it. */
	add(text: string): Promise<Todo>;
	/** Sets the state of the todo `id`, and its text when `text` is given, and returns the todo. */
	set(id: number, state: Todo["state"], text?: string): Promise<Todo>;
	/** The todos of the list, in ID order. */
	list(): Promise<Todo[]>;
};

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

// The lib: helpers that every script gets. See "The script lib" in docs/spec.md of the workflows repository.

/** The subject of a text: its first non-empty line without leading `#`. */
declare function subjectOf(text: string): string;

/** The text on one line: each whitespace run made one space, trimmed. */
declare function oneLine(text: string): string;

/** A session whose first prompt starts with the notes of a memory. */
type RememberingSession = {
	ask(prompt: string | Promise<string>, options?: { schema?: object }): Promise<any>;
	/**
	 * Asks for `{ text, notes }` with the answer rule `text is <rule>`, adds the notes under the role name at `round`, and
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

/** A lesson of a run: when it applies, what to do instead of what, and the run and notes that it rests on. */
type Lesson = { cue: string; lesson: string; evidence: string };

/**
 * The run memory of `ref`: an OptMem store, through the user's `$HOME/.optmem/memo`, or a plain store of `#<k> <note>`
 * lines with no summaries. Without `ref.path`, opens the store `<runDir>/memory`, plain when `memo` is missing. A note
 * is the line `[item <item> ]<author>[ r<round>]: <note>`, cut to 280 bytes.
 */
declare function memory(ref?: MemoryRef): Promise<{
	readonly ref: MemoryRef & { readonly path: string; readonly plain: boolean };
	/**
	 * `result` as it is when `ref.path` was given. Else `result` with `lessons` and a report line
	 * `  lesson <cue>: <lesson> (<evidence>)` for each one. The lessons are `[]` with no turn when there are no notes,
	 * else 0 to 3 lessons of one `summarizer` turn on the `harvest` prompt with `item`, `result` without its `report` and
	 * `memory` keys at any depth, the run ID and the notes, with the whitespace runs of each field made one space.
	 */
	finish<T extends { report: string[]; memory?: Json }>(item: string, result: T): Promise<T & { lessons?: Lesson[] }>;
	/** Adds each note, and answers each compression that `memo` asks for with a `summarizer` turn. */
	note(author: string, round: number | undefined, notes: readonly string[]): Promise<void>;
	/** A session whose first prompt starts with a `## memory` section of the notes. */
	session(name: string): RememberingSession;
	/** The notes, one `#<k> <note>` line each. */
	readonly text: Promise<string>;
}>;

/** The notes of the run memory `notes`, one `#<k> <note>` line each, without empty lines. */
declare function noteLines(notes: { readonly text: Promise<string> }): Promise<string[]>;

/** Stages every change, and commits it as `message` when something is staged. */
declare function commitAll(message: string): Promise<void>;

/**
 * Squashes the commits since `start` into one commit with `message`, logs `commit <short> <subject>` and returns the
 * short head. When nothing changed since `start`, it makes no commit, logs `nothing to commit since <short>` and returns
 * the short head. Safe to repeat: it is one command, so a repeat resets a squash commit that was made but not saved.
 */
declare function squash(start: string, message: string, subject: string): Promise<string>;

/**
 * Writes the commit message of the change from `start` to `HEAD` in one turn of an `implementer` session, with the
 * judge's `findings` lines when there are some, and squashes the change into one commit with it. Returns the short head
 * and the commit subject. When the turn fails or gives an empty subject, the message is the subject of `item`.
 */
declare function commitChange(
	item: string,
	start: string,
	findings?: readonly string[],
): Promise<{ head: string; subject: string }>;

/** The judge fields of `judgeCommit`: a score, or the error of the judge. */
type JudgeFields =
	| {
			score: number;
			answers: ("PASS" | "FAIL")[];
			findings: string[];
			divergence: string;
			judgeError?: undefined;
	  }
	| {
			judgeError: string;
			score?: undefined;
			answers?: undefined;
			findings?: undefined;
			divergence?: undefined;
	  };

/** The child run `judge` on the squashed commit from `start`. Returns `committed` with the judge fields. */
declare function judgeCommit<T extends { head: string; subject: string }>(
	item: string,
	start: string,
	committed: T,
): Promise<Omit<T, keyof JudgeFields> & JudgeFields>;

/** `commitChange`, then `judgeCommit`. */
declare function commitAndJudge(item: string, start: string): Promise<{ head: string; subject: string } & JudgeFields>;

/** Writes the binary diff from `from` to `HEAD` to the file `path`, and returns `path`. */
declare function writePatch(path: string, from: string): Promise<string>;

/** `+12 -3 in 2 files` for the change from `from` to `to` (default `HEAD`), or `no new changes`. */
declare function diffStat(from: string, to?: string): Promise<string>;

/**
 * The change of a script's `args`. With `args.start`, a caller gives the change: `start`, and `args.item` as the
 * intent, with no Git step. Else the change is the one that `args.change` points at, from the current directory, and
 * the run gets the subject of its intent as its title. `args.change` is nothing (the current branch from its merge base
 * with `args.base`, default `main`), a PR number (from the merge base with its base branch, fetched as
 * `pull/<n>/head`, with its branch moved to that head when the branch is missing or behind), a range `A..B` or `A...B` (from the merge base of `A` and `B` to `B`),
 * or a ref (from its merge base with `HEAD` to `HEAD`). `start` is a commit, and `intent` is `args.item`, else
 * `# <title>` and the body of the PR, else the commit messages of the change. `checkout` is the branch of a change on
 * a branch that no worktree has. `dirty` says that the checkout has changes that are not committed; with `wip`, a
 * change that ends here commits them first as `wip`. Throws `no change from <base>` on an empty change, and when the
 * branch of the change is checked out in another worktree or the change does not end on a branch.
 */
declare function changeOf(
	args: { [key: string]: Json | undefined },
	options?: { wip?: boolean },
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
