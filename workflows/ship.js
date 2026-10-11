// The plan, the rounds, the review, the judge and the squash of `workflows ship` and of each `workflows campaign`
// item, in its worktree. Every Git step is safe to repeat: a resume runs a step again when its result was not saved.
const { item, rounds, start, subject, patches = runDir } = args
if (typeof start !== "string") {
	throw new Error("ship runs only through workflows ship or workflows campaign, which give it the start commit")
}

const SHIP_OR_FIX = { enum: ["SHIP", "FIX"] }
const VERDICT = {
	type: "object",
	required: ["answers", "findings"],
	properties: {
		answers: { type: "array", minItems: 8, maxItems: 8, items: { enum: ["PASS", "FAIL"] } },
		findings: { type: "array", items: { type: "string" } },
	},
}
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

// The run memory: numbered notes of the planner, the implementers and the reviewers, only appended to. It is built
// from saved answers only, so a resume builds the same memory and the same prompts.
const memory = []

phase("plan")
const planner = remembering("planner")
await planner.ask(prompts.plan({ item }))
await planner.ask(prompts.challenge())
let plan = await planner.noted(
	0,
	prompts.handoff(),
	"the document, and notes are the decisions of this session, each with its reason.",
)

let before = start
for (let round = 1; round <= rounds; round++) {
	phase(`round ${round}: implement`)
	const implementer = remembering("implementer")
	const reply = await implementer.noted(
		round,
		prompts.implement({ plan }),
		"your report, and notes are what you tried and what you observed.",
	)

	await sh(["git", "add", "-A"])
	if (await ok(["git", "diff", "--cached", "--quiet", start])) return { status: "blocked", rounds: round, reply, memory }
	// The check's result is saved, so a commit that succeeded before a stop may run again with nothing staged.
	if (!(await ok(["git", "diff", "--cached", "--quiet"]))) {
		await sh(["git", "commit", "--allow-empty", "-m", `round ${round}`])
	}
	const change = [await patch(`round-${round}.patch`, start)]
	if (round > 1) change.push(await patch(`round-${round}-fix.patch`, before))

	phase(`round ${round}: review`)
	const reviewer = remembering("reviewer")
	await reviewer.ask(prompts.review({ item, plan, change: change.join("\n"), reply }))
	const answer = "Answer with respond: SHIP if nothing needs to change, FIX otherwise."
	const challenge = `${await prompts.challenge()}\n\n${EVIDENCE}\n\n${answer}`
	if ((await reviewer.ask(challenge, { schema: SHIP_OR_FIX })) === "SHIP") return await judgeAndSquash(round)
	if (round === rounds) return { status: "stopped", rounds: round, memory }
	plan = await reviewer.noted(
		round,
		prompts.handoff(),
		"the document, and notes are the decisions of your challenge, with the findings that you cut and why.",
	)
	before = await sh(["git", "rev-parse", "HEAD"])
}

async function judgeAndSquash(round) {
	const head = await sh(["git", "rev-parse", "HEAD"])
	phase("judge")
	const judge = session("judge")
	let verdict
	let judgeError
	try {
		verdict = await judge.ask(prompts.judge({ item, base: start, head }), { schema: VERDICT })
	} catch (error) {
		judgeError = error.message
	}
	// One command, so that a repeat resets a squash commit that was made but not saved.
	const squash = 'git reset -q --soft "$1" && git commit -q -m "$2"'
	await sh(["sh", "-c", squash, "squash", start, message(round, verdict)])
	return {
		status: "shipped",
		rounds: round,
		head: await sh(["git", "rev-parse", "--short", "HEAD"]),
		...(verdict === undefined ? {} : { score: score(verdict.answers), answers: verdict.answers, findings: verdict.findings }),
		...(judgeError === undefined ? {} : { judgeError }),
		memory,
	}
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

// Zero when question 1 or 2 fails, else the passing fraction of questions 3 to 8.
function score(answers) {
	if (answers[0] !== "PASS" || answers[1] !== "PASS") return 0
	return answers.slice(2).filter((answer) => answer === "PASS").length / 6
}

// The squashed commit message: subject, work item, judge findings, then the trailers.
function message(round, verdict) {
	const paragraphs = [subject, item.trim()]
	const trailers = [`Rounds: ${round}`]
	if (verdict !== undefined) {
		if (verdict.findings.length > 0) paragraphs.push(verdict.findings.join("\n"))
		trailers.push(`Judge: ${score(verdict.answers).toFixed(2)}`)
	}
	return [...paragraphs, trailers.join("\n")].join("\n\n")
}
