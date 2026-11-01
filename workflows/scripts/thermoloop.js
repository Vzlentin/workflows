// The thermoloop: the review loop of a change. `workflows thermoloop [<change>]` reviews the change that `changeOf`
// finds: the current branch from its merge base with `--base`, a PR number, a ref or a range. It commits the changes
// of the checkout first as `wip`, takes the intent from `--item`, the PR or the commit messages, and fixes the change
// in rounds until the reviewer answers SHIP. A change on a branch that no worktree has runs again as a child run in a
// worktree on that branch. A caller gives `start`, the commit that its change starts from, with `item`, and may give
// `plan` and `reply`, the handoff and the report of the implement before, `memory`, the `ref` of a run memory to go on
// with, and `patches`, the folder of the round patches. Without `memory`, the run ends with the lessons of its own
// memory. `ship.js` runs it after `rpi.js`. Every Git step is safe to repeat: a resume runs a step again when its result
// was not saved.
export const meta = {
	description: "Review a change (the current branch, a PR, a ref or a range), and fix it in rounds until the reviewer answers SHIP.",
	args: {
		change: { type: "string", positional: true },
		item: { type: "text", label: "work item" },
		base: { type: "string", default: "main" },
		rounds: { type: "number", default: 3 },
	},
	exit: { blocked: 1, stopped: 1 },
}

const { rounds, patches = runDir } = args
const change = await changeOf(args, { wip: true })

if (change.checkout !== undefined) return await inCheckout("thermoloop", change, { rounds })

const { start, intent: item } = change

const subject = subjectOf(item)

// In the script, and not in a template, so that a template edit cannot remove them.
const SHIP_OR_FIX = { enum: ["SHIP", "FIX"] }
const VERDICT = "When you are done, answer with respond: SHIP if your review has no finding, FIX if it has one or more."

// From round 2, the review covers only the last fix, so the rounds end.
const scope = (round) =>
	round === 1
		? ""
		: `Review the fix patch, round-${round}-fix.patch. The code of the earlier rounds is settled. A finding is a ` +
			"part of the plan that is not done, a problem that the fix added, or a reproduced bug."

const EVERY_FINDING = "Give every finding of your review, each with its fix. The next round fixes all of them."

const NOTES =
	"the document, and notes are what your review checked and found sound, and the lessons that later work needs, " +
	"one in each note. Do not repeat the findings: the document gives them."

const notes = await memory(args.memory)

// The handoff that the last implement round followed, and the implementer's reply of that round.
let plan = args.plan ?? ""
let reply = args.reply ?? ""
let before = start

// Each round reviews the change, and on FIX the reviewer's handoff is implemented as the next round.
for (let round = 1; ; round++) {
	phase(`round ${round}/${rounds}: review`)
	const change = [await patch(`round-${round}.patch`, start)]

	if (round > 1) change.push(await patch(`round-${round}-fix.patch`, before))
	const reviewer = notes.session("reviewer")
	const review = await prompts.review({ item, plan, change: change.join("\n"), scope: scope(round), reply })
	const verdict = await reviewer.ask(`${review}\n\n${VERDICT}`, { schema: SHIP_OR_FIX })
	log(verdict)

	if (verdict === "SHIP") {
		const head = await sh(["git", "rev-parse", "--short", "HEAD"])

		const report = [`approved ${subject} in ${round} rounds, ${head}`]

		return notes.finish(item, { status: "approved", rounds: round, memory: await noteLines(notes), report })
	}

	if (round === rounds) {
		const report = [`stopped ${subject} after ${round} rounds`]

		return notes.finish(item, { status: "stopped", rounds: round, handoff: plan, memory: await noteLines(notes), report })
	}

	plan = await reviewer.noted(round, `${await prompts.handoff()}\n\n${EVERY_FINDING}`, NOTES)
	before = await sh(["git", "rev-parse", "HEAD"])
	const next = round + 1

	phase(`round ${next}/${rounds}: implement`)
	const fixed = await run("implement", { plan, round: next, start, message: `round ${next}`, memory: notes.ref })
	reply = fixed.reply

	if (fixed.status === "blocked") {
		const report = [`blocked ${subject} after ${next} rounds`, reply]

		return notes.finish(item, { status: "blocked", rounds: next, reply, handoff: plan, memory: await noteLines(notes), report })
	}
}

async function patch(name, from) {
	const path = `${patches}/${name}`
	await sh(["git", "diff", "--binary", `--output=${path}`, from, "HEAD"])

	return path
}
