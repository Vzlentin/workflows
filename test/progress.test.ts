import { describe, expect, it } from "vitest";
import { Progress, programStatus, terminalRedraw } from "../src/progress.ts";

/** The color codes that `terminalRedraw` writes around a mark. */
const COLORS = ["\x1b[32m", "\x1b[36m", "\x1b[31m", "\x1b[0m"];

/** The text without the color codes. */
function uncolored(text: string): string {
	return COLORS.reduce((rest, code) => rest.replaceAll(code, ""), text);
}

/** A terminal stream that keeps what is written, with the color codes removed. */
function stream(rows = 24) {
	const written: string[] = [];

	return {
		written,
		columns: 40,
		rows,
		write: (text: string) => written.push(uncolored(text)),
	};
}

describe("the progress on a terminal", () => {
	it("writes again only the lines from the first one that changed", () => {
		const terminal = stream();
		const { redraw } = terminalRedraw(terminal);
		redraw(["◉ item 1/2: one"]);
		redraw(["◉ item 1/2: one", "  ◉ plan"]);
		redraw(["◉ item 1/2: one", "  ✓ plan", "  ◉ round 1: implement"]);
		redraw(["✓ item 1/2: one", "  ✓ plan", "  ✓ round 1: implement", "◉ item 2/2: two"]);
		expect(terminal.written).toEqual([
			"◉ item 1/2: one\n",
			"  ◉ plan\n",
			"\x1b[1A\r\x1b[J  ✓ plan\n  ◉ round 1: implement\n",
			"\x1b[3A\r\x1b[J✓ item 1/2: one\n  ✓ plan\n  ✓ round 1: implement\n◉ item 2/2: two\n",
		]);
	});

	it("cuts a line to the width of the terminal", () => {
		const terminal = stream();
		terminalRedraw(terminal).redraw([`◉ ${"x".repeat(50)}`]);
		expect(terminal.written).toEqual([`◉ ${"x".repeat(36)}…\n`]);
	});

	it("does not move above another write or the top of the screen", () => {
		const terminal = stream(2);
		const { redraw, forget } = terminalRedraw(terminal);
		redraw(["◉ one"]);
		forget();
		redraw(["✓ one", "◉ two"]);
		redraw(["✓ one", "✓ two", "◉ three"]);
		redraw(["✓ one", "✓ two", "✓ three", "◉ four", "◉ five"]);
		redraw(["✗ one", "✓ two", "✓ three", "◉ four", "✗ five"]);
		expect(terminal.written).toEqual([
			"◉ one\n",
			"✓ one\n◉ two\n",
			"\x1b[1A\r\x1b[J✓ two\n◉ three\n",
			"\x1b[1A\r\x1b[J✓ three\n◉ four\n◉ five\n",
			"✗ one\n✓ two\n✓ three\n◉ four\n✗ five\n",
		]);
	});
});

describe("the steps of a run", () => {
	it("give each step that ended its duration", () => {
		const progress = new Progress();
		progress.add({ kind: "phase", run: "r", parent: null, text: "plan", at: 0 });
		progress.add({ kind: "log", run: "r", parent: null, text: "a note", at: 1000 });
		progress.add({ kind: "phase", run: "r", parent: null, text: "judge", at: 185_000 });
		expect(progress.lines()).toEqual(["✓ plan  3m05s", "  a note", "◉ judge"]);
		progress.add({ kind: "end", run: "r", failed: false, at: 3_905_000 });
		expect(progress.lines()).toEqual(["✓ plan  3m05s", "  a note", "✓ judge  1h02m"]);
		// Events that an earlier version saved have no time.
		const earlier = new Progress();
		earlier.add({ kind: "phase", run: "r", parent: null, text: "plan" });
		earlier.add({ kind: "end", run: "r", failed: false });
		expect(earlier.lines()).toEqual(["✓ plan"]);
	});

	it("go on with the step that a new execution starts again in, without the time between", () => {
		const progress = new Progress();
		progress.add({ kind: "phase", run: "r", parent: null, text: "plan", at: 0, continues: true });
		progress.add({ kind: "end", run: "r", failed: true, at: 5000 });
		expect(progress.lines()).toEqual(["✗ plan  5s"]);
		progress.add({ kind: "start", run: "r" });
		progress.add({ kind: "phase", run: "r", parent: null, text: "plan", at: 9000, continues: true });
		progress.add({ kind: "phase", run: "r", parent: null, text: "judge", at: 12_000 });
		// A phase line that repeats the step within an execution is a step of its own.
		progress.add({ kind: "phase", run: "r", parent: null, text: "judge", at: 14_000 });
		expect(progress.lines()).toEqual(["✓ plan  8s", "✓ judge  2s", "◉ judge"]);
	});
});

describe("the steps of child runs", () => {
	it("move a run under its caller when a line of its own child came first", () => {
		const progress = new Progress();
		progress.add({ kind: "phase", run: "c", parent: null, text: "item 1/1: one", at: 0 });
		progress.add({ kind: "phase", run: "r", parent: "s", text: "implement", at: 1 });
		progress.add({ kind: "phase", run: "s", parent: "c", text: "rpi", at: 2 });
		expect(progress.lines()).toEqual(["◉ item 1/1: one", "  ◉ rpi", "    ◉ implement"]);
		progress.add({ kind: "status", run: "r", parent: "s", text: "implement", at: 3 });
		progress.add({ kind: "status", run: "c", parent: null, text: "item 1/1", at: 3 });
		expect(progress.status()).toBe("item 1/1 › implement");
	});
});

describe("the status of a run", () => {
	it("joins the statuses of the runs that have not ended, outermost first", () => {
		const progress = new Progress();
		expect(progress.status()).toBeUndefined();
		progress.add({ kind: "phase", run: "c", parent: null, text: "item 1/2: one", at: 0 });
		progress.add({ kind: "status", run: "c", parent: null, text: "item 1/2", at: 0 });
		progress.add({ kind: "status", run: "s", parent: "c", text: "plan", at: 1 });
		expect(progress.status()).toBe("item 1/2 › plan");
		// An empty status removes the status of its run.
		progress.add({ kind: "status", run: "s", parent: "c", text: "", at: 2 });
		progress.add({ kind: "status", run: "r", parent: "s", text: "round 1/3: review", at: 3 });
		expect(progress.status()).toBe("item 1/2 › round 1/3: review");
		progress.add({ kind: "status", run: "j", parent: "s", text: "judge", at: 4 });
		expect(progress.status()).toBe("item 1/2 › round 1/3: review, judge");
		progress.add({ kind: "end", run: "r", failed: false, at: 5 });
		progress.add({ kind: "end", run: "j", failed: false, at: 5 });
		progress.add({ kind: "end", run: "s", failed: false, at: 5 });
		expect(progress.status()).toBe("item 1/2");
		// The statuses are not lines of the tree.
		expect(progress.lines()).toEqual(["◉ item 1/2: one"]);
		progress.add({ kind: "end", run: "c", failed: false, at: 6 });
		expect(progress.status()).toBeUndefined();
	});
});

describe("the program status report", () => {
	it("writes the state, the kind of a blocked state, and the message in base64 with spaces for control characters", () => {
		expect(programStatus("working", "plan")).toBe("\x1b]7501;state=working:app=workflows:msg=cGxhbg==\x1b\\");
		expect(programStatus("done", "a\tb\nc\u0085é")).toBe("\x1b]7501;state=done:app=workflows:msg=YSBiIGMgw6k=\x1b\\");
		expect(programStatus("blocked", "?", "question")).toBe(
			"\x1b]7501;state=blocked:kind=question:app=workflows:msg=Pw==\x1b\\",
		);
	});

	it("cuts the message to 2048 bytes on a character boundary", () => {
		const report = programStatus("working", `a${"é".repeat(1024)}`);
		const msg = report.slice(report.indexOf("msg=") + 4, -2);
		expect(Buffer.from(msg, "base64").toString()).toBe(`a${"é".repeat(1023)}`);
		expect([msg.length <= 2732, Buffer.byteLength(report) <= 4096]).toEqual([true, true]);
	});
});
