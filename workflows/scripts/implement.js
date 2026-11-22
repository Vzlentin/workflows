// One implement turn: the implementer follows a plan, and every change is committed. `rpi.js`, `thermoloop.js` and
// `fix.js` run it in their directory. A caller gives `start`, the commit that the change starts from, and may give `memory`, the
// `ref` of a run memory to go on with. The commit message is `message`; else, with `item`, the work item that the plan
// serves, the subject and body that the implementer writes, with a subject from `item` when its subject is not a
// Conventional Commit; else the subject of the plan. Every Git step is safe to repeat: a resume runs a step again when its result
// was not saved.
export const meta = {
	description: "Implement a plan in the current directory, and commit the change.",
	args: {
		plan: { type: "text", positional: true, label: "plan", required: true },
		message: { type: "string" },
		round: { type: "number", default: 1 },
		item: { type: "text" },
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

// The form of a Conventional Commit subject: `<type>[(<scope>)][!]: <text>`.
const CONVENTIONAL = /^[a-z]+(\([^()\n]+\))?!?: \S/

// The commit message of the implementer's `answer` for the work item `item`: the subject that the implementer wrote,
// trimmed, when it is one line in Conventional Commit form, else the subject of `item` when it has that form, else
// `fix: ` and the subject of `item` with its first letter in lower case; then the trimmed body, when it is not empty.
function commitMessage(answer, item) {
	const written = answer.subject.trim()
	const fallback = subjectOf(item)
	const body = answer.body.trim()
	let subject = `fix: ${fallback.charAt(0).toLowerCase()}${fallback.slice(1)}`

	if (!written.includes("\n") && CONVENTIONAL.test(written)) subject = written
	else if (CONVENTIONAL.test(fallback)) subject = fallback

	return body === "" ? subject : `${subject}\n\n${body}`
}

const { plan, round } = args
const subject = subjectOf(plan)

if (args.start === undefined) await assertClean()

const before = await sh(["git", "rev-parse", "HEAD"])
const start = args.start ?? before
const notes = await memory(args.memory)

const implementer = notes.session("implementer")
const prompt = prompts.implement({ plan })
const rule = "your report, and notes are what you tried and what you observed."
let reply
let message

if (args.message !== undefined || args.item === undefined) {
	reply = await implementer.noted(round, prompt, rule)
	message = args.message ?? subject
} else {
	const answer = await implementer.noted(round, prompt, rule, {
		subject: "the commit subject of your change: one line, a Conventional Commit, for example `fix(parser): reject an empty name`.",
		body: "what your change fixed and why, in a few short lines.",
	})

	reply = answer.text
	message = commitMessage(answer, args.item)
}

await commitAll(message)

const lines = await noteLines(notes)

if (await ok(["git", "diff", "--quiet", start, "HEAD"])) {
	return { status: "blocked", reply, memory: lines, report: [`blocked ${subject}`, reply] }
}

log(await diffStat(before))

const head = await sh(["git", "rev-parse", "--short", "HEAD"])

return { status: "implemented", head, reply, memory: lines, report: [`implemented ${subject}, ${head}`] }
