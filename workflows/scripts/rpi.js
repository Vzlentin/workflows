// The research, the plan and the implement of one work item, committed on its branch. `ship.js` runs it before the
// review loop of `thermoloop.js`, and a caller may give `memory`, the lines of a run memory to go on with. Every Git
// step is safe to repeat: a resume runs a step again when its result was not saved.
export const meta = {
	description: "Research, plan and implement one work item, and commit it on a new branch.",
	args: {
		item: { type: "text", positional: true, label: "work item", required: true },
	},
	worktree: true,
	exit: { blocked: 1 },
}

const { item, start } = args

// The engine gives a `meta.worktree` script `start` as a string or not at all.
if (start === undefined) throw new Error("rpi runs only through workflows rpi or another script, which give it the start commit")

const subject = subjectOf(item)
const notes = memory(args.memory)

// The research documents the code as it is, in a session of its own, so that the plan starts from its document and
// not from the context of the search.
phase("research")

const research = await session("researcher").ask(prompts.research({ item }))

phase("plan")

const planner = notes.session("planner")

await planner.ask(prompts.plan({ item, research }))

await planner.ask(prompts.challenge())

const plan = await planner.noted(
	0,
	prompts.handoff(),
	"the document, and notes are the decisions of this session, each with its reason.",
)

phase("implement")

const implemented = { plan, round: 1, start, message: subject, memory: notes.lines }
const { status, head, reply, memory: lines } = await run("implement", implemented)

if (status === "blocked") {
	return { status: "blocked", rounds: 1, reply, handoff: plan, memory: lines, report: [`blocked ${subject}`, reply] }
}

return { status: "implemented", head, plan, reply, memory: lines, report: [`implemented ${subject}, ${head}`] }
