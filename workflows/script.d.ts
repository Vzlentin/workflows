// The script API: the globals of a workflow script, for editors and for the agent that writes a script. See "The script
// API" in docs/spec.md of the workflows repository.
// A script is the body of an async function, so top-level `await` and `return` work. A call that runs something,
// also a lib helper, returns a promise, so write `await` before it, as in `JSON.parse(await sh(cmd))`. `session`,
// `phase`, `log` and `title` need no `await`.
// A script has no file system, network, modules or timers, so its effects go through `sh` and `ok`. The sandbox
// replaces Date and Math: `Date`, `Date.now()` and `Math.random()` throw, also through `globalThis`, so that a script
// makes the same calls each time it runs. The other `Math` functions work. Code that gets the real global object
// through `Function`, an indirect `eval` or the `constructor` of a function gets the real `Date` and `Math.random`.
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
	/**
	 * The exit code of each `result.status`, from 0 to 255, except 2, 3, 4 and 130, which the command gives itself (usage,
	 * waiting, a run that the command can never follow, Ctrl+C or aborted). Any other status exits 1, and a result without a status exits 0. Only an open
	 * `input()` call makes a run wait: a result with the status `waiting` and no open `input()` call fails the run.
	 */
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
declare const args: Readonly<Record<string, Json>>;

/** The run ID. A script that `run()` starts gets its own value. */
declare const runId: string;

/** The run directory. A script that `run()` starts gets its own value. */
declare const runDir: string;

/**
 * The directory of `sh` and `ok`: the run's worktree, the repository of `--repo`, the caller's directory, or the
 * directory of the command.
 */
declare const cwd: string;

/**
 * The `workflows` command of this package as one shell-quoted string, run with the Node of the host, and not a
 * `workflows` from `PATH`. A script appends the arguments: ``sh(`${workflowsCommand} --version`)``.
 */
declare const workflowsCommand: string;

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

/**
 * The options of a turn. With `schema`, the answer is checked against that JSON Schema. With `settle: true`, a failed
 * turn returns `{ error }` with its message in place of a throw, and a resume returns the same `{ error }`.
 */
type AskOptions = { schema?: object; settle?: true };

/**
 * One turn in a new session. Returns the reply text, or with `schema` the answer checked against that JSON Schema. The
 * prompt is the key of the session, so `agent` calls with different prompts keep their sessions in `parallel` and
 * `pipeline` branches.
 */
declare function agent(prompt: string | Promise<string>, options?: SessionOptions & AskOptions): Promise<any>;

/**
 * A new session of a role name or of `options` (default `default`). Returns at once, and the session keeps its history:
 * `.ask(prompt, { schema })` is one turn in it. `key` tells apart the sessions of the same options: in `parallel` and
 * `pipeline` branches, give each session a different `key`, else a resume can give a branch the session of another.
 */
declare function session(
	options?: string | (SessionOptions & { key?: string }),
): { ask(prompt: string | Promise<string>, options?: AskOptions): Promise<any> };

/**
 * Runs `sh -c <cmd>` in the current directory of the start. Returns stdout without the last newline, and throws on a
 * nonzero exit code. With an array `[program, ...arguments]`, runs the program with no shell. With `settle: true`, a
 * failure returns `{ error }` with its message in place of a throw, and a resume returns the same `{ error }`.
 */
declare function sh(cmd: string | readonly string[], options: { settle: true }): Promise<string | { error: string }>;
declare function sh(cmd: string | readonly string[], options?: { settle?: false }): Promise<string>;

/** Runs `cmd` as `sh` does. Returns true when the exit code is 0. */
declare function ok(cmd: string | readonly string[]): Promise<boolean>;

/**
 * Asks the user `question`, as an ask of the project with the run as its asker. The first time, the run stops and
 * waits: the command prints the question and exits with 3, and the `workflow` tool gives a `waiting` result with the
 * question. `workflows resume <run-id> --answer <text>`, the tool with `resume: <run-id>` and `answer`, or a resume
 * after an answer of the ask elsewhere, runs the script again, and this call returns the answer. The question must not
 * be blank. Only a root run can ask: in a child run, the call fails. A dropped ask fails the call. Only an open
 * `input()` call makes a run wait: a script result with the status `waiting` and no open `input()` call fails the run.
 */
declare function input(question: string): Promise<string>;

/** A value that a call of a script gives to the host as JSON, which leaves out an object field that is undefined. */
type Json = null | boolean | number | string | Json[] | { [key: string]: Json | undefined };

/**
 * The result object that a script returns. The engine reads these fields, and the script can add others. A script can
 * also return a JSON value that is not an object: a string prints as it is, and any other value prints as JSON. A
 * result with a bad field fails the run with `the script result has a bad field: <path> <problem>`.
 */
type Result = {
	/** The status, whose exit code `meta.exit` gives. */
	status?: string;
	/** The lines that the run prints at its end. */
	report?: string[];
	/** The subject of the change, which names the branch of a run with `worktree`. */
	subject?: string;
	/** The judge score. */
	score?: number;
	/** The engine writes it: the run ID of a child run, in the result of `run()`. */
	runId?: string;
	/**
	 * The change of the run: the main checkout of its repository and the branch that the change is on. A script can
	 * set it. For a run with a worktree of its own, the engine writes it, except in a waiting result: the branch that
	 * the worktree ends on.
	 */
	change?: Change;
	/** The engine writes it: the question of an open `input()` call. */
	question?: string;
	[key: string]: Json | undefined;
};

/** A change: the main checkout of its repository and its branch. */
type Change = { repository: string; branch: string };

/** What a script returns, and what `run()` gives: a result object, or a JSON value that is not an object. */
type ScriptResult = Result | null | boolean | number | string | Json[];

/**
 * Runs the script `name` of `workflows/` as a child run and returns its result, with `runId` when it is an object. The
 * args that its `meta.args` declares are checked before the child starts. The reserved arg `from: <run-id>` gives the
 * child the prompts and agents table of that saved run.
 */
declare function run(name: string, args?: { [key: string]: Json | undefined }): Promise<ScriptResult>;

/** A completed root run of the project store, as `pastRuns` gives it. */
type PastRun = {
	readonly runId: string;
	/** The `item` arg of the run, or null. */
	readonly item: string | null;
	/** The directory that the run ran in: the top level of the repository of `--repo`, else the caller's directory. */
	readonly cwd: string;
	/** The repository and the start commit of the run's worktree, or null. */
	readonly repository: string | null;
	readonly start: string | null;
	/** The saved template texts, by prompt name. */
	readonly prompts: { readonly [name: string]: string };
	/** What the run serves, the item or the parley that its start named, or null. */
	readonly serves: { readonly item: number } | { readonly parley: string } | null;
	/** The result of the run. */
	readonly result: ScriptResult;
};

/**
 * The completed root runs of the workflow `workflow`, or of every workflow for null, in the project store, newest
 * first: up to `limit`, or the runs `runs` in that order. A run of `runs` that is not a completed root run of
 * `workflow` throws.
 */
declare function pastRuns(workflow: string | null, options?: { runs?: readonly string[]; limit?: number }): Promise<PastRun[]>;

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

/** A reference of an edge end: `item:<id>`, `run:<runId>`, `agent:<conversation>`, `parley:<slug>` or `commit:<sha>`. */
type Ref = string;

/** A link between two things, one of them an item, with the time and the caller of its write. */
type Edge = {
	readonly from: Ref;
	readonly kind: "serves" | "shapes" | "landed";
	readonly to: Ref;
	readonly at: number;
	readonly by: string;
};

/** A work item of the project, as the host gives it, with its edges in the order of their writes. */
type Item = {
	readonly id: number;
	readonly title: string;
	readonly text?: string;
	readonly state: "open" | "done" | "dropped";
	readonly edges: readonly Edge[];
	readonly stage: "inbox" | "shaping" | "ready" | "building" | "done" | "dropped";
	readonly needsYou: boolean;
	readonly at: number;
	readonly by: string;
};

/** A node of the tree of the project: an agent with its state and what it serves, or a run. */
type TreeNode = {
	readonly id: string;
	readonly parent?: string;
	readonly name: string;
} & (
	| {
			readonly kind: "agent";
			readonly state: "busy" | "idle" | "error" | "ended";
			readonly serves?:
				| { readonly kind: "spawner" }
				| { readonly kind: "parley"; readonly slug: string }
				| { readonly kind: "contract"; readonly slug: string }
				| { readonly kind: "item"; readonly id: number }
				| { readonly kind: "project" };
	  }
	| { readonly kind: "run"; readonly state: "pending" | "running" | "completed" | "failed" | "aborted" }
);

/**
 * Sends one request to the harness host of the run's project, and returns its reply: the item of `read` and `set`, the
 * edge of `link`, or the nodes of `tree`. The run is the caller of a `link` and a `set`. The call saves its reply, so a
 * resume does not send it again. An error of the host throws.
 */
declare function harness(request: { type: "item"; action: "read"; id: number }): Promise<Item>;
declare function harness(request: { type: "item"; action: "set"; id: number; state: Item["state"] }): Promise<Item>;
declare function harness(request: { type: "item"; action: "link"; from: Ref; kind: Edge["kind"]; to: Ref }): Promise<Edge>;
declare function harness(request: { type: "tree" }): Promise<{ readonly nodes: readonly TreeNode[] }>;

/**
 * Runs the functions at once and returns their results. A resume can start their calls in another order: give each
 * `session` of a function a different `key`.
 */
declare function parallel<const T extends readonly unknown[]>(thunks: { [K in keyof T]: () => T[K] }): Promise<{ -readonly [K in keyof T]: Awaited<T[K]> }>;

/**
 * Sends each item through the stages in order, and the items at once. Each stage gets the awaited value of the one
 * before. The types cover up to six stages. A resume can start the calls of the items in another order: give each
 * `session` of a stage a different `key`.
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
	ask(prompt: string | Promise<string>, options?: AskOptions): Promise<any>;
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

/**
 * Stages every change, and commits it as `message` when something is staged. The check and the commit are one command,
 * so a repeat makes no second commit. The shell runs the commit with `exec`, so a stop of the run also stops the commit.
 */
declare function commitAll(message: string): Promise<void>;

/**
 * Squashes the commits since `start` into one commit with `message`, logs `commit <short> <subject>` and returns the
 * short head. When nothing changed since `start`, it makes no commit, logs `nothing to commit since <short>` and returns
 * the short head. Safe to repeat: it is one command, so a repeat resets a squash commit that was made but not saved. The
 * shell runs the commit in the background and kills it on `TERM`, so a stop of the run also stops the commit.
 */
declare function squash(start: string, message: string, subject: string): Promise<string>;

/**
 * Writes the commit message of the change from `start` to `HEAD` in one turn of an `implementer` session, with the
 * judge's `findings` lines when there are some, and squashes the change into one commit with it. Returns the short head,
 * the commit subject, and `warnings`, the lines that it logged for a script's report. When the turn fails or gives an
 * empty subject, the message is the subject of `item`. A failed turn logs `commit message failed on <subject>: <error>,
 * so the message is the subject of the item`, and that line is the one warning; else `warnings` is empty.
 */
declare function commitChange(
	item: string,
	start: string,
	findings?: readonly string[],
): Promise<{ head: string; subject: string; warnings: string[] }>;

/** The judge fields of `judgeCommit`: the status of the judge and its score. A failed judge fails the caller. */
type JudgeFields = {
	status: "judged" | "rejected";
	score: number;
	answers: ("PASS" | "FAIL")[];
	findings: string[];
	divergence: string;
};

/**
 * The child run `judge` on the squashed commit from `start`. Returns `head` and `subject` of `committed` with the judge
 * fields.
 */
declare function judgeCommit(
	item: string,
	start: string,
	committed: { head: string; subject: string },
): Promise<{ head: string; subject: string } & JudgeFields>;

/** Writes the binary diff from `from` to `HEAD` to the file `path`, and returns `path`. */
declare function writePatch(path: string, from: string): Promise<string>;

/**
 * The worktrees of the repository of `dir`, default the directory of `sh`, from `git worktree list --porcelain`, the
 * main checkout first. `branch` is the full ref (`refs/heads/<name>`), or undefined when the worktree is detached or
 * bare. `prunable` says that the directory of the worktree is gone.
 */
declare function worktrees(dir?: string): Promise<{ path: string; branch: string | undefined; bare: boolean; prunable: boolean }[]>;

/**
 * The PR of `ref` with the JSON `fields`, from `gh pr view` in the directory of `sh`. Throws when `gh` fails, or with
 * `options.settle` returns `{ error }`, as `sh` does.
 */
declare function prOf(ref: string, fields: string, options?: { settle?: boolean }): Promise<any>;

/** The local branch of the PR `pr`: `pr/<number>` for a PR from another repository, else its head branch. */
declare function prBranch(pr: { number: number; headRefName: string; isCrossRepository: boolean }): string;

/** True when `name` is a local branch of the repository of `dir`, default the directory of `sh`. */
declare function isBranch(name: string, dir?: string): Promise<boolean>;

/**
 * The change of the current checkout: the main checkout of its repository, and its branch. Undefined on a detached
 * HEAD, whose branch is unknown.
 */
declare function checkoutChange(): Promise<Change | undefined>;

/**
 * The change of a script's `args`. With `args.start`, a caller gives the change: `start`, and `args.item` as the
 * intent, with no Git step. Else the change is the one that `args.change` points at, from the current directory, and
 * the run gets the subject of its intent as its title. `args.change` is nothing (the current branch from its merge base
 * with `args.base`, default `main`), a PR number (from the merge base with its base branch, fetched as
 * `pull/<n>/head`, with its branch moved to that head when the branch is missing or behind), a range `A..B` or `A...B` (from the merge base of `A` and `B` to `B`),
 * a local branch that another worktree has checked out, other than the current one and `args.base` (from its merge
 * base with `args.base` to the branch), or a ref (from its merge base with `HEAD` to `HEAD`). `start` is a commit, and
 * `intent` is `args.item`, else `# <title>` and the body of the PR, else the commit messages of the change. `checkout`
 * is the branch of a change that ends on a branch other than the current one. `dirty` says that the current checkout
 * has changes that are not committed; with `wip`, a change that ends here commits them first as `wip`. Throws
 * `no change from <base>` on an empty change, when the change does not end on a branch, and, with `wip`, when
 * another worktree has the branch with changes that are not committed.
 */
declare function changeOf(
	args: { [key: string]: Json | undefined },
	options?: { wip?: boolean },
): Promise<{ start: string; intent: string; checkout?: string; dirty: boolean }>;

/**
 * Runs the script `name` again as a child run on the branch `change.checkout`, with `args` and the `item` and `start` of
 * the change: in the worktree that has the branch checked out, else in a worktree of its own on it. Returns its result
 * with the last report line `worktree <path>`.
 */
declare function inCheckout(
	name: string,
	change: { start: string; intent: string; checkout?: string },
	args: { [key: string]: Json | undefined },
): Promise<any>;
