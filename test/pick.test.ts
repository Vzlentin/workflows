import { describe, expect, it } from "vitest";
import { actionOf } from "../src/keys.ts";
import { matching, press, render } from "../src/pick.ts";

const UP = { type: "move", by: -1 } as const;
const DOWN = { type: "move", by: 1 } as const;
const ITEMS = ["◉ Fix the README  ship running", "· Add a thanks line  ship shipped", "✗ Docs  campaign failed"];

describe("the keys of a pick", () => {
	it("reads each encoding of a key as the same action", () => {
		expect(["\x1b[A", "\x1bOA", "\x10"].map(actionOf)).toEqual([UP, UP, UP]);
		expect(["\x1b[B", "\x1bOB", "\x0e"].map(actionOf)).toEqual([DOWN, DOWN, DOWN]);
		expect(["\r", "\x1b", "\x03", "\x7f"].map((key) => actionOf(key)?.type)).toEqual([
			"enter",
			"cancel",
			"cancel",
			"backspace",
		]);
		const typed = ["a", "é", "\x1b[97u"].map(actionOf);
		expect(typed).toEqual(["a", "é", "a"].map((text) => ({ type: "text", text })));
		expect(["\x1b[C", "\t"].map(actionOf)).toEqual([undefined, undefined]);
	});
});

describe("the pick of a run", () => {
	it("filters by each typed word, in any case, and starts the cursor at the first match", () => {
		expect(matching(ITEMS, "")).toEqual([0, 1, 2]);
		expect(matching(ITEMS, "SHIP a")).toEqual([0, 1]);
		expect(press(ITEMS, { query: "", cursor: 2 }, { type: "text", text: "t" })).toEqual({
			pick: { query: "t", cursor: 0 },
		});
		expect(press(ITEMS, { query: "thanks", cursor: 0 }, { type: "backspace" })).toEqual({
			pick: { query: "thank", cursor: 0 },
		});
	});

	it("moves round the ends, and takes the item under the cursor", () => {
		expect(press(ITEMS, { query: "", cursor: 0 }, UP)).toEqual({ pick: { query: "", cursor: 2 } });
		expect(press(ITEMS, { query: "", cursor: 2 }, DOWN)).toEqual({ pick: { query: "", cursor: 0 } });
		expect(press(ITEMS, { query: "ship", cursor: 0 }, DOWN)).toEqual({ pick: { query: "ship", cursor: 1 } });
		expect(press(ITEMS, { query: "docs", cursor: 0 }, { type: "enter" })).toEqual({ taken: 2 });
		expect(press(ITEMS, { query: "nothing", cursor: 0 }, { type: "enter" })).toEqual({
			pick: { query: "nothing", cursor: 0 },
		});
		expect(press(ITEMS, { query: "", cursor: 0 }, { type: "cancel" })).toEqual({ cancelled: true });
	});

	it("draws the question and the matches, scrolled to keep the cursor in view", () => {
		const all = ITEMS.map((item, n) => `${n === 0 ? "›" : " "} ${item}`);
		expect(render("Pick?", ITEMS, { query: "", cursor: 0 }, 10)).toEqual(["Pick? ", ...all]);
		expect(render("Pick?", ITEMS, { query: "", cursor: 2 }, 4)).toEqual(["Pick? ", `  ${ITEMS[1]}`, `› ${ITEMS[2]}`]);
		expect(render("Pick?", ITEMS, { query: "zzz", cursor: 0 }, 4)).toEqual(["Pick? zzz", "  nothing matches"]);
	});
});
