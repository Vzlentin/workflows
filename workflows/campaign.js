// The split, the items and the requeue of `workflows campaign`, in its worktree. Each item ships through ship.js as
// one commit on top of the item before it. Every Git step is safe to repeat: a resume runs a step again when its
// result was not saved.
export const meta = {
	description: "Split a goal into work items and ship each one as a commit on one branch.",
	args: {
		goal: { type: "text", positional: true, label: "goal", required: true },
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

const RUNDOWN = {
	type: "object",
	required: ["rundown", "suggestions", "queue"],
	properties: {
		rundown: { type: "string" },
		suggestions: { type: "array", items: { type: "string" } },
		queue: { type: "array", items: { type: "string" } },
	},
}

const BRANCH = { type: "object", required: ["branch"], properties: { branch: { type: "string" } } }

// Renames the branch `$1` to `$2` when the worktree is on `$1`, with a suffix `-2`, `-3`... when `$2` exists, and
// prints the branch that the worktree is on. A `$2` that Git rejects keeps `$1`, and a second line gives the reason.
// A repeat after the rename finds the worktree on another branch and prints it.
const RENAME = `cur=$(git branch --show-current)
[ "$cur" = "$1" ] || { printf %s "$cur"; exit 0; }
git check-ref-format --branch "$2" >/dev/null 2>&1 || { printf '%s\\nis not a valid branch name' "$1"; exit 0; }
n=$2; i=2
while git show-ref --verify --quiet "refs/heads/$n"; do n=$2-$i; i=$((i+1)); done
git branch -m "$n" 2>/dev/null || { printf '%s\\nis in conflict with an existing branch' "$1"; exit 0; }
printf %s "$n"`

const answer = "\n\nAnswer with respond: the work items, each one as the full text of one work item, in order."

const count = (n) => `${n} item${n === 1 ? "" : "s"}`

phase("split")

let queue = (await agent(`${await prompts.split({ goal })}${answer}`, { as: "planner", schema: items(1) })).items

log(count(queue.length))

const done = []

// Known ceiling: requeue can add items after each shipped item, so the queue has no length limit.
for (let n = 1; queue.length > 0; n++) {
	const [item, ...rest] = queue
	phase(`item ${n}/${n + rest.length}: ${subjectOf(item)}`)
	const patches = `${runDir}/item-${n}`
	await sh(["mkdir", "-p", patches])
	const start = await sh(["git", "rev-parse", "HEAD"])
	const { report: _report, ...result } = await run("ship", { item, rounds, start, patches })

	if (result.status !== "shipped" || result.score === 0) {
		// `start` is the last shipped commit: every earlier item shipped or was reset to its own start.
		await sh(["git", "reset", "--hard", start])
		const shipped = JSON.stringify(done.map(({ item, result }) => ({ item, commit: result.head })))

		const { rundown, suggestions, queue: proposed } = await agent(
			await prompts.rundown({
				goal,
				shipped,
				item,
				status: result.status === "shipped" ? "shipped with judge score 0" : result.status,
				reply: result.reply ?? "",
				handoff: result.handoff ?? "",
				findings: (result.findings ?? []).join("\n"),
				memory: result.memory.join("\n"),
				queue: JSON.stringify(rest),
			}),
			{ as: "planner", schema: RUNDOWN },
		)

		const summary = [
			rundown,
			["Suggestions:", ...suggestions.map((suggestion) => `- ${suggestion}`)].join("\n"),
			["Proposed queue:", ...proposed.map((next, i) => `${i + 1}. ${next}`)].join("\n\n"),
		].join("\n\n")

		const reply = (
			await input(`${summary}\n\nHow should the campaign continue? Answer stop, or nothing, to end it.`)
		).trim()

		if (reply === "" || reply.toLowerCase() === "stop") {
			const report = [`stopped ${name} at item ${n}: ${runDir}/worktree`, rundown]

			return { status: "stopped", items: [...done, { item, result }], rundown, report }
		}

		const split = await prompts.split({ goal, shipped, rundown: summary, answer: reply })
		queue = (await agent(`${split}${answer}`, { as: "planner", schema: items(1) })).items
		continue
	}

	done.push({ item, result })

	const requeue = await prompts.requeue({ goal, done: item, queue: JSON.stringify(rest) })
	queue = (await agent(`${requeue}${answer}`, { as: "planner", schema: items(0) })).items
}

const head = done.at(-1).result.head
const commits = await sh(["git", "log", "--reverse", "--format=%s", `${args.start}..HEAD`])
let named

try {
	named = await agent(prompts.branch({ goal, commits }), { as: "planner", schema: BRANCH })
} catch {}

const branchName = named?.branch.trim() ?? ""
const base = `campaign/${runId}`

const renamed =
	branchName === "" || branchName === base ? base : await sh(["sh", "-c", RENAME, "rename", base, branchName])

const [branch, rejected] = renamed.split("\n")
const report = [`done ${name} in ${count(done.length)}, ${head} on ${branch}`]

if (rejected !== undefined) report.push(`branch ${branchName} ${rejected}; kept ${base}`)

for (const { result } of done) {
	const judged = result.score === undefined ? "failed" : result.score.toFixed(2)
	// A result that an earlier version saved has no subject.
	const commit = result.subject === undefined ? result.head : `${result.head} ${result.subject}`
	report.push(`  ${commit}, judge ${judged}`)
}

return { status: "done", head, branch, items: done, report }
