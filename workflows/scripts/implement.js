// One implement turn: the implementer follows a plan, and every change is committed. `rpi.js`, `thermoloop.js` and
// `fix.js` run it in their directory. A caller gives `start`, the commit that the change starts from, and may give `memory`, the
// `ref` of a run memory to go on with. Every Git step is safe to repeat: a resume runs a step again when its result
// was not saved.
export const meta = {
	description: "Implement a plan in the current directory, and commit the change.",
	args: {
		plan: { type: "text", positional: true, label: "plan", required: true },
		message: { type: "string" },
		round: { type: "number", default: 1 },
	},
	exit: { implemented: 0, blocked: 1 },
	outline: [{ kind: "agent", role: "implementer", label: "implement" }],
}

// `+12 -3 in 2 files` for the change from `from` to `to`, or `no new changes`.
async function diffStat(from, to = "HEAD") {
	const shortstat = await sh(["git", "diff", "--shortstat", from, to])
	const count = (word) => Number(new RegExp(`(\\d+) ${word}`).exec(shortstat)?.[1] ?? 0)
	const files = count("files? changed")

	if (files === 0) return "no new changes"

	return `+${count("insertion")} -${count("deletion")} in ${files} file${files === 1 ? "" : "s"}`
}

// Throws when the checkout of the current directory has changes that are not committed.
async function assertClean() {
	if ((await sh(["git", "status", "--porcelain"])) !== "") {
		throw new Error("the checkout has changes that are not committed; commit or stash them first")
	}
}

const { plan, round } = args
const subject = subjectOf(plan)

if (args.start === undefined) await assertClean()

const before = await sh(["git", "rev-parse", "HEAD"])
const start = args.start ?? before
const notes = await memory(args.memory)

const reply = await notes
	.session("implementer")
	.noted(round, prompts.implement({ plan }), "your report, and notes are what you tried and what you observed.")

await commitAll(args.message ?? subject)

const lines = await noteLines(notes)

if (await ok(["git", "diff", "--quiet", start, "HEAD"])) {
	return { status: "blocked", reply, memory: lines, report: [`blocked ${subject}`, reply] }
}

log(await diffStat(before))

const head = await sh(["git", "rev-parse", "--short", "HEAD"])

return { status: "implemented", head, reply, memory: lines, report: [`implemented ${subject}, ${head}`] }
