// `workflows optimize ship`: an INV turn reads the traces of baseline ship runs and proposes prompt and profile edits,
// a DOM turn proposes skill and AGENTS.md edits, and a Compose turn joins them into one candidate overlay. A valid
// candidate ships each item again, and a blind selector compares the two diffs of each item. The result is a diff from
// the baseline texts to the promoted ones; `prompts/`, `agents/` and the skills stay unchanged.
export const meta = {
	description:
		"Propose prompt, profile, skill and AGENTS.md edits from ship runs, and keep them when a blind judge prefers their diffs.",
	args: {
		workflow: { type: "string", positional: true, default: "ship" },
		items: { type: "string" },
		runs: { type: "string" },
		limit: { type: "number", default: 8 },
		"always-on-max": { type: "number" },
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

const COMPOSE = {
	type: "object",
	required: ["overlay", "notes"],
	properties: {
		overlay: {
			type: "array",
			items: {
				type: "object",
				required: ["path", "text"],
				properties: { path: { type: "string" }, text: { type: ["string", "null"] } },
			},
		},
		notes: {
			type: "array",
			items: {
				type: "object",
				required: ["verdict", "edit", "moment"],
				properties: {
					verdict: { enum: ["kept", "revised", "dropped"] },
					edit: { type: "string" },
					moment: { type: "string" },
				},
			},
		},
	},
}

const SELECT = { enum: ["A", "B", "tie"] }

// The templates of optimize itself are not texts of ship.
const OWN = ["prompts/inv.md", "prompts/select.md", "prompts/dom.md", "prompts/compose.md"]

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

// The surface of the DOM turn: the AGENTS.md and the skills of the first item's start commit, and the user skills.
const [{ repo: home, start: base }] = items
const surface = {}

if (await ok(["git", "-C", home, "cat-file", "-e", `${base}:AGENTS.md`])) {
	surface["AGENTS.md"] = await sh(["git", "-C", home, "show", `${base}:AGENTS.md`])
}

const tree = await sh(["git", "-C", home, "ls-tree", "-r", "--name-only", base, "--", ".agents/skills", ".pi/skills"])
const SKILL = /^\.(?:agents|pi)\/skills\/([^/]+)\/SKILL\.md$/

for (const path of tree.split("\n").filter((path) => SKILL.test(path))) {
	surface[path] = await sh(["git", "-C", home, "show", `${base}:${path}`])
}

// The user skill folders of Pi, with a leading `~` expanded.
const folders = `for dir in "\${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/skills" "$HOME/.agents/skills"; do
case "$dir" in "~"|"~/"*) dir="$HOME\${dir#"~"}" ;; esac
printf "%s\\n" "$dir"
done`

const roots = (await sh(["sh", "-c", folders])).split("\n")
const found = 'for dir in "$@"; do for file in "$dir"/*/SKILL.md; do if [ -f "$file" ]; then printf "%s\\n" "$file"; fi; done; done'

for (const path of (await sh(["sh", "-c", found, "found", ...roots])).split("\n").filter((path) => path !== "")) {
	surface[path] = await sh(["cat", path])
}

// The skill name of `path`, its directory name, or undefined when `path` is not a skill path. A `.` or `..` directory
// is not a skill: the file would be outside the skill folders.
function skillOf(path) {
	const root = roots.find((folder) => path.startsWith(`${folder}/`))

	const name =
		SKILL.exec(path)?.[1] ??
		(root === undefined ? undefined : /^([^/]+)\/SKILL\.md$/.exec(path.slice(root.length + 1))?.[1])

	return name === "." || name === ".." ? undefined : name
}

// Checks that each path of `entries` is allowed and comes once, and returns a map from path to entry.
function checked(label, entries, allowed, refused) {
	const paths = new Map()

	for (const entry of entries) {
		if (!allowed(entry.path)) throw new Error(`${label} ${entry.path} ${refused}`)

		if (paths.has(entry.path)) throw new Error(`${label} ${entry.path} comes twice`)
		paths.set(entry.path, entry)
	}

	return paths
}

const json = (value) => JSON.stringify(value, null, 2)
const { edits } = await agent(prompts.inv({ texts: json(texts), traces: json(traces) }), { schema: EDITS })

if (edits.length === 0) throw new Error("the inv turn gave no edit")

const inv = checked("inv edit", edits, (path) => Object.hasOwn(texts, path), "is not a baseline path")

const dom = (
	await agent(prompts.dom({ texts: json(surface), traces: json(traces), roots: json(roots) }), { schema: EDITS })
).edits

const skills = checked(
	"dom edit",
	dom,
	(path) => path === "AGENTS.md" || skillOf(path) !== undefined,
	"is not a skill or AGENTS.md path",
)

// INV paths are prompt and profile paths, and DOM paths are skill and AGENTS.md paths, so the two never overlap.
const proposed = new Set([...inv.keys(), ...skills.keys()])

// The baseline text of `path`, or null for a new path.
const current = { ...texts, ...surface }
const baselineOf = (path) => current[path] ?? null

const composed = await agent(
	prompts.compose({
		edits: json([
			...edits.map((edit) => ({ source: "inv", ...edit })),
			...dom.map((edit) => ({ source: "dom", ...edit })),
		]),
		texts: json(Object.fromEntries([...proposed].map((path) => [path, baselineOf(path)]))),
	}),
	{ schema: COMPOSE },
)

const overlay = Object.fromEntries(
	[
		...checked("compose overlay", composed.overlay, (path) => proposed.has(path), "has no inv or dom edit").values(),
	].map(({ path, text }) => [path, text]),
)

const notes = composed.notes.map(({ verdict, edit, moment }) => `${verdict} -> ${edit} -> ${oneLine(moment)}`)

// The reasons why the candidate `overlay` is not valid, in overlay order.
function reasonsOf(overlay) {
	const reasons = Object.keys(overlay).length === 0 ? ["invalid candidate: the overlay has no entry"] : []
	// The AGENTS.md text that sessions load with the overlay.
	const agentsText = (Object.hasOwn(overlay, "AGENTS.md") ? overlay["AGENTS.md"] : baselineOf("AGENTS.md")) ?? ""
	const escaped = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

	for (const [path, text] of Object.entries(overlay)) {
		const name = skillOf(path)

		if (path === "AGENTS.md") {
			const length = (text ?? "").replace(/\n$/, "").length
			const cap = args["always-on-max"] ?? surface["AGENTS.md"]?.length ?? 0

			if (length > cap) reasons.push(`invalid candidate: AGENTS.md has ${length} characters, over the ${cap} cap`)
		} else if (name !== undefined && text === null) {
			if (new RegExp(`(^|[^\\w-])${escaped(name)}($|[^\\w-])`).test(agentsText)) {
				reasons.push(`invalid candidate: ${path} removes the skill ${name} that AGENTS.md names`)
			}
		} else if (name !== undefined) {
			const frontmatter = /^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? ""

			for (const field of ["name", "description"]) {
				if (!new RegExp(`^${field}:[ \\t]*\\S`, "m").test(frontmatter)) {
					reasons.push(`invalid candidate: ${path} has no ${field}`)
				}
			}
		}
	}

	return reasons
}

const invalid = reasonsOf(overlay)

// `render` leaves out an empty section, so the selector sees an empty diff as `(no change)`.
const shown = (diff) => (diff === "" ? "(no change)" : diff)
const lines = []
let wins = 0

const runMemory = await memory()

// The changed files of the candidate: one row of the run memory names them for each item.
const files = Object.keys(overlay)
const confounded = files.length > 1

if (invalid.length === 0) {
	for (const item of items) {
		const candidate = await ship(item, { overlay, from: item.from })
		// The order of the two diffs depends only on the saved run ID or the item file name, and the item text, so it is
		// the same in each run.
		const first = hashOf(`${item.name}\n${item.text}`) % 2 === 0
		const [A, B] = first ? [candidate.diff, item.baseline.diff] : [item.baseline.diff, candidate.diff]

		const choice = await agent(prompts.select({ item: item.text, A: shown(A), B: shown(B) }), {
			as: "judge",
			schema: SELECT,
		})

		const verdict = choice === "tie" ? "tie" : (choice === "A") === first ? "win" : "loss"

		if (verdict === "win") wins++
		lines.push(`${item.name}: ${verdict}`)

		await runMemory.note(`item ${subjectOf(item.text)}`, undefined, [
			`files ${files.join(", ")}, verdict ${verdict}, confounded ${confounded ? "yes" : "no"}`,
		])
	}
}

// When the candidate is not valid, no item ships, so `lines` is empty.
const outcomes = [...lines, ...invalid]

const promoted = items.length >= 4 && wins / items.length >= 0.75

const write = 'mkdir -p "$(dirname "$1")" && printf "%s\\n" "$2" > "$1"'

await sh(["mkdir", "-p", `${runDir}/baseline`, `${runDir}/best`])

await sh(["sh", "-c", write, "write", `${runDir}/notes.txt`, notes.join("\n")])

for (const [path, text] of Object.entries(overlay)) {
	// An absolute key goes under its own path in the two folders.
	const key = path.replace(/^\//, "")
	const before = baselineOf(path)

	if (before !== null) await sh(["sh", "-c", write, "write", `${runDir}/baseline/${key}`, before])
	const best = promoted ? text : before

	if (best !== null) await sh(["sh", "-c", write, "write", `${runDir}/best/${key}`, best])
}

const header = [
	...outcomes,
	...[...edits, ...dom].map(({ path, moment }) => `edit ${path}: ${oneLine(moment)}`),
]

const diff = `${runDir}/overlay.diff`

// git diff --no-index exits 1 when the files differ.
const compare =
	'cd "$1" && printf "%s\\n" "$2" > "$3" && { git diff --no-index --no-prefix baseline best >> "$3"; test $? -le 1; }'

await sh(["sh", "-c", compare, "diff", runDir, header.join("\n"), "overlay.diff"])

const few = items.length < 4 ? ["fewer than 4 items: nothing promoted"] : []
const line = `optimized ship: ${wins}/${items.length} wins, ${promoted ? "promoted" : "not promoted"}, ${diff}`

const result = { wins, items: items.length, promoted, overlay, notes, invalid, diff, report: [...notes, ...outcomes, ...few, line] }

// When the overlay changes more than one file, no rollout tells which change made a verdict, so no row can teach a
// lesson and the run makes no harvest turn.
return confounded ? { ...result, lessons: [] } : await runMemory.finish(meta.description, result)
