/**
 * `workflows outline [<wf>]`: the outline of a workflow script, or of every script, from its `meta.outline`, and with
 * `--json` the catalog entry of each script. It reads the scripts only: it starts no run, connects to no host, opens no
 * store and calls no model.
 */
import { parseArgs } from "node:util";
import { type Static, Type } from "typebox";
import { loadBundle } from "../../workflow/bundle.ts";
import { findScript, type Io, usageOf, UsageError, withUsage } from "../../workflow/find.ts";
import { META, MetaError, OUTLINE_STEP, readDeclared } from "../../workflow/meta.ts";

export const OUTLINE = "workflows outline [<workflow>] [--json]";

/**
 * One script of `workflows outline --json`: its checked `meta` with its outline and its usage line without `usage: `,
 * or, for a script whose `meta` is bad, the error that a run of it gives.
 */
export const CATALOG_ENTRY = Type.Union([
	Type.Object(
		{
			workflow: Type.String(),
			...META.properties,
			outline: Type.Array(OUTLINE_STEP),
			usage: Type.String(),
		},
		{ additionalProperties: false },
	),
	Type.Object({ workflow: Type.String(), error: Type.String() }, { additionalProperties: false }),
]);

type CatalogEntry = Static<typeof CATALOG_ENTRY>;

/** The catalog entry of the script `source` named `workflow`. */
async function entryOf(workflow: string, source: string): Promise<CatalogEntry> {
	try {
		const { meta, outline } = await readDeclared(source, workflow);

		return { workflow, ...meta, outline: [...outline], usage: usageOf(workflow, meta) };
	} catch (error) {
		if (error instanceof MetaError) return { workflow, error: error.message };

		throw error;
	}
}

/** The catalog entry of each script of the package and of the project of the directory `cwd`, in the order of `workflows`. */
async function catalog(cwd: string): Promise<CatalogEntry[]> {
	const { scripts } = await loadBundle(cwd);
	const entries: CatalogEntry[] = [];

	for (const [workflow, source] of Object.entries(scripts)) entries.push(await entryOf(workflow, source));

	return entries;
}

/**
 * One line for each entry: the name, padded to the longest name, two spaces and the labels of the top-level steps
 * joined with ` ─ `, or the name alone without steps. The first entry with an error, in order, throws that error.
 */
function linesOf(entries: readonly CatalogEntry[]): string[] {
	const width = Math.max(...entries.map(({ workflow }) => workflow.length));

	return entries.map((entry) => {
		if ("error" in entry) throw new Error(entry.error);
		const { workflow, outline } = entry;

		return outline.length === 0
			? workflow
			: `${workflow.padEnd(width)}  ${outline.map(({ label }) => label).join(" ─ ")}`;
	});
}

/**
 * Prints the outline of the script `<wf>`, found as `check` finds it, or of every script: the text lines of `linesOf`,
 * or with `--json` one line, the catalog entry of `<wf>`, or the array of every entry.
 */
export async function outline(args: readonly string[], io: Io, json: boolean): Promise<number> {
	const { positionals } = withUsage(
		() => parseArgs({ args: [...args], allowPositionals: true, strict: true }),
		OUTLINE,
	);

	const [word, ...rest] = positionals;

	if (rest.length > 0) throw new UsageError("give at most one workflow", OUTLINE);

	if (word === undefined) {
		const entries = await catalog(io.cwd);

		for (const line of json ? [JSON.stringify(entries)] : linesOf(entries)) io.stdout(line);

		return 0;
	}

	const found = await findScript(word, io);
	const one = await entryOf(found.name, found.source);

	for (const line of json ? [JSON.stringify(one)] : linesOf([one])) io.stdout(line);

	return 0;
}
