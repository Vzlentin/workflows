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
case "$1 $2" in
"run ok")
	echo "run r1"; echo "phase one" >&2; echo "log two" >&2
	echo '{"runId":"r1","status":"finished","result":{"answer":42},"report":["{\\"answer\\":42}"]}' ;;
"run -")
	echo "run r2"; cat > stdin.js
	echo '{"runId":"r2","status":"finished","result":"from stdin","report":["from stdin"]}' ;;
"run bad") echo "run r3"; echo "phase one" >&2; echo '{"runId":"r3","status":"failed","error":"boom"}'; exit 1 ;;
"run slow")
	echo "run r4"
	trap 'echo '"'"'{"runId":"r4","status":"interrupted"}'"'"'; exit 130' INT
	echo "started" >&2
	while :; do sleep 0.02; done ;;
"run usage") echo "workflows: unknown flag" >&2; exit 2 ;;
"ship --rounds=2")
	echo "run r5"
	echo '{"runId":"r5","status":"finished","result":{"status":"shipped","rounds":1,"head":"abc"},"report":["shipped Fix the README typo in 1 rounds, judge failed, abc"]}' ;;
"list ") echo "r5 ship shipped Fix the README typo"; echo "r4 run unfinished slow" ;;
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
		const { result, updates } = await call({ name: "ok", args: { path: "src", depth: 2 } });
		expect(result.structuredContent).toEqual({
			runId: "r1",
			status: "finished",
			result: { answer: 42 },
			report: ['{"answer":42}'],
		});
		expect(result.isError).toBeUndefined();
		expect(updates).toEqual(["phase one", "log two"]);
		expect(await readFile(join(root, "args.log"), "utf8")).toBe("run ok --arg=path=src --arg=depth=2 --json\n");
	});

	it("sends a script on stdin and maps ship arguments to its flags", async () => {
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
		expect((await readFile(join(root, "args.log"), "utf8")).split("\n")).toEqual([
			"run - --json",
			"ship --rounds=2 --json -- Fix the README typo",
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
		expect(draw({ name: "ok" })).toEqual(["workflow ok"]);
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
