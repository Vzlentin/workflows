// The review loop of a change. `workflows review` reviews the branch of the current directory from its merge base
// with `--base`, and fixes it in rounds until the reviewer answers SHIP. `ship.js` runs it after `rpi.js` with the start
// commit, the plan, the implementer's reply and the memory. Every Git step is safe to repeat: a resume runs a step
// again when its result was not saved.
export const meta = {
	description: "Review the change of the current branch, and fix it in rounds until the reviewer answers SHIP.",
	args: {
		item: { type: "text", positional: true, label: "work item", required: true },
		base: { type: "string", default: "main" },
		rounds: { type: "number", default: 3 },
	},
	exit: { blocked: 1, stopped: 1 },
}

const { item, rounds, patches = runDir } = args
const subject = subjectOf(item)

// A caller gives `start`, and its change; without one, the review takes the branch as it is.
if (args.start === undefined && (await sh(["git", "status", "--porcelain"])) !== "") {
	throw new Error("the checkout has changes that are not committed; commit or stash them before the review")
}

const start = args.start ?? (await sh(["git", "merge-base", args.base, "HEAD"]))

if (args.start === undefined && (await ok(["git", "diff", "--quiet", start, "HEAD"]))) {
	throw new Error(`no change from ${args.base} to review`)
}

const SHIP_OR_FIX = { enum: ["SHIP", "FIX"] }

// With the SHIP or FIX rule, and not in a template, so that a template edit cannot remove it.
const EVIDENCE =
	"A reversal of a memory note, or of a choice that the implementer explained, stays only with a defect that this " +
	"review showed: a reproduced bug, a failing check, or a quoted rule of the work item that the choice breaks. Write " +
	"it as `reverses #k: <defect>`. A preference, less code, a stricter check, or a claim from a few observations is " +
	"not a defect."

const notes = memory(args.memory)

// The handoff that the last implement round followed, and the implementer's reply of that round.
let plan = args.plan ?? ""
let reply = args.reply ?? ""
let before = start

for (let round = 1; round <= rounds; round++) {
	if (round > 1) {
		phase(`round ${round}: implement`)
		status(`round ${round}/${rounds}: implement`)

		reply = await notes
			.session("implementer")
			.noted(round, prompts.implement({ plan }), "your report, and notes are what you tried and what you observed.")

		await commitAll(`round ${round}`)

		if (await ok(["git", "diff", "--quiet", start, "HEAD"])) {
			const report = [`blocked ${subject} after ${round} rounds`, reply]

			return { status: "blocked", rounds: round, reply, handoff: plan, memory: notes.lines, report }
		}

		log(await diffStat(before))
	}

	phase(`round ${round}: review`)
	status(`round ${round}/${rounds}: review`)
	const change = [await patch(`round-${round}.patch`, start)]

	if (round > 1) change.push(await patch(`round-${round}-fix.patch`, before))
	const reviewer = notes.session("reviewer")
	await reviewer.ask(prompts.review({ item, plan, change: change.join("\n"), reply }))
	const answer = "Answer with respond: SHIP if nothing needs to change, FIX otherwise."
	const verdict = await reviewer.ask(`${await prompts.challenge()}\n\n${EVIDENCE}\n\n${answer}`, { schema: SHIP_OR_FIX })
	log(verdict)

	if (verdict === "SHIP") {
		const head = await sh(["git", "rev-parse", "--short", "HEAD"])

		return { status: "approved", rounds: round, memory: notes.lines, report: [`approved ${subject} in ${round} rounds, ${head}`] }
	}

	if (round === rounds) {
		const report = [`stopped ${subject} after ${round} rounds`]

		return { status: "stopped", rounds: round, handoff: plan, memory: notes.lines, report }
	}

	plan = await reviewer.noted(
		round,
		prompts.handoff(),
		"the document, and notes are the decisions of your challenge, with the findings that you cut and why.",
	)
	before = await sh(["git", "rev-parse", "HEAD"])
}

async function patch(name, from) {
	const path = `${patches}/${name}`
	await sh(["git", "diff", "--binary", `--output=${path}`, from, "HEAD"])

	return path
}
