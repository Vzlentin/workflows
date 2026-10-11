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

phase("plan")
const planner = session("planner")
await planner.ask(prompts.plan({ item }))
await planner.ask(prompts.challenge())
let plan = await planner.ask(prompts.handoff())

let before = start
for (let round = 1; round <= rounds; round++) {
	phase(`round ${round}: implement`)
	const implementer = session("implementer")
	const reply = await implementer.ask(prompts.implement({ plan }))

	await sh(["git", "add", "-A"])
	if (await ok(["git", "diff", "--cached", "--quiet", start])) return { status: "blocked", rounds: round, reply }
	// The check's result is saved, so a commit that succeeded before a stop may run again with nothing staged.
	if (!(await ok(["git", "diff", "--cached", "--quiet"]))) {
		await sh(["git", "commit", "--allow-empty", "-m", `round ${round}`])
	}
	const change = [await patch(`round-${round}.patch`, start)]
	if (round > 1) change.push(await patch(`round-${round}-fix.patch`, before))

	phase(`round ${round}: review`)
	const reviewer = session("reviewer")
	await reviewer.ask(prompts.review({ item, plan, change: change.join("\n"), reply }))
	const challenge = `${await prompts.challenge()}\n\nAnswer with respond: SHIP if nothing needs to change, FIX otherwise.`
	if ((await reviewer.ask(challenge, { schema: SHIP_OR_FIX })) === "SHIP") return await judgeAndSquash(round)
	if (round === rounds) return { status: "stopped", rounds: round }
	plan = await reviewer.ask(prompts.handoff())
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
