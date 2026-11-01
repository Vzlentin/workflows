/** The checked `meta.args` values of the command line of `workflows <wf>`, and the texts that they name. */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import type { JsonObject } from "@earendil-works/pi-durable";
import { Value } from "typebox/value";
import { type Io, labelOf, UsageError, withUsage } from "../workflow/find.ts";
import { ARG_VALUES, type ArgSpec, type Meta } from "../workflow/meta.ts";

/**
 * The text that `noun` names, such as `work item`: a `.md` file, inline text, or piped stdin. Throws when it has no
 * non-empty line. It is undefined without an argument and without stdin, and also with blank stdin when it is
 * `optional`, because the `workflow` tool pipes an empty stdin.
 */
async function readItem(
	argument: string | undefined,
	io: Io,
	noun: string,
	optional: boolean,
): Promise<string | undefined> {
	let text: string | undefined;

	if (argument === undefined) {
		text = await io.stdin();

		if (text === undefined || (optional && text.trim() === "")) return undefined;
	} else if (argument.endsWith(".md")) {
		const path = resolve(io.cwd, argument);
		text = await readFile(path, "utf8").catch(() => {
			throw new Error(`cannot read ${noun} ${path}`);
		});
	} else {
		text = argument;
	}

	if (text.trim() === "") throw new Error(`the ${noun} is empty`);

	return text;
}

/** A required argument `arg`, which `spec` declares, without a value. */
type ArgMissing = { readonly arg: string; readonly spec: ArgSpec; readonly missing: true };

/** A value of `arg` that is not `expected`, as `ARG_VALUES` names its type. */
type ArgWrong = { readonly arg: string; readonly spec: ArgSpec; readonly expected: string };

type ArgProblem = ArgMissing | ArgWrong;

/**
 * The first problem of `args` against `specs`, in declaration order: a required argument without a value, or a value
 * that is not of its type (`null` included). Arguments that `specs` does not declare are not checked.
 */
function argProblem(specs: readonly (readonly [string, ArgSpec])[], args: JsonObject): ArgProblem | undefined {
	for (const [arg, spec] of specs) {
		const value = args[arg];
		const { schema, expected } = ARG_VALUES[spec.type];

		if (value === undefined) {
			if (spec.required) return { arg, spec, missing: true };
		} else if (!Value.Check(schema, value)) {
			return { arg, spec, expected };
		}
	}

	return undefined;
}

/**
 * Throws the first problem of `args` against `specs` as `run <name>: <arg> is missing` or
 * `run <name>: <arg> must be <expected>`. Arguments that `specs` does not declare pass.
 */
export function checkArgs(name: string, specs: Meta["args"], args: JsonObject): void {
	const found = argProblem(Object.entries(specs), args);

	if (found === undefined) return;

	const problem = "missing" in found ? "is missing" : `must be ${found.expected}`;

	throw new Error(`run ${name}: ${found.arg} ${problem}`);
}

/**
 * The args of the child run of `run(name, given)`: the `meta` defaults and `given`, checked by `checkArgs` against
 * `meta.args`.
 */
export function runArgs(name: string, meta: Meta, given: JsonObject): JsonObject {
	const defaults = Object.entries(meta.args).flatMap(([arg, spec]) =>
		spec.default === undefined ? [] : [[arg, spec.default] as const],
	);

	const args = { ...Object.fromEntries(defaults), ...given };
	checkArgs(name, meta.args, args);

	return args;
}

/** The checked `meta.args` values of `argv`; texts are read after every other value is checked. */
export async function parseValues(meta: Meta, argv: readonly string[], io: Io, usage: string) {
	const entries = Object.entries(meta.args);

	const options: Record<string, { type: "string" | "boolean" }> = {};
	options.prompts = { type: "string" };
	options.help = { type: "boolean" };
	options.json = { type: "boolean" };

	if (meta.worktree) {
		options.repo = { type: "string" };
		options.base = { type: "string" };
		options.branch = { type: "string" };
	}

	for (const [arg, spec] of entries) options[arg] = { type: spec.type === "boolean" ? "boolean" : "string" };
	const positional = entries.find(([, spec]) => spec.positional);

	const parsed = withUsage(
		() => parseArgs({ args: [...argv], options, allowPositionals: positional !== undefined, strict: true }),
		usage,
	);

	const { values } = parsed;

	if (positional !== undefined) {
		const [arg, spec] = positional;

		if (parsed.positionals.length > 1) throw new UsageError(`give the ${labelOf(arg, spec)} as one argument`, usage);

		if (parsed.positionals.length === 1) {
			if (values[arg] !== undefined) throw new UsageError(`give the ${labelOf(arg, spec)} once`, usage);
			values[arg] = parsed.positionals[0];
		}
	}

	const args: JsonObject = {};

	for (const [arg, spec] of entries) {
		const raw = values[arg];

		if (spec.type === "text") continue;

		if (raw === undefined) {
			if (spec.default !== undefined) args[arg] = spec.default;
			else if (spec.type === "boolean") args[arg] = false;
		} else {
			args[arg] = spec.type === "number" ? Number(raw) : raw;
		}
	}

	const found = argProblem(
		entries.filter(([, spec]) => spec.type !== "text"),
		args,
	);

	if (found !== undefined && "missing" in found) {
		throw new UsageError(`missing ${labelOf(found.arg, found.spec)}`, usage);
	}

	if (found !== undefined) throw new UsageError(`--${found.arg} must be ${found.expected}`, usage);

	for (const [arg, spec] of entries) {
		if (spec.type !== "text") continue;
		const raw = stringOption(values[arg]);
		const label = labelOf(arg, spec);
		const optional = spec.required !== true;

		const value =
			raw === undefined && spec.default !== undefined ? spec.default : await readItem(raw, io, label, optional);

		if (value !== undefined) args[arg] = value;
	}

	// A text value is always a string, from `readItem` or a string default, so a text can only be missing.
	const missing = entries.find(([arg, spec]) => spec.type === "text" && spec.required && args[arg] === undefined);

	if (missing !== undefined) throw new UsageError(`missing ${labelOf(...missing)}`);

	return {
		args,
		prompts: stringOption(values.prompts),
		repo: stringOption(values.repo),
		base: stringOption(values.base) ?? "main",
		branch: stringOption(values.branch),
	};
}

/** The value of a `parseArgs` option of the type `string`, which is never a boolean. */
function stringOption(value: string | boolean | undefined): string | undefined {
	return value === true || value === false ? undefined : value;
}
