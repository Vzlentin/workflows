// `workflows optimize ship`: one INV turn reads the traces of baseline ship runs and proposes an overlay of prompt and
// profile edits. Each item ships again with the overlay, and a blind selector compares the two diffs of each item. The
// result is a diff from the baseline texts to the promoted ones; `prompts/` and `agents/` stay unchanged.
export const meta = {
	description: "Propose prompt and profile edits from ship runs, and keep them when a blind judge prefers their diffs.",
	args: {
		workflow: { type: "string", positional: true, default: "ship" },
		items: { type: "string" },
		runs: { type: "string" },
		limit: { type: "number", default: 8 },
	},
}

const EDITS = {
	type: "object",
	required: ["edits"],
	properties: {
		edits: {
			type: "array",
			items: {
				type: "object",
				required: ["path", "text", "moment"],
				properties: { path: { type: "string" }, text: { type: ["string", "null"] }, moment: { type: "string" } },
			},
		},
	},
}

const SELECT = { enum: ["A", "B", "tie"] }

// The templates of optimize itself are not texts of ship.
const OWN = ["prompts/inv.md", "prompts/select.md"]

if (args.workflow !== "ship") throw new Error(`optimize takes ship only, not ${args.workflow}`)

if (args.items !== undefined && args.runs !== undefined) throw new Error("give --items or --runs, not both")

// Ships `item` as a child run with the extra args, and takes the diff of its commits before it removes its worktree
// and its branch.
async function ship(item, extra) {
	const result = await run("ship", { item: item.text, repo: item.repo, base: item.start, ...extra })
	const diff = await sh(["git", "-C", result.worktree, "diff", item.start, "HEAD"])
	// Known ceiling: the branch name of a run that did not ship copies ship's branch name.
	await ok(["git", "-C", item.repo, "worktree", "remove", "--force", result.worktree])
	await ok(["git", "-C", item.repo, "branch", "-D", result.branch ?? `ship/${result.runId}`])

	return { runId: result.runId, result, diff }
}

// The FNV-1a hash of `text`, as an unsigned 32-bit number.
function hashOf(text) {
	let hash = 0x811c9dc5

	for (let index = 0; index < text.length; index++) {
		hash ^= text.charCodeAt(index)
		hash = Math.imul(hash, 0x01000193)
	}

	return hash >>> 0
}

const items = []
const texts = {}
let source

if (args.items === undefined) {
	const options =
		args.runs === undefined
			? { limit: args.limit }
			: {
					runs: args.runs
						.split(",")
						.map((id) => id.trim())
						.filter((id) => id !== ""),
				}

	const past = await pastRuns("ship", options)

	if (past.length === 0) throw new Error("optimize found no completed ship run")

	for (const { runId: from, item: text, repository: repo, start, result } of past) {
		const item = { name: from, text, repo, start, from }
		const head = result?.status === "shipped" ? result.head : undefined
		const kept = head !== undefined && (await ok(["git", "-C", repo, "cat-file", "-e", `${head}^{commit}`]))

		// A saved baseline that did not ship, or whose head is gone, runs again once with its saved bundle.
		item.baseline = kept
			? { runId: from, result, diff: await sh(["git", "-C", repo, "diff", start, head]) }
			: await ship(item, { from })
		items.push(item)
	}

	source = past[0]
} else {
	const absolute = (base, path) => (path.startsWith("/") ? path : `${base}/${path}`)
	const folder = absolute(await sh("pwd"), args.items)
	const unquote = (value) => value.trim().replace(/^(["'])(.*)\1$/, "$2")

	for (const file of (await sh(["ls", folder])).split("\n").filter((file) => file.endsWith(".md"))) {
		const name = file.slice(0, -3)
		const text = await sh(["cat", `${folder}/${file}`])
		const [, frontmatter = "", body = text] = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text) ?? []
		const repo = /^repo:(.*)$/m.exec(frontmatter)?.[1]
		const start = /^start:(.*)$/m.exec(frontmatter)?.[1]

		if (repo === undefined || start === undefined) {
			throw new Error(`item ${name} needs repo and start in its frontmatter`)
		}

		items.push({ name, text: body, repo: absolute(folder, unquote(repo)), start: unquote(start) })
	}

	if (items.length === 0) throw new Error(`no work item in ${folder}`)

	for (const item of items) item.baseline = await ship(item, {})

	source = { prompts: {}, agents }

	for (const name of Object.keys(prompts)) source.prompts[name] = await prompts[name]()
}

for (const [name, text] of Object.entries(source.prompts)) texts[`prompts/${name}.md`] = text

for (const [name, text] of Object.entries(source.agents)) texts[`agents/${name}.md`] = text

for (const path of OWN) delete texts[path]

// The `memory` field of a ship result holds the notes of its run memory.
const traces = items.map(({ text, baseline }) => {
	const { status, rounds, findings, divergence, lessons, memory: notes } = baseline.result

	return {
		runId: baseline.runId,
		item: text,
		status,
		rounds,
		findings: findings ?? [],
		divergence: divergence ?? null,
		lessons: lessons ?? [],
		notes: notes ?? [],
	}
})

const json = (value) => JSON.stringify(value, null, 2)
const { edits } = await agent(prompts.inv({ texts: json(texts), traces: json(traces) }), { schema: EDITS })

if (edits.length === 0) throw new Error("the inv turn gave no edit")

const overlay = {}

for (const { path, text } of edits) {
	if (!Object.hasOwn(texts, path)) throw new Error(`inv edit ${path} is not a baseline path`)

	if (Object.hasOwn(overlay, path)) throw new Error(`inv edit ${path} comes twice`)
	overlay[path] = text
}

// `render` leaves out an empty section, so the selector sees an empty diff as `(no change)`.
const shown = (diff) => (diff === "" ? "(no change)" : diff)
const lines = []
let wins = 0

for (const item of items) {
	const candidate = await ship(item, { overlay, from: item.from })
	// The order of the two diffs depends only on the saved run ID or the item file name, and the item text, so it is the
	// same in each run.
	const first = hashOf(`${item.name}\n${item.text}`) % 2 === 0
	const [A, B] = first ? [candidate.diff, item.baseline.diff] : [item.baseline.diff, candidate.diff]
	const choice = await agent(prompts.select({ item: item.text, A: shown(A), B: shown(B) }), { as: "judge", schema: SELECT })
	const verdict = choice === "tie" ? "tie" : (choice === "A") === first ? "win" : "loss"

	if (verdict === "win") wins++
	lines.push(`${item.name}: ${verdict}`)
}

const promoted = items.length >= 4 && wins / items.length >= 0.75
const write = 'mkdir -p "$(dirname "$1")" && printf "%s\\n" "$2" > "$1"'

await sh(["mkdir", "-p", `${runDir}/best`])

for (const [path, text] of Object.entries(overlay)) {
	await sh(["sh", "-c", write, "write", `${runDir}/baseline/${path}`, texts[path]])
	const best = promoted ? text : texts[path]

	if (best !== null) await sh(["sh", "-c", write, "write", `${runDir}/best/${path}`, best])
}

const header = [...lines, ...edits.map(({ path, moment }) => `edit ${path}: ${oneLine(moment)}`)]
const diff = `${runDir}/overlay.diff`

// git diff --no-index exits 1 when the files differ.
const compare =
	'cd "$1" && printf "%s\\n" "$2" > "$3" && { git diff --no-index --no-prefix baseline best >> "$3"; test $? -le 1; }'

await sh(["sh", "-c", compare, "diff", runDir, header.join("\n"), "overlay.diff"])

const few = items.length < 4 ? ["fewer than 4 items: nothing promoted"] : []
const line = `optimized ship: ${wins}/${items.length} wins, ${promoted ? "promoted" : "not promoted"}, ${diff}`

return { wins, items: items.length, promoted, overlay, diff, report: [...lines, ...few, line] }
