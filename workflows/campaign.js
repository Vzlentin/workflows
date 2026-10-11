// Split a goal into work items and ship each one as a commit on one branch.
// The split, the items and the requeue of `workflows campaign`, in its worktree. Each item ships through ship.js as
// one commit on top of the item before it. Every Git step is safe to repeat: a resume runs a step again when its
// result was not saved.
export const meta = {
	args: {
		goal: { type: "text", positional: true, label: "goal" },
		rounds: { type: "number", default: 3 },
	},
	worktree: true,
	exit: { stopped: 1 },
}

const { goal, rounds } = args
const subjectOf = (text) => (text.split("\n").find((line) => line.trim() !== "") ?? "").replace(/^#+/, "").trim()
const name = subjectOf(goal)

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
	phase(`item ${n}: ${subjectOf(item)}`)
	const patches = `${runDir}/item-${n}`
	await sh(["mkdir", "-p", patches])
	const start = await sh(["git", "rev-parse", "HEAD"])
	const { report, ...result } = await run("ship", { item, rounds, start, patches })
	done.push({ item, result })
	if (result.status !== "shipped" || result.score === 0) {
		return { status: "stopped", items: done, report: [`stopped ${name} at item ${n}: ${runDir}/worktree`] }
	}
	const requeue = await prompts.requeue({ goal, done: item, queue: JSON.stringify(rest) })
	queue = (await agent(`${requeue}${answer}`, { as: "planner", schema: items(0) })).items
}
const head = done.at(-1).result.head
return { status: "done", head, items: done, report: [`done ${name} in ${done.length} items, ${head}`] }
