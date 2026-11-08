// The fix round of a work item that a judge scored 0: one implement turn on the judge's findings, then `commitChange`:
// the commit message turn on the judge's findings and the squash of the item from `start`. When the squashed commit has
// the same tree and message as `HEAD` before the round, the round is `blocked`: `HEAD` goes back and no judge runs.
// Else `judgeCommit` runs a new judge on the squashed commit.
// `campaign.js` runs it in its worktree. A caller gives `start`, the commit that the item started from, `findings`, the
// judge's findings as an array of lines, `message`, the commit message of the implement turn before the squash,
// `round`, the round of the implementer's notes, and may give `memory`, the `ref` of a run memory to go on with. A
// failed child run is a result of this run, `failed`, so that the caller saves it and a resume does not run the fix
// round again. A stopped child run fails this run, so that a resume runs it again. Every Git step is safe to repeat: a
// resume runs a step again when its result was not saved.
export const meta = {
	description: "Fix a work item on the judge's findings in one implement turn, squash it into one commit, and judge it again.",
	args: {
		item: { type: "text", positional: true, label: "work item", required: true },
		start: { type: "string", required: true },
		round: { type: "number", default: 1 },
		message: { type: "string" },
	},
	exit: { judged: 0, failed: 1, blocked: 1, unjudged: 1 },
}

const { item, start, round, findings = [] } = args
const subject = subjectOf(item)

phase("fix")

const plan = [item, "## Judge findings", findings.map((finding) => `- ${finding}`).join("\n")].join("\n\n")
const implement = { plan, round, start }

if (args.memory !== undefined) implement.memory = args.memory

if (args.message !== undefined) implement.message = args.message

let reply

try {
	const before = await sh(["git", "rev-parse", "HEAD"])
	const fixed = await run("implement", implement)
	reply = fixed.reply

	if (fixed.status !== "implemented") return { status: fixed.status, reply, report: [`${fixed.status} ${subject}`, reply] }

	const committed = await commitChange(item, start, findings)
	const messageOf = (commit) => sh(["git", "log", "-1", "--format=%B", commit])
	const sameTree = await ok(["git", "diff", "--quiet", before, "HEAD"])

	if (sameTree && (await messageOf(before)) === (await messageOf("HEAD"))) {
		await sh(["git", "reset", "-q", "--soft", before])

		return { status: "blocked", reply, report: [`blocked ${subject}`, reply] }
	}

	const shipped = await judgeCommit(item, start, committed)
	const { score, judgeError } = shipped

	if (score === undefined) {
		const report = [`judge failed on ${subject}: ${judgeError}`]

		return { status: "unjudged", judgeError, shipped, reply, report }
	}

	const report = [`judge ${score.toFixed(2)}: ${subject}`, ...shipped.findings.map((finding) => `  ${finding}`)]

	return { status: "judged", shipped, reply, report }
} catch (error) {
	const message = error?.message ?? String(error)

	// A stopped child run is not a failure: the caller fails, and its resume runs the fix round again.
	if (/^child run \S+ stopped/.test(message)) throw error

	const failed = { status: "failed", error: message, report: [`fix failed on ${subject}: ${message}`] }

	if (reply !== undefined) failed.reply = reply

	return failed
}
