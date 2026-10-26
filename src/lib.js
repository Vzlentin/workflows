// The lib of workflow scripts: helpers that every script gets next to the script calls of `prelude` in script.ts.
// It runs in the sandbox, so it uses only those calls. A script's own declarations shadow these names.

/** The subject of a text: its first non-empty line without leading `#`. */
const subjectOf = (text) => (text.split("\n").find((line) => line.trim() !== "") ?? "").replace(/^#+/, "").trim();

/**
 * A run memory: numbered notes, only appended to, starting with `lines`, the `lines` of another memory. `context`
 * puts the notes as a `## memory` section before a prompt. `session(profile)` is a session whose every prompt starts
 * with the notes, read when the prompt is sent, and whose `noted(round, prompt, rule)` asks for a text and notes,
 * adds the notes under the profile as author, and returns the text. A memory built from saved answers only builds the
 * same notes at resume.
 */
function memory(lines = []) {
	const notes = [...lines];

	const note = (author, round, texts) => {
		for (const text of texts) {
			const line = text.replace(/\s+/g, " ").trim();

			if (line !== "") notes.push(`#${notes.length + 1} ${author} ${round}: ${line}`);
		}
	};

	const context = (prompt) => (notes.length === 0 ? prompt : `## memory\n${notes.join("\n")}\n\n${prompt}`);

	const remembering = (profile) => {
		const s = session(profile);
		const ask = async (prompt, options) => s.ask(context(await prompt), options);

		const noted = async (round, prompt, rule) => {
			const answer = `When you are done, answer with respond: text is ${rule}`;
			const { text, notes: added } = await ask(`${await prompt}\n\n${answer}`, { schema: NOTED });
			note(profile, round, added);

			return text;
		};

		return { ask, noted };
	};

	return {
		get lines() {
			return [...notes];
		},
		note,
		context,
		session: remembering,
	};
}

const NOTED = {
	type: "object",
	required: ["text", "notes"],
	properties: { text: { type: "string" }, notes: { type: "array", items: { type: "string" } } },
};

/**
 * Stages every change and commits it as `message` when something is staged. Safe to repeat: the check's result is
 * saved, so a commit that succeeded before a stop may run again with nothing staged.
 */
async function commitAll(message) {
	await sh(["git", "add", "-A"]);

	if (!(await ok(["git", "diff", "--cached", "--quiet"]))) await sh(["git", "commit", "--allow-empty", "-m", message]);
}

/** `+12 -3 in 2 files` for the change from `from` to `to`, or `no new changes`. */
async function diffStat(from, to = "HEAD") {
	const shortstat = await sh(["git", "diff", "--shortstat", from, to]);
	const count = (word) => Number(new RegExp(`(\\d+) ${word}`).exec(shortstat)?.[1] ?? 0);
	const files = count("files? changed");

	if (files === 0) return "no new changes";

	return `+${count("insertion")} -${count("deletion")} in ${files} file${files === 1 ? "" : "s"}`;
}

/**
 * The start of the change of the branch of the current directory: its merge base with `base`. It refuses a checkout
 * with changes that are not committed, and a branch with no change from `base`.
 */
async function branchStart(base) {
	if ((await sh(["git", "status", "--porcelain"])) !== "") {
		throw new Error("the checkout has changes that are not committed; commit or stash them first");
	}

	const start = await sh(["git", "merge-base", base, "HEAD"]);

	if (await ok(["git", "diff", "--quiet", start, "HEAD"])) throw new Error(`no change from ${base}`);

	return start;
}

/** The result of the child run `name` with `values`, without its report lines and its run ID. */
async function runChild(name, values) {
	const { report: _report, runId: _runId, ...result } = await run(name, values);

	return result;
}
