// `workflows land <run-id>` lands the branch of a completed root run of ship or campaign, or of an approved root run of
// thermoloop, on `main`, with no model call: 1. find the repository, the branch and the worktree of the run, through
// `pastRuns` and `git worktree list`; 2. switch the main checkout to `main` when it is on the branch, and check that it
// is clean and on `main`, that `main` equals `origin/main` after a fetch, and that the branch is a fast-forward of
// `main`; 3. push the branch; 4. wait for its CI; 5. push the head to `main` on `origin`, then fast-forward `main` in the
// main checkout; 6. delete the branch on `origin`; 7. for a run that serves an item, link the item to the head with a
// `landed` edge, and set the item to `done` when no live agent serves it; 8. wait for the CI of `main`; 9. sweep the
// run with `workflows sweep <run-id> --yes`, or for a run with no worktree of its own, delete its local branch; 10.
// check the repository. A thermoloop run with no worktree of its own lands in the repository that it ran in. A failed
// step from 1 to 6 refuses, with the step and the reason in one line, and changes nothing after it: a refusal before
// step 5 leaves `main` untouched on both sides. A failed step 7 is a `check failed` line. A red `main` gives
// `landed-red`, and nothing is reverted. Each CI wait is one shell command that reads `gh run list` every 15 s, bounded
// by `--wait` seconds (default 1800). It never squashes, never merges through a pull request and never force-pushes.
// Every Git step is safe to repeat: a resume runs a step again when its result was not saved, and finds it done.
export const meta = {
	description: "Land the branch of a run on main: push it, wait for its CI, fast-forward main, push main, and sweep the run or delete its branch.",
	args: {
		run: { type: "string", positional: true, label: "run ID", required: true },
		wait: { type: "number", default: 1800 },
	},
	exit: { landed: 0, "landed-red": 1, refused: 1 },
}

const id = String(args.run)
const bound = Number(args.wait)
const LANDED = ["ship", "campaign", "thermoloop"]

// The conclusions of a CI run that pass.
const PASSED = new Set(["success", "skipped", "neutral"])

title(`land ${id}`)

let step = 0

// Starts the step `n`, with the progress step `name`.
function begin(n, name) {
	step = n
	phase(name)
}

// The past run `id` of the first workflow of `LANDED` that has it as a completed root run, or undefined.
async function pastRun() {
	for (const workflow of LANDED) {
		const past = (await pastRuns(workflow)).find((run) => run.runId === id)

		if (past !== undefined) return { workflow, ...past }
	}

	return undefined
}

// Step 1, first part: the run to land, `{ workflow, repository, own, branch, serves }`, where `own` says that the run
// has a worktree of its own. Throws the reason of a refusal when the run has not ended, is not a run of `LANDED`, is a
// thermoloop run that is not approved, is a ship or campaign run with no worktree of its own, or has no branch.
async function runOf() {
	const past = await pastRun()

	if (past === undefined) throw new Error(`run ${id} has not ended or is not a run of ship, campaign or thermoloop`)
	const { workflow, cwd, result, serves } = past
	// The engine keeps `branch` and `status` of a result only as strings, and a result that is not an object has neither.
	const status = result?.status ?? "with no status"

	if (workflow === "thermoloop" && status !== "approved") {
		throw new Error(`the thermoloop run ${id} ended ${status}, not approved`)
	}

	const own = past.repository !== null

	if (!own && workflow !== "thermoloop") throw new Error(`the ${workflow} run ${id} has no worktree of its own`)
	const repository = past.repository ?? cwd

	// A thermoloop on a detached HEAD has the branch "".
	if (result?.branch === undefined || result.branch === "") {
		throw new Error(`the ${workflow} run ${id} ended ${status} and has no branch`)
	}

	// Step 6 deletes the branch on `origin`.
	if (result.branch === "main") throw new Error(`the ${workflow} run ${id} is on main`)

	return { workflow, repository, own, branch: result.branch, serves }
}

// Step 1, second part: the run `run` with its checkouts and its head, `{ ...run, main, worktree, head, short, subject }`,
// with `main` and `worktree` the entries of `worktrees`, and `worktree` undefined when the run has no worktree of its
// own and no worktree has its branch. Throws the reason of a refusal when the worktree of the branch is missing, gone or
// dirty.
async function locate(run) {
	const { repository, own, branch } = run
	const entries = await worktrees(repository)
	const main = entries[0]
	const worktree = entries.find((entry) => entry.branch === `refs/heads/${branch}`)

	if (worktree === undefined && own) throw new Error(`no worktree of ${repository} is on ${branch}`)

	if (worktree?.prunable) throw new Error(`the worktree ${worktree.path} of ${branch} is gone`)

	if (worktree !== undefined && (await sh(["git", "-C", worktree.path, "status", "--porcelain"])) !== "") {
		throw new Error(`the worktree ${worktree.path} has uncommitted changes`)
	}

	const head = await sh(["git", "-C", repository, "rev-parse", "--verify", `refs/heads/${branch}^{commit}`])
	const short = await sh(["git", "-C", repository, "rev-parse", "--short", head])
	const subject = await sh(["git", "-C", repository, "log", "-1", "--format=%s", head])

	return { ...run, main, worktree, head, short, subject }
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
async function land({ branch, main, head, short }) {
	begin(2, "check main")

	if (main.bare) throw new Error(`the main checkout ${main.path} is bare`)

	// Step 1 found the main checkout clean when it is on the branch.
	if (main.branch === `refs/heads/${branch}`) {
		await sh(["git", "-C", main.path, "switch", "-q", "main"])
	} else if (main.branch !== "refs/heads/main") {
		throw new Error(`the main checkout ${main.path} is not on main`)
	}

	if ((await sh(["git", "-C", main.path, "status", "--porcelain"])) !== "") {
		throw new Error(`the main checkout ${main.path} has uncommitted changes`)
	}

	await sh(["git", "-C", main.path, "fetch", "-q", "origin"])
	const local = await sh(["git", "-C", main.path, "rev-parse", "refs/heads/main"])
	const remote = await sh(["git", "-C", main.path, "rev-parse", "refs/remotes/origin/main"])
	const ahead = await ok(["git", "-C", main.path, "merge-base", "--is-ancestor", local, head])

	// `origin/main` at the head with `main` behind it is a step 5 that stopped between its push and its merge.
	if (local !== remote && !(remote === head && ahead)) {
		throw new Error(`main ${local.slice(0, short.length)} differs from origin/main ${remote.slice(0, short.length)}`)
	}

	if (!ahead) throw new Error(`${branch} is not a fast-forward of main`)

	begin(3, `push ${branch}`)
	await sh(["git", "-C", main.path, "push", "-q", "origin", `${head}:refs/heads/${branch}`])

	begin(4, `CI of ${branch}`)
	const red = await ciOf(main.path, branch, head, short)

	if (red !== undefined) throw new Error(red)

	begin(5, "land on main")
	// The push comes first, so that a rejected push leaves `main` untouched on both sides.
	await sh([
		"sh",
		"-c",
		'git -C "$1" push -q origin "$2:refs/heads/main" || exit; exec git -C "$1" merge -q --ff-only "$2"',
		"land",
		main.path,
		head,
	])

	begin(6, `delete ${branch} on origin`)
	// Skips the push when the branch is already gone from `origin`.
	await sh([
		"sh",
		"-c",
		'listed=$(git -C "$1" ls-remote origin "refs/heads/$2") || exit; if [ -n "$listed" ]; then git -C "$1" push -q origin --delete "$2" || exit; fi; exec git -C "$1" update-ref -d "refs/remotes/origin/$2"',
		"delete",
		main.path,
		branch,
	])
}

// The commit of `ref` on `origin`, from `git ls-remote` in `checkout`: empty when `origin` has no `ref`, undefined
// when `ls-remote` fails.
async function onOrigin(checkout, ref) {
	const listed = await sh(["git", "-C", checkout, "ls-remote", "origin", ref], { settle: true })

	return listed.error === undefined ? listed.split(/\s/)[0] : undefined
}

// Step 7: links the item `item` to the commit `head` with a `landed` edge, and sets it to `done` when no live agent
// serves it. Returns the line of the report. Never sets an item to `open`.
async function closeItem(item, head) {
	await harness({ type: "item", action: "link", from: `item:${item}`, kind: "landed", to: `commit:${head}` })
	const { edges } = await harness({ type: "item", action: "read", id: item })

	// Only the tree tells whether an agent lives, and only an agent that serves the item has a `serves` edge from `agent:`.
	if (edges.some((edge) => edge.kind === "serves" && edge.from.startsWith("agent:"))) {
		const { nodes } = await harness({ type: "tree" })

		const live = nodes.find(
			(node) =>
				node.kind === "agent" &&
				node.serves?.kind === "item" &&
				node.serves.id === item &&
				node.state !== "ended",
		)

		if (live !== undefined) return `item ${item} stays open: ${live.name} serves it`
	}

	await harness({ type: "item", action: "set", id: item, state: "done" })

	return `item ${item} done`
}

let run
let found

try {
	begin(1, "find the run")
	run = await runOf()
	found = await locate(run)
	await land(found)
} catch (error) {
	return {
		status: "refused",
		head: found?.short,
		branch: run?.branch,
		report: [`refused at step ${step}: ${oneLine(error.message)}`],
	}
}

const { repository, own, branch, main, worktree, head, short, subject, serves } = found
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
	const red = await ciOf(main.path, "main", head, short)

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
	if (own) {
		// Skipped when the worktree and the local branch are gone, as after a sweep whose result was not saved.
		await sh([
			"sh",
			"-c",
			`[ -e "$1" ] || git -C "$2" show-ref --verify --quiet "refs/heads/$3" || exit 0; exec ${workflowsCommand} sweep "$4" --yes`,
			"sweep",
			worktree.path,
			repository,
			branch,
			id,
		])
	} else {
		// Skipped when the local branch is gone, as after a delete whose result was not saved.
		await sh([
			"sh",
			"-c",
			'git -C "$1" show-ref --verify --quiet "refs/heads/$2" || exit 0; exec git -C "$1" branch -q -d "$2"',
			"delete",
			main.path,
			branch,
		])
	}
} catch (error) {
	failures.push(`check failed: sweep ${id}: ${oneLine(error.message)}`)
}

begin(10, "check")

const bare = await sh(["git", "-C", main.path, "config", "--get", "--bool", "core.bare"], { settle: true })

if (bare === "true") failures.push(`check failed: core.bare is true in ${main.path}`)

const mainHere = await sh(["git", "-C", main.path, "rev-parse", "refs/heads/main"], { settle: true })
const mainThere = await onOrigin(main.path, "refs/heads/main")

if (mainThere === undefined || mainHere !== mainThere) failures.push("check failed: main differs from main on origin")

const local = await ok(["git", "-C", main.path, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`])
const tracked = await ok(["git", "-C", main.path, "show-ref", "--verify", "--quiet", `refs/remotes/origin/${branch}`])

if (local || tracked) failures.push(`check failed: the branch ${branch} stays in ${repository}`)

if ((await onOrigin(main.path, `refs/heads/${branch}`)) !== "") failures.push(`check failed: the branch ${branch} stays on origin`)

return { status: landed.status, head: short, branch, report: [landed.line, ...notes, ...failures] }
