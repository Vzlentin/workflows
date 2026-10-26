// The implement and review rounds of a change. `workflows review` reviews the branch of the current directory from
// its merge base with `--base`, and fixes it in rounds until the reviewer answers SHIP. `ship.js` runs it with the
// handoff of its planner as `plan`, so that its first round implements the plan. Every Git step is safe to repeat: a
// resume runs a step again when its result was not saved.
export const meta = {
	description: "Review the change of the current branch, and fix it in rounds until the reviewer answers SHIP.",
	args: {
		item: { type: "text", positional: true, label: "work item", required: true },
		base: { type: "string", default: "main" },
		rounds: { type: "number", default: 3 },
	},
	exit: { blocked: 1, stopped: 1 },
}

const { item, rounds, patches = runDir } = args
const subject = (item.split("\n").find((line) => line.trim() !== "") ?? "").replace(/^#+/, "").trim()
const planned = (args.plan ?? "") !== ""

if (!planned && (await sh(["git", "status", "--porcelain"])) !== "") {
	throw new Error("the checkout has changes that are not committed; commit or stash them before the review")
}

const start = args.start ?? (await sh(["git", "merge-base", args.base, "HEAD"]))

if (!planned && (await ok(["git", "diff", "--quiet", start, "HEAD"]))) {
	throw new Error(`no change from ${args.base} to review`)
}

const SHIP_OR_FIX = { enum: ["SHIP", "FIX"] }

const NOTED = {
	type: "object",
	required: ["text", "notes"],
	properties: { text: { type: "string" }, notes: { type: "array", items: { type: "string" } } },
}

// With the SHIP or FIX rule, and not in a template, so that a template edit cannot remove it.
const EVIDENCE =
	"A reversal of a memory note, or of a choice that the implementer explained, stays only with a defect that this " +
	"review showed: a reproduced bug, a failing check, or a quoted rule of the work item that the choice breaks. Write " +
	"it as `reverses #k: <defect>`. A preference, less code, a stricter check, or a claim from a few observations is " +
	"not a defect."

// The run memory: numbered notes of the planner, the implementers and the reviewers, only appended to. It starts with
// the notes of the caller, and is built from saved answers only, so a resume builds the same memory and the same prompts.
const memory = [...(args.memory ?? [])]

// The handoff that the next implement round follows, and the reply of the last implement round.
let plan = planned ? args.plan : ""
let reply = ""
let before = start

for (let round = 1; round <= rounds; round++) {
	if (round > 1 || planned) {
		phase(`round ${round}: implement`)
		status(`round ${round}/${rounds}: implement`)
		const implementer = remembering("implementer")

		reply = await implementer.noted(
			round,
			prompts.implement({ plan }),
			"your report, and notes are what you tried and what you observed.",
		)

		await sh(["git", "add", "-A"])

		if (await ok(["git", "diff", "--cached", "--quiet", start])) {
			return { status: "blocked", rounds: round, reply, handoff: plan, memory, report: [`blocked ${subject} after ${round} rounds`, reply] }
		}

		// The check's result is saved, so a commit that succeeded before a stop may run again with nothing staged.
		if (!(await ok(["git", "diff", "--cached", "--quiet"]))) {
			await sh(["git", "commit", "--allow-empty", "-m", `round ${round}`])
		}

		log(stat(await sh(["git", "diff", "--shortstat", before, "HEAD"])))
	}

	const change = [await patch(`round-${round}.patch`, start)]

	if (round > 1) change.push(await patch(`round-${round}-fix.patch`, before))

	phase(`round ${round}: review`)
	status(`round ${round}/${rounds}: review`)
	const reviewer = remembering("reviewer")
	await reviewer.ask(prompts.review({ item, plan, change: change.join("\n"), reply }))
	const answer = "Answer with respond: SHIP if nothing needs to change, FIX otherwise."
	const challenge = `${await prompts.challenge()}\n\n${EVIDENCE}\n\n${answer}`

	const verdict = await reviewer.ask(challenge, { schema: SHIP_OR_FIX })
	log(verdict)

	if (verdict === "SHIP") {
		const head = await sh(["git", "rev-parse", "--short", "HEAD"])

		return { status: "approved", rounds: round, handoff: plan, memory, report: [`approved ${subject} in ${round} rounds, ${head}`] }
	}

	if (round === rounds) {
		return { status: "stopped", rounds: round, handoff: plan, memory, report: [`stopped ${subject} after ${round} rounds`] }
	}

	plan = await reviewer.noted(
		round,
		prompts.handoff(),
		"the document, and notes are the decisions of your challenge, with the findings that you cut and why.",
	)
	before = await sh(["git", "rev-parse", "HEAD"])
}

function remember(author, round, notes) {
	for (const note of notes) {
		const line = note.replace(/\s+/g, " ").trim()

		if (line !== "") memory.push(`#${memory.length + 1} ${author} ${round}: ${line}`)
	}
}

function withMemory(prompt) {
	return memory.length === 0 ? prompt : `## memory\n${memory.join("\n")}\n\n${prompt}`
}

// A session whose every prompt starts with the run memory, read when the prompt is sent. `noted` asks for a text and
// notes, adds the notes to the memory under the profile as author, and returns the text.
function remembering(profile) {
	const s = session(profile)
	const ask = async (prompt, options) => s.ask(withMemory(await prompt), options)

	const noted = async (round, prompt, rule) => {
		const rules = `When you are done, answer with respond: text is ${rule}`
		const { text, notes } = await ask(`${await prompt}\n\n${rules}`, { schema: NOTED })
		remember(profile, round, notes)

		return text
	}

	return { ask, noted }
}

async function patch(name, from) {
	const path = `${patches}/${name}`
	await sh(["git", "diff", "--binary", `--output=${path}`, from, "HEAD"])

	return path
}

// `+12 -3 in 2 files` from the output of `git diff --shortstat`, or `no new changes`.
function stat(shortstat) {
	const count = (word) => Number(new RegExp(`(\\d+) ${word}`).exec(shortstat)?.[1] ?? 0)
	const files = count("files? changed")

	if (files === 0) return "no new changes"

	return `+${count("insertion")} -${count("deletion")} in ${files} file${files === 1 ? "" : "s"}`
}
