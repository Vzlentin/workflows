import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
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
	echo '{"runId":"r1","status":"finished","result":{"answer":42}}' ;;
"run -") echo "run r2"; cat > stdin.js; echo '{"runId":"r2","status":"finished","result":"from stdin"}' ;;
"run bad")
	echo "run r3"; echo "failed bad: boom" >&2; echo "continue with: workflows run resume r3" >&2
	echo '{"runId":"r3","status":"failed","error":"boom"}'; exit 1 ;;
"run slow")
	echo "run r4"
	trap 'echo "interrupted; continue with: workflows run resume r4" >&2; echo '"'"'{"runId":"r4","status":"interrupted"}'"'"'; exit 130' INT
	echo "started" >&2
	while :; do sleep 0.02; done ;;
"run usage") echo "workflows: unknown flag" >&2; exit 2 ;;
"ship --rounds=2") echo "run r5"; echo '{"runId":"r5","status":"finished","result":{"status":"shipped","rounds":1,"head":"abc"}}' ;;
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
	const onUpdate = (partial: { content: { type: string; text?: string }[] }) => {
		updates.push(partial.content[0]?.text ?? "");
	};
	const ctx = { cwd: root } as Parameters<ToolDefinition["execute"]>[4];
	const result = await tool.execute("call-1", params, signal, onUpdate as never, ctx);
	return { result, updates };
}

describe("the workflow tool", () => {
	it("returns the structured result of a finished run, with each stderr line as progress", async () => {
		const { result, updates } = await call({ name: "ok", args: { path: "src", depth: 2 } });
		expect(result.structuredContent).toEqual({ runId: "r1", status: "finished", result: { answer: 42 } });
		expect(result.isError).toBeUndefined();
		expect(updates).toEqual(["phase one", "log two"]);
		expect(await readFile(join(root, "args.log"), "utf8")).toBe("run ok --arg=path=src --arg=depth=2 --json\n");
	});

	it("sends a script on stdin and maps ship arguments to its flags", async () => {
		const script = await call({ script: "return 'hi'" });
		expect(script.result.structuredContent).toEqual({ runId: "r2", status: "finished", result: "from stdin" });
		expect(await readFile(join(root, "stdin.js"), "utf8")).toBe("return 'hi'");

		const ship = await call({ name: "ship", args: { item: "Fix the README typo", rounds: 2 } });
		expect(ship.result.structuredContent).toEqual({
			runId: "r5",
			status: "finished",
			result: { status: "shipped", rounds: 1, head: "abc" },
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
		expect(updates).toEqual(["started", "interrupted; continue with: workflows run resume r4"]);
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
