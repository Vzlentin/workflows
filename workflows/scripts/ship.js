// `workflows ship` and each `workflows campaign` item, in its worktree: the child runs `rpi.js` and `thermoloop.js`,
// then `commitAndJudge`: the commit message turn, the squash, and the child run `judge.js` on the squashed commit. A
// caller may give `memory`, the `ref` of a run memory to go on with. The engine names the branch from `subject` of the
// result. Every Git step is safe to repeat: a resume runs a step again when its result was not saved.
export const meta = {
	description: "Ship one work item onto a new branch: research, plan, implement, review rounds, one squashed commit, and judge.",
	args: {
		item: { type: "text", positional: true, label: "work item", required: true },
		rounds: { type: "number", default: 3 },
	},
	worktree: true,
	exit: { shipped: 0, blocked: 1, stopped: 1 },
	outline: [
		{ kind: "agent", role: "researcher", label: "research" },
		{ kind: "agent", role: "planner", label: "plan" },
		{ kind: "run", workflow: "implement", label: "implement" },
		{
			kind: "loop",
			label: "review, in rounds",
			steps: [
				{ kind: "agent", role: "reviewer", label: "review" },
				{ kind: "run", workflow: "implement", label: "fix" },
			],
		},
		{ kind: "run", workflow: "judge", label: "judge" },
	],
}

const { item, rounds, start, patches = runDir } = args

// The engine gives a `meta.worktree` script `start` as a string or not at all.
if (start === undefined) {
	throw new Error("ship runs only through workflows ship or workflows campaign, which give it the start commit")
}

const subject = subjectOf(item)
const worktree = cwd

// The result of a child run that did not get to the judge, with the report lines of ship.
const unshipped = ({ status, rounds, reply, handoff, memory }) => {
	const report = [`${status} ${subject} after ${rounds} rounds: ${worktree}`]

	return { status, rounds, reply, handoff, memory, worktree, report: status === "blocked" ? [...report, reply] : report }
}

const notes = await memory(args.memory)

const built = await run("rpi", { item, start, memory: notes.ref })

if (built.status !== "implemented") return notes.finish(item, unshipped(built))

const { plan, reply } = built
const reviewed = await run("thermoloop", { item, rounds, start, patches, plan, reply, memory: notes.ref })

if (reviewed.status !== "approved") return notes.finish(item, unshipped(reviewed))

const shipped = await commitAndJudge(item, start)
const judged = shipped.score === undefined ? "failed" : shipped.score.toFixed(2)

return notes.finish(item, {
	status: "shipped",
	rounds: reviewed.rounds,
	...shipped,
	memory: reviewed.memory,
	worktree,
	report: [`shipped ${subject} in ${reviewed.rounds} rounds, judge ${judged}, ${shipped.head}`],
})
