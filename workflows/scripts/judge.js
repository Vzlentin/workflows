// The judge of a change: the fixed rubric of `prompts/judge.md`. `workflows judge [<change>]` judges the change that
// `changeOf` finds, as `thermoloop.js` does, against the intent from `--item`, the PR or the commit messages. It
// commits nothing: it says that it does not judge the changes of the checkout that are not committed. A change on a
// branch that no worktree has runs again as a child run in a worktree on that branch. A caller gives `start`, the
// commit that its change starts from, with `item`, and with `commit: true` also gets the commit message of the change,
// which the judge writes in the same session. `ship.js` runs it on the change of its rounds, and `campaign.js` on the
// change of all its items.
export const meta = {
	description: "Judge a change (the current branch, a PR, a ref or a range) against its intent with the fixed rubric.",
	args: {
		change: { type: "string", positional: true },
		item: { type: "text", label: "work item" },
		base: { type: "string", default: "main" },
	},
	exit: { unjudged: 1 },
}

const { commit = false } = args

phase("judge")

const change = await changeOf(args)

if (change.checkout !== undefined) return await inCheckout("judge", change, {})

const { start, intent: item } = change
const notes = change.dirty ? ["uncommitted changes are not judged"] : []

for (const note of notes) log(note)

const subject = subjectOf(item)
const head = await sh(["git", "rev-parse", "HEAD"])

const VERDICT = {
	type: "object",
	required: ["answers", "findings"],
	properties: {
		answers: { type: "array", minItems: 8, maxItems: 8, items: { enum: ["PASS", "FAIL"] } },
		findings: { type: "array", items: { type: "string" } },
	},
}

const COMMIT = {
	type: "object",
	required: ["subject", "body"],
	properties: { subject: { type: "string" }, body: { type: "string" } },
}

const judge = session("judge")
let verdict

try {
	verdict = await judge.ask(prompts.judge({ item, base: start, head }), { schema: VERDICT })
} catch (error) {
	log(`judge failed on ${subject}: ${error.message}`)

	const report = [`judge failed on ${subject}: ${error.message}`, ...notes]

	return { status: "unjudged", judgeError: error.message, report }
}

const { answers, findings } = verdict
const score = scoreOf(answers)

log(`judge ${score.toFixed(2)}`)

const report = [`judge ${score.toFixed(2)}: ${subject}`, ...findings.map((finding) => `  ${finding}`), ...notes]
const judged = { status: "judged", score, answers, findings, report }
const message = commit ? await commitMessage() : undefined

return message === undefined ? judged : { ...judged, commit: message }

// The commit message that the judge writes for the change it judged, or undefined when it gives none.
async function commitMessage() {
	try {
		const answer = await judge.ask(prompts.commit(), { schema: COMMIT })

		return answer.subject.trim() === "" ? undefined : { subject: answer.subject.trim(), body: answer.body.trim() }
	} catch {
		return undefined
	}
}

// Zero when question 1 or 2 fails, else the passing fraction of questions 3 to 8.
function scoreOf(answers) {
	if (answers[0] !== "PASS" || answers[1] !== "PASS") return 0

	return answers.slice(2).filter((answer) => answer === "PASS").length / 6
}
