// The split and the items of `workflows campaign`, in its worktree. Each item ships through ship.js as one commit on
// top of the item before it. A failed item gets a rundown and a question, and the answer goes back to the split. When
// every item shipped, judge.js judges the change of the whole campaign against the goal, which no item's judge sees.
// The engine names the branch from `subject` of the result. Every Git step is safe to repeat: a resume runs a step
// again when its result was not saved.
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
const shipped = () => JSON.stringify(done.map(({ item, result }) => ({ item, commit: result.head })))

// The step `split`: the first split has only the goal, a split after a failed item also has `shipped`, `rundown` and
// `answer`.
async function split(inputs) {
	phase("split")
	const answered = await agent(`${await prompts.split({ goal, ...inputs })}${answer}`, { as: "planner", schema: SPLIT })
	log(count(answered.items.length))

	return answered
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

	if (result.status === "shipped" && result.score !== 0) {
		done.push({ item, result })
		queue = rest
		continue
	}

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
			status: result.status === "shipped" ? "shipped with judge score 0" : result.status,
			reply: result.reply ?? "",
			handoff: result.handoff ?? "",
			findings: (result.findings ?? []).join("\n"),
			memory: await notes.text,
			remaining: JSON.stringify(rest),
			patch,
		}),
		{ as: "planner", schema: RUNDOWN },
	)

	const { rundown, suggestions } = proposed

	const summary = [
		rundown,
		["Suggestions:", ...suggestions.map((suggestion) => `- ${suggestion}`)].join("\n"),
		["Proposed items:", ...proposed.items.map((next, i) => `${i + 1}. ${next}`)].join("\n\n"),
		...(patch ? [`Patch of the failed item: ${patch}`] : []),
	].join("\n\n")

	const reply = (await input(`${summary}\n\nHow should the campaign continue? Answer stop, or nothing, to end it.`)).trim()

	if (reply === "" || reply.toLowerCase() === "stop") {
		const report = [`stopped ${name} at item ${n}: ${runDir}/worktree`, rundown]

		return { status: "stopped", items: [...done, { item, result }], rundown, report }
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

for (const { result } of done) report.push(`  ${result.head} ${result.subject}, judge ${judgedOf(result.score)}`)

for (const finding of findings ?? []) report.push(`  finding ${finding}`)

const judge = judgeError === undefined ? { score, findings } : undefined

return { status: "done", subject, head, judge, judgeError, items: done, report }
