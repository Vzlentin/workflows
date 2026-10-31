// Script lib: the run memory, an OptMem store, or a plain file of notes when `memo` of OptMem is missing.

// The command that installs OptMem.
const MEMO_INSTALL = "curl -fsSL https://raw.githubusercontent.com/VictorTaelin/OptMem/main/install.sh | sh";

// The prefix of every `memo` call: `sh -c "${MEMO} ..." memo <store> <args>` runs with `$m`, the user's `memo`, and
// with `MEMORY_DIR` set to the store, so that a run never writes to the user's own memory.
const MEMO =
	`m="$HOME/.optmem/memo"; [ -x "$m" ] || { echo "workflows: memo of OptMem is missing at $m. Install it with: ` +
	`${MEMO_INSTALL}" >&2; exit 1; }; export MEMORY_DIR="$1"; shift;`;

// Without `memo`, the store is this file of `#<k> <note>` lines in the store folder, with no summaries.
const PLAIN = "notes.txt";

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
 * Opens the store `<runDir>/memory`: an OptMem store, or, without `memo`, a plain store. Returns whether it is plain.
 */
async function openStore() {
	const path = `${runDir}/memory`;

	// `wake` splits an output above PART_CHARS (20000 bytes by default) into parts, and its 96 lines of notes can reach
	// about 29 KB. One part keeps the section whole.
	const opened = await sh([
		"sh",
		"-c",
		'm="$HOME/.optmem/memo"; if [ -x "$m" ]; then export MEMORY_DIR="$1"; "$m" init >/dev/null && ' +
			'"$m" config PART_CHARS=100000 >/dev/null && echo optmem; else mkdir -p "$1" && touch "$1/$2" && echo plain; fi',
		"memory",
		path,
		PLAIN,
	]);

	const plain = opened === "plain";

	if (plain) {
		log(
			"memo of OptMem is missing, so the run memory keeps plain notes without summaries. Install it with: " +
				MEMO_INSTALL,
		);
	}

	return { path, plain };
}

/** The OptMem store `path`, through `memo`. */
function optmemStore(path) {
	// Answers each compression that `output` asks for with a summarizer turn, until none is left.
	const compress = async (output) => {
		while (output.includes("Compress memories")) {
			const asked = output.slice(output.indexOf("Compress memories"));
			const prompt = asked.slice(0, asked.search(/^Run:/m)).trim();
			const [, lo, hi] = /nap (\d+)-(\d+)/.exec(asked);
			const answer = "When you are done, answer with only the one line, with no other text.";
			const summary = await agent(`${prompt}\n\n${answer}`, { as: "summarizer" });

			const line = cutNote("", oneLine(String(summary)));
			output = await memo(path, "nap", `${lo}-${hi}`, line);
		}
	};

	return {
		wake: async () => {
			const woken = await memo(path, "wake");
			await compress(woken);

			return woken;
		},
		add: async (line) => compress(await memo(path, "note", line)),
		// The notes as `#<k> <note>`, read from `LOG.txt`, whose fixed-width records of OptMem are `#<k> <date> <note>`
		// padded with spaces: `memo recall` stops at 20000 bytes.
		text: () => sh(["sh", "-c", `sed -e 's/ *$//' -e 's/^\\(#[0-9]*\\) [0-9-]* /\\1 /' "$1/LOG.txt"`, "memory", path]),
	};
}

/** The plain store `path`: the file `<path>/notes.txt`, with one `#<k> <note>` line for each note. */
function plainStore(path) {
	const file = `${path}/${PLAIN}`;
	const read = () => sh(["cat", file]);

	return {
		wake: read,
		add: async (line) => {
			await sh(["sh", "-c", 'n=$(wc -l < "$1"); printf "#%d %s\\n" $n "$2" >> "$1"', "memory", file, line]);
		},
		text: read,
	};
}

/**
 * The run memory of `ref`, the `.ref` of the memory of a caller. Without `ref.path`, opens the store
 * `<runDir>/memory`. `ref.item` is the number of the campaign item that the notes come from.
 */
async function memory(ref = {}) {
	const opened = ref.path === undefined;
	const { path, plain } = opened ? await openStore() : ref;
	const { item } = ref;
	const store = plain ? plainStore(path) : optmemStore(path);
	const prefix = item === undefined ? "" : `item ${item} `;

	const note = async (author, round, texts) => {
		for (const text of texts) {
			const line = oneLine(text);

			if (line === "") continue;

			const by = round === undefined ? author : `${author} r${round}`;
			await store.add(cutNote(`${prefix}${by}: `, line));
		}
	};

	const remembering = (profile) => {
		const s = session(profile);
		let first = true;

		// Only the first prompt gets the notes: the session keeps them in its history.
		const ask = async (prompt, options) => {
			if (!first) return s.ask(await prompt, options);
			first = false;

			const lines = (await store.wake())
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

	// The outcome has no `report` or `memory` key at any depth, also in the results of campaign items.
	const withoutReport = (key, value) => (key === "report" || key === "memory" ? undefined : value);

	// One `summarizer` turn on the notes, with no turn when there are none. The notes do not change.
	const harvest = async (work, outcome) => {
		const notes = (await store.text()).trim();

		if (notes === "") return [];

		const prompt = await prompts.harvest({
			item: work,
			outcome: JSON.stringify(outcome, withoutReport),
			run: runId,
			notes,
		});

		const { lessons } = await agent(prompt, { as: "summarizer", schema: LESSONS });

		return lessons.map(({ cue, lesson, evidence }) => ({
			cue: oneLine(cue),
			lesson: oneLine(lesson),
			evidence: oneLine(evidence),
		}));
	};

	// A run that opened its own memory ends with the lessons of its notes, and a report line for each one.
	const finish = async (work, result) => {
		if (!opened) return result;

		const lessons = await harvest(work, result);
		const lines = lessons.map(({ cue, lesson, evidence }) => `  lesson ${cue}: ${lesson} (${evidence})`);

		return { ...result, lessons, report: [...result.report, ...lines] };
	};

	return {
		ref: { path, plain, item },
		note,
		finish,
		session: remembering,
		get text() {
			return store.text();
		},
	};
}

const NOTED = {
	type: "object",
	required: ["text", "notes"],
	properties: { text: { type: "string" }, notes: { type: "array", items: { type: "string" } } },
};

const LESSONS = {
	type: "object",
	required: ["lessons"],
	properties: {
		lessons: {
			type: "array",
			maxItems: 3,
			items: {
				type: "object",
				required: ["cue", "lesson", "evidence"],
				properties: { cue: { type: "string" }, lesson: { type: "string" }, evidence: { type: "string" } },
			},
		},
	},
};
