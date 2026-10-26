// The research, the plan, the rounds, the judge and the squash of `workflows ship` and of each `workflows campaign`
// item, in its worktree. The rounds are the child run `review.js`, and the judge the child run `judge.js`. The engine
// names the branch from `subject` of the result. Every Git step is safe to repeat: a resume runs a step again when its
// result was not saved.
export const meta = {
	description: "Ship one work item onto a new branch: research, plan, implement and review rounds, judge, and one squashed commit.",
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

const subject = (item.split("\n").find((line) => line.trim() !== "") ?? "").replace(/^#+/, "").trim()
const worktree = `${runDir}/worktree`

const NOTED = {
	type: "object",
	required: ["text", "notes"],
	properties: { text: { type: "string" }, notes: { type: "array", items: { type: "string" } } },
}

// The research documents the code as it is, in a session of its own, so that the plan starts from its document and
// not from the context of the search.
phase("research")

status("research")

const research = await session("researcher").ask(prompts.research({ item }))

phase("plan")

status("plan")

const planner = session("planner")

await planner.ask(prompts.plan({ item, research }))

await planner.ask(prompts.challenge())

const rule = "the document, and notes are the decisions of this session, each with its reason."

const handoff = await planner.ask(`${await prompts.handoff()}\n\nWhen you are done, answer with respond: text is ${rule}`, {
	schema: NOTED,
})

// The first notes of the run memory, which the rounds append to.
const memory = handoff.notes
	.map((note) => note.replace(/\s+/g, " ").trim())
	.filter((note) => note !== "")
	.map((note, i) => `#${i + 1} planner 0: ${note}`)

phase("review")

// The rounds show their own status.
status("")

const { report: _report, runId: _runId, ...reviewed } = await run("review", {
	item,
	rounds,
	start,
	patches,
	plan: handoff.text,
	memory,
})

if (reviewed.status === "blocked") {
	return { ...reviewed, report: [`blocked ${subject} after ${reviewed.rounds} rounds: ${worktree}`, reviewed.reply] }
}

if (reviewed.status === "stopped") {
	return { ...reviewed, report: [`stopped ${subject} after ${reviewed.rounds} rounds: ${worktree}`] }
}

phase("judge")

status("judge")

const { report: _judged, runId: _judgeRun, status: _status, commit, ...verdict } = await run("judge", {
	item,
	start,
	commit: true,
})

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
