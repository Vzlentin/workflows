// The split and the items of `workflows campaign`, in its worktree. Each item ships through ship.js as one commit on
// top of the item before it. An item that ships with a judge score of 0 gets one fix round, fix.js: an implement turn
// on the judge's findings, and a new judge. A failed item gets a rundown and a question, and the answer goes back to
// the split. When every item shipped, judge.js judges the change of the whole campaign against the goal, which no
// item's judge sees. The engine names the branch from `subject` of the result. Every Git step is safe to repeat: a
// resume runs a step again when its result was not saved.
export const meta = {
	description: "Split a goal into work items and ship each one as a commit on one branch.",
	args: {
		goal: { type: "text", positional: true, label: "goal", required: true },
		rounds: { type: "number", default: 3 },
	},
	worktree: true,
	exit: { done: 0, stopped: 1 },
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
// `answer`.
async function split(inputs) {
	phase("split")
	const answered = await agent(`${await prompts.split({ goal, ...inputs })}${answer}`, { as: "planner", schema: SPLIT })
	log(count(answered.items.length))

	return answered
}

// The rundown text of each failed fix round, by the status of fix.js.
const FIX_FAILED = {
	failed: (fixed) => `the fix round failed: ${fixed.error}`,
	blocked: () => "the fix round changed nothing",
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

// The outcome of an item's ship: `shipped`, the result of an item that shipped, or `failure`, the rundown inputs of
// an item that failed: `status`, `reply`, `findings` and an optional `summary` block of the question. An item whose
// judge failed is a failed item. An item that shipped with a judge score of 0 and findings gets one fix round, the
// child run fix.js. With a score above 0 it squashes the item again with its commit message.
async function settle(n, item, start, result) {
	const failed = (status) => ({ failure: { status, reply: result.reply ?? "", findings: result.findings ?? [] } })

	if (result.status !== "shipped") return failed(result.status)

	if (result.score === undefined) return failed(`shipped with a failed judge: ${result.judgeError}`)

	if (result.score !== 0) return { shipped: result }

	if (result.findings.length === 0) return failed("shipped with judge score 0")

	const message = await sh(["git", "log", "-1", "--format=%B"])

	const fixed = await run("fix", {
		item,
		start,
		findings: result.findings,
		round: result.rounds + 1,
		message: `fix: judge findings of item ${n}`,
		memory: { ...notes.ref, item: n },
	})

	if (fixed.status === "judged" && fixed.score !== 0) {
		const { score, answers, findings } = fixed
		const short = await squash(start, message, result.subject)

		return { shipped: { ...result, head: short, score, answers, findings } }
	}

	const outcome = Object.hasOwn(FIX_FAILED, fixed.status)
		? FIX_FAILED[fixed.status](fixed)
		: `the fix round ended with the unknown status ${fixed.status}`

	const findings = fixed.status === "judged" ? fixed.findings : []

	return {
		failure: {
			status: `shipped with judge score 0, ${outcome}`,
			reply: fixed.reply ?? result.reply ?? "",
			findings: findings.length > 0 ? findings : result.findings,
			summary: [`Fix round: ${outcome}`, ...findings.map((finding) => `- ${finding}`)].join("\n"),
		},
	}
}

let { subject, items: queue } = await split({})
const notes = await memory()

// The result of a campaign that the user stopped after a failed item.
let stopped

for (let n = 1; queue.length > 0; n++) {
	const [item, ...rest] = queue
	phase(`item ${n}/${n + rest.length}: ${subjectOf(item)}`)
	await ensureBranch()
	const patches = `${runDir}/item-${n}`
	await sh(["mkdir", "-p", patches])
	const start = await sh(["git", "rev-parse", "HEAD"])
	const result = await run("ship", { item, rounds, start, patches, memory: { ...notes.ref, item: n } })

	const outcome = await settle(n, item, start, result)

	if (outcome.shipped) {
		done.push({ item, result: outcome.shipped })
		queue = rest
		continue
	}

	const { failure } = outcome

	await assertResettable(start)
	// The whole change of the item, also its fix commit, before the reset drops it.
	const file = await writePatch(`${patches}/item.patch`, start)
	const patch = (await ok(["test", "-s", file])) ? file : ""
	await sh(["git", "reset", "--hard", start])
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
			remaining: JSON.stringify(rest),
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

	if (reply === "" || reply.toLowerCase() === "stop") {
		const report = [`stopped ${name} at item ${n}: ${cwd}`, rundown]
		stopped = { status: "stopped", items: [...done, { item, result }], rundown, report }
		break
	}

	const next = await split({ shipped: shipped(), rundown: summary, answer: reply })
	subject = next.subject
	queue = next.items
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

for (const { result } of done)
	report.push(`  ${result.head} ${result.subject}, judge ${judgedOf(result.score)}${divergedOf(result.divergence)}`)

for (const finding of findings ?? []) report.push(`  finding ${finding}`)

const judge = judgeError === undefined ? { score, findings } : undefined

return notes.finish(goal, { status: "done", subject, head, judge, judgeError, items: done, report })
