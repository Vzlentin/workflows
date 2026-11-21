// The judge of a change: the fixed rubric of `prompts/judge.md`. `workflows judge [<change>]` judges the change that
// `changeOf` finds, as `thermoloop.js` does, against the intent from `--item`, the PR or the commit messages. It
// commits nothing: it says that it does not judge the changes of the checkout that are not committed. A change on
// another branch runs again as a child run in the worktree that has that branch, else in a worktree of its own on it. A
// caller gives `start`, the commit that its change starts from, with `item`. The result also gives `divergence`, one
// line on how the change differs from its intent, or `none`. A score of 0 is `rejected`, and exits 1. A judge that
// gives no verdict fails the run, and a resume judges again. `ship.js` runs it on the squashed commit of an item,
// `fix.js` on the squashed commit of an item after its fix, and `campaign.js` on the change of all its items.
// `--repo <path>` runs it in the checkout of that local repository, as from its directory.
export const meta = {
	description: "Judge a change (the current branch, a PR, a ref or a range) against its intent with the fixed rubric.",
	args: {
		change: { type: "string", positional: true },
		item: { type: "text", label: "work item" },
		base: { type: "string", default: "main" },
	},
	repo: true,
	exit: { judged: 0, rejected: 1 },
	outline: [{ kind: "agent", role: "judge", label: "judge" }],
}

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
	required: ["answers", "findings", "divergence"],
	properties: {
		answers: { type: "array", minItems: 8, maxItems: 8, items: { enum: ["PASS", "FAIL"] } },
		findings: { type: "array", items: { type: "string" } },
		divergence: { type: "string" },
	},
}

const judge = session("judge")
const verdict = await judge.ask(prompts.judge({ item, base: start, head }), { schema: VERDICT })

const { answers, findings } = verdict
const score = scoreOf(answers)

log(`judge ${score.toFixed(2)}`)

const report = [`judge ${score.toFixed(2)}: ${subject}`, ...findings.map((finding) => `  ${finding}`), ...notes]

return { status: score === 0 ? "rejected" : "judged", change: await checkoutChange(), score, answers, findings, divergence: oneLine(verdict.divergence), report }

// Zero when question 1 or 2 fails, else the passing fraction of questions 3 to 8.
function scoreOf(answers) {
	if (answers[0] !== "PASS" || answers[1] !== "PASS") return 0

	return answers.slice(2).filter((answer) => answer === "PASS").length / 6
}
