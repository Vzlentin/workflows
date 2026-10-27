// Script lib: Git steps.

/**
 * Stages every change and commits it as `message` when something is staged. Safe to repeat: the check's result is
 * saved, so a commit that succeeded before a stop may run again with nothing staged.
 */
async function commitAll(message) {
	await sh(["git", "add", "-A"]);

	if (!(await ok(["git", "diff", "--cached", "--quiet"]))) await sh(["git", "commit", "--allow-empty", "-m", message]);
}

/** `+12 -3 in 2 files` for the change from `from` to `to`, or `no new changes`. */
async function diffStat(from, to = "HEAD") {
	const shortstat = await sh(["git", "diff", "--shortstat", from, to]);
	const count = (word) => Number(new RegExp(`(\\d+) ${word}`).exec(shortstat)?.[1] ?? 0);
	const files = count("files? changed");

	if (files === 0) return "no new changes";

	return `+${count("insertion")} -${count("deletion")} in ${files} file${files === 1 ? "" : "s"}`;
}

/** Throws when the checkout of the current directory has changes that are not committed. */
async function assertClean() {
	if ((await sh(["git", "status", "--porcelain"])) !== "") {
		throw new Error("the checkout has changes that are not committed; commit or stash them first");
	}
}

/**
 * The start of the change of the branch of the current directory: its merge base with `base`. It refuses a checkout
 * with changes that are not committed, and a branch with no change from `base`.
 */
async function branchStart(base) {
	await assertClean();
	const start = await sh(["git", "merge-base", base, "HEAD"]);

	if (await ok(["git", "diff", "--quiet", start, "HEAD"])) throw new Error(`no change from ${base}`);

	return start;
}
