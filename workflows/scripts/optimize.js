// `workflows optimize ship`: a reflective loop searches for better texts of some ship prompts. Each evaluation is a
// ship child run of one item with a candidate's prompts, and each new text comes from a reflect turn. The result is a
// diff from the baseline texts to the best candidate; `prompts/` stays unchanged.
export const meta = {
	description: "Search for better ship prompts over a folder of work items.",
	args: {
		workflow: { type: "string", positional: true, default: "ship" },
		items: { type: "string", required: true },
		improve: { type: "string", default: "review,handoff" },
		trials: { type: "number", default: 3 },
	},
}

// The prompts that a candidate can change. `judge` is not one: it gives the score.
const CANDIDATES = ["research", "plan", "handoff", "implement", "review"]

if (args.workflow !== "ship") throw new Error(`optimize takes ship only, not ${args.workflow}`)

const names = [...new Set(args.improve.split(","))]

for (const name of names) {
	if (!CANDIDATES.includes(name)) throw new Error(`--improve takes ${CANDIDATES.join(", ")}, not ${name}`)
}

const absolute = (base, path) => (path.startsWith("/") ? path : `${base}/${path}`)
const folder = absolute(await sh("pwd"), args.items)
const unquote = (value) => value.trim().replace(/^(["'])(.*)\1$/, "$2")
const items = []

for (const file of (await sh(["ls", folder])).split("\n").filter((file) => file.endsWith(".md"))) {
	const name = file.slice(0, -3)
	const text = await sh(["cat", `${folder}/${file}`])
	const [, frontmatter = "", body = text] = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text) ?? []
	const repo = /^repo:(.*)$/m.exec(frontmatter)?.[1]
	const start = /^start:(.*)$/m.exec(frontmatter)?.[1]

	if (repo === undefined || start === undefined) throw new Error(`item ${name} needs repo and start in its frontmatter`)
	items.push({ name, repo: absolute(folder, unquote(repo)), start: unquote(start), body })
}

if (items.length < 2) throw new Error("--items needs at least 2 items")

// For a shipped run, the fraction of the eight judge answers that pass, less 0.1 for each round after the first. A
// judge that failed passes nothing. A blocked or stopped run scores 0.
function score(result) {
	if (result.status !== "shipped") return 0
	const passes = (result.answers ?? []).filter((answer) => answer === "PASS").length

	return passes / 8 - 0.1 * (result.rounds - 1)
}

const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length

// Known ceiling: no evaluation cache. A reflect turn that gives back an earlier text ships that candidate again.
async function evaluate(candidate) {
	const results = []

	for (const item of items) {
		const result = await run("ship", { item: item.body, repo: item.repo, base: item.start, prompts: candidate })
		// Known ceiling: the branch name of a run that did not ship copies ship's branch name.
		await ok(["git", "-C", item.repo, "worktree", "remove", "--force", result.worktree])
		await ok(["git", "-C", item.repo, "branch", "-D", result.branch ?? `ship/${result.runId}`])
		results.push(result)
	}

	return { candidate, results, scores: results.map(score) }
}

async function reflect(name, best) {
	const current = best.candidate[name]

	const records = best.results.map((result, index) => ({
		item: items[index].body,
		score: best.scores[index],
		findings: result.status === "shipped" ? (result.findings ?? []) : [],
		memory: result.memory,
	}))

	const reply = await agent(prompts.reflect({ prompt: name, current, records: JSON.stringify(records, null, 2) }))

	if (reply === "" || reply === current.trim()) throw new Error(`the reflect turn for ${name} gave no new text`)

	return reply
}

const texts = {}

for (const name of names) texts[name] = await prompts[name]()

const baseline = await evaluate(texts)

// Each trial after the baseline changes the next prompt in turn. A candidate replaces the best one only when its mean
// is higher, so the baseline stays on a tie.
let best = baseline

for (let trial = 1; trial < args.trials; trial++) {
	const name = names[(trial - 1) % names.length]
	const next = await evaluate({ ...best.candidate, [name]: await reflect(name, best) })

	if (mean(next.scores) > mean(best.scores)) best = next
}

const write = 'mkdir -p "$(dirname "$1")" && printf "%s\\n" "$2" > "$1"'

for (const name of names) {
	await sh(["sh", "-c", write, "write", `${runDir}/baseline/${name}.md`, baseline.candidate[name]])
	await sh(["sh", "-c", write, "write", `${runDir}/best/${name}.md`, best.candidate[name]])
}

const lines = items.map(
	(item, index) => `${item.name}: baseline ${baseline.scores[index].toFixed(2)}, best ${best.scores[index].toFixed(2)}`,
)

const diff = `${runDir}/prompts.diff`

// git diff --no-index exits 1 when the files differ.
const compare =
	'cd "$1" && printf "%s\\n" "$2" > "$3" && { git diff --no-index --no-prefix baseline best >> "$3"; test $? -le 1; }'

await sh(["sh", "-c", compare, "diff", runDir, lines.join("\n"), "prompts.diff"])

const means = { baseline: mean(baseline.scores), best: mean(best.scores) }
const line = `optimized ship: baseline ${means.baseline.toFixed(2)}, best ${means.best.toFixed(2)}, ${diff}`

return { ...means, diff, report: [line] }
