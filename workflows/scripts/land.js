// `workflows land <change>` lands a change on `main`, with no model call. The change is a PR number, a local branch of
// the main checkout of the current directory, or the ID of a completed root run, whose `change` gives the repository
// and the branch. 1. find the repository, the branch and the worktree that has it, through `gh pr view`, `pastRuns`
// and `git worktree list`; 2. switch the main checkout to `main` when it is on the branch, and check that it is clean
// and on `main`, that `main` equals `origin/main` after a fetch, and that the branch is a fast-forward of `main`; 3.
// push the branch; 4. wait for its CI; 5. push the head to `main` on `origin`, then fast-forward `main` in the main
// checkout; 6. delete the branch on `origin`; 7. for a run that serves an item, `closeItem` links the item to the head
// with a `landed` edge, and sets the item to `done` when no live agent serves it; 8. wait for the CI of `main`; 9. sweep
// the branch with `workflows sweep <branch> --yes` in the repository; 10. check the repository. A failed step from 1 to 6
// refuses, with the step and the reason in one line, and changes nothing after it: a refusal before step 5 leaves
// `main` untouched on both sides. A failed step 7 is a `check failed` line. A red `main` gives `landed-red`, and
// nothing is reverted. Each CI wait is one shell command that reads `gh run list` every 15 s, bounded by `--wait`
// seconds (default 1800). It never squashes, never merges through a pull request and never force-pushes. Every Git
// step is safe to repeat: a resume runs a step again when its result was not saved, and finds it done.
export const meta = {
	description: "Land a change (a branch, a PR number or a run ID) on main: push its branch, wait for its CI, fast-forward main, push main, and sweep the branch.",
	args: {
		change: { type: "string", positional: true, label: "change", required: true },
		wait: { type: "number", default: 1800 },
	},
	exit: { landed: 0, "landed-red": 1, refused: 1 },
}

const arg = String(args.change)
const bound = Number(args.wait)

// The conclusions of a CI run that pass.
const PASSED = new Set(["success", "skipped", "neutral"])

title(`land ${arg}`)

let step = 0

// Starts the step `n`, with the progress step `name`.
function begin(n, name) {
	step = n
	phase(name)
}

// Step 1, first part: the change of `arg`, `{ repository, branch, serves }`, where `serves` is what a run serves. A PR
// number gives the local branch of the PR, and a local branch of the main checkout gives itself, both in the main
// checkout of the current directory; else `arg` is a run ID, and its `change` gives both. Throws the reason of a
// refusal when `arg` is none of these, or names a run with no change.
async function changeOfArg() {
	const repository = (await worktrees())[0].path

	if (/^\d+$/.test(arg)) return { repository, branch: prBranch(await prOf(arg, "number,headRefName,isCrossRepository")) }

	if (await isBranch(arg, repository)) return { repository, branch: arg }
	let past

	try {
		past = (await pastRuns(null, { runs: [arg] }))[0]
	} catch {
		throw new Error(`${arg} is no PR number, no branch of ${repository} and no completed run`)
	}

	// The engine keeps `change` of a result only as an object of strings, and a result that is not an object has none.
	const change = past.result?.change

	// A run on a detached HEAD, or saved by an older version, has no `change`.
	if (change === undefined || change.branch === "") throw new Error(`the run ${arg} has no change`)

	return { repository: change.repository, branch: change.branch, serves: past.serves }
}

// Step 1, second part: the change `target` with its main checkout and its head, `{ ...target, main, head, short,
// subject }`, with `main` the first entry of `worktrees`, whose path is `repository`. Throws the reason of a refusal
// when the branch is `main` or missing, or when the worktree that has it is gone or dirty.
async function locate(target) {
	const { repository, branch } = target

	// Step 6 deletes the branch on `origin`.
	if (branch === "main") throw new Error("the branch is main")

	if (!(await isBranch(branch, repository))) throw new Error(`the branch ${branch} is not in ${repository}`)
	const entries = await worktrees(repository)
	const main = entries[0]
	const worktree = entries.find((entry) => entry.branch === `refs/heads/${branch}`)

	if (worktree?.prunable) throw new Error(`the worktree ${worktree.path} of ${branch} is gone`)

	if (worktree !== undefined && (await sh(["git", "-C", worktree.path, "status", "--porcelain"])) !== "") {
		throw new Error(`the worktree ${worktree.path} has uncommitted changes`)
	}

	const head = await sh(["git", "-C", repository, "rev-parse", "--verify", `refs/heads/${branch}^{commit}`])
	const short = await sh(["git", "-C", repository, "rev-parse", "--short", head])
	const subject = await sh(["git", "-C", repository, "log", "-1", "--format=%s", head])

	return { ...target, main, head, short, subject }
}

// The CI runs of the commit `head` on `ref`, from `gh run list` in `checkout`: one blocking shell command that reads
// them every 15 s until the list is not empty and every run is completed, or until `bound` seconds have passed. Returns
// the reason that the CI is red, with the short head `short`, or undefined when it passed.
async function ciOf(checkout, ref, head, short) {
	const output = await sh([
		"sh",
		"-c",
		`cd "$1" || exit
end=$(($(date +%s) + $4))
while :; do
	runs=$(gh run list --commit "$2" --branch "$3" --json databaseId,workflowName,status,conclusion,url) || exit
	if printf '%s' "$runs" | grep -q '"status"' && ! printf '%s' "$runs" | grep -Eo '"status": *"[^"]*"' | grep -qv '"completed"'; then break; fi
	left=$((end - $(date +%s)))
	[ "$left" -gt 0 ] || break
	sleep $((left < 15 ? left : 15))
done
printf '%s\\n' "$runs"`,
		"ci",
		checkout,
		head,
		ref,
		String(bound),
	])

	const runs = JSON.parse(output)
	const named = (list) => list.map((run) => `${run.workflowName} ${run.url}`).join(", ")
	const unfinished = runs.filter((run) => run.status !== "completed")
	const failed = runs.filter((run) => run.status === "completed" && !PASSED.has(run.conclusion))

	if (runs.length === 0) return `no CI run for ${short} on ${ref} after ${bound} s`

	if (failed.length > 0) return `CI failed on ${ref} at ${short}: ${named(failed)}`

	if (unfinished.length > 0) return `the CI of ${ref} at ${short} did not finish in ${bound} s: ${named(unfinished)}`

	return undefined
}

// Steps 2 to 6: switches the main checkout from the branch to `main`, checks `main`, pushes the branch, waits for its
// CI, lands the head on `main` and deletes the branch on `origin`. Throws the reason of a refusal.
async function land({ repository, branch, main, head, short }) {
	begin(2, "check main")

	if (main.bare) throw new Error(`the main checkout ${repository} is bare`)

	// Step 1 found the main checkout clean when it is on the branch.
	if (main.branch === `refs/heads/${branch}`) {
		await sh(["git", "-C", repository, "switch", "-q", "main"])
	} else if (main.branch !== "refs/heads/main") {
		throw new Error(`the main checkout ${repository} is not on main`)
	}

	if ((await sh(["git", "-C", repository, "status", "--porcelain"])) !== "") {
		throw new Error(`the main checkout ${repository} has uncommitted changes`)
	}

	await sh(["git", "-C", repository, "fetch", "-q", "origin"])
	const local = await sh(["git", "-C", repository, "rev-parse", "refs/heads/main"])
	const remote = await sh(["git", "-C", repository, "rev-parse", "refs/remotes/origin/main"])
	const ahead = await ok(["git", "-C", repository, "merge-base", "--is-ancestor", local, head])

	// `origin/main` at the head with `main` behind it is a step 5 that stopped between its push and its merge.
	if (local !== remote && !(remote === head && ahead)) {
		throw new Error(`main ${local.slice(0, short.length)} differs from origin/main ${remote.slice(0, short.length)}`)
	}

	if (!ahead) throw new Error(`${branch} is not a fast-forward of main`)

	begin(3, `push ${branch}`)
	await sh(["git", "-C", repository, "push", "-q", "origin", `${head}:refs/heads/${branch}`])

	begin(4, `CI of ${branch}`)
	const red = await ciOf(repository, branch, head, short)

	if (red !== undefined) throw new Error(red)

	begin(5, "land on main")
	// The push comes first, so that a rejected push leaves `main` untouched on both sides.
	await sh([
		"sh",
		"-c",
		'git -C "$1" push -q origin "$2:refs/heads/main" || exit; exec git -C "$1" merge -q --ff-only "$2"',
		"land",
		repository,
		head,
	])

	begin(6, `delete ${branch} on origin`)
	// Skips the push when the branch is already gone from `origin`.
	await sh([
		"sh",
		"-c",
		'listed=$(git -C "$1" ls-remote origin "refs/heads/$2") || exit; if [ -n "$listed" ]; then git -C "$1" push -q origin --delete "$2" || exit; fi; exec git -C "$1" update-ref -d "refs/remotes/origin/$2"',
		"delete",
		repository,
		branch,
	])
}

// The commit of `ref` on `origin`, from `git ls-remote` in `checkout`: empty when `origin` has no `ref`, undefined
// when `ls-remote` fails.
async function onOrigin(checkout, ref) {
	const listed = await sh(["git", "-C", checkout, "ls-remote", "origin", ref], { settle: true })

	return listed.error === undefined ? listed.split(/\s/)[0] : undefined
}

let change
let found

try {
	begin(1, "find the change")
	const target = await changeOfArg()
	change = { repository: target.repository, branch: target.branch }
	found = await locate(target)
	await land(found)
} catch (error) {
	return {
		status: "refused",
		head: found?.short,
		change,
		report: [`refused at step ${step}: ${oneLine(error.message)}`],
	}
}

const { repository, branch, head, short, subject, serves } = found
const notes = []
const failures = []

if (serves?.item !== undefined) {
	begin(7, `item ${serves.item}`)

	try {
		notes.push(await closeItem(serves.item, head))
	} catch (error) {
		failures.push(`check failed: item ${serves.item}: ${oneLine(error.message)}`)
	}
}

begin(8, "CI of main")

let landed

try {
	const red = await ciOf(repository, "main", head, short)

	landed =
		red === undefined
			? { status: "landed", line: `landed ${subject} ${short}, CI passed on the branch and on main` }
			: { status: "landed-red", line: `landed-red ${subject} ${short}, CI passed on the branch; ${red}` }
} catch (error) {
	landed = {
		status: "landed-red",
		line: `landed-red ${subject} ${short}, CI passed on the branch; the CI of main is unknown: ${oneLine(error.message)}`,
	}
}

begin(9, "sweep")

try {
	// Skipped when the local branch is gone, as after a sweep whose result was not saved.
	await sh([
		"sh",
		"-c",
		`git -C "$1" show-ref --verify --quiet "refs/heads/$2" || exit 0; cd "$1" && exec ${workflowsCommand} sweep "$2" --yes`,
		"sweep",
		repository,
		branch,
	])
} catch (error) {
	failures.push(`check failed: sweep ${branch}: ${oneLine(error.message)}`)
}

begin(10, "check")

const bare = await sh(["git", "-C", repository, "config", "--get", "--bool", "core.bare"], { settle: true })

if (bare === "true") failures.push(`check failed: core.bare is true in ${repository}`)

const mainHere = await sh(["git", "-C", repository, "rev-parse", "refs/heads/main"], { settle: true })
const mainThere = await onOrigin(repository, "refs/heads/main")

if (mainThere === undefined || mainHere !== mainThere) failures.push("check failed: main differs from main on origin")

const local = await isBranch(branch, repository)
const tracked = await ok(["git", "-C", repository, "show-ref", "--verify", "--quiet", `refs/remotes/origin/${branch}`])

if (local || tracked) failures.push(`check failed: the branch ${branch} stays in ${repository}`)

if ((await onOrigin(repository, `refs/heads/${branch}`)) !== "") failures.push(`check failed: the branch ${branch} stays on origin`)

return { status: landed.status, head: short, change, report: [landed.line, ...notes, ...failures] }
