// Script lib: run calls at once, and in order.

/** Runs every thunk at once and gives their results in order. */
const parallel = (thunks) => Promise.all(thunks.map((thunk) => thunk()));

/** Passes each item through the stages in order, all items at once, and gives the results in item order. */
const pipeline = (items, ...stages) =>
	Promise.all(
		items.map(async (item) => {
			let value = item;

			for (const stage of stages) value = await stage(value);

			return value;
		}),
	);

/**
 * Writes the commit message of the change from `start` to `HEAD` in one turn of an `implementer` session, squashes the
 * change into one commit with it, then judges the squashed commit in the child run `judge.js`. Returns `{ head,
 * subject, score, answers, findings, judgeError, divergence }`, with `head` the short head from `squash` and `subject`
 * the commit subject. When the turn fails or gives an empty subject, the message is the subject of `item`.
 */
async function commitAndJudge(item, start) {
	const head = await sh(["git", "rev-parse", "HEAD"]);

	const schema = {
		type: "object",
		required: ["subject", "body"],
		properties: { subject: { type: "string" }, body: { type: "string" } },
	};

	const answer = await session("implementer")
		.ask(prompts.commit({ item, base: start, head }), { schema })
		.catch(() => undefined);

	const written = answer?.subject.trim() ?? "";
	const subject = written === "" ? subjectOf(item) : written;
	const body = written === "" ? "" : answer.body.trim();
	const message = body === "" ? subject : `${subject}\n\n${body}`;
	const short = await squash(start, message, subject);
	const { score, answers, findings, judgeError, divergence } = await run("judge", { item, start });

	return { head: short, subject, score, answers, findings, judgeError, divergence };
}
