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

// The results of the child runs, without their report lines and run IDs.
const child = async (name, values) => {
	const { report: _report, runId: _runId, ...result } = await run(name, values)

	return result
}

phase("rpi")

const built = await child("rpi", { item, start })
const { plan, reply, memory } = built

if (built.status === "blocked") {
	const report = [`blocked ${subject} after 1 rounds: ${worktree}`, reply]

	return { status: "blocked", rounds: 1, reply, handoff: plan, memory, report }
}

phase("thermoloop")

const reviewed = await child("thermoloop", { item, rounds, start, patches, plan, reply, memory })

if (reviewed.status === "blocked") {
	const report = [`blocked ${subject} after ${reviewed.rounds} rounds: ${worktree}`, reviewed.reply]

	return { ...reviewed, report }
}

if (reviewed.status === "stopped") {
	return { ...reviewed, report: [`stopped ${subject} after ${reviewed.rounds} rounds: ${worktree}`] }
}

phase("judge")

status("judge")

const { status: _status, commit, ...verdict } = await child("judge", { item, start, commit: true })
const commitSubject = commit?.subject ?? subject
const commitMessage = commit === undefined ? subject : `${commit.subject}\n\n${commit.body}`

// One command, so that a repeat resets a squash commit that was made but not saved.
const squash = 'git reset -q --soft "$1" && git commit -q -m "$2"'

await sh(["sh", "-c", squash, "squash", start, commitMessage])

const short = await sh(["git", "rev-parse", "--short", "HEAD"])
const judged = verdict.score === undefined ? "failed" : verdict.score.toFixed(2)

log(`judge ${judged}: ${short} ${commitSubject}`)

return {
	status: "shipped",
	rounds: reviewed.rounds,
	head: short,
	subject: commitSubject,
	...verdict,
	memory: reviewed.memory,
	report: [`shipped ${subject} in ${reviewed.rounds} rounds, judge ${judged}, ${short}`],
}
