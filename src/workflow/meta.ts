/**
 * The `meta` of a workflow script. `export const meta = { ... }` at the top of the script declares its arguments,
 * whether it runs in a new worktree, and the exit code of each result status. The meta reader evaluates only that
 * literal, in the sandbox, and never runs the script.
 */
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
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

export type Meta = {
	/** One line for `workflows` and `--help`; empty when the script has none. */
	readonly description: string;
	readonly args: Readonly<Record<string, ArgSpec>>;
	/**
	 * The run gets `--repo`, `--base` and `--branch`, a worktree on `--branch` or `<wf>/<run-id>`, and `args.start`. A
	 * result with a `subject` renames `<wf>/<run-id>`.
	 */
	readonly worktree: boolean;
	/** The exit code of each `result.status`; any other status exits 0. */
	readonly exit: Readonly<Record<string, number>>;
};

const META_KEYS = new Set(["description", "args", "worktree", "exit"]);
const SPEC_KEYS = new Set(["type", "default", "required", "positional", "label"]);
export const OBJECT = Type.Object({});
const DESCRIPTION = Type.Object({ description: Type.Optional(Type.String()) });
const ARGS = Type.Object({ args: Type.Optional(Type.Record(Type.String(), Type.Unknown())) });
const WORKTREE = Type.Object({ worktree: Type.Optional(Type.Boolean()) });
const EXIT = Type.Object({ exit: Type.Optional(Type.Record(Type.String(), Type.Integer())) });
const SPEC_TYPE = Type.Object({ type: ARG_TYPE });

/** The arguments that `meta.worktree` gives a script. */
const WORKTREE_ARGS = ["repo", "base", "branch", "start"];

const SPEC_FLAGS = Type.Object({
	required: Type.Optional(Type.Boolean()),
	positional: Type.Optional(Type.Boolean()),
	label: Type.Optional(Type.String()),
});

/** The `default` of each argument type. */
const DEFAULTS = {
	string: Type.Object({ default: Type.Optional(Type.String()) }),
	number: Type.Object({ default: Type.Optional(Type.Integer({ minimum: 1 })) }),
	boolean: Type.Object({ default: Type.Optional(Type.Boolean()) }),
	text: Type.Object({ default: Type.Optional(Type.String()) }),
};

/** Throws the first problem of `value` as the `meta` of the script `name`. */
function checkMeta(value: unknown, name: string): asserts value is Partial<Meta> {
	const fail = (problem: string) => new Error(`${name}: ${problem}`);

	if (!Value.Check(OBJECT, value)) throw fail("meta is not an object");
	const [extra] = Object.keys(value).filter((key) => !META_KEYS.has(key));

	if (extra !== undefined) throw fail(`meta.${extra} is not a meta field`);

	if (!Value.Check(DESCRIPTION, value)) throw fail("meta.description is not a string");

	if (!Value.Check(ARGS, value)) throw fail("meta.args is not an object");

	if (!Value.Check(WORKTREE, value)) throw fail("meta.worktree is not a boolean");

	if (!Value.Check(EXIT, value)) throw fail("meta.exit does not map statuses to integer exit codes");
	const worktreeArgs = value.worktree === true ? WORKTREE_ARGS : [];
	const reserved = new Set(["prompts", "overlay", "checkout", "from", "help", "json", ...worktreeArgs]);
	let positionals = 0;

	for (const [arg, spec] of Object.entries(value.args ?? {})) {
		const at = `meta.args.${arg}`;

		if (reserved.has(arg)) throw fail(`${at} is a reserved name`);

		if (!Value.Check(SPEC_TYPE, spec)) throw fail(`${at}.type is not string, number, boolean or text`);
		const [unknown] = Object.keys(spec).filter((key) => !SPEC_KEYS.has(key));

		if (unknown !== undefined) throw fail(`${at}.${unknown} is not an argument field`);
		const { type } = spec;
		const expected = type === "text" ? "string" : type;

		if (!Value.Check(DEFAULTS[type], spec)) {
			throw fail(`${at}.default is not a ${type === "number" ? "positive integer" : expected}`);
		}

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

	if (found === null) return { description: "", args: {}, worktree: false, exit: {} };
	const from = found[0].length;
	let literal: string | undefined;

	if (source.slice(from).trimStart().startsWith("{")) {
		for (let at = source.indexOf("}", from); at !== -1 && literal === undefined; at = source.indexOf("}", at + 1)) {
			const slice = source.slice(from, at + 1);

			try {
				new Function(`return (${slice})`);
				literal = slice;
			} catch {
				// Not the end of the literal yet.
			}
		}
	}

	if (literal === undefined) throw new Error(`${name}: meta is not an object literal`);
	const sandbox = new CodemodeSandbox({ timeoutMs: 5000 });

	try {
		const result = await sandbox.execute(`return (${literal})`);

		if (!result.ok) throw new Error(`${name}: meta: ${result.error.message}`);
		const { value } = result;
		checkMeta(value, name);
		const { description = "", args = {}, worktree = false, exit = {} } = value;

		return { description, args, worktree, exit };
	} finally {
		await sandbox.close();
	}
}
