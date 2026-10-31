// `workflows ship` and each `workflows campaign` item, in its worktree: the child runs `rpi.js`, `thermoloop.js` and
// `judge.js`, then the squash. A caller may give `memory`, the `ref` of a run memory to go on with. The engine names
// the branch from `subject` of the result. Every Git step is safe to repeat: a resume runs a step again when its result
// was not saved.
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
const worktree = cwd

// The result of a child run that did not get to the judge, with the report lines of ship.
const unshipped = ({ status, rounds, reply, handoff, memory }) => {
	const report = [`${status} ${subject} after ${rounds} rounds: ${worktree}`]

	return { status, rounds, reply, handoff, memory, worktree, report: status === "blocked" ? [...report, reply] : report }
}

const notes = await memory(args.memory)

// A ship that opened its own memory ends with the lessons of its notes, and a report line for each one.
const finish = async (result) => {
	if (!notes.opened) return result

	const { report, memory: _, ...outcome } = result
	const lessons = await notes.harvest(item, outcome)
	const lines = lessons.map(({ cue, lesson, evidence }) => `  lesson ${cue}: ${lesson} (${evidence})`)

	return { ...result, lessons, report: [...report, ...lines] }
}

const built = await run("rpi", { item, start, memory: notes.ref })

if (built.status === "blocked") return finish(unshipped(built))

const { plan, reply } = built
const reviewed = await run("thermoloop", { item, rounds, start, patches, plan, reply, memory: notes.ref })

if (reviewed.status !== "approved") return finish(unshipped(reviewed))

const { score, answers, findings, judgeError, commit } = await run("judge", { item, start, commit: true })
const commitSubject = commit?.subject ?? subject
const commitMessage = commit === undefined ? subject : `${commit.subject}\n\n${commit.body}`

// One command, so that a repeat resets a squash commit that was made but not saved.
const squash = 'git reset -q --soft "$1" && git commit -q -m "$2"'

await sh(["sh", "-c", squash, "squash", start, commitMessage])

const short = await sh(["git", "rev-parse", "--short", "HEAD"])
const judged = score === undefined ? "failed" : score.toFixed(2)

log(`commit ${short} ${commitSubject}`)

return finish({
	status: "shipped",
	rounds: reviewed.rounds,
	head: short,
	subject: commitSubject,
	score,
	answers,
	findings,
	judgeError,
	divergence: commit?.divergence,
	memory: reviewed.memory,
	worktree,
	report: [`shipped ${subject} in ${reviewed.rounds} rounds, judge ${judged}, ${short}`],
})
