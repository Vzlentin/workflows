import { describe, expect, it } from "vitest";
import { actionOf } from "../src/keys.ts";
import { matching, press, render } from "../src/pick.ts";

const UP = { type: "move", by: -1 } as const;
const DOWN = { type: "move", by: 1 } as const;
const ITEMS = ["◉ Fix the README  ship running", "· Add a thanks line  ship shipped", "✗ Docs  campaign failed"];

describe("the pick of a run", () => {
	it("reads each terminal encoding of an arrow or a typed key the same", () => {
		expect(["\x1b[A", "\x1bOA", "\x1b[B", "\x1bOB"].map(actionOf)).toEqual([UP, UP, DOWN, DOWN]);
		expect(["é", "\x1b[97u"].map(actionOf)).toEqual(["é", "a"].map((text) => ({ type: "text", text })));
	});

	it("filters by each word, in any case, moves round the ends of the matches, and takes only a match", () => {
		expect(matching(ITEMS, "SHIP a")).toEqual([0, 1]);
		expect(press(ITEMS, { query: "", cursor: 0 }, UP)).toEqual({ pick: { query: "", cursor: 2 } });
		expect(press(ITEMS, { query: "ship", cursor: 1 }, DOWN)).toEqual({ pick: { query: "ship", cursor: 0 } });
		expect(press(ITEMS, { query: "docs", cursor: 0 }, { type: "enter" })).toEqual({ taken: 2 });
		const none = { query: "nothing", cursor: 0 };
		expect(press(ITEMS, none, { type: "enter" })).toEqual({ pick: none });
	});

	it("scrolls the matches to keep the cursor in view", () => {
		expect(render("Pick?", ITEMS, { query: "", cursor: 2 }, 4)).toEqual(["Pick? ", `  ${ITEMS[1]}`, `› ${ITEMS[2]}`]);
	});
});
