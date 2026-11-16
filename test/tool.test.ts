import { describe, expect, it } from "vite-plus/test";
import { outcomeText, runCli, Steps } from "../src/tool.ts";

/** The command that runs `script` with `/bin/sh -c`; the args of a call are `$1`, `$2`, … */
function sh(script: string): string[] {
	return ["/bin/sh", "-c", script, "sh"];
}

describe("runCli", () => {
	it("gives the stdout lines, the exit code, the first run ID, and the update text of each stderr line to the steps", async () => {
		const seen: { text: string; progress: boolean; lines: string[] }[] = [];
		const out: string[] = [];
		const steps = new Steps();

		const output = await runCli(
			sh(
				[
					`echo "run $1"`,
					`echo "run other"`,
					`echo '{"status":"review","progress":["✓ plan","◉ review"]}' >&2`,
					"echo warning >&2",
					`printf 'last'`,
					"exit 3",
				].join("\n"),
			),
			["r-1"],
			"/",
			{
				steps,
				run: (runId) => out.push(runId),
				stderr: (text, progress) => seen.push({ text, progress, lines: steps.lines }),
			},
		);

		expect(output).toEqual({ code: 3, stdout: ["run r-1", "run other", "last"], stderr: ["warning"] });
		expect(out).toEqual(["r-1"]);
		expect(seen).toEqual([
			{ text: "◉ review", progress: true, lines: ["✓ plan", "◉ review"] },
			{ text: "warning", progress: false, lines: ["✓ plan", "◉ review", "warning"] },
		]);
		expect(steps.step).toBe("review");
	});

	it("keeps only the last 100 stderr lines that are not progress lines", async () => {
		const steps = new Steps();

		const output = await runCli(
			sh(`i=1; while [ $i -le 150 ]; do echo "line $i" >&2; echo '{"progress":["◉ x"]}' >&2; i=$((i+1)); done`),
			[],
			"/",
			{ steps },
		);

		expect(steps.lines).toEqual(["◉ x", ...output.stderr]);
		expect(output.stderr).toHaveLength(100);
		expect(output.stderr[0]).toBe("line 51");
		expect(output.stderr.at(-1)).toBe("line 150");
	});

	it("gives in stderr only the lines of its own call when calls share the steps", async () => {
		const steps = new Steps();

		const first = await runCli(sh("echo 'error: first wait failed' >&2; exit 1"), [], "/", { steps });
		const second = await runCli(sh("echo 'error: second wait failed' >&2; exit 1"), [], "/", { steps });

		expect(first.stderr).toEqual(["error: first wait failed"]);
		expect(second.stderr).toEqual(["error: second wait failed"]);
		expect(steps.lines).toEqual(["error: first wait failed", "error: second wait failed"]);
	});

	it("splits on CRLF, gives stdin, and runs with env when it is set", async () => {
		const output = await runCli(sh(`printf 'a\\r\\nb\\n'; cat; echo "$WF_TEST"`), [], "/", {
			stdin: "in\n",
			env: { WF_TEST: "set" },
		});

		expect(output.stdout).toEqual(["a", "b", "in", "set"]);
	});

	it("rejects when the command cannot start", async () => {
		await expect(runCli(["/no/such/program"], [], "/")).rejects.toThrow();
	});
});

describe("Steps", () => {
	it("gives the last progress lines, then the last 100 other lines, and the step", () => {
		const steps = new Steps();

		expect(steps.step).toBe("starting");
		expect(steps.add('{"progress":["✓ plan","  ◉ review "]}')).toEqual({ text: "◉ review", progress: true });
		expect(steps.step).toBe("◉ review");

		for (let n = 1; n <= 120; n += 1) expect(steps.add(`w${n}`)).toEqual({ text: `w${n}`, progress: false });

		expect(steps.add('{"progress":["◉ judge"],"status":"item 1/2 › judge"}')).toEqual({
			text: "◉ judge",
			progress: true,
		});
		expect(steps.step).toBe("item 1/2 › judge");
		expect(steps.lines).toHaveLength(101);
		expect(steps.lines.slice(0, 2)).toEqual(["◉ judge", "w21"]);
		expect(steps.lines.at(-1)).toBe("w120");
	});
});

describe("outcomeText", () => {
	it("gives the whole findings of a done value, without its top-level memory and report", () => {
		const findings = Array.from({ length: 8 }, (_, n) => `finding ${n}: ${"f".repeat(85)}`);
		const value = { findings, memory: ["m".repeat(5000)], report: ["r"], items: [{ memory: "kept" }] };
		const text = outcomeText({ runId: "r1", state: "done", result: { code: 0 }, value, report: [] });

		expect(text).toBe(`run r1 done, exit 0: ${JSON.stringify({ findings, items: [{ memory: "kept" }] })}`);
	});

	it("gives a string value as its JSON", () => {
		const text = outcomeText({ runId: "r1", state: "done", result: { code: 0 }, value: 'a "b"', report: [] });

		expect(text).toBe('run r1 done, exit 0: "a \\"b\\""');
	});

	it("keeps a report line of 1000 bytes whole, and cuts a report line longer than 4000 bytes to 3997 bytes and …", () => {
		const whole = "é".repeat(500);

		const text = outcomeText({
			runId: "r1",
			state: "done",
			result: { code: 0 },
			value: 1,
			report: [whole, "x".repeat(4100)],
		});

		expect(text.split("\n")).toEqual(["run r1 done, exit 0: 1", whole, `${"x".repeat(3997)}…`]);
	});
});
