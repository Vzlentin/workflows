// The split, the items and the requeue of `workflows campaign`, in its worktree. Each item ships through ship.js as
// one commit on top of the item before it. Every Git step is safe to repeat: a resume runs a step again when its
// result was not saved.
const { goal, rounds } = args

const items = (min) => ({
	type: "object",
	required: ["items"],
	properties: { items: { type: "array", minItems: min, items: { type: "string" } } },
})
const answer = "\n\nAnswer with respond: the work items, each one as the full text of one work item, in order."

let queue = (await agent(`${await prompts.split({ goal })}${answer}`, { as: "planner", schema: items(1) })).items
const done = []
// Known ceiling: requeue can add items after each shipped item, so the queue has no length limit.
for (let n = 1; queue.length > 0; n++) {
	const [item, ...rest] = queue
	const line = item.split("\n").find((candidate) => candidate.trim() !== "") ?? ""
	const subject = line.replace(/^#+/, "").trim()
	phase(`item ${n}: ${subject}`)
	const patches = `${runDir}/item-${n}`
	await sh(["mkdir", "-p", patches])
	const start = await sh(["git", "rev-parse", "HEAD"])
	const result = await run("ship", { item, subject, rounds, start, patches })
	done.push({ item, result })
	if (result.status !== "shipped" || result.score === 0) return { status: "stopped", items: done }
	const requeue = await prompts.requeue({ goal, done: item, queue: JSON.stringify(rest) })
	queue = (await agent(`${requeue}${answer}`, { as: "planner", schema: items(0) })).items
}
return { status: "done", head: done.at(-1).result.head, items: done }
