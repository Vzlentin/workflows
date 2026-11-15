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
 * Writes the commit message of the change from `start` to `HEAD` in one turn of an `implementer` session, with the
 * judge's `findings` lines when there are some, and squashes the change into one commit with it. Returns `{ head,
 * subject, warnings }`, with `head` the short head from `squash`, `subject` the commit subject, and `warnings` the lines
 * that it logged for a script's report: none, or the line of a failed turn. When the turn fails or gives an empty
 * subject, the message is the subject of `item`.
 */
async function commitChange(item, start, findings = []) {
	const head = await sh(["git", "rev-parse", "HEAD"]);

	const schema = {
		type: "object",
		required: ["subject", "body"],
		properties: { subject: { type: "string" }, body: { type: "string" } },
	};

	const answer = await session("implementer").ask(
		prompts.commit({ item, base: start, head, findings: findings.join("\n") }),
		{ schema, settle: true },
	);

	const failed = answer.error !== undefined;

	const warnings = failed
		? [`commit message failed on ${subjectOf(item)}: ${answer.error}, so the message is the subject of the item`]
		: [];

	for (const line of warnings) log(line);
	const written = failed ? "" : answer.subject.trim();
	const subject = written === "" ? subjectOf(item) : written;
	const body = written === "" ? "" : answer.body.trim();
	const message = body === "" ? subject : `${subject}\n\n${body}`;
	const short = await squash(start, message, subject);

	return { head: short, subject, warnings };
}

/**
 * The child run `judge.js` on the squashed commit from `start`. Returns `head` and `subject` of `committed`, the result
 * of `commitChange`, with the judge fields `status` (`judged`, `rejected` or `unjudged`), `score`, `answers`,
 * `findings`, `judgeError` and `divergence`.
 */
async function judgeCommit(item, start, { head, subject }) {
	const { status, score, answers, findings, judgeError, divergence } = await run("judge", { item, start });

	return { head, subject, status, score, answers, findings, judgeError, divergence };
}
