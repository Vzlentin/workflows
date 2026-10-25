import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonValue } from "@earendil-works/chord";
import type { TSchema } from "@earendil-works/pi-ai";
import type {
	CustomEntry,
	ExtensionCommandContext,
	ExtensionContext,
	ExtensionUIContext,
	Theme,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import extension, { type workflowTool } from "../pi/index.ts";
import { RunView } from "../pi/run-view.ts";
import { hostModel, sandbox, startHost } from "./support.ts";

/** The factory that `/workflows` gives `ctx.ui.custom`. */
type CustomFactory = Parameters<ExtensionUIContext["custom"]>[0];

type Tool = ReturnType<typeof workflowTool>;

let root: string;
let tool: Tool;

/** A fake `workflows` command: its behavior comes from its arguments, which it appends to `args.log`. */
const FAKE = `#!/bin/sh
echo "$@" >> args.log
case "$1 $3" in "resume --background") echo "run $2"; echo '{"runId":"'"$2"'","status":"started","workflow":"campaign"}'; exit 0 ;; esac
case " $* " in *" --background "*) echo "run rb"; echo '{"runId":"rb","status":"started","workflow":"ship"}'; exit 0 ;; esac
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
	*-*)
		until [ -e "go-$2" ]; do sleep 0.02; done
		echo "warning: slow disk" >&2; echo '{"progress":["◉ item 2/5: x","  ◉ round 1: review"]}' >&2
		until [ -e "end-$2" ]; do sleep 0.02; done
		echo '{"runId":"'"$2"'","status":"finished","result":1,"report":["one"]}' ;;
	esac ;;
list)
	if [ -e list.fails ]; then echo "workflows: no harness project" >&2; exit 1; fi
	if [ -e runs.json ]; then cat runs.json; else echo '[]'; fi ;;
show) if [ -e show.json ]; then cat show.json; else echo "workflows: no run $2" >&2; exit 1; fi ;;
attach) case "$2" in *-bad) echo "workflows: run $2 has no session" >&2; exit 1 ;; esac ;;
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

type Command = Parameters<Api["registerCommand"]>[1];

/** The part of a context that the handlers of the extension read. */
type Context = Pick<ExtensionContext, "cwd" | "hasUI"> & {
	readonly ui: ExtensionUIContext | undefined;
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
	const commands = new Map<string, Command>();
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
		registerCommand: (name, command) => commands.set(name, command),
		// SAFETY: the extension registers only the renderer of `workflow-result`, which checks its details.
		registerMessageRenderer: (customType, renderer) => renderers.set(customType, renderer as Renderer),
		// SAFETY: `on` has one overload for each event, and the fake keeps every handler by its event name. The handlers
		// of the extension read only `ctx.cwd`, `ctx.hasUI`, `ctx.ui` and `ctx.sessionManager.getEntries()`, which `fire`
		// gives.
		on: on as Api["on"],
		sendMessage: (message, options) => messages.push({ message, options }),
		appendEntry: (customType, data) => {
			id += 1;
			entries.push({ type: "custom", customType, data, id: `e${id}`, parentId: null, timestamp: "" });
		},
	};

	extension(pi, command);

	/** Fires `event` with a context in `root` whose session has `entries`, with `ui` when given. */
	const fire = async (event: string, ui?: ExtensionUIContext, hasUI = ui !== undefined) => {
		const ctx: Context = { cwd: root, hasUI, ui, sessionManager: { getEntries: () => entries } };

		for (const handler of handlers.get(event) ?? []) await handler({ type: event }, ctx);
	};

	/** Runs the command `name` with a context in `root` that has `ui`. */
	const runCommand = async (name: string, ui: ExtensionUIContext) => {
		// SAFETY: the `/workflows` command reads only `ctx.cwd` and `ctx.ui` of its context.
		const ctx = { cwd: root, hasUI: true, ui } as ExtensionCommandContext;
		await commands.get(name)?.handler("", ctx);
	};

	const [registered] = tools;

	if (registered === undefined) throw new Error("the extension registered no tool");

	return { names, registered, renderers, messages, entries, fire, runCommand };
}

/** A start entry of a background run, with `workflow` when it is given. */
const startEntry = (runId: string, cwd: string, workflow?: string): CustomEntry => ({
	type: "custom",
	customType: "workflow-background",
	data: workflow === undefined ? { runId, cwd } : { runId, cwd, workflow },
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

/**
 * A fake UI that records each `setWidget`, `select` and `notify` call and each read of its theme. `select` gives the
 * line at the index that `choose` sets, or undefined.
 */
function fakeUi() {
	const views: RunView[] = [];
	const widgets: [string, string[] | undefined][] = [];
	const selects: [string, string[]][] = [];
	const notes: [string, string | undefined][] = [];
	let chosen: number | undefined;
	let reads = 0;

	const fake = {
		setWidget: (key: string, content: string[] | undefined) => {
			widgets.push([key, content]);
		},
		select: async (title: string, lines: string[]) => {
			selects.push([title, lines]);

			return chosen === undefined ? undefined : lines[chosen];
		},
		notify: (message: string, type?: string) => {
			notes.push([message, type]);
		},
		custom: (factory: CustomFactory) =>
			new Promise((resolve) => {
				const keybindings = { matches: (data: string, binding: string) => binding === `tui.select.${data}` };
				// SAFETY: the run view calls only `requestRender` of the TUI and `matches` of the keybindings.
				const view = factory({ requestRender: () => {} } as never, theme, keybindings as never, resolve);

				if (!(view instanceof RunView)) throw new Error("the command showed another component");
				views.push(view);
			}),
		get theme() {
			reads += 1;

			return theme;
		},
	};

	// SAFETY: the watcher calls only `setWidget` with lines or undefined, and reads only `theme`. The `/workflows` command
	// calls only `select` with a title and lines, `notify` with a message and a type, and `custom` with a run view.
	return {
		ui: fake as ExtensionUIContext,
		widgets,
		selects,
		notes,
		views,
		reads: () => reads,
		choose: (index: number | undefined) => {
			chosen = index;
		},
	};
}

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

		expect(result.structuredContent).toEqual({ runId: "rb", status: "started", workflow: "ship" });
		expect(result.isError).toBeUndefined();
		expect(result.content).toEqual([
			{
				type: "text",
				text: 'run rb started in the background; its result comes as a message in this conversation when it ends; follow it with resume: "rb", or stop it with the command workflows stop rb',
			},
		]);
		expect(pi.entries.map((entry) => [entry.customType, entry.data])).toEqual([
			["workflow-background", { runId: "rb", cwd: root, workflow: "ship" }],
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

	it("shows the step of a followed run in the widget, and removes the widget when the run ends", async () => {
		const pi = fakePi();
		const { ui, widgets } = fakeUi();
		const id = "20261024T223428-bb814010";
		await pi.fire("session_start", ui);
		expect(widgets).toEqual([["workflows", undefined]]);
		await pi.registered.execute("call-1", { resume: id, background: true }, undefined, undefined, contextOf(root));
		await vi.waitFor(() => expect(widgets.at(-1)).toEqual(["workflows", ["campaign: bb814010 starting"]]));

		await writeFile(join(root, `go-${id}`), "");
		await vi.waitFor(() => expect(widgets.at(-1)).toEqual(["workflows", ["campaign: bb814010 ◉ round 1: review"]]));
		expect(widgets.some(([, lines]) => lines?.some((line) => line.includes("slow disk")))).toBe(false);

		await writeFile(join(root, `end-${id}`), "");
		await vi.waitFor(() => expect(pi.entries).toHaveLength(2));
		await vi.waitFor(() => expect(widgets.at(-1)).toEqual(["workflows", undefined]));
		expect(pi.messages[0]?.message.content).toEqual([{ type: "text", text: `run ${id} finished: 1` }]);
		expect(pi.entries[1]?.data).toEqual({ runId: id });
	});

	it("shows each run that a resume at start or a call follows, in one line", async () => {
		const first = "20261024T223428-aaaa1111";
		const second = "20261024T223428-bb814010";
		const pi = fakePi([startEntry(first, root, "ship")]);
		const { ui, widgets } = fakeUi();
		await pi.fire("session_start", ui);
		await pi.registered.execute("call-1", { resume: second, background: true }, undefined, undefined, contextOf(root));
		await vi.waitFor(() =>
			expect(widgets.at(-1)).toEqual(["workflows", ["ship: aaaa1111 starting | campaign: bb814010 starting"]]),
		);

		await writeFile(join(root, `go-${first}`), "");
		await writeFile(join(root, `end-${first}`), "");
		await vi.waitFor(() => expect(pi.messages).toHaveLength(1));
		await vi.waitFor(() => expect(widgets.at(-1)).toEqual(["workflows", ["campaign: bb814010 starting"]]));

		await writeFile(join(root, `go-${second}`), "");
		await writeFile(join(root, `end-${second}`), "");
		await vi.waitFor(() => expect(widgets.at(-1)).toEqual(["workflows", undefined]));
	});

	it("draws no widget without a UI", async () => {
		const pi = fakePi([startEntry("rb", root)]);
		const fake = fakeUi();
		await pi.fire("session_start", fake.ui, false);
		await pi.registered.execute("call-1", { name: "ship", background: true }, undefined, undefined, contextOf(root));
		await vi.waitFor(() => expect(pi.messages).toHaveLength(1));
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect([fake.widgets, fake.reads()]).toEqual([[], 0]);
	});

	it("draws nothing after shutdown", async () => {
		const pi = fakePi([startEntry("long", root, "ship")]);
		const { ui, widgets } = fakeUi();
		await pi.fire("session_start", ui);
		await vi.waitFor(() => readFile(join(root, "waiting")));
		await vi.waitFor(() => expect(widgets.at(-1)).toEqual(["workflows", ["ship: long starting"]]));
		const drawn = widgets.length;
		await pi.fire("session_shutdown");
		await vi.waitFor(() => readFile(join(root, "detached")));
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(widgets).toHaveLength(drawn);
	});

	it("refuses background with save, and answer without resume, and runs no command", async () => {
		await expect(call({ save: { runId: "r2", name: "fix" }, background: true })).rejects.toThrow(
			"background works only with name, script or resume",
		);
		await expect(call({ name: "ok", answer: "y" })).rejects.toThrow("answer works only with resume");
		await expect(readFile(join(root, "args.log"), "utf8")).rejects.toThrow();
	});
});

describe("the /workflows command", () => {
	const good = "20261024T223428-aaaa1111";
	const bad = "20261024T223428-bad";

	const runs = [
		{ runId: good, workflow: "ship", title: "Fix the typo", status: "running", repository: null },
		{ runId: bad, workflow: "campaign", title: "Docs", status: "failed", repository: null },
	];

	const listed = [`${good}  ship  running  Fix the typo`, `${bad}  campaign  failed  Docs`];

	const commands = async () => (await readFile(join(root, "args.log"), "utf8")).split("\n").filter(Boolean);

	it("says that the project has no run, and shows no list", async () => {
		const pi = fakePi();
		const fake = fakeUi();
		await pi.runCommand("workflows", fake.ui);
		expect([fake.notes, fake.selects]).toEqual([[["No workflow runs in this project", "info"]], []]);
	});

	it("gives the error of a list that fails", async () => {
		await writeFile(join(root, "list.fails"), "");
		const pi = fakePi();
		const fake = fakeUi();
		await pi.runCommand("workflows", fake.ui);
		expect([fake.notes, fake.selects]).toEqual([[["workflows: no harness project", "error"]], []]);
	});

	/** An agent of `show --agents --json` that took `end` s. */
	const agent = (conversation: number, text: string, mark: string, depth = 0, end = 31) => ({
		kind: "agent",
		depth,
		mark,
		text,
		conversation,
		facts: `sonnet  1 ask  ${end}s`,
	});

	/** The run `good`: a planner, two coordinators, the second of which works, and a child ship run with one agent. */
	const shown = {
		runId: good,
		workflow: "mine",
		title: "Mine",
		status: "running",
		agents: [
			{ kind: "phase", depth: 0, text: "plan" },
			agent(1, "You plan the fleet.", "✓"),
			{ kind: "phase", depth: 0, text: "work" },
			agent(2, 'You coordinate "a".', "✗", 0, 32),
			agent(3, 'You coordinate "b".', "◉"),
			{ kind: "run", depth: 0, mark: "◉", text: "run ship 20261025T120045-cccc3333" },
			{ kind: "phase", depth: 1, text: "plan" },
			agent(4, "Plan the item.", "✓", 1),
		],
	};

	/**
	 * Shows the run view of `/workflows` for the first run, and gives the view and the end of the command once the first
	 * line of the view has `first`.
	 */
	const opened = async (fake: ReturnType<typeof fakeUi>, first: string = good) => {
		const pi = fakePi();
		fake.choose(0);
		const before = fake.views.length;
		await writeFile(join(root, "runs.json"), JSON.stringify(runs));
		const ended = pi.runCommand("workflows", fake.ui);
		await vi.waitFor(() => expect(fake.views).toHaveLength(before + 1));
		const view = fake.views.at(-1);

		if (view === undefined) throw new Error("no run view");
		await vi.waitFor(() => expect(view.render(200)[0]).toContain(first));

		return { view, ended };
	};

	beforeEach(() => writeFile(join(root, "show.json"), JSON.stringify(shown)));

	it("shows the phases, agents and child runs of the chosen run, and selects the agent that works", async () => {
		const fake = fakeUi();
		const { view, ended } = await opened(fake);
		const lines = view.render(200);
		expect(fake.selects).toEqual([["Show workflow run", listed]]);
		expect(
			lines.slice(0, -1).map((line) => line.replace(/ \S+$/, (time) => (line.includes("◉ You") ? " <time>" : time))),
		).toEqual([
			`mine ${good} running Mine`,
			"  plan",
			"    ✓ You plan the fleet.  sonnet  1 ask  31s",
			"  work",
			'    ✗ You coordinate "a".  sonnet  1 ask  32s',
			'>   ◉ You coordinate "b".  sonnet  1 ask  <time>',
			"    ◉ run ship 20261025T120045-cccc3333",
			"      plan",
			"        ✓ Plan the item.  sonnet  1 ask  31s",
		]);
		view.handleInput("cancel");
		await ended;
		expect((await commands()).slice(0, 2)).toEqual(["list --json", `show ${good} --agents --json`]);
	});

	it("attaches to the selected agent in Herdr, or gives the command", async () => {
		const saved = process.env.HERDR_ENV;

		try {
			process.env.HERDR_ENV = "1";
			const fake = fakeUi();
			const herdr = await opened(fake);
			herdr.view.handleInput("down");
			herdr.view.handleInput("confirm");
			await herdr.ended;
			expect([(await commands()).at(-1), fake.notes]).toEqual([`attach ${good} --conversation 4`, []]);

			delete process.env.HERDR_ENV;
			const plain = await opened(fake);
			plain.view.handleInput("up");
			plain.view.handleInput("confirm");
			await plain.ended;
			expect((await commands()).filter((line) => line.startsWith("attach"))).toEqual([
				`attach ${good} --conversation 4`,
			]);
			expect(fake.notes).toEqual([[`Run in another terminal: workflows attach ${good} --conversation 2`, "info"]]);
		} finally {
			if (saved === undefined) delete process.env.HERDR_ENV;
			else process.env.HERDR_ENV = saved;
		}
	});

	it("shows the error of a first read that fails in place of the run", async () => {
		await rm(join(root, "show.json"));
		const fake = fakeUi();
		const { view, ended } = await opened(fake, `workflows: no run ${good}`);
		expect(view.render(200)).toEqual([`workflows: no run ${good}`]);
		view.handleInput("cancel");
		await ended;
	});

	it("gives the error of an attach that fails", async () => {
		const saved = process.env.HERDR_ENV;
		await writeFile(join(root, "runs.json"), JSON.stringify([runs[1]]));
		await writeFile(join(root, "show.json"), JSON.stringify({ ...shown, runId: bad }));

		try {
			process.env.HERDR_ENV = "1";
			const fake = fakeUi();
			const pi = fakePi();
			fake.choose(0);
			const ended = pi.runCommand("workflows", fake.ui);
			await vi.waitFor(() => expect(fake.views[0]?.render(200)[0]).toContain(bad));
			fake.views[0]?.handleInput("confirm");
			await ended;
			expect(fake.notes).toEqual([
				[
					`workflows: run ${bad} has no session. Run in another terminal: workflows attach ${bad} --conversation 3`,
					"error",
				],
			]);
		} finally {
			if (saved === undefined) delete process.env.HERDR_ENV;
			else process.env.HERDR_ENV = saved;
		}
	});
});

/** A tool that `load` records: its description, and a call in `cwd` with no params that gives its content. */
type LoadedTool = { readonly description: string; readonly call: (cwd: string) => Promise<Result["content"]> };

/** A handler of `session_start` of an extension load without a command. */
type StartHandler = (event: { readonly type: string }, ctx: ExtensionContext) => void | Promise<void>;

/** A fake Pi API that records the tools, the commands and the handlers of an extension load without a command. */
async function load() {
	const tools = new Map<string, LoadedTool>();
	const commands = new Map<string, Command>();
	const handlers = new Map<string, StartHandler[]>();

	const on = (event: string, handler: StartHandler) => {
		handlers.set(event, [...(handlers.get(event) ?? []), handler]);
	};

	const pi: Api = {
		registerTool: (registered) =>
			tools.set(registered.name, {
				description: registered.description,
				call: async (cwd) => {
					// SAFETY: the tests call only the tool without workflows, whose parameters are an empty object.
					const params = {} as Parameters<typeof registered.execute>[1];
					const { content } = await registered.execute("call-1", params, undefined, undefined, contextOf(cwd));

					return content;
				},
			}),
		registerCommand: (name, command) => commands.set(name, command),
		registerMessageRenderer: () => {},
		// SAFETY: `on` has one overload for each event, and the fake keeps every handler by its event name.
		on: on as Api["on"],
		sendMessage: () => {},
		appendEntry: () => {},
	};

	await extension(pi);

	return { tools, commands, handlers };
}

/** A fake UI that answers `answer` to each dialog and records the dialogs and the notifications. */
function fakeUI(answer: boolean) {
	const dialogs: [string, string][] = [];
	const notes: [string, string | undefined][] = [];

	const ui: Pick<ExtensionUIContext, "confirm" | "notify"> = {
		confirm: async (title, message) => {
			dialogs.push([title, message]);

			return answer;
		},
		notify: (message, type) => {
			notes.push([message, type]);
		},
	};

	return { ui, dialogs, notes };
}

/** Calls the `session_start` handlers of `registered` at startup in the mode `mode`, with `ui`. */
async function startSession(
	registered: Awaited<ReturnType<typeof load>>,
	mode: ExtensionContext["mode"],
	ui: Pick<ExtensionUIContext, "confirm" | "notify">,
): Promise<void> {
	for (const handler of registered.handlers.get("session_start") ?? []) {
		// SAFETY: the session_start handler without workflows reads only `mode` and `ui`.
		await handler({ type: "session_start" }, { mode, hasUI: true, ui } as ExtensionContext);
	}
}

/** The notes that the command `name` of `registered` shows when it runs in `cwd`. */
async function notesOf(registered: Awaited<ReturnType<typeof load>>, cwd: string, name = "workflows") {
	const notes: [string, string | undefined][] = [];

	const ui: Pick<ExtensionUIContext, "notify"> = {
		notify: (message, type) => {
			notes.push([message, type]);
		},
	};

	// SAFETY: `/workflows` reads only `ctx.cwd` and `ctx.ui.notify` when the list is empty or workflows is missing.
	await registered.commands.get(name)?.handler("", { cwd, ui } as ExtensionCommandContext);

	return notes;
}

describe("the lookup of the workflows install", () => {
	const { version } = JSON.parse(readFileSync(join(import.meta.dirname, "..", "pi", "package.json"), "utf8"));
	const MESSAGE = `workflows is not installed: npm install -g @vzlentin/workflows@${version}`;
	const EMPTY = [["No workflow runs in this project", "info"]];
	let saved: NodeJS.ProcessEnv;
	let home: string;
	let globalRoot: string;

	/** A fake `npm` whose `root -g` prints `folder`. */
	const fakeNpm = async (folder: string) => {
		await writeFile(join(home, "bin", "npm"), `#!/bin/sh\necho "${folder}"\n`);
		await chmod(join(home, "bin", "npm"), 0o755);
	};

	beforeEach(async () => {
		saved = process.env;
		home = await sandbox();
		process.env.PATH = `${home}/bin:/usr/bin:/bin`;
		globalRoot = join(home, "global");
		const pkg = join(globalRoot, "@vzlentin", "workflows");
		await mkdir(join(pkg, "dist"), { recursive: true });
		await mkdir(join(home, "empty"));
		await writeFile(join(pkg, "package.json"), JSON.stringify({ name: "@vzlentin/workflows" }));
		await writeFile(join(pkg, "dist", "cli.js"), 'process.stdout.write("[]\\n");\n');
	});

	afterEach(async () => {
		process.env = saved;
		await rm(home, { recursive: true, force: true });
	});

	it("uses the package of the first workflows on PATH", async () => {
		await symlink(join(globalRoot, "@vzlentin", "workflows", "dist", "cli.js"), join(home, "bin", "workflows"));
		await fakeNpm(join(home, "empty"));

		expect(await notesOf(await load(), home)).toEqual(EMPTY);
	});

	it("uses the package in npm's global root when workflows is not on PATH", async () => {
		await fakeNpm(globalRoot);

		expect(await notesOf(await load(), home)).toEqual(EMPTY);
	});

	it("skips a workflows on PATH whose package is not @vzlentin/workflows", async () => {
		const other = join(home, "other");
		await mkdir(join(other, "dist"), { recursive: true });
		await writeFile(join(other, "package.json"), JSON.stringify({ name: "workflows" }));
		await writeFile(join(other, "dist", "cli.js"), "process.exit(9);\n");
		await symlink(join(other, "dist", "cli.js"), join(home, "bin", "workflows"));
		await fakeNpm(globalRoot);

		expect(await notesOf(await load(), home)).toEqual(EMPTY);
	});

	it("waits until the install lock is free before it looks up workflows", async () => {
		await fakeNpm(globalRoot);
		const holder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });

		try {
			const lock = join(home, "state", "workflows", "install.lock");
			await mkdir(lock, { recursive: true });
			await writeFile(join(lock, "pid"), String(holder.pid));
			let loaded = false;

			const loading = load().then((registered) => {
				loaded = true;

				return registered;
			});

			await new Promise((resolve) => setTimeout(resolve, 600));
			expect(loaded).toBe(false);
			await rm(lock, { recursive: true, force: true });

			expect(await notesOf(await loading, home)).toEqual(EMPTY);
		} finally {
			holder.kill();
		}
	});

	it("answers with the install command when workflows is not installed", async () => {
		await fakeNpm(join(home, "empty"));
		const registered = await load();
		const missing = registered.tools.get("workflow");
		const content = await missing?.call(home);

		expect([...registered.tools.keys()]).toEqual(["workflow"]);
		expect([...registered.commands.keys()]).toEqual(["workflows"]);
		expect(missing?.description).toBe(MESSAGE);
		expect(content).toEqual([{ type: "text", text: MESSAGE }]);
		expect(await notesOf(registered, home)).toEqual([[MESSAGE, "error"]]);
	});

	describe("the install offer", () => {
		const log = () => join(home, "log");
		const prefix = () => join(home, "prefix");
		const lock = () => join(home, "state", "workflows", "install.lock");
		const declined = () => join(home, "state", "workflows", "install.declined");
		const logLines = () => (existsSync(log()) ? readFileSync(log(), "utf8").trim().split("\n") : []);

		/**
		 * A `npm` on `PATH` that logs its arguments. `npm install -g` creates `@vzlentin/workflows` in its global root,
		 * with a `dist/cli.js` that logs its arguments too, or prints 30 lines and fails with `fail`.
		 */
		const installingNpm = async (fail: boolean) => {
			const global = join(prefix(), "lib", "node_modules");
			const pkg = join(global, "@vzlentin", "workflows");
			const cli = `require("node:fs").appendFileSync(${JSON.stringify(log())}, "workflows " + process.argv.slice(2).join(" ") + "\\n");`;

			const script = [
				"#!/bin/sh",
				`echo "npm $*" >> "${log()}"`,
				`case "$1" in`,
				`prefix) echo "${prefix()}" ;;`,
				`root) echo "${global}" ;;`,
				"install)",
				fail
					? `  i=1; while [ $i -le 30 ]; do echo "line $i"; i=$((i + 1)); done; echo "npm error failed" >&2; exit 1`
					: "  :",
				`  mkdir -p "${join(pkg, "dist")}"`,
				`  echo '{"name":"@vzlentin/workflows"}' > "${join(pkg, "package.json")}"`,
				`  cat > "${join(pkg, "dist", "cli.js")}" <<'EOF'`,
				cli,
				"EOF",
				"  ;;",
				"esac",
			].join("\n");

			await writeFile(join(home, "bin", "npm"), `${script}\n`);
			await chmod(join(home, "bin", "npm"), 0o755);
		};

		it("installs workflows and runs it when the answer is yes", async () => {
			await installingNpm(false);
			const registered = await load();
			const { ui, dialogs, notes } = fakeUI(true);
			await startSession(registered, "tui", ui);
			await vi.waitFor(() => expect(notes).toHaveLength(1), { timeout: 10_000 });

			expect(dialogs).toEqual([
				["workflows is not installed", `Install @vzlentin/workflows@${version} with npm install -g into ${prefix()}?`],
			]);

			expect(logLines()).toEqual([
				"npm root -g",
				"npm root -g",
				"npm prefix -g",
				`npm install -g @vzlentin/workflows@${version}`,
				"npm root -g",
				"workflows --version",
			]);

			expect(notes).toEqual([["workflows installed, run /reload", "info"]]);
			expect(existsSync(lock())).toBe(false);
		});

		it("shows the end of the output and the command when npm install fails", async () => {
			await installingNpm(true);
			const { ui, notes } = fakeUI(true);
			await startSession(await load(), "tui", ui);
			await vi.waitFor(() => expect(notes).toHaveLength(1), { timeout: 10_000 });
			const tail = Array.from({ length: 19 }, (_, i) => `line ${i + 12}`);

			expect(notes).toEqual([
				[
					[...tail, "npm error failed", `Run by hand: npm install -g @vzlentin/workflows@${version}`].join("\n"),
					"error",
				],
			]);

			expect(existsSync(lock())).toBe(false);
		});

		it("remembers a no and does not ask again", async () => {
			await installingNpm(false);
			const { ui, dialogs, notes } = fakeUI(false);
			await startSession(await load(), "tui", ui);

			await vi.waitFor(
				() => {
					expect(existsSync(declined())).toBe(true);
					expect(existsSync(lock())).toBe(false);
				},
				{ timeout: 10_000 },
			);

			const next = await load();
			await startSession(next, "tui", ui);
			await new Promise((resolve) => setTimeout(resolve, 300));

			expect(dialogs).toHaveLength(1);
			expect(notes).toEqual([]);
			expect(logLines()).not.toContain(`npm install -g @vzlentin/workflows@${version}`);
			expect(await next.tools.get("workflow")?.call(home)).toEqual([{ type: "text", text: MESSAGE }]);
		});

		it("does not ask in print mode or in RPC mode", async () => {
			await installingNpm(false);
			const registered = await load();
			const { ui, dialogs } = fakeUI(true);

			for (const mode of ["print", "rpc"] as const) await startSession(registered, mode, ui);
			await new Promise((resolve) => setTimeout(resolve, 300));

			expect(dialogs).toEqual([]);
			expect(logLines()).toEqual(["npm root -g"]);
		});
	});

	it("is the Pi package @vzlentin/pi-workflows at the version of workflows", () => {
		const read = (path: string) => JSON.parse(readFileSync(join(import.meta.dirname, "..", path), "utf8"));
		const pi = read("pi/package.json");
		const root = read("package.json");

		expect([
			pi.name,
			pi.private,
			pi.dependencies,
			pi.keywords,
			pi.version,
			pi.repository?.url,
			pi.publishConfig?.access,
		]).toEqual([
			"@vzlentin/pi-workflows",
			undefined,
			undefined,
			["pi-package"],
			root.version,
			root.repository.url,
			"public",
		]);
	});
});
