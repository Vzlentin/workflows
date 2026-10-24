import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonValue } from "@earendil-works/chord";
import type { TSchema } from "@earendil-works/pi-ai";
import type { CustomEntry, ExtensionContext, Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import extension, { type workflowTool } from "../pi/index.ts";
import { hostModel, sandbox, startHost } from "./support.ts";

type Tool = ReturnType<typeof workflowTool>;

let root: string;
let tool: Tool;

/** A fake `workflows` command: its behavior comes from its arguments, which it appends to `args.log`. */
const FAKE = `#!/bin/sh
echo "$@" >> args.log
case " $* " in *" --background "*) echo "run rb"; echo '{"runId":"rb","status":"started"}'; exit 0 ;; esac
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
wait)
	echo "run $2"
	case "$2" in
	rb) echo '{"progress":["✓ plan"]}' >&2; echo '{"runId":"rb","status":"finished","result":1,"report":["one"]}' ;;
	failed) echo '{"progress":["✗ plan"]}' >&2; echo '{"runId":"failed","status":"failed","error":"boom"}'; exit 1 ;;
	stopped) echo '{"runId":"stopped","status":"stopped"}'; exit 130 ;;
	gone) echo "workflows: no run gone" >&2; exit 1 ;;
	long)
		trap 'touch detached; echo '"'"'{"runId":"long","status":"detached"}'"'"'; exit 130' INT
		touch waiting
		while :; do sleep 0.02; done ;;
	esac ;;
*) exit 9 ;;
esac
`;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "workflows-extension-test-"));
	await writeFile(join(root, "workflows"), FAKE);
	tool = fakePi().registered;
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

type Api = Parameters<typeof extension>[0];

type Message = Parameters<Api["sendMessage"]>[0];

type MessageOptions = Parameters<Api["sendMessage"]>[1];

type Renderer = Parameters<Api["registerMessageRenderer"]>[1];

/** The part of a context that the handlers of the extension read. */
type Context = Pick<ExtensionContext, "cwd"> & {
	readonly sessionManager: Pick<ExtensionContext["sessionManager"], "getEntries">;
};

type Handler = (event: { readonly type: string }, ctx: Context) => void | Promise<void>;

/** Whether `registered` is the tool of `workflowTool`, by its name, which is the only tool the extension registers. */
function isWorkflowTool<P extends TSchema, D, S>(
	registered: ToolDefinition<P, D, S>,
): registered is ToolDefinition<P, D, S> & Tool {
	return registered.name === "workflow";
}

/** A fake Pi API that records the calls of the extension, with the entries that `appendEntry` adds to the session. */
function fakePi(entries: CustomEntry[] = [], command = ["/bin/sh", join(root, "workflows")]) {
	const tools: Tool[] = [];
	const names: string[] = [];
	const renderers = new Map<string, Renderer>();
	const handlers = new Map<string, Handler[]>();
	const messages: { message: Message; options: MessageOptions }[] = [];
	let id = entries.length;

	const on = (event: string, handler: Handler) => {
		handlers.set(event, [...(handlers.get(event) ?? []), handler]);
	};

	const pi: Api = {
		registerTool: (registered) => {
			names.push(registered.name);

			if (isWorkflowTool(registered)) tools.push(registered);
		},
		// SAFETY: the extension registers only the renderer of `workflow-result`, which checks its details.
		registerMessageRenderer: (customType, renderer) => renderers.set(customType, renderer as Renderer),
		// SAFETY: `on` has one overload for each event, and the fake keeps every handler by its event name. The handlers
		// of the extension read only `ctx.cwd` and `ctx.sessionManager.getEntries()`, which `fire` gives.
		on: on as Api["on"],
		sendMessage: (message, options) => messages.push({ message, options }),
		appendEntry: (customType, data) => {
			id += 1;
			entries.push({ type: "custom", customType, data, id: `e${id}`, parentId: null, timestamp: "" });
		},
	};

	extension(pi, command);

	/** Fires `event` with a context in `root` whose session has `entries`. */
	const fire = async (event: string) => {
		const ctx: Context = { cwd: root, sessionManager: { getEntries: () => entries } };

		for (const handler of handlers.get(event) ?? []) await handler({ type: event }, ctx);
	};

	const [registered] = tools;

	if (registered === undefined) throw new Error("the extension registered no tool");

	return { names, registered, renderers, messages, entries, fire };
}

/** A start entry of a background run, as the extension records it. */
const startEntry = (runId: string, cwd: string): CustomEntry => ({
	type: "custom",
	customType: "workflow-background",
	data: { runId, cwd },
	id: `s-${runId}`,
	parentId: null,
	timestamp: "",
});

const endEntry = (runId: string): CustomEntry => ({
	type: "custom",
	customType: "workflow-background-end",
	data: { runId },
	id: `x-${runId}`,
	parentId: null,
	timestamp: "",
});

const waits = async () =>
	(await readFile(join(root, "args.log"), "utf8").catch(() => ""))
		.split("\n")
		.filter((line) => line.startsWith("wait"));

describe("the workflow tool", () => {
	it("is the tool that the extension registers", () => {
		const pi = fakePi();
		expect(pi.names).toEqual(["workflow"]);
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

	it("gives the question of a waiting run, and continues the run with the answer", { timeout: 30_000 }, async () => {
		const saved = process.env;
		const cwd = await sandbox();
		// The command runs as a child process, which finds the host of this process through HARNESS_PROJECT.
		process.env.HARNESS_PROJECT = "main";
		const host = await startHost("main", hostModel().models);
		const cli = [process.execPath, join(import.meta.dirname, "..", "src", "cli.ts")];
		const real = fakePi([], cli).registered;

		try {
			const script = 'const a = await input("Q?")\nreturn a';
			const waiting = await real.execute("call-1", { script }, undefined, undefined, contextOf(cwd));
			const [first] = waiting.content;
			const text = first?.type === "text" ? first.text : "";
			const id = /^run (\S+) /.exec(text)?.[1] ?? "";
			expect([text, waiting.isError]).toEqual([
				`run ${id} waits for an answer: Q?; answer it with resume: "${id}" and answer: "<your answer>"`,
				undefined,
			]);

			const answered = await real.execute(
				"call-2",
				{ resume: id, answer: "yes" },
				undefined,
				undefined,
				contextOf(cwd),
			);

			expect(answered.content).toEqual([{ type: "text", text: `run ${id} finished: "yes"` }]);
			expect(answered.structuredContent).toEqual({ runId: id, status: "finished", result: "yes", report: ["yes"] });
		} finally {
			await host.close();
			process.env = saved;
			await rm(cwd, { recursive: true, force: true });
		}
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

describe("a background run of the workflow tool", () => {
	it("returns started, and posts the outcome of the run as a message that starts a turn", async () => {
		const pi = fakePi();

		const result = await pi.registered.execute(
			"call-1",
			{ name: "ship", background: true },
			undefined,
			undefined,
			contextOf(root),
		);

		expect(result.structuredContent).toEqual({ runId: "rb", status: "started" });
		expect(result.isError).toBeUndefined();
		expect(result.content).toEqual([
			{
				type: "text",
				text: 'run rb started in the background; its result comes as a message in this conversation when it ends; follow it with resume: "rb", or stop it with the command workflows stop rb',
			},
		]);
		expect(pi.entries.map((entry) => [entry.customType, entry.data])).toEqual([
			["workflow-background", { runId: "rb", cwd: root }],
		]);
		await vi.waitFor(() => expect(pi.entries).toHaveLength(2));
		expect(pi.messages).toEqual([
			{
				message: {
					customType: "workflow-result",
					content: [{ type: "text", text: "run rb finished: 1" }],
					display: true,
					details: {
						steps: ["✓ plan"],
						outcome: { runId: "rb", status: "finished", result: 1, report: ["one"] },
					},
				},
				options: { triggerTurn: true, deliverAs: "followUp" },
			},
		]);
		expect(pi.entries[1]?.customType).toBe("workflow-background-end");
		expect(pi.entries[1]?.data).toEqual({ runId: "rb" });
		expect(await readFile(join(root, "args.log"), "utf8")).toBe("ship --background --json\nwait rb --json\n");
	});

	it("posts a failed or stopped run with the run ID to resume", async () => {
		for (const runId of ["failed", "stopped"]) {
			const pi = fakePi([startEntry(runId, root)]);
			await pi.fire("session_start");
			await vi.waitFor(() => expect(pi.entries).toHaveLength(2));
			expect(pi.messages).toHaveLength(1);
			const [{ message } = { message: undefined }] = pi.messages;
			expect(message?.content).toEqual([{ type: "text", text: expect.stringContaining(`resume: "${runId}"`) }]);

			if (runId !== "failed" || message === undefined) continue;
			const render = pi.renderers.get("workflow-result");
			const drawn = render?.({ ...message, role: "custom", timestamp: 0 }, { expanded: false, outputPad: 0 }, theme);
			expect(drawn?.render(200).map((line) => line.trimEnd())).toEqual([
				"✗ plan",
				'✗ run failed failed: boom; continue it with resume: "failed"',
			]);
		}
	});

	it("watches each run of the session that has no end entry, once", async () => {
		const pi = fakePi([startEntry("rb", root), startEntry("stopped", root), endEntry("stopped")]);
		await pi.fire("session_start");
		await pi.fire("session_start");
		await vi.waitFor(() => expect(pi.messages).toHaveLength(1));
		expect(await waits()).toEqual(["wait rb --json"]);
		expect(pi.messages[0]?.message.content).toEqual([{ type: "text", text: "run rb finished: 1" }]);
	});

	it("posts nothing when the wait prints no outcome", async () => {
		const pi = fakePi([startEntry("gone", root)]);
		await pi.fire("session_start");
		await vi.waitFor(async () => expect(await waits()).toEqual(["wait gone --json"]));
		await new Promise((resolve) => setTimeout(resolve, 200));
		expect(pi.messages).toEqual([]);
		expect(pi.entries).toHaveLength(1);
	});

	it("detaches the waits at shutdown, and posts nothing", async () => {
		const pi = fakePi([startEntry("long", root)]);
		await pi.fire("session_start");
		await vi.waitFor(() => readFile(join(root, "waiting")));
		await pi.fire("session_shutdown");
		await vi.waitFor(() => readFile(join(root, "detached")));
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(pi.messages).toEqual([]);
		expect(pi.entries).toHaveLength(1);
	});

	it("refuses background with save, and answer without resume, and runs no command", async () => {
		await expect(call({ save: { runId: "r2", name: "fix" }, background: true })).rejects.toThrow(
			"background works only with name, script or resume",
		);
		await expect(call({ name: "ok", answer: "y" })).rejects.toThrow("answer works only with resume");
		await expect(readFile(join(root, "args.log"), "utf8")).rejects.toThrow();
	});
});
