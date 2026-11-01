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
	exit: { stopped: 1 },
}

const { goal, rounds, start: first } = args
const name = subjectOf(goal)

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

// The outcome of an item's ship: `shipped`, the result of an item that shipped, or `failure`, the rundown inputs of
// an item that failed: `status`, `reply`, `findings` and an optional `summary` block of the question. An item that
// shipped with a judge score of 0 and findings gets one fix round, the child run fix.js. With a score above 0 it
// squashes the item again with its commit message.
async function settle(n, item, start, result) {
	if (result.status === "shipped" && result.score !== 0) return { shipped: result }

	if (result.status !== "shipped" || result.findings.length === 0) {
		const status = result.status === "shipped" ? "shipped with judge score 0" : result.status

		return { failure: { status, reply: result.reply ?? "", findings: result.findings ?? [] } }
	}

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

	const outcome = FIX_FAILED[fixed.status](fixed)
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

for (let n = 1; queue.length > 0; n++) {
	const [item, ...rest] = queue
	phase(`item ${n}/${n + rest.length}: ${subjectOf(item)}`)
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

	// `start` is the last shipped commit: every earlier item shipped or was reset to its own start.
	await sh(["git", "reset", "--hard", start])
	await notes.note("campaign", undefined, [`item ${n} failed and was reset: its notes describe code that is gone`])
	const file = `${patches}/round-${result.rounds}.patch`
	const patch = (await ok(["test", "-f", file])) ? file : ""

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

		return notes.finish(goal, { status: "stopped", items: [...done, { item, result }], rundown, report })
	}

	const next = await split({ shipped: shipped(), rundown: summary, answer: reply })
	subject = next.subject
	queue = next.items
}

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
