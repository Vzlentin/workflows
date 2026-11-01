import { execFile } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { copyFile, cp, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
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
import { DefaultPackageManager, loadSkills, SettingsManager } from "@earendil-works/pi-coding-agent";
import { entriesPath } from "@vzlentin/harness/entries";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import extension, { type workflowTool } from "../pi/index.ts";
import { parseRun, RunView } from "../pi/run-view.ts";
import workflowsEntry from "../src/entry.ts";
import type { Host } from "../src/run/version.ts";
import * as toolModule from "../src/tool.ts";
import { hostModel, sandbox, startHost } from "./support.ts";

const run = promisify(execFile);

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
keys) echo "run r12"; echo '{"status":"s","progress":["◉ one"]}' >&2; echo '{"runId":"r12","status":"finished","result":1,"report":["one"]}' ;;
many|cutmany)
	echo "run r13"; i=1; while [ $i -le 150 ]; do echo "warning: $i" >&2; i=$((i + 1)); done
	[ "$1" = cutmany ] && exit 1
	echo '{"runId":"r13","status":"finished","result":1,"report":["one"]}' ;;
bad) echo "run r3"; echo '{"progress":["✗ one"]}' >&2; echo '{"runId":"r3","status":"failed","error":"boom"}'; exit 1 ;;
slow)
	echo "run r4"
	trap 'echo '"'"'{"runId":"r4","status":"detached"}'"'"'; exit 130' INT
	echo "started" >&2
	while :; do sleep 0.02; done ;;
resume) echo "run $2"; touch fg-done; echo '{"runId":"'"$2"'","status":"finished","result":2,"report":["two"]}' ;;
stopped) echo "run r8"; echo '{"runId":"r8","status":"stopped"}'; exit 130 ;;
host) echo "run r9"; echo '{"runId":"r9","status":"host-stopped"}'; exit 1 ;;
cut) echo "run r11"; echo "workflows: lost the host" >&2; exit 1 ;;
invalid) echo "run r10"; echo '{"runId":"r10","status":"lost"}' ;;
usage) echo "workflows: unknown flag" >&2; exit 2 ;;
save)
	if [ "$3" = taken ]; then echo "workflows: a workflow taken exists; replace it with --force" >&2; exit 1; fi
	echo "$PWD/.workflows/scripts/$3.js" ;;
ship)
	echo "run r5"
	echo '{"runId":"r5","status":"finished","result":{"status":"shipped","rounds":1,"head":"abc"},"report":["shipped Fix the README typo in 1 rounds, judge failed, abc"]}' ;;
campaign)
	echo "run r6"
	echo '{"runId":"r6","status":"finished","result":{"status":"done","items":[]},"report":["done Fix the docs in 2 items, abc"]}' ;;
optimize)
	echo "run r7"
	echo '{"runId":"r7","status":"finished","result":{"wins":3,"items":4,"promoted":true,"overlay":{},"diff":"overlay.diff"},"report":["optimized ship: 3/4 wins, promoted, overlay.diff"]}' ;;
wait)
	echo "run $2"
	case "$2" in
	rb) echo '{"progress":["✓ plan"]}' >&2; echo '{"runId":"rb","status":"finished","result":1,"report":["one"]}' ;;
	failed) echo '{"progress":["✗ plan"]}' >&2; echo '{"runId":"failed","status":"failed","error":"boom"}'; exit 1 ;;
	stopped) echo '{"runId":"stopped","status":"stopped"}'; exit 130 ;;
	gone) echo "workflows: no run gone" >&2; exit 4 ;;
	sleepy) echo '{"runId":"sleepy","status":"host-stopped"}'; exit 1 ;;
	flaky)
		if [ -e flaky-once ]; then echo '{"runId":"flaky","status":"finished","result":1,"report":["one"]}'
		else touch flaky-once; echo '{"runId":"flaky","status":"host-stopped"}'; exit 1; fi ;;
	fg)
		until [ -e fg-done ]; do sleep 0.02; done
		echo '{"runId":"fg","status":"finished","result":2,"report":["two"]}' ;;
	long)
		trap 'touch detached; echo '"'"'{"runId":"long","status":"detached"}'"'"'; exit 130' INT
		touch waiting
		while :; do sleep 0.02; done ;;
	*-*)
		until [ -e "go-$2" ]; do sleep 0.02; done
		echo "warning: slow disk" >&2; echo '{"progress":["◉ item 2/5: x","  ◉ round 1: review"]}' >&2
		until [ -e "end-$2" ] || [ -e "status-$2" ]; do sleep 0.02; done
		[ -e "status-$2" ] && echo '{"progress":["◉ item 2/5: x","  ◉ round 1: review"],"status":"item 2/5 › round 1/3: review"}' >&2
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

	extension(pi, { command, tool: toolModule });

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
		const optimize = await call({ name: "optimize", args: { workflow: "ship", limit: 4 } });
		expect(optimize.result.structuredContent).toEqual({
			runId: "r7",
			status: "finished",
			result: { wins: 3, items: 4, promoted: true, overlay: {}, diff: "overlay.diff" },
			report: ["optimized ship: 3/4 wins, promoted, overlay.diff"],
		});
		expect((await readFile(join(root, "args.log"), "utf8")).split("\n")).toEqual([
			"- --word=a --all --json",
			"ship --item=Fix the README typo --rounds=2 --json",
			"campaign --base=develop --goal=goal.md --json",
			"optimize --workflow=ship --limit=4 --json",
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

	it("takes a JSON line with progress as a progress line, whatever the order of its keys", async () => {
		const { result, updates } = await call({ name: "keys" });
		expect(updates).toEqual(["◉ one"]);
		expect(draw({ name: "keys" }, result)).toEqual(["workflow keys", "◉ one", "one"]);
	});

	it("keeps only the last 100 other stderr lines, in the steps and in the error text", async () => {
		const last = Array.from({ length: 100 }, (_, index) => `warning: ${index + 51}`);
		const { result } = await call({ name: "many" });
		expect(draw({ name: "many" }, result)).toEqual(["workflow many", ...last, "one"]);
		await expect(call({ name: "cutmany" })).rejects.toThrow(new Error(`run r13: ${last.join("\n")}`));
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

	it("throws the stderr text after the run ID when the run started and the command gave no outcome", async () => {
		await expect(call({ name: "cut" })).rejects.toThrow(/^run r11: workflows: lost the host$/);
	});

	it("gives the question of a waiting run, and continues the run with the answer", async () => {
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

			expect(answered.content).toEqual([{ type: "text", text: `run ${id} finished: "yes"\nyes` }]);
			expect(answered.structuredContent).toEqual({ runId: id, status: "finished", result: "yes", report: ["yes"] });
		} finally {
			await host.close();
			process.env = saved;
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it("saves the script of a run and returns the file", async () => {
		const file = join(await realpath(root), ".workflows", "scripts", "fix.js");
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

	it("has the description, parameters and output schema of the tool of the harness host", () => {
		// SAFETY: the entry reads the host only when a tool call or a task runs, and this test runs neither.
		const [hostTool] = workflowsEntry({} as Host).extensions[0]?.tools ?? [];
		expect(hostTool?.description).toBe(tool.description);
		expect(hostTool?.parameters).toEqual(tool.parameters);
		expect(hostTool?.structuredOutputSchema).toEqual(tool.outputSchema);
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
					content: [{ type: "text", text: "run rb finished: 1\none" }],
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
		expect(pi.messages[0]?.message.content).toEqual([{ type: "text", text: "run rb finished: 1\none" }]);
	});

	it("ends a gone run with its reason, and posts nothing", async () => {
		const pi = fakePi([startEntry("gone", root)]);
		await pi.fire("session_start");
		await vi.waitFor(() => expect(pi.entries).toHaveLength(2));
		expect(pi.entries[1]?.data).toEqual({ runId: "gone", reason: "run gone: workflows: no run gone" });
		expect(pi.messages).toEqual([]);
		expect(await waits()).toEqual(["wait gone --json"]);
	});

	it("waits again after a wait that gives no outcome to post, and posts the next outcome", async () => {
		const pi = fakePi([startEntry("flaky", root)]);
		await pi.fire("session_start");
		await vi.waitFor(() => expect(pi.messages).toHaveLength(1), { timeout: 3000 });
		expect(await waits()).toEqual(["wait flaky --json", "wait flaky --json"]);
		expect(pi.messages[0]?.message.content).toEqual([{ type: "text", text: "run flaky finished: 1\none" }]);
		expect(pi.entries.map((entry) => entry.data)).toEqual([{ runId: "flaky", cwd: root }, { runId: "flaky" }]);
	});

	it("lets a foreground resume of a followed run give the outcome, and posts nothing", async () => {
		const pi = fakePi([startEntry("fg", root)]);
		await pi.fire("session_start");
		await vi.waitFor(async () => expect(await waits()).toEqual(["wait fg --json"]));
		const result = await pi.registered.execute("call-1", { resume: "fg" }, undefined, undefined, contextOf(root));
		expect(result.structuredContent).toEqual({ runId: "fg", status: "finished", result: 2, report: ["two"] });
		await vi.waitFor(() => expect(pi.entries).toHaveLength(2));
		await new Promise((resolve) => setTimeout(resolve, 200));
		expect(pi.messages).toEqual([]);
		expect(pi.entries.map((entry) => entry.data)).toEqual([{ runId: "fg", cwd: root }, { runId: "fg" }]);
	});

	it("removes a run that a foreground resume ends while the watcher waits to retry", async () => {
		const pi = fakePi([startEntry("sleepy", root)]);
		const { ui, widgets } = fakeUi();
		await pi.fire("session_start", ui);
		await vi.waitFor(async () => expect(await waits()).toEqual(["wait sleepy --json"]));
		await pi.registered.execute("call-1", { resume: "sleepy" }, undefined, undefined, contextOf(root));

		// The first retry comes after 1 s; the run leaves the widget before it.
		await vi.waitFor(() => expect(widgets.at(-1)).toEqual(["workflows", undefined]), { timeout: 500 });
		expect(pi.messages).toEqual([]);
		expect(pi.entries.map((entry) => entry.data)).toEqual([{ runId: "sleepy", cwd: root }, { runId: "sleepy" }]);
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

		// The status of a progress line takes the place of its last line.
		await writeFile(join(root, `status-${id}`), "");
		await vi.waitFor(() =>
			expect(widgets.at(-1)).toEqual(["workflows", ["campaign: bb814010 item 2/5 › round 1/3: review"]]),
		);

		await writeFile(join(root, `end-${id}`), "");
		await vi.waitFor(() => expect(pi.entries).toHaveLength(2));
		await vi.waitFor(() => expect(widgets.at(-1)).toEqual(["workflows", undefined]));
		expect(pi.messages[0]?.message.content).toEqual([{ type: "text", text: `run ${id} finished: 1\none` }]);
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
		ended: false,
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

	it("shows the error of a later read that fails or rejects under the tree, until a good read", async () => {
		vi.useFakeTimers();

		const agents = [{ kind: "agent", depth: 0, mark: "◉", text: "You plan.", conversation: 1, facts: "sonnet" }];

		const json = JSON.stringify({
			runId: good,
			workflow: "mine",
			title: "Mine",
			status: "running",
			ended: false,
			agents,
		});

		const tree = parseRun({ code: 0, stdout: [json], stderr: [] });

		const reads = [
			async () => tree,
			async () => {
				throw new Error("spawn workflows ENOENT");
			},
			async () => `workflows: no run ${good}`,
			async () => tree,
		];

		const read = () => (reads.shift() ?? (async () => tree))();
		const help = "up/down select an agent, enter attaches, escape closes";
		const view = new RunView({ read, render: () => {}, theme, matches: () => false, done: () => {} });

		try {
			const rows = [`mine ${good} running Mine`, ">   ◉ You plan.  sonnet"];
			await vi.advanceTimersByTimeAsync(0);
			expect(view.render(200)).toEqual([...rows, help]);
			await vi.advanceTimersByTimeAsync(2000);
			expect(view.render(200)).toEqual([...rows, "spawn workflows ENOENT", help]);
			await vi.advanceTimersByTimeAsync(2000);
			expect(view.render(200)).toEqual([...rows, `workflows: no run ${good}`, help]);
			await vi.advanceTimersByTimeAsync(2000);
			expect(view.render(200)).toEqual([...rows, help]);
		} finally {
			view.dispose();
			vi.useRealTimers();
		}
	});

	it("reads the run no more once a read shows that it ended", async () => {
		vi.useFakeTimers();

		const agents = [{ kind: "agent", depth: 0, mark: "✓", text: "You plan.", conversation: 1, facts: "sonnet" }];
		const json = JSON.stringify({ runId: good, workflow: "mine", title: "Mine", status: "done", ended: true, agents });
		const tree = parseRun({ code: 0, stdout: [json], stderr: [] });
		let reads = 0;

		const read = async () => {
			reads++;

			return tree;
		};

		const view = new RunView({ read, render: () => {}, theme, matches: () => false, done: () => {} });

		try {
			await vi.advanceTimersByTimeAsync(6000);
			expect(reads).toBe(1);
			expect(view.render(200)[0]).toBe(`mine ${good} done Mine`);
		} finally {
			view.dispose();
			vi.useRealTimers();
		}
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

/**
 * The `node_modules` folder of a fake install of the Pi package, as npm installs it: `@vzlentin/pi-workflows` from
 * `pi/`, next to its dependency `@vzlentin/workflows` built from this checkout.
 */
let modules: string;
let installed: typeof extension;

/** Loads the installed extension without a command against a fake Pi, and gives the `workflow` tool that it registers. */
async function load(): Promise<Tool> {
	const tools: Tool[] = [];

	const pi: Api = {
		registerTool: (registered) => {
			if (isWorkflowTool(registered)) tools.push(registered);
		},
		registerCommand: () => {},
		registerMessageRenderer: () => {},
		on: () => () => {},
		sendMessage: () => {},
		appendEntry: () => {},
	};

	await installed(pi);
	const [registered] = tools;

	if (registered === undefined) throw new Error("the extension registered no tool");

	return registered;
}

describe("the installed extension", () => {
	const repo = join(import.meta.dirname, "..");
	let saved: NodeJS.ProcessEnv;
	let home: string;

	beforeAll(async () => {
		modules = join(realpathSync(await mkdtemp(join(tmpdir(), "workflows-install-"))), "node_modules");
		const workflows = join(modules, "@vzlentin", "workflows");
		const piWorkflows = join(modules, "@vzlentin", "pi-workflows");
		const tsc = join(repo, "node_modules", "typescript", "bin", "tsc");
		await run(process.execPath, [tsc, "-p", "tsconfig.build.json", "--outDir", join(workflows, "dist")], { cwd: repo });
		await copyFile(join(repo, "package.json"), join(workflows, "package.json"));
		await symlink(join(repo, "workflows"), join(workflows, "workflows"));
		await symlink(join(repo, "node_modules"), join(workflows, "node_modules"));
		await mkdir(piWorkflows, { recursive: true });

		for (const file of await readdir(join(repo, "pi"))) {
			if (file.endsWith(".ts") || file === "package.json")
				await copyFile(join(repo, "pi", file), join(piWorkflows, file));
		}

		for (const name of ["@earendil-works", "typebox"])
			await symlink(join(repo, "node_modules", name), join(modules, name));
		({ default: installed } = await import(pathToFileURL(join(piWorkflows, "index.ts")).href));
	}, 60_000);

	afterAll(() => rm(dirname(modules), { recursive: true, force: true }));

	beforeEach(async () => {
		saved = process.env;
		home = await sandbox();
	});

	afterEach(async () => {
		process.env = saved;
		await rm(home, { recursive: true, force: true });
	});

	it("runs dist/cli.js of its workflows dependency", async () => {
		const registered = await load();
		const called = registered.execute("call-1", { name: "nope" }, undefined, undefined, contextOf(home));

		// Only the CLI, after it read the scripts of the install, knows that no workflow has that name.
		await expect(called).rejects.toThrow("workflows: unknown command nope");
	});

	it("gives the tool of dist/tool.js of its workflows dependency", async () => {
		const registered = await load();
		expect(registered.description).toBe(toolModule.DESCRIPTION);
		expect(registered.parameters).toEqual(toolModule.PARAMETERS);
	});

	it("puts the .bin folder next to its workflows last on PATH, once for each load", async () => {
		process.env.PATH = ["/usr/bin", "/bin"].join(delimiter);
		await load();
		await load();

		expect((process.env.PATH ?? "").split(delimiter)).toEqual(["/usr/bin", "/bin", join(modules, ".bin")]);
	});

	it("sets the entry of harness to dist/entry.js of its workflows dependency", async () => {
		const entry = async () => JSON.parse(await readFile(entriesPath(), "utf8")).workflows;

		expect(await entry()).toBe(join(repo, "src", "entry.ts"));
		await load();
		expect(await entry()).toBe(join(modules, "@vzlentin", "workflows", "dist", "entry.js"));
	});
});

describe("the Pi package", () => {
	it("is @vzlentin/pi-workflows at the version of workflows, and brings workflows and pi-agents", () => {
		const read = (path: string) => JSON.parse(readFileSync(join(import.meta.dirname, "..", path), "utf8"));
		const pi = read("pi/package.json");
		const root = read("package.json");

		expect([
			pi.name,
			pi.private,
			pi.dependencies,
			pi.pi?.extensions,
			pi.pi?.skills,
			pi.keywords,
			pi.version,
			pi.repository?.url,
			pi.publishConfig?.access,
		]).toEqual([
			"@vzlentin/pi-workflows",
			undefined,
			{ "@vzlentin/workflows": root.version, "@vzlentin/pi-agents": "^0.6.0" },
			["./index.ts", "../pi-agents/index.ts", "./node_modules/@vzlentin/pi-agents/index.ts"],
			["./skills", "../pi-agents/skills", "./node_modules/@vzlentin/pi-agents/skills"],
			["pi-package"],
			root.version,
			root.repository.url,
			"public",
		]);

		// release-please moves the dependency on workflows with the version.
		expect(read("release-please-config.json").packages["."]["extra-files"]).toContainEqual({
			type: "json",
			path: "pi/package.json",
			jsonpath: "$.dependencies['@vzlentin/workflows']",
		});
	});
});

/** The skills that Pi loads from the Pi packages `packages`, with the diagnostics of their load. */
async function skillsOf(root: string, packages: string[]) {
	const agentDir = join(root, "agent");
	const settingsManager = SettingsManager.inMemory({ packages });
	const resolved = await new DefaultPackageManager({ cwd: root, agentDir, settingsManager }).resolve();
	const skillPaths = resolved.skills.filter((skill) => skill.enabled).map((skill) => skill.path);
	const { skills, diagnostics } = loadSkills({ cwd: root, agentDir, skillPaths, includeDefaults: false });

	return { skillPaths, names: skills.map((skill) => skill.name), diagnostics };
}

describe("the skills of the Pi package", () => {
	const repo = join(import.meta.dirname, "..");
	let saved: NodeJS.ProcessEnv;
	let home: string;

	beforeEach(async () => {
		saved = process.env;
		// The sandbox's HOME keeps the user's own skills out of Pi's resolve.
		home = realpathSync(await sandbox());
	});

	afterEach(async () => {
		process.env = saved;
		await rm(home, { recursive: true, force: true });
	});

	it("bring the workflows skill from a checkout", async () => {
		const { skillPaths, names } = await skillsOf(home, [join(repo, "pi")]);

		expect(skillPaths).toContain(join(repo, "pi", "skills", "workflows", "SKILL.md"));
		expect(names).toEqual(["workflows"]);
	});

	it("bring the skills of pi-agents next to it once, also when Pi's settings list pi-agents too", async () => {
		const scope = join(home, "npm", "node_modules", "@vzlentin");
		const piWorkflows = join(scope, "pi-workflows");
		const piAgents = join(scope, "pi-agents");
		await mkdir(piWorkflows, { recursive: true });
		await copyFile(join(repo, "pi", "package.json"), join(piWorkflows, "package.json"));
		await cp(join(repo, "pi", "skills"), join(piWorkflows, "skills"), { recursive: true });
		await mkdir(join(piAgents, "skills", "subagent"), { recursive: true });
		await writeFile(
			join(piAgents, "package.json"),
			JSON.stringify({ name: "@vzlentin/pi-agents", keywords: ["pi-package"], pi: { skills: ["./skills"] } }),
		);
		await writeFile(
			join(piAgents, "skills", "subagent", "SKILL.md"),
			"---\nname: subagent\ndescription: Spawn subagents.\n---\nSpawn subagents.\n",
		);

		const alone = await skillsOf(home, [piWorkflows]);
		const both = await skillsOf(home, [piWorkflows, piAgents]);

		expect([alone.names.toSorted(), alone.diagnostics]).toEqual([["subagent", "workflows"], []]);
		expect([both.names.toSorted(), both.diagnostics]).toEqual([["subagent", "workflows"], []]);
	});
});
