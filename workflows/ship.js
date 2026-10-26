// `workflows ship` and each `workflows campaign` item, in its worktree: the child runs `rpi.js`, `thermoloop.js` and
// `judge.js`, then the squash. The engine names the branch from `subject` of the result. Every Git step is safe to
// repeat: a resume runs a step again when its result was not saved.
export const meta = {
	description: "Ship one work item onto a new branch: research, plan, implement, review rounds, judge, and one squashed commit.",
	args: {
		item: { type: "text", positional: true, label: "work item", required: true },
		rounds: { type: "number", default: 3 },
	},
	worktree: true,
	exit: { blocked: 1, stopped: 1 },
}

const { item, rounds, start, patches = runDir } = args

// The engine gives a `meta.worktree` script `start` as a string or not at all.
if (start === undefined) {
	throw new Error("ship runs only through workflows ship or workflows campaign, which give it the start commit")
}

const subject = subjectOf(item)
const worktree = `${runDir}/worktree`

// The result of a child run that did not get to the judge, with the report lines of ship.
const unshipped = (result) => {
	const report = [`${result.status} ${subject} after ${result.rounds} rounds: ${worktree}`]

	return { ...result, report: result.status === "blocked" ? [...report, result.reply] : report }
}

const built = await runChild("rpi", { item, start })

if (built.status === "blocked") return unshipped(built)

const { plan, reply } = built
const reviewed = await runChild("thermoloop", { item, rounds, start, patches, plan, reply, memory: built.memory })

if (reviewed.status !== "approved") return unshipped(reviewed)

const { status: _status, commit, ...verdict } = await runChild("judge", { item, start, commit: true })
const commitSubject = commit?.subject ?? subject
const commitMessage = commit === undefined ? subject : `${commit.subject}\n\n${commit.body}`

// One command, so that a repeat resets a squash commit that was made but not saved.
const squash = 'git reset -q --soft "$1" && git commit -q -m "$2"'

await sh(["sh", "-c", squash, "squash", start, commitMessage])

const short = await sh(["git", "rev-parse", "--short", "HEAD"])
const judged = verdict.score === undefined ? "failed" : verdict.score.toFixed(2)

log(`commit ${short} ${commitSubject}`)

return {
	status: "shipped",
	rounds: reviewed.rounds,
	head: short,
	subject: commitSubject,
	...verdict,
	memory: reviewed.memory,
	report: [`shipped ${subject} in ${reviewed.rounds} rounds, judge ${judged}, ${short}`],
}
