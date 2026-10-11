/** What workflows that take one text and work in a new worktree share: the text and the worktree. */
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { selectRepository } from "./git.ts";
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

/**
 * The selected repository and its start commit, and the worktree path of `run` on the branch `<scriptName>/<run-id>`.
 */
export async function prepareWorktree(
	scriptName: string,
	args: { readonly repo: string | undefined; readonly base: string },
	run: Run,
): Promise<{ repository: string; start: string; branch: string; worktree: string }> {
	const repository = await selectRepository(run.cwd, args.repo, args.base, join(run.directory, "repository"));
	return {
		repository: repository.path,
		start: repository.start,
		branch: `${scriptName}/${run.id}`,
		worktree: join(run.directory, "worktree"),
	};
}
