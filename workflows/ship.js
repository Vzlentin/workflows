// The research, the plan, the rounds, the review, the judge, the squash and the branch rename of `workflows ship` and
// of each `workflows campaign` item, in its worktree. Every Git step is safe to repeat: a resume runs a step again when
// its result was not saved.
export const meta = {
	description: "Ship one work item onto a new branch: research, plan, implement and review rounds, judge, and one squashed commit.",
	args: {
		item: { type: "text", positional: true, label: "work item", required: true },
		rounds: { type: "number", default: 3 },
		branch: { type: "string" },
	},
	worktree: true,
	exit: { blocked: 1, stopped: 1 },
}

const { item, rounds, start, patches = runDir } = args

// The engine gives a `meta.worktree` script `start` as a string or not at all.
if (start === undefined) {
	throw new Error("ship runs only through workflows ship or workflows campaign, which give it the start commit")
}

const subject = (item.split("\n").find((line) => line.trim() !== "") ?? "").replace(/^#+/, "").trim()
const worktree = `${runDir}/worktree`

const SHIP_OR_FIX = { enum: ["SHIP", "FIX"] }

const VERDICT = {
	type: "object",
	required: ["answers", "findings"],
	properties: {
		answers: { type: "array", minItems: 8, maxItems: 8, items: { enum: ["PASS", "FAIL"] } },
		findings: { type: "array", items: { type: "string" } },
	},
}

const COMMIT = {
	type: "object",
	required: ["branch", "subject", "body"],
	properties: { branch: { type: "string" }, subject: { type: "string" }, body: { type: "string" } },
}

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

// The research documents the code as it is, in a session of its own, so that the plan starts from its document and
// not from the context of the search.
phase("research")

const research = await session("researcher").ask(prompts.research({ item }))

phase("plan")

const planner = remembering("planner")

await planner.ask(prompts.plan({ item, research }))

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

	if (await ok(["git", "diff", "--cached", "--quiet", start])) {
		const report = [`blocked ${subject} after ${round} rounds: ${worktree}`, reply]

		return { status: "blocked", rounds: round, reply, handoff: plan, memory, report }
	}

	// The check's result is saved, so a commit that succeeded before a stop may run again with nothing staged.
	if (!(await ok(["git", "diff", "--cached", "--quiet"]))) {
		await sh(["git", "commit", "--allow-empty", "-m", `round ${round}`])
	}

	const change = [await patch(`round-${round}.patch`, start)]

	if (round > 1) change.push(await patch(`round-${round}-fix.patch`, before))
	log(stat(await sh(["git", "diff", "--shortstat", before, "HEAD"])))

	phase(`round ${round}: review`)
	const reviewer = remembering("reviewer")
	await reviewer.ask(prompts.review({ item, plan, change: change.join("\n"), reply }))
	const answer = "Answer with respond: SHIP if nothing needs to change, FIX otherwise."
	const challenge = `${await prompts.challenge()}\n\n${EVIDENCE}\n\n${answer}`

	const verdict = await reviewer.ask(challenge, { schema: SHIP_OR_FIX })
	log(verdict)

	if (verdict === "SHIP") return await judgeAndSquash(round)

	if (round === rounds) {
		return {
			status: "stopped",
			rounds: round,
			handoff: plan,
			memory,
			report: [`stopped ${subject} after ${round} rounds: ${worktree}`],
		}
	}

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
		log(`judge failed on ${subject}: ${judgeError}`)
	}

	let answer

	if (verdict !== undefined) {
		try {
			answer = await judge.ask(prompts.commit(), { schema: COMMIT })
		} catch {}
	}

	const valid = answer !== undefined && answer.subject.trim() !== ""
	const commitSubject = valid ? answer.subject.trim() : subject
	const commitMessage = valid ? `${commitSubject}\n\n${answer.body.trim()}` : subject
	const name = args.branch ?? (valid ? answer.branch.trim() : "")

	// One command, so that a repeat resets a squash commit that was made but not saved.
	const squash = 'git reset -q --soft "$1" && git commit -q -m "$2"'
	await sh(["sh", "-c", squash, "squash", start, commitMessage])
	const short = await sh(["git", "rev-parse", "--short", "HEAD"])
	const base = `ship/${runId}`
	const renamed = name === "" || name === base ? base : await sh(["sh", "-c", RENAME, "rename", base, name])
	const [branch, rejected] = renamed.split("\n")
	const judged = verdict === undefined ? "failed" : score(verdict.answers).toFixed(2)
	log(`judge ${judged}: ${short} ${commitSubject}`)
	const shipped = { status: "shipped", rounds: round, head: short, subject: commitSubject, branch }

	if (verdict !== undefined) {
		shipped.score = score(verdict.answers)
		shipped.answers = verdict.answers
		shipped.findings = verdict.findings
	}

	if (judgeError !== undefined) shipped.judgeError = judgeError
	shipped.memory = memory
	shipped.report = [`shipped ${subject} in ${round} rounds, judge ${judged}, ${short} on ${branch}`]

	if (rejected !== undefined) shipped.report.push(`branch ${name} ${rejected}; kept ${base}`)

	return shipped
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

// Zero when question 1 or 2 fails, else the passing fraction of questions 3 to 8.
function score(answers) {
	if (answers[0] !== "PASS" || answers[1] !== "PASS") return 0

	return answers.slice(2).filter((answer) => answer === "PASS").length / 6
}
