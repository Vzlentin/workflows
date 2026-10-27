// One implement turn: the implementer follows a plan, and every change is committed. `rpi.js` and `thermoloop.js` run
// it in their directory. A caller gives `start`, the commit that the change starts from, and may give `memory`, the
// path of a run memory to go on with, and `itemNumber`, the campaign item of its notes. Every Git step is safe to
// repeat: a resume runs a step again when its result was not saved.
export const meta = {
	description: "Implement a plan in the current directory, and commit the change.",
	args: {
		plan: { type: "text", positional: true, label: "plan", required: true },
		message: { type: "string" },
		round: { type: "number", default: 1 },
	},
	exit: { blocked: 1 },
}

const { plan, round } = args
const subject = subjectOf(plan)

if (args.start === undefined) await assertClean()

const before = await sh(["git", "rev-parse", "HEAD"])
const start = args.start ?? before
const notes = await memory(args.memory, args.itemNumber)

const reply = await notes
	.session("implementer")
	.noted(round, prompts.implement({ plan }), "your report, and notes are what you tried and what you observed.")

await commitAll(args.message ?? subject)

const lines = (await notes.text).split("\n").filter(Boolean)

if (await ok(["git", "diff", "--quiet", start, "HEAD"])) {
	return { status: "blocked", reply, memory: lines, report: [`blocked ${subject}`, reply] }
}

log(await diffStat(before))

const head = await sh(["git", "rev-parse", "--short", "HEAD"])

return { status: "implemented", head, reply, memory: lines, report: [`implemented ${subject}, ${head}`] }
