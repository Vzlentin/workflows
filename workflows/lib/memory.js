// Script lib: the run memory.
// It runs in the sandbox after the prelude of script.ts, so it uses only the script calls. A script's own
// declarations shadow these names.

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
