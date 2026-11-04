/**
 * `workflows check <wf>`: the static analysis of a workflow script, which reads its `meta` and its prompts, and the
 * models of its agents table and of the literal fields of its calls.
 */
import type { Models } from "@earendil-works/pi-ai/models";
import type { Bundle } from "../../workflow/bundle.ts";
import { findScript, type Io, problem, UsageError } from "../../workflow/find.ts";
import { readMeta } from "../../workflow/meta.ts";
import { roleOf } from "../../workflow/roles.ts";

export const CHECK = "workflows check <workflow>";

/** The fields of an object literal that a session call reads: a string literal gives its text, any other value null. */
type Fields = { readonly provider?: string | null; readonly model?: string | null; readonly as?: string | null };

/** `fields` of the text of one brace block, whose strings are `"<n>"` with their texts in `strings`. */
function fieldsOf(text: string, strings: readonly string[]): Fields | undefined {
	const fields: Record<string, string | null> = {};

	for (const name of ["provider", "model", "as"]) {
		if (!new RegExp(String.raw`(?:^|[,\s])${name}\s*(?::|,|$)`).test(text)) continue;
		const literal = new RegExp(String.raw`(?:^|[,\s])${name}\s*:\s*"(\d+)"\s*(?:,|$)`).exec(text)?.[1];
		fields[name] = literal === undefined ? null : (strings[Number(literal)] ?? null);
	}

	return Object.keys(fields).length === 0 ? undefined : fields;
}

/**
 * Whether the `/` at `at` of `source`, which starts no comment, starts a regular expression literal: after an operator,
 * an opening bracket, a separator or a keyword such as `return`, a value comes, and a `/` there is not a division.
 */
function regexStarts(source: string, at: number): boolean {
	const before = source.slice(0, at).trimEnd();

	if (before === "") return true;

	if (/[([{,;:=!&|?+\-*%<>~^]$/.test(before)) return true;

	return /\b(?:return|typeof|case|do|else|in|of|new|delete|void|throw|yield|await)$/.test(before);
}

/**
 * The fields of each object literal that `source` passes directly to `session(...)` or `agent(...)`, at the object's
 * own level. Comments, strings and nested objects do not count, and an object with a spread is left out, because its
 * fields are not all known.
 */
function sessionFields(source: string): Fields[] {
	const found: Fields[] = [];
	const strings: string[] = [];
	// The open brackets. An object keeps its text at its own level: each string as `"<n>"`, a template with `${` as `x`,
	// and an inner object as `{}`.
	const open: ({ readonly call: string } | { text: string; readonly session: boolean })[] = [];

	const add = (text: string) => {
		const object = open.findLast((entry) => "text" in entry);

		if (object !== undefined && "text" in object) object.text += text;
	};

	let inClass = false;

	for (let at = 0; at < source.length; at++) {
		const char = source[at] ?? "";
		const rest = source.slice(at, at + 2);

		if (rest === "//" || rest === "/*") {
			const end = source.indexOf(rest === "//" ? "\n" : "*/", at + 2);
			at = end === -1 ? source.length : end + (rest === "//" ? 0 : 1);
			continue;
		}

		if (char === "/" && regexStarts(source, at)) {
			// A quote in a regular expression literal does not start a string.
			for (at++, inClass = false; at < source.length; at++) {
				const inner = source[at];

				if (inner === "\\") at++;
				else if (inner === "[") inClass = true;
				else if (inner === "]") inClass = false;
				else if (inner === "/" && !inClass) break;
				else if (inner === "\n") break;
			}

			add("x");
		} else if (char === '"' || char === "'" || char === "`") {
			let text = "";
			let computed = false;

			for (at++; at < source.length && source[at] !== char; at++) {
				if (source[at] === "\\") at++;
				else if (char === "`" && source.slice(at, at + 2) === "${") computed = true;
				text += source[at] ?? "";
			}

			strings.push(text);
			add(computed ? "x" : `"${strings.length - 1}"`);
		} else if (char === "(") {
			open.push({ call: /([A-Za-z_$][\w$]*)\s*$/.exec(source.slice(0, at))?.[1] ?? "" });
			add(char);
		} else if (char === ")") {
			if (open.at(-1) !== undefined && "call" in (open.at(-1) ?? {})) open.pop();
			add(char);
		} else if (char === "{") {
			const top = open.at(-1);
			add("{}");
			open.push({ text: "", session: top !== undefined && "call" in top && ["session", "agent"].includes(top.call) });
		} else if (char === "}") {
			const top = open.at(-1);

			if (top === undefined || !("text" in top)) continue;
			open.pop();
			const fields = top.session && !top.text.includes("...") ? fieldsOf(top.text, strings) : undefined;

			if (fields !== undefined) found.push(fields);
		} else {
			add(char);
		}
	}

	return found;
}

/**
 * The first model, as `<provider>/<id>`, that a session call of `source` names with a literal `provider` or `model`,
 * with the role of its `as` (default `default`) in the agents table for the other field, and that `models` does not
 * have. A call with a computed field, or without a provider or a model after its role, is left to the start of the
 * session.
 */
async function unknownModel(
	source: string,
	bundle: Bundle,
	models: () => Promise<Models>,
): Promise<string | undefined> {
	const named = sessionFields(source).flatMap(({ provider, model, as }) => {
		if (provider === null || model === null || as === null) return [];

		if (provider === undefined && model === undefined) return [];
		const role = roleOf(bundle.agents, as ?? "default").model;
		const found = { provider: provider ?? role?.provider, model: model ?? role?.modelId };

		return found.provider === undefined || found.model === undefined ? [] : [found];
	});

	if (named.length === 0) return undefined;
	const registry = await models();
	const unknown = named.find(({ provider, model }) => registry.getModel(provider ?? "", model ?? "") === undefined);

	return unknown === undefined ? undefined : `${unknown.provider}/${unknown.model}`;
}

/** The first name of the agents table of `bundle` whose model `models` does not have, with that model. */
async function unknownTableModel(
	bundle: Bundle,
	models: () => Promise<Models>,
): Promise<{ readonly name: string; readonly model: string } | undefined> {
	const named = Object.entries(bundle.agents).flatMap(([name, { model }]) =>
		model === undefined ? [] : [{ name, model }],
	);

	if (named.length === 0) return undefined;
	const registry = await models();
	const found = named.find(({ model }) => registry.getModel(model.provider, model.modelId) === undefined);

	return found && { name: found.name, model: `${found.model.provider}/${found.model.modelId}` };
}

/**
 * `workflows check <wf>`: reads `meta` and checks the prompts that the script names, and the models of the agents
 * table and the literal models of its calls against Pi's model registry; starts no run. A role name needs no entry.
 */
export async function check(
	args: readonly string[],
	io: Io & { readonly models: () => Promise<Models> },
): Promise<number> {
	const [word, ...rest] = args;

	if (word === undefined || rest.length > 0) throw new UsageError("give one workflow to check", CHECK);
	const found = await findScript(word, io);
	await readMeta(found.source, found.name);
	const failed = problem(found.source, found.name, found.bundle);

	if (failed !== undefined) throw new Error(failed);
	const model = await unknownModel(found.source, found.bundle, io.models);

	if (model !== undefined)
		throw new Error(`${found.name} uses the model ${model}, which Pi's model registry does not have`);
	const table = await unknownTableModel(found.bundle, io.models);

	if (table !== undefined) {
		throw new Error(
			`agents.json gives ${table.name} the model ${table.model}, which Pi's model registry does not have`,
		);
	}

	io.stdout(`ok ${found.name}`);

	return 0;
}
