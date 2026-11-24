// Script lib: Git steps.

/**
 * Stages every change and commits it as `message` when something is staged. Safe to repeat: the check and the commit
 * are one command, so a repeat after a commit whose result was not saved finds nothing staged and makes no commit. The
 * shell runs the commit with `exec`, so a stop of the run also stops the commit.
 */
async function commitAll(message) {
	await sh(["git", "add", "-A"]);
	await sh(["sh", "-c", 'git diff --cached --quiet || exec git commit -q -m "$1"', "commit", message]);
}

/**
 * Squashes the commits since `start` into one commit with `message`, logs `commit <short> <subject>` and returns the
 * short head. When nothing changed since `start`, it makes no commit, logs `nothing to commit since <short>` and returns
 * the short head, which is `start`. The shell runs the commit with `exec`, so a stop of the run also stops the commit.
 */
async function squash(start, message, subject) {
	// One command, so that a repeat resets a squash commit that was made but not saved.
	// The commit runs in the background under a trap, so that a stop of the call also stops it.
	const output = await sh([
		"sh",
		"-c",
		'git reset -q --soft "$1" || exit; if git diff --cached --quiet; then echo "none $(git rev-parse --short HEAD)"; else trap \'kill "$c"\' TERM; git commit -q -m "$2" & c=$!; wait "$c" || exit; echo "commit $(git rev-parse --short HEAD)"; fi',
		"squash",
		start,
		message,
	]);

	const [made, short] = output.split("\n").at(-1).split(" ");

	log(made === "none" ? `nothing to commit since ${short}` : `commit ${short} ${subject}`);

	return short;
}

/** Writes the binary diff from `from` to `HEAD` to the file `path`, and returns `path`. */
async function writePatch(path, from) {
	await sh(["git", "diff", "--binary", `--output=${path}`, from, "HEAD"]);

	return path;
}

/**
 * The worktrees of the repository of `dir`, default the directory of `sh`, from `git worktree list --porcelain`, the
 * main checkout first: `{ path, branch, bare, prunable }`, where `branch` is the full ref, or undefined when the
 * worktree is detached or bare.
 */
async function worktrees(dir) {
	const entries = [];
	const listed = await sh(["git", ...(dir === undefined ? [] : ["-C", dir]), "worktree", "list", "--porcelain"]);

	for (const line of listed.split("\n")) {
		if (line.startsWith("worktree "))
			entries.push({ path: line.slice("worktree ".length), branch: undefined, bare: false, prunable: false });
		else if (line.startsWith("branch ")) entries.at(-1).branch = line.slice("branch ".length);
		else if (line === "bare") entries.at(-1).bare = true;
		else if (line === "prunable" || line.startsWith("prunable ")) entries.at(-1).prunable = true;
	}

	return entries;
}

/**
 * The change of the current checkout: `{ repository, branch }`, with the main checkout of its repository and its
 * branch. Undefined on a detached HEAD, whose branch is unknown.
 */
async function checkoutChange() {
	const branch = await sh(["git", "branch", "--show-current"]);

	return branch === "" ? undefined : { repository: (await worktrees())[0].path, branch };
}

/** The path of the worktree that has `branch` checked out, or undefined when no worktree has it. */
async function checkedOutAt(branch) {
	return (await worktrees()).find((entry) => entry.branch === `refs/heads/${branch}`)?.path;
}

/** `# <title>` and the body of `pr`. */
function prIntent(pr) {
	return `# ${pr.title}\n\n${pr.body}`.trim();
}

/** The local branch of the pull request `pr`: `pr/<number>` for one from another repository, else its head branch. */
function prBranch(pr) {
	return pr.fork ? `pr/${pr.number}` : pr.branch;
}

/** True when `name` is a local branch of the repository of `dir`, default the directory of `sh`. */
function isBranch(name, dir) {
	return ok([
		"git",
		...(dir === undefined ? [] : ["-C", dir]),
		"show-ref",
		"--verify",
		"--quiet",
		`refs/heads/${name}`,
	]);
}

/** True when the commit `a` is an ancestor of the commit `b`, or is `b`. */
function isAncestor(a, b) {
	return ok(["git", "merge-base", "--is-ancestor", a, b]);
}

/**
 * Fetches the head of the pull request `pr` from its `ref` on `origin`, and puts the local branch `end` on it when the
 * branch is missing or behind it. A branch that is ahead of the head stays as it is. Throws when the branch has
 * diverged from the head, and when it is behind and a worktree has it checked out. Safe to repeat: `git branch -f`
 * gives the same branch.
 */
async function pullBranch(pr, end) {
	await sh(["git", "fetch", "origin", pr.ref]);
	const head = await sh(["git", "rev-parse", "FETCH_HEAD"]);

	if (await isBranch(end)) {
		if (await isAncestor(head, end)) return;
		const name = `PR #${pr.number}`;

		if (!(await isAncestor(end, head))) throw new Error(`${end} has diverged from ${name}; rebase it or delete it`);
		const path = await checkedOutAt(end);

		if (path !== undefined) throw new Error(`${end} is behind ${name} and checked out at ${path}; update it there`);
	}

	await sh(["git", "branch", "-f", end, head]);
}

/**
 * The ref of the branch `base` that a change starts from: `refs/remotes/origin/<base>` when it is a commit, else
 * `base`. It does not fetch, so a stale `origin/<base>` stays as it is.
 */
async function baseRef(base) {
	const remote = `refs/remotes/origin/${base}`;

	return (await ok(["git", "rev-parse", "--verify", "--quiet", `${remote}^{commit}`])) ? remote : base;
}

/**
 * Where `target` points, as `changeOf` reads it: `{ from, end, start, intent }`. `from` names the start in messages,
 * `end` is the ref that the change ends on, `start` the commit that it starts from, and `intent` the PR of a PR number.
 * Fetches the head of a PR, and moves its branch there with `pullBranch`. A plain value that is a local branch other
 * than `base` reads as that branch, wherever it is checked out: from its merge base with `base` to the branch. For no
 * value and a local branch, `base` is `origin/<base>` when that ref exists, as `baseRef` says.
 */
async function targetOf(target, base) {
	const mergeBase = (a, b) => sh(["git", "merge-base", a, b]);

	if (target === undefined || target === "") {
		return { from: base, end: "HEAD", start: await mergeBase(await baseRef(base), "HEAD") };
	}

	if (/^\d+$/.test(target)) {
		const pr = await gitHost.state(Number(target));
		const end = prBranch(pr);

		await pullBranch(pr, end);
		const from = pr.base;
		const start = await mergeBase((await isBranch(from)) ? from : `origin/${from}`, end);

		return { from, end, start, intent: prIntent(pr) };
	}

	const range = /^(.*?)\.\.\.?(.*)$/.exec(target);

	if (range === null && target !== base && (await isBranch(target)))
		return { from: base, end: target, start: await mergeBase(await baseRef(base), target) };
	const from = range === null ? target : range[1] || "HEAD";
	const end = range === null ? "HEAD" : range[2] || "HEAD";

	return { from, end, start: await mergeBase(from, end) };
}

/**
 * The change of a script's `args`: `{ start, intent, checkout, dirty }`. A caller that gives `args.start` gives the
 * change: `start`, and `args.item` as the intent, with no Git step. Else the change is the one that `args.change`
 * points at, from the current directory, and the run gets the subject of its intent as its title. `args.change` is
 * nothing (the current branch from its merge base with `args.base`, default `main`), a PR number, a range `A..B` or
 * `A...B` (from the merge base of `A` and `B` to `B`), a local branch other than `args.base` (from its merge base with
 * `args.base` to the branch), or a ref (from its merge base with `HEAD` to `HEAD`). For nothing and a local branch,
 * the merge base is with `origin/<args.base>` when that ref exists, with no fetch. The intent is `args.item`, else
 * the PR, else the commit messages of the change. A change on the current branch runs here. `checkout` is the branch
 * of a change that ends on a branch other than the current one, for a run in the worktree that has it, else in a
 * worktree of its own. `dirty` says that the current checkout has changes that are not committed; with `wip`, a change
 * that ends here commits them first as `wip`. Throws when the change is empty, when it ends on a commit that is not a
 * branch, and, with `wip`, when the other worktree that has its branch has changes that are not committed.
 */
async function changeOf(args, { wip = false } = {}) {
	if (args.start !== undefined) return { start: args.start, intent: args.item, dirty: false };
	const here = await sh(["git", "branch", "--show-current"]);
	const { from, end, start, intent } = await targetOf(args.change, args.base ?? "main");
	const branch = end === "HEAD" ? here : (await isBranch(end)) ? end : undefined;

	if (branch === undefined) throw new Error(`the change ends on ${end}, which is not a branch`);
	const local = branch === here;

	if (!local && wip) {
		const path = await checkedOutAt(branch);

		if (path !== undefined && (await sh(["git", "-C", path, "status", "--porcelain"])) !== "")
			throw new Error(`the worktree ${path} of ${branch} has uncommitted changes`);
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
	// Without a PR, or without a Git host, the commit messages say what the change is for.
	if (branch !== "") {
		const pr = await gitHost.state(branch, { settle: true });

		if (pr !== null && pr.error === undefined) return prIntent(pr);
	}

	return await sh(["git", "log", "--reverse", "--format=%B", range]);
}

/**
 * Runs the script `name` again as a child run on the branch of `change`, with `args`: in the worktree that has the
 * branch checked out, else in a worktree of its own on it. Returns its result with the last report line
 * `worktree <path>`.
 */
async function inCheckout(name, change, args) {
	const path = await checkedOutAt(change.checkout);
	const place = path === undefined ? { checkout: change.checkout } : { repo: path };
	const result = await run(name, { ...args, item: change.intent, start: change.start, ...place });

	return { ...result, report: [...result.report, `worktree ${path ?? (await checkedOutAt(change.checkout))}`] };
}
