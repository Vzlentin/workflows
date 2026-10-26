// The judge of a change: the fixed rubric of `prompts/judge.md`. `workflows judge` judges the branch of the current
// directory from its merge base with `--base`. A caller gives `start`, the commit that its change starts from, and with
// `commit: true` also gets the commit message of the change, which the judge writes in the same session. `ship.js`
// runs it on the change of its rounds, and `campaign.js` on the change of all its items.
export const meta = {
	description: "Judge the change of the current branch against a work item with the fixed rubric.",
	args: {
		item: { type: "text", positional: true, label: "work item", required: true },
		base: { type: "string", default: "main" },
	},
	exit: { unjudged: 1 },
}

const { item, commit = false } = args

phase("judge")

const subject = subjectOf(item)
const base = args.start ?? (await branchStart(args.base))
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
	verdict = await judge.ask(prompts.judge({ item, base, head }), { schema: VERDICT })
} catch (error) {
	log(`judge failed on ${subject}: ${error.message}`)

	return { status: "unjudged", judgeError: error.message, report: [`judge failed on ${subject}: ${error.message}`] }
}

const judged = { status: "judged", score: score(verdict.answers), answers: verdict.answers, findings: verdict.findings }

log(`judge ${judged.score.toFixed(2)}`)

judged.report = [`judge ${judged.score.toFixed(2)}: ${subject}`, ...verdict.findings.map((finding) => `  ${finding}`)]

if (commit) {
	try {
		const answer = await judge.ask(prompts.commit(), { schema: COMMIT })

		if (answer.subject.trim() !== "") judged.commit = { subject: answer.subject.trim(), body: answer.body.trim() }
	} catch {}
}

return judged

// Zero when question 1 or 2 fails, else the passing fraction of questions 3 to 8.
function score(answers) {
	if (answers[0] !== "PASS" || answers[1] !== "PASS") return 0

	return answers.slice(2).filter((answer) => answer === "PASS").length / 6
}
