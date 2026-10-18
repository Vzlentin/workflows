import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonValue } from "@earendil-works/chord";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import extension, { workflowTool } from "../pi/index.ts";

type Tool = ReturnType<typeof workflowTool>;

let root: string;
let tool: Tool;

/** A fake `workflows` command: its behavior comes from its arguments, which it appends to `args.log`. */
const FAKE = `#!/bin/sh
echo "$@" >> args.log
case "$1" in
ok)
	echo "run r1"; echo '{"progress":["◉ item 1/2: one"]}' >&2
	echo '{"progress":["◉ item 1/2: one","  ◉ plan"]}' >&2; echo "warning: slow disk" >&2
	echo '{"progress":["◉ item 1/2: one","  ✓ plan","  judge failed","◉ item 2/2: two"]}' >&2
	echo '{"progress":["✓ item 1/2: one","  ✓ plan","  judge failed","✓ item 2/2: two"]}' >&2
	echo '{"runId":"r1","status":"finished","result":{"answer":42},"report":["{\\"answer\\":42}"]}' ;;
-)
	echo "run r2"; cat > stdin.js
	echo '{"runId":"r2","status":"finished","result":"from stdin","report":["from stdin"]}' ;;
bad) echo "run r3"; echo '{"progress":["✗ one"]}' >&2; echo '{"runId":"r3","status":"failed","error":"boom"}'; exit 1 ;;
slow)
	echo "run r4"
	trap 'echo '"'"'{"runId":"r4","status":"detached"}'"'"'; exit 130' INT
	echo "started" >&2
	while :; do sleep 0.02; done ;;
stopped) echo "run r8"; echo '{"runId":"r8","status":"stopped"}'; exit 130 ;;
host) echo "run r9"; echo '{"runId":"r9","status":"host-stopped"}'; exit 1 ;;
invalid) echo "run r10"; echo '{"runId":"r10","status":"lost"}' ;;
usage) echo "workflows: unknown flag" >&2; exit 2 ;;
save)
	if [ "$3" = taken ]; then echo "workflows: a workflow taken exists; replace it with --force" >&2; exit 1; fi
	echo "$PWD/.workflows/workflows/$3.js" ;;
ship)
	echo "run r5"
	echo '{"runId":"r5","status":"finished","result":{"status":"shipped","rounds":1,"head":"abc"},"report":["shipped Fix the README typo in 1 rounds, judge failed, abc"]}' ;;
campaign)
	echo "run r6"
	echo '{"runId":"r6","status":"finished","result":{"status":"done","items":[]},"report":["done Fix the docs in 2 items, abc"]}' ;;
optimize)
	echo "run r7"
	echo '{"runId":"r7","status":"finished","result":{"baseline":0.5,"best":0.75,"diff":"prompts.diff"},"report":["optimized ship: baseline 0.50, best 0.75, prompts.diff"]}' ;;
*) exit 9 ;;
esac
`;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "workflows-extension-test-"));
	await writeFile(join(root, "workflows"), FAKE);
	tool = workflowTool(["/bin/sh", join(root, "workflows")]);
});

afterEach(() => rm(root, { recursive: true, force: true }));

/** The arguments of a call of the tool, which Pi checks against the tool's parameters. */
type Params = Parameters<Tool["execute"]>[1];

/** A result or an update of a call of the tool. */
type Result = Awaited<ReturnType<Tool["execute"]>>;

/** The arguments of a call while it streams, so any field can be missing. */
type PartialParams = {
	readonly name?: string;
	readonly script?: string;
	readonly resume?: string;
	readonly save?: { readonly runId?: string; readonly name?: string; readonly force?: boolean };
	readonly args?: { readonly [key: string]: JsonValue };
};

/** The context of a tool call in `cwd`. */
const contextOf = (cwd: string) => {
	// SAFETY: `execute` of the workflow tool reads only `ctx.cwd` of its context.
	return { cwd } as Parameters<Tool["execute"]>[4];
};

async function call(params: Params, signal?: AbortSignal) {
	const updates: string[] = [];
	const partials: Result[] = [];

	const onUpdate = (partial: Result) => {
		const [first] = partial.content;
		updates.push(first?.type === "text" ? first.text : "");
		partials.push(partial);
	};

	const result = await tool.execute("call-1", params, signal, onUpdate, contextOf(root));

	return { result, updates, partials };
}

// SAFETY: the renderers of the workflow tool call only `fg` and `bold` of the theme.
const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as Theme;

/** The lines that the renderers draw for the call row and, when given, for `result`. */
function draw(args: PartialParams, result?: Result, isPartial = false): string[] {
	const components = [tool.renderCall(args, theme)];

	if (result !== undefined) components.push(tool.renderResult(result, { expanded: false, isPartial }, theme));

	return components.flatMap((component) => component.render(200).map((line) => line.trimEnd()));
}

describe("the workflow tool", () => {
	it("is the tool that the extension registers", () => {
		const names: string[] = [];
		const pi: Pick<ExtensionAPI, "registerTool"> = { registerTool: (registered) => names.push(registered.name) };
		extension(pi, ["/bin/sh", join(root, "workflows")]);
		expect(names).toEqual([tool.name]);
	});

	it("returns the structured result of a finished run, with each stderr line as an update", async () => {
		const args = { path: "src", depth: 2, all: true, dry: false, tags: ["a"] };
		const { result, updates } = await call({ name: "ok", args });
		expect(result.structuredContent).toEqual({
			runId: "r1",
			status: "finished",
			result: { answer: 42 },
			report: ['{"answer":42}'],
		});
		expect(result.isError).toBeUndefined();
		expect(updates).toEqual(["◉ item 1/2: one", "◉ plan", "warning: slow disk", "◉ item 2/2: two", "✓ item 2/2: two"]);
		expect(await readFile(join(root, "args.log"), "utf8")).toBe('ok --path=src --depth=2 --all --tags=["a"] --json\n');
	});

	it("sends a script on stdin, passes every argument as a flag", async () => {
		const script = await call({ script: "return 'hi'", args: { word: "a", all: true } });
		expect(script.result.structuredContent).toEqual({
			runId: "r2",
			status: "finished",
			result: "from stdin",
			report: ["from stdin"],
		});
		expect(await readFile(join(root, "stdin.js"), "utf8")).toBe("return 'hi'");

		const ship = await call({ name: "ship", args: { item: "Fix the README typo", rounds: 2 } });
		expect(ship.result.structuredContent).toEqual({
			runId: "r5",
			status: "finished",
			result: { status: "shipped", rounds: 1, head: "abc" },
			report: ["shipped Fix the README typo in 1 rounds, judge failed, abc"],
		});

		const campaign = await call({ name: "campaign", args: { base: "develop", goal: "goal.md" } });
		expect(campaign.result.structuredContent).toEqual({
			runId: "r6",
			status: "finished",
			result: { status: "done", items: [] },
			report: ["done Fix the docs in 2 items, abc"],
		});
		const optimize = await call({ name: "optimize", args: { workflow: "ship", items: "items", trials: 4 } });
		expect(optimize.result.structuredContent).toEqual({
			runId: "r7",
			status: "finished",
			result: { baseline: 0.5, best: 0.75, diff: "prompts.diff" },
			report: ["optimized ship: baseline 0.50, best 0.75, prompts.diff"],
		});
		expect((await readFile(join(root, "args.log"), "utf8")).split("\n")).toEqual([
			"- --word=a --all --json",
			"ship --item=Fix the README typo --rounds=2 --json",
			"campaign --base=develop --goal=goal.md --json",
			"optimize --workflow=ship --items=items --trials=4 --json",
			"",
		]);
	});

	it("returns a failed run as an error result that keeps its data", async () => {
		const { result } = await call({ name: "bad" });
		expect(result.structuredContent).toEqual({ runId: "r3", status: "failed", error: "boom" });
		expect(result.isError).toBe(true);
	});

	it("detaches from the run with SIGINT on Esc, and says how to follow or stop it", async () => {
		const esc = new AbortController();
		const updates: string[] = [];

		const result = await tool.execute(
			"call-1",
			{ name: "slow" },
			esc.signal,
			(partial) => {
				const [first] = partial.content;
				const line = first?.type === "text" ? first.text : "";
				updates.push(line);

				if (line === "started") esc.abort();
			},
			contextOf(root),
		);

		expect(result.structuredContent).toEqual({ runId: "r4", status: "detached" });
		expect(result.isError).toBe(true);
		expect(result.content).toEqual([
			{
				type: "text",
				text: 'run r4 detached and goes on in the harness host; follow it with resume: "r4", or stop it with the command workflows stop r4',
			},
		]);
		expect(updates).toEqual(["started"]);
	});

	it("returns a stopped run as an error result with the run ID to resume", async () => {
		const { result } = await call({ name: "stopped" });
		expect(result.structuredContent).toEqual({ runId: "r8", status: "stopped" });
		expect(result.isError).toBe(true);
		expect(result.content).toEqual([{ type: "text", text: 'run r8 stopped; continue it with resume: "r8"' }]);
	});

	it("returns a run whose host stopped as an error result that says how to follow it", async () => {
		const { result } = await call({ name: "host" });
		expect(result.structuredContent).toEqual({ runId: "r9", status: "host-stopped" });
		expect(result.isError).toBe(true);
		expect(result.content).toEqual([
			{
				type: "text",
				text: 'the harness host of run r9 stopped; the run continues when the host starts again, so follow it with resume: "r9"',
			},
		]);
	});

	it("throws an outcome line that is not valid", async () => {
		await expect(call({ name: "invalid" })).rejects.toThrow(
			'workflows printed an outcome that is not valid: {"runId":"r10","status":"lost"}',
		);
	});

	it("draws the call line of each kind of call", () => {
		expect(draw({ name: "ship", args: { item: "# Fix the README typo\n\nMore text" } })).toEqual([
			"workflow ship Fix the README typo",
		]);
		expect(draw({ name: "ship", args: { item: "notes/fix-readme.md" } })).toEqual(["workflow ship fix-readme"]);
		expect(draw({ name: "campaign", args: { goal: "## Fix the docs\n\nAll of them" } })).toEqual([
			"workflow campaign Fix the docs",
		]);
		expect(draw({ name: "campaign", args: { goal: "goals/docs.md" } })).toEqual(["workflow campaign docs"]);
		expect(draw({ name: "campaign" })).toEqual(["workflow campaign"]);
		expect(draw({ name: "optimize", args: { workflow: "ship", items: "items" } })).toEqual(["workflow optimize ship"]);
		expect(draw({ name: "ok" })).toEqual(["workflow ok"]);
		expect(draw({ name: "fix", args: { depth: 2, path: "src/lib" } })).toEqual(["workflow fix src/lib"]);
		expect(draw({ name: "toString" })).toEqual(["workflow toString"]);
		expect(draw({ script: "return 1" })).toEqual(["workflow script"]);
		expect(draw({ resume: "r4" })).toEqual(["workflow resume r4"]);
		expect(draw({ save: { runId: "r2", name: "fix" } })).toEqual(["workflow save r2 fix"]);
		expect(draw({ save: { runId: "r2" } })).toEqual(["workflow save r2"]);
	});

	it("draws the last progress lines of the command, then the other stderr lines", async () => {
		const { partials } = await call({ name: "ok" });
		expect(draw({ name: "ok" }, partials[2], true)).toEqual([
			"workflow ok",
			"◉ item 1/2: one",
			"  ◉ plan",
			"warning: slow disk",
		]);
	});

	it("draws the report lines after the steps of a finished run", async () => {
		const ok = await call({ name: "ok" });
		expect(draw({ name: "ok" }, ok.result)).toEqual([
			"workflow ok",
			"✓ item 1/2: one",
			"  ✓ plan",
			"  judge failed",
			"✓ item 2/2: two",
			"warning: slow disk",
			'{"answer":42}',
		]);

		const ship = await call({ name: "ship", args: { item: "Fix the README typo", rounds: 2 } });
		expect(draw({ name: "ship", args: { item: "Fix the README typo" } }, ship.result)).toEqual([
			"workflow ship Fix the README typo",
			"shipped Fix the README typo in 1 rounds, judge failed, abc",
		]);
	});

	it("draws a failed run with the failed step and the run ID to resume", async () => {
		const { result } = await call({ name: "bad" });
		expect(result.content).toEqual([{ type: "text", text: 'run r3 failed: boom; continue it with resume: "r3"' }]);
		expect(draw({ name: "bad" }, result)).toEqual([
			"workflow bad",
			"✗ one",
			'✗ run r3 failed: boom; continue it with resume: "r3"',
		]);
	});

	it("throws the stderr text when no run starts", async () => {
		await expect(call({ name: "usage" })).rejects.toThrow("workflows: unknown flag");
		const both = "give exactly one of name, script, resume or save";
		await expect(call({ name: "ok", resume: "r1" })).rejects.toThrow(both);
		await expect(call({ script: "return 1", save: { runId: "r2", name: "fix" } })).rejects.toThrow(both);
	});

	it("saves the script of a run and returns the file", async () => {
		const file = join(await realpath(root), ".workflows", "workflows", "fix.js");
		const { result } = await call({ save: { runId: "r2", name: "fix" } });
		expect(result.structuredContent).toEqual({ runId: "r2", status: "finished", result: { file }, report: [file] });
		expect(result.content).toEqual([{ type: "text", text: `saved the script of run r2 as ${file}` }]);
		expect(draw({ save: { runId: "r2", name: "fix" } }, result)).toEqual(["workflow save r2 fix", file]);

		await call({ save: { runId: "r2", name: "fix", force: true } });
		await expect(call({ save: { runId: "r2", name: "taken" } })).rejects.toThrow(
			"workflows: a workflow taken exists; replace it with --force",
		);
		expect((await readFile(join(root, "args.log"), "utf8")).split("\n")).toEqual([
			"save r2 fix",
			"save r2 fix --force",
			"save r2 taken",
			"",
		]);
	});

	it("names every script global in its prompt guidelines", async () => {
		const declarations = await readFile(new URL("../workflows/script.d.ts", import.meta.url), "utf8");
		const globals = [...declarations.matchAll(/^declare (?:const|function) (\w+)/gm)].map(([, name]) => name);
		expect(globals.length).toBeGreaterThan(10);
		const guidelines = (tool.promptGuidelines ?? []).join("\n");

		for (const name of globals) expect(guidelines, name).toContain(`\`${name}`);
	});
});
