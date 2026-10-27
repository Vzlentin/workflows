// Script lib: the run memory, an OptMem store.

// The prefix of every `memo` call: `sh -c "${MEMO} ..." memo <store> <args>` runs with `$m`, the user's `memo`, and
// with `MEMORY_DIR` set to the store, so that a run never writes to the user's own memory.
const MEMO =
	'm="$HOME/.optmem/memo"; [ -x "$m" ] || { echo "workflows: memo of OptMem is missing at $m. Install it from ' +
	"https://github.com/VictorTaelin/OptMem with: curl -fsSL " +
	'https://raw.githubusercontent.com/VictorTaelin/OptMem/main/install.sh | sh" >&2; exit 1; }; ' +
	'export MEMORY_DIR="$1"; shift;';

// The longest note that `memo note` and `memo nap` take, in UTF-8 bytes.
const NOTE_BYTES = 280;

/** Runs `memo <args>` on the store `path`, and returns its output. */
function memo(path, ...args) {
	return sh(["sh", "-c", `${MEMO} "$m" "$@"`, "memo", path, ...args]);
}

/** The UTF-8 length of `text`: the sandbox has no `TextEncoder`. */
function bytesOf(text) {
	return encodeURIComponent(text).replace(/%../g, "x").length;
}

/**
 * `head + text`, cut to the bytes of one note. Only `text` is cut: words drop from its end, then, with no space left,
 * whole characters.
 */
function cutNote(head, text) {
	const budget = NOTE_BYTES - bytesOf(head);
	let cut = text;

	while (bytesOf(cut) > budget && cut.includes(" ")) cut = cut.slice(0, cut.lastIndexOf(" ")).trimEnd();

	if (bytesOf(cut) > budget) {
		const chars = Array.from(cut);

		while (bytesOf(chars.join("")) > budget) chars.pop();
		cut = chars.join("");
	}

	return head + cut;
}

/**
 * The run memory in the OptMem store `path`. Without `path`, opens the store `<runDir>/memory`. `item` is the number
 * of the campaign item that the notes come from.
 */
async function memory(path, item) {
	if (path === undefined) {
		path = `${runDir}/memory`;
		// `wake` splits an output above PART_CHARS (20000 bytes by default) into parts, and its 96 lines of notes can
		// reach about 29 KB. One part keeps the section whole.
		await sh(["sh", "-c", `${MEMO} "$m" init >/dev/null && "$m" config PART_CHARS=100000 >/dev/null`, "memo", path]);
	}

	const prefix = item === undefined ? "" : `item ${item} `;

	// Answers each compression that `output` asks for with a summarizer turn, until none is left.
	const compress = async (output) => {
		while (output.includes("Compress memories")) {
			const asked = output.slice(output.indexOf("Compress memories"));
			const prompt = asked.slice(0, asked.search(/^Run:/m)).trim();
			const [, lo, hi] = /nap (\d+)-(\d+)/.exec(asked);
			const answer = "When you are done, answer with only the one line, with no other text.";
			const summary = await agent(`${prompt}\n\n${answer}`, { as: "summarizer" });

			const line = cutNote("", String(summary).replace(/\s+/g, " ").trim());
			output = await memo(path, "nap", `${lo}-${hi}`, line);
		}
	};

	const note = async (author, round, texts) => {
		for (const text of texts) {
			const line = text.replace(/\s+/g, " ").trim();

			if (line === "") continue;

			const by = round === undefined ? author : `${author} r${round}`;
			await compress(await memo(path, "note", cutNote(`${prefix}${by}: `, line)));
		}
	};

	const remembering = (profile) => {
		const s = session(profile);
		let first = true;

		// Only the first prompt gets the notes: the session keeps them in its history.
		const ask = async (prompt, options) => {
			if (!first) return s.ask(await prompt, options);
			first = false;
			const woken = await memo(path, "wake");
			await compress(woken);

			const lines = woken
				.split("\n")
				.filter((line) => /^#\d+(-\d+)? /.test(line))
				.map((line) => line.replace(/^#(\d+) \d{4}-\d{2}-\d{2} /, "#$1 "));

			const text = await prompt;

			return s.ask(lines.length === 0 ? text : `## memory\n${lines.join("\n")}\n\n${text}`, options);
		};

		const noted = async (round, prompt, rule) => {
			const answer =
				`When you are done, answer with respond: text is ${rule} Each note is one line of at most ` +
				`${NOTE_BYTES} bytes.`;

			const { text, notes: added } = await ask(`${await prompt}\n\n${answer}`, { schema: NOTED });
			await note(profile, round, added);

			return text;
		};

		return { ask, noted };
	};

	return {
		path,
		item,
		note,
		session: remembering,
		// The notes as `#<k> <note>`, read from `LOG.txt`, whose fixed-width records of OptMem are `#<k> <date> <note>`
		// padded with spaces: `memo recall` stops at 20000 bytes.
		get text() {
			return sh(["sh", "-c", `sed -e 's/ *$//' -e 's/^\\(#[0-9]*\\) [0-9-]* /\\1 /' "$1/LOG.txt"`, "memory", path]);
		},
	};
}

const NOTED = {
	type: "object",
	required: ["text", "notes"],
	properties: { text: { type: "string" }, notes: { type: "array", items: { type: "string" } } },
};
