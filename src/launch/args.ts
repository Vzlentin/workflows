/** The checked `meta.args` values of the command line of `workflows <wf>`, and the texts that they name. */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import type { JsonObject } from "@earendil-works/pi-durable";
import { type Io, labelOf, UsageError, withUsage } from "../workflow/find.ts";
import type { Meta } from "../workflow/meta.ts";

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
			else if (spec.required) throw new UsageError(`missing ${labelOf(arg, spec)}`, usage);
		} else if (spec.type === "number") {
			const n = Number(raw);

			if (!Number.isInteger(n) || n < 1) throw new UsageError(`--${arg} must be a positive integer`, usage);
			args[arg] = n;
		} else {
			args[arg] = raw;
		}
	}

	for (const [arg, spec] of entries) {
		if (spec.type !== "text") continue;
		const raw = stringOption(values[arg]);
		const label = labelOf(arg, spec);
		const optional = spec.required !== true;

		const value =
			raw === undefined && spec.default !== undefined ? spec.default : await readItem(raw, io, label, optional);

		if (value !== undefined) args[arg] = value;
		else if (spec.required) throw new UsageError(`missing ${label}`);
	}

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
