// Script lib: text.

/** The subject of a text: its first non-empty line without leading `#`. */
const subjectOf = (text) => (text.split("\n").find((line) => line.trim() !== "") ?? "").replace(/^#+/, "").trim();
