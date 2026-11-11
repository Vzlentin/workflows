// The split and the items of `workflows campaign`, in its worktree. Each item ships through ship.js as one commit on
// top of the item before it. An item that ships with a judge score of 0 gets one fix round, fix.js: an implement turn
// on the judge's findings, and a new judge. An item still at 0, or whose judge failed, is one squashed commit, and
// the user answers keep, one more fix round on their words, reset or stop. A failed or reset item gets a rundown and a
// question, and the answer goes back to the split. When every item shipped, judge.js judges the change of the whole
// campaign against the goal, which no item's judge sees. The engine names the branch from `subject` of the result.
// Each item is a todo of the run: `open` after its split, `doing` from its item step, `done` when it ships, and
// `dropped` at its reset, at a stop at it, or when a new split replaces it.
// Every Git step is safe to repeat: a resume runs a step again when its result was not saved.
export const meta = {
	description: "Split a goal into work items and ship each one as a commit on one branch.",
	args: {
		goal: { type: "text", positional: true, label: "goal", required: true },
		rounds: { type: "number", default: 3 },
	},
	worktree: true,
	exit: { done: 0, stopped: 1 },
	outline: [
		{ kind: "agent", role: "planner", label: "split" },
		{ kind: "loop", label: "each item: ship", steps: [{ kind: "run", workflow: "ship", label: "ship" }] },
		{ kind: "run", workflow: "judge", label: "judge" },
	],
}

const { goal, rounds, start: first } = args

// The engine gives a `meta.worktree` script `start` as a string or not at all.
if (first === undefined) {
	throw new Error('campaign needs start: run it with workflows campaign, run("campaign", { goal, repo }) or run("campaign", { goal, start })')
}

const name = subjectOf(goal)

// The branch of the campaign worktree. Each item and each end checks that the worktree is still on it.
const branch = await sh(["git", "branch", "--show-current"])

const SPLIT = {
	type: "object",
	required: ["subject", "items"],
	properties: {
		subject: { type: "string" },
		items: { type: "array", minItems: 1, items: { type: "string" } },
	},
}

const RUNDOWN = {
	type: "object",
	required: ["rundown", "suggestions", "items"],
	properties: {
		rundown: { type: "string" },
		suggestions: { type: "array", items: { type: "string" } },
		items: { type: "array", items: { type: "string" } },
	},
}

const answer =
	"\n\nAnswer with respond: the subject, and the work items, each one as the full text of one work item, in order."

const count = (n) => `${n} item${n === 1 ? "" : "s"}`

const done = []

const shipped = () =>
	JSON.stringify(done.map(({ item, result }) => ({ item, commit: result.head, divergence: result.divergence })))

// The step `split`: the first split has only the goal, a split after a failed item also has `shipped`, `rundown` and
// `answer`. Gives the subject and the queue: each item of the split, in order, with the ID of its new todo, whose text
// is the subject of the item.
async function split(inputs) {
	phase("split")
	const answered = await agent(`${await prompts.split({ goal, ...inputs })}${answer}`, { as: "planner", schema: SPLIT })
	log(count(answered.items.length))
	const queue = []

	for (const item of answered.items) queue.push({ item, id: (await todo.add(subjectOf(item))).id })

	return { subject: answered.subject, queue }
}

// The rundown text of each failed fix round, by the status of fix.js.
const FIX_FAILED = {
	failed: (fixed) => `the fix round failed: ${fixed.error}`,
	blocked: () => "the fix round left no change",
	unjudged: () => "no judge score after one fix round",
	judged: () => "still 0 after one fix round",
}

// The last shipped commit: the head of the last shipped item, or the start commit when no item shipped.
const lastShipped = () => (done.length === 0 ? first : done.at(-1).result.head)

// Whether HEAD contains `commit`.
const headContains = (commit) => ok(["git", "merge-base", "--is-ancestor", commit, "HEAD"])

// The short name of HEAD, for the error texts.
const shortHead = () => sh(["git", "rev-parse", "--short", "HEAD"])

// Puts the worktree back on the campaign branch when HEAD is detached or on another branch, and HEAD contains the last
// shipped commit: the campaign branch moves to HEAD. Else throws. Safe to repeat.
async function ensureBranch() {
	if ((await sh(["git", "branch", "--show-current"])) === branch) return

	if (branch !== "" && (await headContains(lastShipped()))) {
		await sh(["git", "checkout", "-q", "-B", branch])

		return
	}

	const head = await shortHead()

	throw new Error(
		`the campaign worktree is not on ${branch || "a branch"} (HEAD ${head}), and HEAD does not contain the last ` +
			`shipped commit: check out the campaign branch and resume`,
	)
}

// Throws unless `start` is the last shipped commit and HEAD contains it, so that the reset after a failed item drops
// only the commits of that item.
async function assertResettable(start) {
	const shippedAt = await sh(["git", "rev-parse", `${lastShipped()}^{commit}`])

	if (shippedAt === start && (await headContains(start))) return

	const head = await shortHead()

	throw new Error(
		`HEAD ${head} does not contain the last shipped commit ${shippedAt.slice(0, 7)}: the campaign does not reset it`,
	)
}

// The question about an item that shipped and is still at 0, or whose judge failed: `status`, the commit, the latest
// findings and the answers.
function stillZero(n, status, shipped, findings) {
	const listed = findings.length === 0 ? [] : [["Findings:", ...findings.map((finding) => `- ${finding}`)].join("\n")]

	return [
		`Item ${n} ${status}: ${shipped.head} ${shipped.subject}`,
		...listed,
		"How should the campaign continue? Answer keep to ship the item as it is, fix: <words> for one more fix round on " +
			"your words, or reset to reset the item and get a rundown. Answer stop, or nothing, to end the campaign and " +
			"keep the commit.",
	].join("\n\n")
}

// The answer to `stillZero`: `{ answer }`, one of `keep`, `reset` or `stop`, or `{ answer: "fix", words }`. An
// unknown answer asks again.
async function askStillZero(question) {
	let text = question

	for (;;) {
		const reply = (await input(text)).trim()
		const lower = reply.toLowerCase()

		if (lower === "" || lower === "stop") return { answer: "stop" }

		if (lower === "keep" || lower === "reset") return { answer: lower }

		if (lower.startsWith("fix:") && reply.slice(4).trim() !== "") return { answer: "fix", words: reply.slice(4).trim() }

		text = `Unknown answer: ${reply}\n\n${question}`
	}
}

// The judge fields of a ship result, which a fix round replaces.
const JUDGE_FIELDS = ["score", "answers", "findings", "judgeError", "divergence"]

// The ship result `result` with the head, subject and judge fields of `shipped`, the result of `commitAndJudge` in a
// fix round. The judge fields of `result` go first, also when `shipped` has no value for them: a saved result comes
// back from JSON with no undefined keys.
function withFixRound(result, shipped) {
	const kept = Object.entries(result).filter(([key]) => !JUDGE_FIELDS.includes(key))

	return { ...Object.fromEntries(kept), ...shipped }
}

// The outcome of an item's ship: `shipped`, the `done` entry of an item that shipped, without its `item`, `stopped`,
// the result of an item at which the user stopped the campaign, or `failure`, the rundown inputs of an item that the
// campaign resets: `status`, `reply`, `findings` and an optional `summary` block of the question. The entry is
// `{ result }`, or `{ result, kept: true, findings }` when the user kept the item at 0, with the findings of its
// question. An item that shipped with a judge score of 0 and findings gets one fix round, the child run fix.js, which
// squashes the item again with a new commit message and judges it again. After a fix round, the result of the item is
// `withFixRound`. With a score above 0 the item ships. An item whose judge failed, that is at 0 with no findings, or
// that the fix round left at 0 or unjudged, is one squashed commit, so the user answers keep, fix: <words> for one
// more fix round, reset or stop. A fix round that fails, leaves no change or ends with an unknown status is a failure.
async function settle(n, item, start, result) {
	if (result.status !== "shipped") {
		return { failure: { status: result.status, reply: result.reply ?? "", findings: result.findings ?? [] } }
	}

	if (result.score !== undefined && result.score !== 0) return { shipped: { result } }

	let current = result
	let round = result.rounds
	let reply = result.reply ?? ""
	// The findings of the last judge that gave some: the question, the kept report and the rundown show them.
	let findings = result.findings ?? []
	let summary
	// The outcome text of the item, which the question shows.
	let status
	// The findings of the next fix round, or undefined when the user answers next.
	let pending

	if (result.score === undefined) status = `shipped with a failed judge: ${result.judgeError}`
	else if (findings.length === 0) status = "shipped with judge score 0"
	else pending = findings

	for (;;) {
		if (pending !== undefined) {
			round += 1

			const fixed = await run("fix", {
				item,
				start,
				findings: pending,
				round,
				message: `fix: judge findings of item ${n}`,
				memory: { ...notes.ref, item: n },
			})

			pending = undefined

			if (fixed.shipped !== undefined) current = withFixRound(result, fixed.shipped)

			if (fixed.status === "judged" && fixed.shipped.score !== 0) return { shipped: { result: current } }

			const outcome = Object.hasOwn(FIX_FAILED, fixed.status)
				? FIX_FAILED[fixed.status](fixed)
				: `the fix round ended with the unknown status ${fixed.status}`

			const latest = fixed.status === "judged" ? fixed.shipped.findings : []
			status = `shipped with judge score 0, ${outcome}`
			reply = fixed.reply ?? reply
			findings = latest.length > 0 ? latest : findings
			summary = [`Fix round: ${outcome}`, ...latest.map((finding) => `- ${finding}`)].join("\n")

			if (fixed.status !== "judged" && fixed.status !== "unjudged") {
				return { failure: { status, reply, findings, summary } }
			}
		}

		const answered = await askStillZero(stillZero(n, status, current, findings))

		switch (answered.answer) {
			case "keep":
				return { shipped: { result: current, kept: true, findings } }
			case "stop":
				return { stopped: current }
			case "reset":
				return { failure: { status, reply, findings, summary } }
			case "fix":
				pending = [answered.words]
				break
			default:
				throw new Error(`unknown answer about item ${n}: ${answered.answer}`)
		}
	}
}

// The result of a campaign that the user stopped at item `n`, with `result`, the result of the item, and `rundown`
// when the item was reset.
function stoppedAt(n, item, result, rundown) {
	const items = [...done, { item, result }]
	const line = `stopped ${name} at item ${n}: ${cwd}`

	if (rundown === undefined) return { status: "stopped", items, report: [line] }

	return { status: "stopped", items, rundown, report: [line, rundown] }
}

let { subject, queue } = await split({})
const notes = await memory()

// The result of a campaign that the user stopped after a failed item.
let stopped

for (let n = 1; queue.length > 0; n++) {
	const [{ item, id }, ...rest] = queue
	phase(`item ${n}/${n + rest.length}: ${subjectOf(item)}`)
	await todo.set(id, "doing")
	await ensureBranch()
	const patches = `${runDir}/item-${n}`
	await sh(["mkdir", "-p", patches])
	const start = await sh(["git", "rev-parse", "HEAD"])
	const result = await run("ship", { item, rounds, start, patches, memory: { ...notes.ref, item: n } })

	const outcome = await settle(n, item, start, result)

	if (outcome.shipped !== undefined) {
		await todo.set(id, "done")
		done.push({ item, ...outcome.shipped })
		queue = rest
		continue
	}

	// A stop at the question about an item still at 0 keeps its commit, and has no rundown.
	if (outcome.stopped !== undefined) {
		await todo.set(id, "dropped")
		stopped = stoppedAt(n, item, outcome.stopped)
		break
	}

	const { failure } = outcome

	await assertResettable(start)
	// The whole change of the item, also its fix commit, before the reset drops it.
	const file = await writePatch(`${patches}/item.patch`, start)
	const patch = (await ok(["test", "-s", file])) ? file : ""
	await sh(["git", "reset", "--hard", start])
	await todo.set(id, "dropped")
	await notes.note("campaign", undefined, [`item ${n} failed and was reset: its notes describe code that is gone`])

	const proposed = await agent(
		await prompts.rundown({
			goal,
			shipped: shipped(),
			item,
			status: failure.status,
			reply: failure.reply,
			handoff: result.handoff ?? "",
			findings: failure.findings.join("\n"),
			memory: await notes.text,
			remaining: JSON.stringify(rest.map((later) => later.item)),
			patch,
		}),
		{ as: "planner", schema: RUNDOWN },
	)

	const { rundown, suggestions } = proposed

	const summary = [
		rundown,
		...(failure.summary === undefined ? [] : [failure.summary]),
		["Suggestions:", ...suggestions.map((suggestion) => `- ${suggestion}`)].join("\n"),
		["Proposed items:", ...proposed.items.map((next, i) => `${i + 1}. ${next}`)].join("\n\n"),
		...(patch ? [`Patch of the failed item: ${patch}`] : []),
	].join("\n\n")

	const reply = (await input(`${summary}\n\nHow should the campaign continue? Answer stop, or nothing, to end it.`)).trim()

	// The reset dropped the todo of the item. The todos of the items after it stay open.
	if (reply === "" || reply.toLowerCase() === "stop") {
		stopped = stoppedAt(n, item, result, rundown)
		break
	}

	// The new split replaces the items that did not run.
	for (const later of rest) await todo.set(later.id, "dropped")

	const next = await split({ shipped: shipped(), rundown: summary, answer: reply })
	subject = next.subject
	queue = next.queue
}

await ensureBranch()

if (stopped !== undefined) return notes.finish(goal, stopped)

const head = done.at(-1).result.head
const judgedOf = (score) => (score === undefined ? "failed" : score.toFixed(2))

// The judge of the whole campaign sees the change of every item at once, against the goal.
phase(`all ${count(done.length)}`)

const { score, findings, judgeError } = await run("judge", { item: goal, start: first })
const report = [`done ${name} in ${count(done.length)}, judge ${judgedOf(score)}, ${head}`]

// A divergence of `none` or an empty one adds nothing to the item line.
const divergedOf = (divergence) =>
	divergence === undefined || divergence === "" || divergence === "none" ? "" : `, divergence ${divergence}`

// A kept item is still at 0: the findings of its question follow its item line.
for (const entry of done) {
	const { result } = entry
	report.push(`  ${result.head} ${result.subject}, judge ${judgedOf(result.score)}${divergedOf(result.divergence)}`)

	if (entry.kept) for (const finding of entry.findings) report.push(`    finding ${finding}`)
}

for (const finding of findings ?? []) report.push(`  finding ${finding}`)

const judge = judgeError === undefined ? { score, findings } : undefined

return notes.finish(goal, { status: "done", subject, head, judge, judgeError, items: done, report })
