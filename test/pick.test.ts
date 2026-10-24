import { describe, expect, it } from "vitest";
import { matching, press, render } from "../src/pick.ts";

const ITEMS = ["◉ Fix the README  ship running", "· Add a thanks line  ship shipped", "✗ Docs  campaign failed"];

describe("the pick of a run", () => {
	it("filters by each typed word, in any case, and starts the cursor at the first match", () => {
		expect(matching(ITEMS, "")).toEqual([0, 1, 2]);
		expect(matching(ITEMS, "SHIP a")).toEqual([0, 1]);
		let step = press(ITEMS, { query: "", cursor: 2 }, "t");
		expect(step).toEqual({ pick: { query: "t", cursor: 0 } });
		step = press(ITEMS, { query: "thanks", cursor: 0 }, "\x7f");
		expect(step).toEqual({ pick: { query: "thank", cursor: 0 } });
	});

	it("moves with the arrows and Ctrl+N and Ctrl+P, round the ends, and takes the item under the cursor", () => {
		expect(press(ITEMS, { query: "", cursor: 0 }, "\x1b[A")).toEqual({ pick: { query: "", cursor: 2 } });
		expect(press(ITEMS, { query: "", cursor: 2 }, "\x0e")).toEqual({ pick: { query: "", cursor: 0 } });
		expect(press(ITEMS, { query: "ship", cursor: 0 }, "\x1b[B")).toEqual({ pick: { query: "ship", cursor: 1 } });
		expect(press(ITEMS, { query: "docs", cursor: 0 }, "\r")).toEqual({ taken: 2 });
		expect(press(ITEMS, { query: "nothing", cursor: 0 }, "\r")).toEqual({ pick: { query: "nothing", cursor: 0 } });
	});

	it("cancels on Esc and Ctrl+C", () => {
		expect(press(ITEMS, { query: "", cursor: 0 }, "\x1b")).toEqual({ cancelled: true });
		expect(press(ITEMS, { query: "", cursor: 0 }, "\x03")).toEqual({ cancelled: true });
	});

	it("draws the question and the matches, scrolled to keep the cursor in view", () => {
		expect(render("Attach?", ITEMS, { query: "", cursor: 0 }, 10)).toEqual([
			"Attach? ",
			...ITEMS.map((i, n) => `${n === 0 ? "›" : " "} ${i}`),
		]);
		expect(render("Attach?", ITEMS, { query: "", cursor: 2 }, 4)).toEqual([
			"Attach? ",
			`  ${ITEMS[1]}`,
			`› ${ITEMS[2]}`,
		]);
		expect(render("Attach?", ITEMS, { query: "zzz", cursor: 0 }, 4)).toEqual(["Attach? zzz", "  nothing matches"]);
	});
});
