// Script lib: text.
// It runs in the sandbox after the prelude of script.ts, so it uses only the script calls. A script's own
// declarations shadow these names.

/** The subject of a text: its first non-empty line without leading `#`. */
const subjectOf = (text) => (text.split("\n").find((line) => line.trim() !== "") ?? "").replace(/^#+/, "").trim();
