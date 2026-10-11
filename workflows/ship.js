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
const NOTES = { type: "array", items: { type: "string" } }
const HANDOFF = {
	type: "object",
	required: ["handoff", "notes"],
	properties: { handoff: { type: "string" }, notes: NOTES },
}
const IMPLEMENT = {
	type: "object",
	required: ["reply", "notes"],
	properties: { reply: { type: "string" }, notes: NOTES },
}
// The respond rules of the note turns. The notes go to the run memory.
const PLANNER_HANDOFF =
	"Answer with respond: handoff is the document, and notes are the decisions of this session, each with its reason."
const REVIEWER_HANDOFF =
	"Answer with respond: handoff is the document, and notes are the decisions of your challenge, " +
	"with the findings that you cut and why."
const IMPLEMENT_RULE =
	"When you are done, answer with respond: reply is your report, and notes are what you tried and what you observed."

// The run memory: numbered notes of the planner, the implementers and the reviewers, only appended to. It is built
// from saved answers only, so a resume builds the same memory and the same prompts.
const memory = []

phase("plan")
const planner = remembering("planner")
await planner.ask(prompts.plan({ item }))
await planner.ask(prompts.challenge())
const planned = await planner.ask(`${await prompts.handoff()}\n\n${PLANNER_HANDOFF}`, { schema: HANDOFF })
let plan = planned.handoff
remember("planner", 0, planned.notes)

let before = start
for (let round = 1; round <= rounds; round++) {
	phase(`round ${round}: implement`)
	const implementer = remembering("implementer")
	const implemented = await implementer.ask(`${await prompts.implement({ plan })}\n\n${IMPLEMENT_RULE}`, {
		schema: IMPLEMENT,
	})
	const { reply } = implemented
	remember("implementer", round, implemented.notes)

	await sh(["git", "add", "-A"])
	if (await ok(["git", "diff", "--cached", "--quiet", start])) return { status: "blocked", rounds: round, reply }
	// The check's result is saved, so a commit that succeeded before a stop may run again with nothing staged.
	if (!(await ok(["git", "diff", "--cached", "--quiet"]))) {
		await sh(["git", "commit", "--allow-empty", "-m", `round ${round}`])
	}
	const change = [await patch(`round-${round}.patch`, start)]
	if (round > 1) change.push(await patch(`round-${round}-fix.patch`, before))

	phase(`round ${round}: review`)
	const reviewer = remembering("reviewer")
	await reviewer.ask(prompts.review({ item, plan, change: change.join("\n"), reply }))
	const challenge = `${await prompts.challenge()}\n\nAnswer with respond: SHIP if nothing needs to change, FIX otherwise.`
	if ((await reviewer.ask(challenge, { schema: SHIP_OR_FIX })) === "SHIP") return await judgeAndSquash(round)
	if (round === rounds) return { status: "stopped", rounds: round }
	const handoff = await reviewer.ask(`${await prompts.handoff()}\n\n${REVIEWER_HANDOFF}`, { schema: HANDOFF })
	plan = handoff.handoff
	remember("reviewer", round, handoff.notes)
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
		...(verdict === undefined ? {} : { score: score(verdict.answers) }),
		...(judgeError === undefined ? {} : { judgeError }),
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

// A session whose every prompt starts with the run memory, read when the prompt is sent.
function remembering(profile) {
	const s = session(profile)
	return { ask: async (prompt, options) => s.ask(withMemory(await prompt), options) }
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
