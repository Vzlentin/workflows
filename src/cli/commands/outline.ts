/**
 * `workflows outline [<wf>]`: the outline of a workflow script, or of every script, from its `meta.outline`. It reads
 * the scripts only: it starts no run, connects to no host, opens no store and calls no model.
 */
import { parseArgs } from "node:util";
import { loadBundle } from "../../workflow/bundle.ts";
import { findScript, type Io, UsageError, withUsage } from "../../workflow/find.ts";
import { type OutlineStep, readOutline } from "../../workflow/meta.ts";

export const OUTLINE = "workflows outline [<workflow>] [--json]";

/** The outline of one script: its name, and the steps of its `meta.outline` as it declares them. */
type Outline = { readonly workflow: string; readonly steps: readonly OutlineStep[] };

/**
 * The outline of each script of the package and of the project of the directory `cwd`, in the order of `workflows`. It
 * reads one script at a time, so a bad `meta` fails with the first such script in that order.
 */
async function everyOutline(cwd: string): Promise<Outline[]> {
	const { scripts } = await loadBundle(cwd);
	const outlines: Outline[] = [];

	for (const [workflow, source] of Object.entries(scripts)) {
		outlines.push({ workflow, steps: await readOutline(source, workflow) });
	}

	return outlines;
}

/**
 * One line for each outline: the name, padded to the longest name, two spaces and the labels of the top-level steps
 * joined with ` ─ `, or the name alone without steps.
 */
function linesOf(outlines: readonly Outline[]): string[] {
	const width = Math.max(...outlines.map(({ workflow }) => workflow.length));

	return outlines.map(({ workflow, steps }) =>
		steps.length === 0 ? workflow : `${workflow.padEnd(width)}  ${steps.map(({ label }) => label).join(" ─ ")}`,
	);
}

/**
 * Prints the outline of the script `<wf>`, found as `check` finds it, or of every script: the text lines of `linesOf`,
 * or with `--json` one line, the outline of `<wf>` as `{ workflow, steps }`, or the array of every outline.
 */
export async function outline(args: readonly string[], io: Io, json: boolean): Promise<number> {
	const { positionals } = withUsage(
		() => parseArgs({ args: [...args], allowPositionals: true, strict: true }),
		OUTLINE,
	);

	const [word, ...rest] = positionals;

	if (rest.length > 0) throw new UsageError("give at most one workflow", OUTLINE);

	if (word === undefined) {
		const outlines = await everyOutline(io.cwd);

		for (const line of json ? [JSON.stringify(outlines)] : linesOf(outlines)) io.stdout(line);

		return 0;
	}

	const found = await findScript(word, io);
	const one = { workflow: found.name, steps: await readOutline(found.source, found.name) };

	for (const line of json ? [JSON.stringify(one)] : linesOf([one])) io.stdout(line);

	return 0;
}
