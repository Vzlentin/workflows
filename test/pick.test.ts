import { describe, expect, it } from "vitest";
import { actionOf } from "../src/keys.ts";
import { matching, press, render, startPick } from "../src/pick.ts";

const UP = { type: "move", by: -1 } as const;
const DOWN = { type: "move", by: 1 } as const;
const TEXTS = ["◉ Fix the README  ship running", "· Add a thanks line  ship shipped", "✗ Docs  campaign failed"];

/** The items of `TEXTS`, each with its index as its value where `pickable` flags it. */
const items = (pickable: readonly boolean[]) =>
	TEXTS.map((text, index) => ({ text, value: pickable[index] === true ? index : undefined }));

const ITEMS = items([true, true, true]);

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

	it("keeps the pick open at Enter on an item that cannot be taken", () => {
		const pick = { query: "ship", cursor: 1 };
		expect(press(items([true, false, true]), pick, { type: "enter" })).toEqual({ pick });
		expect(press(items([false, true, false]), pick, { type: "enter" })).toEqual({ taken: 1 });
	});

	it("starts the cursor on the first match that can be taken, also after a new filter text", () => {
		const some = items([false, true, true]);
		expect(startPick(some, "")).toEqual({ query: "", cursor: 1 });
		expect(press(some, startPick(some, ""), { type: "enter" })).toEqual({ taken: 1 });
		expect(press(some, { query: "", cursor: 0 }, { type: "text", text: "s" })).toEqual({
			pick: { query: "s", cursor: 1 },
		});
		expect(startPick(items([false, false, false]), "")).toEqual({ query: "", cursor: 0 });
	});

	it("scrolls the matches to keep the cursor in view", () => {
		expect(render("Pick?", ITEMS, { query: "", cursor: 2 }, 4)).toEqual(["Pick? ", `  ${TEXTS[1]}`, `› ${TEXTS[2]}`]);
	});
});
