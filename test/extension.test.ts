import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	AgentToolResult,
	ExtensionAPI,
	ExtensionCommandContext,
	Theme,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import extension from "../extensions/workflows.ts";

let root: string;
let tool: ToolDefinition;
let command: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
let messages: { content: unknown; details?: unknown }[];
let prompts: unknown[][];

/** A fake `workflows` command: its behavior comes from its arguments, which it appends to `args.log`. */
const FAKE = `#!/bin/sh
echo "$@" >> args.log
case "$1" in
ok)
	echo "run r1"; echo "phase one" >&2; echo "log two" >&2
	echo '{"runId":"r1","status":"finished","result":{"answer":42},"report":["{\\"answer\\":42}"]}' ;;
-)
	echo "run r2"; cat > stdin.js
	echo '{"runId":"r2","status":"finished","result":"from stdin","report":["from stdin"]}' ;;
bad) echo "run r3"; echo "phase one" >&2; echo '{"runId":"r3","status":"failed","error":"boom"}'; exit 1 ;;
slow)
	echo "run r4"
	trap 'echo '"'"'{"runId":"r4","status":"interrupted"}'"'"'; exit 130' INT
	echo "started" >&2
	while :; do sleep 0.02; done ;;
usage) echo "workflows: unknown flag" >&2; exit 2 ;;
ship)
	echo "run r5"
	echo '{"runId":"r5","status":"finished","result":{"status":"shipped","rounds":1,"head":"abc"},"report":["shipped Fix the README typo in 1 rounds, judge failed, abc"]}' ;;
campaign)
	echo "run r6"
	echo '{"runId":"r6","status":"finished","result":{"status":"done","items":[]},"report":["done Fix the docs in 2 items, abc"]}' ;;
optimize)
	echo "run r7"
	echo '{"runId":"r7","status":"finished","result":{"baseline":0.5,"best":0.75,"diff":"prompts.diff"},"report":["optimized ship: baseline 0.50, best 0.75, prompts.diff"]}' ;;
list) echo "r5 ship shipped Fix the README typo"; echo "r4 run unfinished slow" ;;
save)
	[ -n "$3" ] || { echo "workflows: give one run ID and one name" >&2; echo "usage: workflows save <run-id> <name> [--force]" >&2; exit 2; }
	[ "$2" = r5 ] || { echo "workflows: no run $2" >&2; exit 1; }
	echo "/repo/.workflows/workflows/$3.js\${4:+ $4}" ;;
show)
	[ -n "$2" ] || { echo "workflows: give one run ID" >&2; echo "usage: workflows show <run-id> [--json]" >&2; exit 2; }
	[ "$2" = r5 ] || { echo "workflows: no run $2" >&2; exit 1; }
	echo "run r5 ship shipped Fix"; echo "  ✓ sh git status  0s" ;;
*) exit 9 ;;
esac
`;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "workflows-extension-test-"));
	await writeFile(join(root, "workflows"), FAKE);
	messages = [];
	prompts = [];
	const pi = {
		registerTool: (registered: ToolDefinition) => {
			tool = registered;
		},
		registerCommand: (name: string, options: { handler: typeof command }) => {
			expect(name).toBe("workflows");
			command = options.handler;
		},
		sendMessage: (message: { content: unknown; details?: unknown }) => messages.push(message),
		sendUserMessage: (...args: unknown[]) => prompts.push(args),
	} as unknown as ExtensionAPI;
	extension(pi, ["/bin/sh", join(root, "workflows")]);
});

afterEach(() => rm(root, { recursive: true, force: true }));

async function call(params: object, signal?: AbortSignal) {
	const updates: string[] = [];
	const partials: AgentToolResult<unknown>[] = [];
	const onUpdate = (partial: AgentToolResult<unknown>) => {
		const [first] = partial.content;
		updates.push(first?.type === "text" ? first.text : "");
		partials.push(partial);
	};
	const ctx = { cwd: root } as Parameters<ToolDefinition["execute"]>[4];
	const result = await tool.execute("call-1", params, signal, onUpdate, ctx);
	return { result, updates, partials };
}

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as unknown as Theme;

/** The lines that the renderers draw for the call row and, when given, for `result`. */
function draw(args: object, result?: AgentToolResult<unknown>, isPartial = false): string[] {
	const context = { args } as Parameters<NonNullable<ToolDefinition["renderCall"]>>[2];
	const components = [
		tool.renderCall?.(args, theme, context),
		result && tool.renderResult?.(result, { expanded: false, isPartial }, theme, context),
	];
	return components.flatMap((component) => component?.render(200).map((line) => line.trimEnd()) ?? []);
}

describe("the workflow tool", () => {
	it("returns the structured result of a finished run, with each stderr line as progress", async () => {
		const args = { path: "src", depth: 2, all: true, dry: false, tags: ["a"] };
		const { result, updates } = await call({ name: "ok", args });
		expect(result.structuredContent).toEqual({
			runId: "r1",
			status: "finished",
			result: { answer: 42 },
			report: ['{"answer":42}'],
		});
		expect(result.isError).toBeUndefined();
		expect(updates).toEqual(["phase one", "log two"]);
		expect(await readFile(join(root, "args.log"), "utf8")).toBe('ok --path=src --depth=2 --all --tags=["a"] --json\n');
	});

	it("sends a script on stdin, passes every argument as a flag", async () => {
		const script = await call({ script: "return 'hi'" });
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
			"- --json",
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

	it("stops the run with SIGINT on Esc and returns it as interrupted", async () => {
		const esc = new AbortController();
		const updates: string[] = [];
		const ctx = { cwd: root } as Parameters<ToolDefinition["execute"]>[4];
		const result = await tool.execute(
			"call-1",
			{ name: "slow" },
			esc.signal,
			(partial) => {
				const line = (partial.content[0] as { text: string }).text;
				updates.push(line);
				if (line === "started") esc.abort();
			},
			ctx,
		);
		expect(result.structuredContent).toEqual({ runId: "r4", status: "interrupted" });
		expect(result.isError).toBe(true);
		expect(updates).toEqual(["started"]);
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
	});

	it("draws the steps of a running run, the last one as running", async () => {
		const { partials } = await call({ name: "ok" });
		expect(draw({ name: "ok" }, partials[1], true)).toEqual(["workflow ok", "✓ phase one", "◉ log two"]);
	});

	it("draws the report lines after the steps of a finished run", async () => {
		const ok = await call({ name: "ok" });
		expect(draw({ name: "ok" }, ok.result)).toEqual(["workflow ok", "✓ phase one", "✓ log two", '{"answer":42}']);

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
			"✗ phase one",
			'✗ run r3 failed: boom; continue it with resume: "r3"',
		]);
	});

	it("throws the stderr text when no run starts", async () => {
		await expect(call({ name: "usage" })).rejects.toThrow("workflows: unknown flag");
		await expect(call({ name: "ok", resume: "r1" })).rejects.toThrow("give exactly one of name, script or resume");
	});
});

describe("/workflows", () => {
	const ctx = (idle = true) => ({ cwd: root, isIdle: () => idle }) as unknown as ExtensionCommandContext;

	it("lists the runs", async () => {
		await command("", ctx());
		expect(messages.map((message) => message.content)).toEqual([
			"r5 ship shipped Fix the README typo\nr4 run unfinished slow",
		]);
	});

	it("shows a run, or the error of the command", async () => {
		await command("show r5", ctx());
		await command("show r9", ctx());
		await command("show", ctx());
		await command("nope", ctx());
		expect(messages.map((message) => message.content)).toEqual([
			"run r5 ship shipped Fix\n  ✓ sh git status  0s",
			"workflows: no run r9",
			"workflows: give one run ID\nusage: workflows show <run-id> [--json]",
			"usage: /workflows [show <run-id> | save <run-id> <name> [--force] | resume <run-id>]",
		]);
	});

	it("saves the script of a run, or sends the error of the command", async () => {
		await command("save r5 fix", ctx());
		await command("save r9 fix", ctx());
		await command("save r5 fix --force", ctx());
		await command("save r5", ctx());
		expect(messages.map((message) => message.content)).toEqual([
			"/repo/.workflows/workflows/fix.js",
			"workflows: no run r9",
			"/repo/.workflows/workflows/fix.js --force",
			"workflows: give one run ID and one name\nusage: workflows save <run-id> <name> [--force]",
		]);
	});

	it("asks the agent to resume a run with the workflow tool", async () => {
		await command("resume r4", ctx());
		await command("resume r5", ctx(false));
		const message = (id: string) => `Continue the workflow run ${id} with the workflow tool: resume: "${id}".`;
		expect(prompts).toEqual([
			[message("r4"), undefined],
			[message("r5"), { deliverAs: "followUp" }],
		]);
		expect(messages).toEqual([]);
		await expect(readFile(join(root, "args.log"), "utf8")).rejects.toThrow();
	});
});
