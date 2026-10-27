// The thermoloop: the review loop of a change. `workflows thermoloop` reviews the branch of the current directory from
// its merge base with `--base`, and fixes it in rounds until the reviewer answers SHIP. A caller gives `start`, the
// commit that its change starts from, and may give `plan` and `reply`, the handoff and the report of the implement
// before, `memory`, the path of a run memory to go on with, `itemNumber`, the campaign item of its notes, and
// `patches`, the folder of the round patches.
// `ship.js` runs it after `rpi.js`. Every Git step is safe to repeat: a resume runs a step again when its result was
// not saved.
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

const start = args.start ?? (await branchStart(args.base))

const SHIP_OR_FIX = { enum: ["SHIP", "FIX"] }

// With the SHIP or FIX rule, and not in a template, so that a template edit cannot remove it.
const EVIDENCE =
	"A reversal of a memory note, or of a choice that the implementer explained, stays only with a defect that this " +
	"review showed: a reproduced bug, a failing check, or a quoted rule of the work item that the choice breaks. Write " +
	"it as `reverses #k: <defect>`. A preference, less code, a stricter check, or a claim from a few observations is " +
	"not a defect."

const notes = await memory(args.memory, args.itemNumber)
const lines = async () => (await notes.text).split("\n").filter(Boolean)

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
	await reviewer.ask(prompts.review({ item, plan, change: change.join("\n"), reply }))
	const answer = "Answer with respond: SHIP if nothing needs to change, FIX otherwise."
	const verdict = await reviewer.ask(`${await prompts.challenge()}\n\n${EVIDENCE}\n\n${answer}`, { schema: SHIP_OR_FIX })
	log(verdict)

	if (verdict === "SHIP") {
		const head = await sh(["git", "rev-parse", "--short", "HEAD"])

		return { status: "approved", rounds: round, memory: await lines(), report: [`approved ${subject} in ${round} rounds, ${head}`] }
	}

	if (round === rounds) {
		const report = [`stopped ${subject} after ${round} rounds`]

		return { status: "stopped", rounds: round, handoff: plan, memory: await lines(), report }
	}

	plan = await reviewer.noted(
		round,
		prompts.handoff(),
		"the document, and notes are the decisions of your challenge, with the findings that you cut and why.",
	)
	before = await sh(["git", "rev-parse", "HEAD"])
	const next = round + 1

	phase(`round ${next}/${rounds}: implement`)
	const fixed = await run("implement", { plan, round: next, start, message: `round ${next}`, memory: notes.path, itemNumber: notes.item })
	reply = fixed.reply

	if (fixed.status === "blocked") {
		const report = [`blocked ${subject} after ${next} rounds`, reply]

		return { status: "blocked", rounds: next, reply, handoff: plan, memory: await lines(), report }
	}
}

async function patch(name, from) {
	const path = `${patches}/${name}`
	await sh(["git", "diff", "--binary", `--output=${path}`, from, "HEAD"])

	return path
}
