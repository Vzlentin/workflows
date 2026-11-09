/**
 * The `meta` of a workflow script. `export const meta = { ... }` at the top of the script declares its arguments,
 * whether it runs in a new worktree or in the repository of `--repo`, and the exit code of each result status. The meta
 * reader evaluates only that literal, in the sandbox, and never runs the script.
 */
import { InlineCodemodeSandbox, loadQuickJSWasm } from "@earendil-works/pi-codemode";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { META } from "./bundle.ts";

const ARG_TYPE = Type.Union([
	Type.Literal("string"),
	Type.Literal("number"),
	Type.Literal("boolean"),
	Type.Literal("text"),
]);

/** One argument of `meta.args`. `number` is a positive integer. `label` names the argument in error messages. */
export type ArgSpec = {
	readonly type: Static<typeof ARG_TYPE>;
	readonly default?: string | number | boolean;
	readonly required?: boolean;
	readonly positional?: boolean;
	readonly label?: string;
};

/**
 * Where a run of a script runs. `here`: in the directory of the command or of the caller. `repo` (`repo: true`): the
 * run gets `--repo`, the top level of a local Git repository, and runs in that checkout in place of the current
 * directory. `worktree` (`worktree: true`): the run gets `--repo`, `--base` and `--branch`, a worktree on `--branch` or
 * `<wf>/<run-id>`, and `args.start`; a result with a `subject` renames `<wf>/<run-id>`.
 */
export type Placement = "here" | "repo" | "worktree";

/** A command-line option that a placement adds. */
export type PlacementOption = "repo" | "base" | "branch";

/** The command-line options that each placement adds, in the order of the usage line. */
export const PLACEMENT_OPTIONS: Readonly<Record<Placement, readonly PlacementOption[]>> = {
	here: [],
	repo: ["repo"],
	worktree: ["repo", "base", "branch"],
};

export type Meta = {
	/** One line for `workflows` and `--help`; empty when the script has none. */
	readonly description: string;
	readonly args: Readonly<Record<string, ArgSpec>>;
	readonly placement: Placement;
	/** The exit code of each `result.status`; any other status exits 1, and a result without a status exits 0. */
	readonly exit: Readonly<Record<string, number>>;
};

/** `meta` as a script writes it: the `Meta` of `workflows/script.d.ts`. */
type Literal = {
	readonly description?: string;
	readonly args?: Readonly<Record<string, ArgSpec>>;
	readonly worktree?: boolean;
	readonly repo?: boolean;
	readonly exit?: Readonly<Record<string, number>>;
};

const META_KEYS = new Set(["description", "args", "worktree", "repo", "exit"]);
const SPEC_KEYS = new Set(["type", "default", "required", "positional", "label"]);
export const OBJECT = Type.Object({});
const DESCRIPTION = Type.Object({ description: Type.Optional(Type.String()) });
const ARGS = Type.Object({ args: Type.Optional(Type.Record(Type.String(), Type.Unknown())) });
const WORKTREE = Type.Object({ worktree: Type.Optional(Type.Boolean()) });
const REPO = Type.Object({ repo: Type.Optional(Type.Boolean()) });
const EXIT = Type.Object({ exit: Type.Optional(Type.Record(Type.String(), Type.Integer())) });
const SPEC_TYPE = Type.Object({ type: ARG_TYPE });

const SPEC_FLAGS = Type.Object({
	required: Type.Optional(Type.Boolean()),
	positional: Type.Optional(Type.Boolean()),
	label: Type.Optional(Type.String()),
});

/** The values of each argument type, and how an error message names them: `number` is a positive integer. */
export const ARG_VALUES = {
	string: { schema: Type.String(), expected: "a string" },
	number: { schema: Type.Integer({ minimum: 1 }), expected: "a positive integer" },
	boolean: { schema: Type.Boolean(), expected: "a boolean" },
	text: { schema: Type.String(), expected: "a string" },
};

/** The `default` of each argument type. */
const DEFAULTS = {
	string: Type.Object({ default: Type.Optional(ARG_VALUES.string.schema) }),
	number: Type.Object({ default: Type.Optional(ARG_VALUES.number.schema) }),
	boolean: Type.Object({ default: Type.Optional(ARG_VALUES.boolean.schema) }),
	text: Type.Object({ default: Type.Optional(ARG_VALUES.text.schema) }),
};

/** The placement of a checked `meta` literal, which never has both `worktree` and `repo`. */
function placementOf({ worktree, repo }: Pick<Literal, "worktree" | "repo">): Placement {
	if (worktree === true) return "worktree";

	return repo === true ? "repo" : "here";
}

/** Throws the first problem of `value` as the `meta` of the script `name`. */
function checkMeta(value: unknown, name: string): asserts value is Literal {
	const fail = (problem: string) => new Error(`${name}: ${problem}`);

	if (!Value.Check(OBJECT, value)) throw fail("meta is not an object");
	const [extra] = Object.keys(value).filter((key) => !META_KEYS.has(key));

	if (extra !== undefined) throw fail(`meta.${extra} is not a meta field`);

	if (!Value.Check(DESCRIPTION, value)) throw fail("meta.description is not a string");

	if (!Value.Check(ARGS, value)) throw fail("meta.args is not an object");

	if (!Value.Check(WORKTREE, value)) throw fail("meta.worktree is not a boolean");

	if (!Value.Check(REPO, value)) throw fail("meta.repo is not a boolean");

	if (value.repo === true && value.worktree === true) throw fail("meta.repo is for a script without meta.worktree");

	if (!Value.Check(EXIT, value)) throw fail("meta.exit does not map statuses to integer exit codes");
	const placement = placementOf(value);
	const reserved = new Set(["prompts", "agents", "overlay", "checkout", "from", "help", "json"]);

	for (const option of PLACEMENT_OPTIONS[placement]) reserved.add(option);

	if (placement === "worktree") reserved.add("start");
	let positionals = 0;

	for (const [arg, spec] of Object.entries(value.args ?? {})) {
		const at = `meta.args.${arg}`;

		if (reserved.has(arg)) throw fail(`${at} is a reserved name`);

		if (!Value.Check(SPEC_TYPE, spec)) throw fail(`${at}.type is not string, number, boolean or text`);
		const [unknown] = Object.keys(spec).filter((key) => !SPEC_KEYS.has(key));

		if (unknown !== undefined) throw fail(`${at}.${unknown} is not an argument field`);
		const { type } = spec;

		if (!Value.Check(DEFAULTS[type], spec)) throw fail(`${at}.default is not ${ARG_VALUES[type].expected}`);

		if (!Value.Check(SPEC_FLAGS, spec)) {
			throw fail(`${at}: required and positional are booleans, and label is a string`);
		}

		if (spec.positional === true && type === "boolean") throw fail(`${at} is a boolean and cannot be positional`);

		if (spec.positional === true) positionals++;
	}

	if (positionals > 1) throw fail("meta.args has more than one positional argument");
}

/**
 * The `meta` of the script `source`, checked; no arguments for a script without one. The end of the literal is the
 * first `}` after which the text compiles as an expression. Compiling runs nothing; the literal then runs in the sandbox.
 */
export async function readMeta(source: string, name: string): Promise<Meta> {
	const found = META.exec(source);

	if (found === null) return { description: "", args: {}, placement: "here", exit: {} };
	const from = found[0].length;
	let literal: string | undefined;

	if (source.slice(from).trimStart().startsWith("{")) {
		for (let at = source.indexOf("}", from); at !== -1 && literal === undefined; at = source.indexOf("}", at + 1)) {
			const slice = source.slice(from, at + 1);

			try {
				// oxlint-disable-next-line typescript/no-implied-eval -- it only parses the slice, and never calls it.
				new Function(`return (${slice})`);
				literal = slice;
			} catch {
				// Not the end of the literal yet.
			}
		}
	}

	if (literal === undefined) throw new Error(`${name}: meta is not an object literal`);

	// The literal runs on this thread with a budget of interrupt polls and no deadline: a clock fails a short literal
	// when the machine is busy, and the budget stops a literal that computes without end in a fraction of a second.
	const sandbox = new InlineCodemodeSandbox({
		wasm: loadQuickJSWasm(),
		interruptBudget: 1_000,
		timeoutMs: Number.POSITIVE_INFINITY,
	});

	try {
		const result = await sandbox.execute(`return (${literal})`);

		if (!result.ok) throw new Error(`${name}: meta: ${result.error.message}`);
		const { value } = result;
		checkMeta(value, name);
		const { description = "", args = {}, exit = {} } = value;

		return { description, args, placement: placementOf(value), exit };
	} finally {
		await sandbox.close();
	}
}
