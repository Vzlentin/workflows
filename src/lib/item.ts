/** What workflows that take one text and work in a new worktree share: the text, the arguments and the worktree. */
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { selectRepository } from "./git.ts";
import { loadBundle, type RunBundle } from "./script.ts";
import { type Io, type Run, UsageError } from "./workflow.ts";

/** The first non-empty line of `item`, without leading #. */
export function subject(item: string): string {
	const line = item.split("\n").find((candidate) => candidate.trim() !== "") ?? "";
	return line.replace(/^#+/, "").trim();
}

/**
 * The text that `noun` names, such as `work item`: a `.md` file, inline text, or piped stdin. Throws when it has no
 * non-empty line.
 */
export async function readItem(argument: string | undefined, io: Io, noun: string): Promise<string> {
	let text: string | undefined;
	if (argument === undefined) {
		text = await io.stdin();
		if (text === undefined) throw new UsageError(`missing ${noun}`);
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

/** `--repo`, `--base` (default `main`), `--rounds` (default 3) and at most one positional, the `noun`. */
export function parseItemArgs(args: readonly string[], noun: string) {
	const { values, positionals } = parseArgs({
		args: [...args],
		options: { repo: { type: "string" }, base: { type: "string" }, rounds: { type: "string" } },
		allowPositionals: true,
	});
	if (positionals.length > 1) throw new UsageError(`give the ${noun} as one argument`);
	const rounds = Number(values.rounds ?? "3");
	if (!Number.isInteger(rounds) || rounds < 1) throw new UsageError("--rounds must be a positive integer");
	return { repo: values.repo, base: values.base ?? "main", rounds, item: positionals[0] };
}

/**
 * The package's bundle with `workflows/<scriptName>.js` as the run's own script, the selected repository and its start
 * commit, and the worktree path of `run` on the branch `<scriptName>/<run-id>`.
 */
export async function prepareWorktree(
	scriptName: string,
	args: { readonly repo: string | undefined; readonly base: string },
	run: Run,
): Promise<{ bundle: RunBundle; repository: string; start: string; branch: string; worktree: string }> {
	const bundle = await loadBundle();
	const main = bundle.scripts[scriptName];
	if (main === undefined) throw new Error(`the package has no workflows/${scriptName}.js`);
	const repository = await selectRepository(run.cwd, args.repo, args.base, join(run.directory, "repository"));
	return {
		bundle: { ...bundle, main },
		repository: repository.path,
		start: repository.start,
		branch: `${scriptName}/${run.id}`,
		worktree: join(run.directory, "worktree"),
	};
}
