// Script lib: Git steps.

/**
 * Stages every change and commits it as `message` when something is staged. Safe to repeat: the check's result is
 * saved, so a commit that succeeded before a stop may run again with nothing staged.
 */
async function commitAll(message) {
	await sh(["git", "add", "-A"]);

	if (!(await ok(["git", "diff", "--cached", "--quiet"]))) await sh(["git", "commit", "--allow-empty", "-m", message]);
}

/**
 * Squashes the commits since `start` into one commit with `message`, logs `commit <short> <subject>` and returns the
 * short head.
 */
async function squash(start, message, subject) {
	// One command, so that a repeat resets a squash commit that was made but not saved.
	await sh(["sh", "-c", 'git reset -q --soft "$1" && git commit -q -m "$2"', "squash", start, message]);

	const short = await sh(["git", "rev-parse", "--short", "HEAD"]);

	log(`commit ${short} ${subject}`);

	return short;
}

/** Writes the binary diff from `from` to `HEAD` to the file `path`, and returns `path`. */
async function writePatch(path, from) {
	await sh(["git", "diff", "--binary", `--output=${path}`, from, "HEAD"]);

	return path;
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

/** The path of the worktree that has `branch` checked out, or undefined when no worktree has it. */
async function checkedOutAt(branch) {
	let path;

	for (const line of (await sh(["git", "worktree", "list", "--porcelain"])).split("\n")) {
		if (line.startsWith("worktree ")) path = line.slice("worktree ".length);
		else if (line === `branch refs/heads/${branch}`) return path;
	}

	return undefined;
}

/** `# <title>` and the body of `pr`. */
function prIntent(pr) {
	return `# ${pr.title}\n\n${pr.body ?? ""}`.trim();
}

/** The PR of `ref` with the JSON `fields`, from `gh pr view`. Throws when `gh` fails. */
async function prOf(ref, fields) {
	return JSON.parse(await sh(["gh", "pr", "view", ref, "--json", fields]));
}

/** True when `name` is a local branch. */
function isBranch(name) {
	return ok(["git", "show-ref", "--verify", "--quiet", `refs/heads/${name}`]);
}

/** True when the commit `a` is an ancestor of the commit `b`, or is `b`. */
function isAncestor(a, b) {
	return ok(["git", "merge-base", "--is-ancestor", a, b]);
}

/**
 * Fetches the head of the PR `number`, and puts the local branch `end` on it when the branch is missing or behind it. A
 * branch that is ahead of the head stays as it is. Throws when the branch has diverged from the head, and when it is
 * behind and a worktree has it checked out. Safe to repeat: `git branch -f` gives the same branch.
 */
async function pullBranch(number, end) {
	await sh(["git", "fetch", "origin", `pull/${number}/head`]);
	const head = await sh(["git", "rev-parse", "FETCH_HEAD"]);

	if (await isBranch(end)) {
		if (await isAncestor(head, end)) return;
		const pr = `PR #${number}`;

		if (!(await isAncestor(end, head))) throw new Error(`${end} has diverged from ${pr}; rebase it or delete it`);
		const path = await checkedOutAt(end);

		if (path !== undefined) throw new Error(`${end} is behind ${pr} and checked out at ${path}; update it there`);
	}

	await sh(["git", "branch", "-f", end, head]);
}

/**
 * Where `target` points, as `changeOf` reads it: `{ from, end, start, intent }`. `from` names the start in messages,
 * `end` is the ref that the change ends on, `start` the commit that it starts from, and `intent` the PR of a PR number.
 * Fetches the head of a PR, and moves its branch there with `pullBranch`.
 */
async function targetOf(target, base) {
	const mergeBase = (a, b) => sh(["git", "merge-base", a, b]);

	if (target === undefined || target === "") return { from: base, end: "HEAD", start: await mergeBase(base, "HEAD") };

	if (/^\d+$/.test(target)) {
		const pr = await prOf(target, "number,title,body,headRefName,baseRefName,isCrossRepository");
		const end = pr.isCrossRepository ? `pr/${pr.number}` : pr.headRefName;

		await pullBranch(pr.number, end);
		const from = pr.baseRefName;
		const start = await mergeBase((await isBranch(from)) ? from : `origin/${from}`, end);

		return { from, end, start, intent: prIntent(pr) };
	}

	const range = /^(.*?)\.\.\.?(.*)$/.exec(target);
	const from = range === null ? target : range[1] || "HEAD";
	const end = range === null ? "HEAD" : range[2] || "HEAD";

	return { from, end, start: await mergeBase(from, end) };
}

/**
 * The change of a script's `args`: `{ start, intent, checkout, dirty }`. A caller that gives `args.start` gives the
 * change: `start`, and `args.item` as the intent, with no Git step. Else the change is the one that `args.change`
 * points at, from the current directory, and the run gets the subject of its intent as its title. `args.change` is
 * nothing (the current branch from its merge base with `args.base`, default `main`), a PR number, a range `A..B` or
 * `A...B` (from the merge base of `A` and `B` to `B`), or a ref (from its merge base with `HEAD` to `HEAD`). The
 * intent is `args.item`, else the PR, else the commit messages of the change. `checkout` is the branch of a change
 * that ends on a branch that no worktree has, for a run in a worktree of its own. `dirty` says that the checkout has
 * changes that are not committed; with `wip`, a change that ends here commits them first as `wip`. Throws when the
 * change is empty, when its branch is checked out in another worktree, and when it ends on a commit that is not a
 * branch.
 */
async function changeOf(args, { wip = false } = {}) {
	if (args.start !== undefined) return { start: args.start, intent: args.item, dirty: false };
	const { from, end, start, intent } = await targetOf(args.change, args.base ?? "main");
	const here = await sh(["git", "branch", "--show-current"]);
	const branch = end === "HEAD" ? here : (await isBranch(end)) ? end : undefined;

	if (branch === undefined) throw new Error(`${end} is not a branch, and the fixes need one`);
	const local = branch === here;

	if (!local) {
		const path = await checkedOutAt(branch);

		if (path !== undefined) throw new Error(`${branch} is checked out at ${path}; run there`);
	}

	const dirty = local && (await sh(["git", "status", "--porcelain"])) !== "";

	if (dirty && wip) await commitAll("wip");
	const tip = local ? "HEAD" : branch;

	if (await ok(["git", "diff", "--quiet", start, tip])) throw new Error(`no change from ${from}`);

	const resolved = args.item ?? intent ?? (await intentOf(branch, `${start}..${tip}`));
	title(subjectOf(resolved));

	return local ? { start, intent: resolved, dirty } : { start, intent: resolved, checkout: branch, dirty };
}

/** The intent of the PR of `branch`, else the commit messages of `range`. A detached `HEAD` (`branch` empty) has no PR. */
async function intentOf(branch, range) {
	// Without a PR, or without gh, the commit messages say what the change is for.
	const pr = branch === "" ? undefined : await prOf(branch, "title,body").catch(() => undefined);

	return pr === undefined ? await sh(["git", "log", "--reverse", "--format=%B", range]) : prIntent(pr);
}

/**
 * Runs the script `name` again as a child run on the branch of `change`, with `args`, and returns its result with the
 * last report line `worktree <path>`.
 */
async function inCheckout(name, change, args) {
	const result = await run(name, { ...args, item: change.intent, start: change.start, checkout: change.checkout });

	return { ...result, report: [...result.report, `worktree ${await checkedOutAt(change.checkout)}`] };
}
