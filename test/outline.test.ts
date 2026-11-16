import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Value } from "typebox/value";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { CATALOG_ENTRY } from "../src/cli/commands/outline.ts";
import { type OutlineStep, readDeclared, readMeta } from "../src/workflow/meta.ts";
import { runsOf, sandbox, storeOf, workflows } from "./support.ts";

let root: string;

beforeEach(async () => {
	root = await sandbox();
});

afterEach(() => rm(root, { recursive: true, force: true }));

function agent(role: string, label: string): OutlineStep {
	return { kind: "agent", role, label };
}

function run(workflow: string, label: string): OutlineStep {
	return { kind: "run", workflow, label };
}

function loop(label: string, steps: [OutlineStep, ...OutlineStep[]]): OutlineStep {
	return { kind: "loop", label, steps };
}

/** The outline that each package script declares. */
const OUTLINES = {
	ship: [
		agent("researcher", "research"),
		agent("planner", "plan"),
		run("implement", "implement"),
		loop("review, in rounds", [agent("reviewer", "review"), run("implement", "fix")]),
		run("judge", "judge"),
	],
	campaign: [agent("planner", "split"), loop("each item: ship", [run("ship", "ship")]), run("judge", "judge")],
	thermoloop: [loop("review ─ fix, in rounds", [agent("reviewer", "review"), run("implement", "fix")])],
	rpi: [agent("researcher", "research"), agent("planner", "plan"), run("implement", "implement")],
	implement: [agent("implementer", "implement")],
	fix: [run("implement", "fix"), run("judge", "judge")],
	judge: [agent("judge", "judge")],
	optimize: [
		loop("each item: baseline", [run("ship", "baseline")]),
		agent("default", "inv"),
		agent("default", "dom"),
		agent("default", "compose"),
		loop("each item: ship ─ select", [run("ship", "ship"), agent("judge", "select")]),
	],
} satisfies Record<string, OutlineStep[]>;

/** The lines of `workflows outline` for the package scripts. */
const PACKAGE_LINES = [
	"campaign    split ─ each item: ship ─ judge",
	"fix         fix ─ judge",
	"implement   implement",
	"judge       judge",
	"optimize    each item: baseline ─ inv ─ dom ─ compose ─ each item: ship ─ select",
	"rpi         research ─ plan ─ implement",
	"ship        research ─ plan ─ implement ─ review, in rounds ─ judge",
	"thermoloop  review ─ fix, in rounds",
];

/** A script whose `meta` declares `outline`. */
const metaOf = (outline: readonly OutlineStep[]) =>
	`export const meta = { outline: ${JSON.stringify(outline)} }\nreturn 1`;

/** The catalog entry of a script whose `meta` declares only `outline`. */
const plainEntry = (workflow: string, outline: readonly OutlineStep[]) => ({
	workflow,
	description: "",
	args: {},
	placement: "here",
	exit: {},
	outline,
	usage: `workflows ${workflow} [--prompts <folder>] [--agents <name>=<provider/id>:<thinking>,...] [--serves <todo-id | parley-slug>] [--background] [--json]`,
});

describe("meta.outline", () => {
	it("refuses a bad outline in a check and in a run, before the run starts", async () => {
		for (const [outline, problem] of [
			['"plan"', "meta.outline is not an array of steps"],
			['[{ kind: "tool", label: "use" }]', "meta.outline/0/kind must be agent, run or loop"],
			[
				'[{ kind: "agent", role: "planner", label: "plan" }, { kind: "agent", role: "planner", label: "a\\nb" }]',
				"meta.outline/1/label must be a non-empty line",
			],
			[
				'[{ kind: "agent", role: "planner", label: "plan" }, { kind: "run", workflow: "judge", label: "judge" }, { kind: "loop", label: "rounds", steps: [] }]',
				"meta.outline/2/steps must have at least one step",
			],
			[
				'[{ kind: "agent", role: "planner", label: "plan", model: "opus" }]',
				"meta.outline/0/model is not an outline field",
			],
			[
				'[{ kind: "run", workflow: "judge", label: "judge", role: "judge" }]',
				"meta.outline/0/role is not an outline field",
			],
			[
				'[{ kind: "agent", role: "planner", label: "plan", "a/b~": 1 }]',
				"meta.outline/0/a~1b~0 is not an outline field",
			],
			["[1]", "meta.outline/0 is not a step"],
			['[{ kind: "agent", label: "plan" }]', "meta.outline/0/role must be a non-empty line"],
			['[{ kind: "run", workflow: "", label: "judge" }]', "meta.outline/0/workflow must be a non-empty line"],
			['[{ kind: "loop", label: "rounds", steps: {} }]', "meta.outline/0/steps is not an array of steps"],
			[
				'[{ kind: "loop", label: "items", steps: [{ kind: "loop", label: "rounds", steps: [{ kind: "agent", role: "reviewer", label: "review" }, { kind: "run", workflow: "implement", label: "a\\u2028b" }] }] }]',
				"meta.outline/0/steps/0/steps/1/label must be a non-empty line",
			],
		]) {
			await writeFile(join(root, "x.js"), `export const meta = { outline: ${outline} }\nreturn 1`);

			for (const args of [["check", "x.js"], ["x.js"]]) {
				const refused = await workflows(args, { cwd: root });
				expect([refused.code, refused.stdout, refused.stderr], `${args[0]} ${outline}`).toEqual([
					1,
					[],
					[`workflows: x: ${problem}`],
				]);
			}
		}

		expect(existsSync(join(root, "state", "workflows", "runs"))).toBe(false);
	});

	it("checks the run steps against the workflows of the bundle, and runs a script with an outline as before", async () => {
		const scripts = join(root, ".workflows", "scripts");
		await mkdir(scripts, { recursive: true });
		await writeFile(join(scripts, "helper.js"), 'return "helped"');

		const mine = (name: string) =>
			writeFile(
				join(scripts, "mine.js"),
				`export const meta = {
	description: "Mine.",
	args: { word: { type: "string" } },
	outline: [
		{ kind: "run", workflow: "ship", label: "ship" },
		{
			kind: "loop",
			label: "rounds",
			steps: [
				{ kind: "agent", role: "reviewer", label: "review" },
				{ kind: "run", workflow: "${name}", label: "help" },
			],
		},
	],
}
return args.word`,
			);

		await mine("helpr");
		const unknown = await workflows(["check", "mine"], { cwd: root });
		expect([unknown.code, unknown.stderr]).toEqual([
			1,
			["workflows: mine: meta.outline/1/steps/1/workflow names no workflow helpr"],
		]);

		await mine("helper");
		const checked = await workflows(["check", "mine"], { cwd: root });
		expect([checked.code, checked.stdout]).toEqual([0, ["ok mine"]]);
		const ran = await workflows(["mine", "--word", "hello"], { cwd: root });
		expect([ran.code, ran.stdout.at(-1)]).toEqual([0, "hello"]);
		const help = await workflows(["mine", "--help"], { cwd: root });
		expect([help.code, help.stdout]).toEqual([
			0,
			[
				"usage: workflows mine [--word <value>] [--prompts <folder>] [--agents <name>=<provider/id>:<thinking>,...] [--serves <todo-id | parley-slug>] [--background] [--json]",
				"Mine.",
			],
		]);
	});

	it("gives each package script its outline, which check passes", async () => {
		for (const [name, outline] of Object.entries(OUTLINES)) {
			const source = await readFile(new URL(`../workflows/scripts/${name}.js`, import.meta.url), "utf8");
			expect((await readDeclared(source, name)).outline, name).toEqual(outline);
			const checked = await workflows(["check", name], { cwd: root });
			expect([checked.code, checked.stdout], name).toEqual([0, [`ok ${name}`]]);
		}
	});

	it("reads the outline apart from the meta that a run saves, and no steps without one", async () => {
		const source =
			'export const meta = { description: "Plan.", outline: [{ kind: "agent", role: "planner", label: "plan" }] }\nreturn 1';

		const meta = { description: "Plan.", args: {}, placement: "here", exit: {} };

		expect(await readDeclared(source, "plan")).toEqual({ meta, outline: [agent("planner", "plan")] });
		expect(await readMeta(source, "plan")).toEqual(meta);
		expect(await readDeclared('export const meta = { description: "Plan." }\nreturn 1', "plan")).toEqual({
			meta,
			outline: [],
		});
		expect(await readDeclared("return 1", "plan")).toEqual({ meta: { ...meta, description: "" }, outline: [] });
	});
});

describe("workflows outline", () => {
	it("prints the catalog entry of one script as one JSON line, with no run, no store and no model call", async () => {
		const shown = await workflows(["outline", "ship", "--json"], { cwd: root });
		expect([shown.code, shown.stderr]).toEqual([0, []]);
		const entries = shown.stdout.map((line) => JSON.parse(line));
		expect(entries).toEqual([
			{
				workflow: "ship",
				description:
					"Ship one work item onto a new branch: research, plan, implement, review rounds, one squashed commit, and judge.",
				args: {
					item: { type: "text", positional: true, label: "work item", required: true },
					rounds: { type: "number", default: 3 },
				},
				placement: "worktree",
				exit: { shipped: 0, rejected: 1, blocked: 1, stopped: 1 },
				outline: OUTLINES.ship,
				usage:
					"workflows ship [--rounds <n>] [--repo <repository>] [--base <branch>] [--branch <name>] [--prompts <folder>] [--agents <name>=<provider/id>:<thinking>,...] [--serves <todo-id | parley-slug>] [<item.md> | <text>] [--background] [--json]",
			},
		]);
		expect(entries.every((entry) => Value.Check(CATALOG_ENTRY, entry))).toBe(true);
		expect([existsSync(runsOf(root)), existsSync(storeOf()), shown.model.calls]).toEqual([false, false, []]);
	});

	it("fails every command that loads the scripts for a project script with the name of a command", async () => {
		const scripts = join(root, ".workflows", "scripts");
		await mkdir(scripts, { recursive: true });
		await writeFile(join(scripts, "log.js"), "return 1");
		const error = `workflows: ${join(scripts, "log.js")} has the name of the command log; rename the script`;

		for (const argv of [[], ["outline", "--json"]]) {
			const run = await workflows(argv, { cwd: root });
			expect([run.code, run.stderr], argv.join(" ")).toEqual([1, [error]]);
		}
	});

	it("gives an error entry for a script with a bad meta, and the full entry of each other script", async () => {
		const scripts = join(root, ".workflows", "scripts");
		await mkdir(scripts, { recursive: true });
		await writeFile(
			join(scripts, "bad.js"),
			'export const meta = { outline: [{ kind: "tool", label: "use" }] }\nreturn 1',
		);
		await writeFile(
			join(scripts, "mine.js"),
			`export const meta = {
	description: "Mine.",
	args: { path: { type: "string", positional: true, required: true }, all: { type: "boolean" } },
	repo: true,
	exit: { found: 0, missing: 5 },
	outline: [{ kind: "agent", role: "reader", label: "read" }],
}
return 1`,
		);
		const bad = { workflow: "bad", error: "bad: meta.outline/0/kind must be agent, run or loop" };

		const every = await workflows(["outline", "--json"], { cwd: root });
		expect([every.code, every.stderr, every.stdout.length]).toEqual([0, [], 1]);
		const entries: unknown = JSON.parse(every.stdout[0] ?? "");

		if (!Array.isArray(entries)) throw new Error("outline --json printed no array");
		expect(entries.every((entry) => Value.Check(CATALOG_ENTRY, entry))).toBe(true);
		expect(entries.map(({ workflow }: { workflow: string }) => workflow)).toEqual([
			...Object.keys(OUTLINES).toSorted(),
			"bad",
			"mine",
		]);
		expect(entries.slice(-2)).toEqual([
			bad,
			{
				workflow: "mine",
				description: "Mine.",
				args: { path: { type: "string", positional: true, required: true }, all: { type: "boolean" } },
				placement: "repo",
				exit: { found: 0, missing: 5 },
				outline: [agent("reader", "read")],
				usage:
					"workflows mine [--all] [--repo <repository>] [--prompts <folder>] [--agents <name>=<provider/id>:<thinking>,...] [--serves <todo-id | parley-slug>] <path> [--background] [--json]",
			},
		]);

		const one = await workflows(["outline", "bad", "--json"], { cwd: root });
		expect([one.code, one.stdout.map((line) => JSON.parse(line)), one.stderr]).toEqual([0, [bad], []]);
	});

	it("prints one line for each script, with the names padded to the longest printed name", async () => {
		const every = await workflows(["outline"], { cwd: root });
		expect([every.code, every.stdout, every.stderr]).toEqual([0, PACKAGE_LINES, []]);
		const one = await workflows(["outline", "judge"], { cwd: root });
		expect([one.code, one.stdout]).toEqual([0, ["judge  judge"]]);
	});

	it("reads the project scripts and a script file or stdin, and prints a script without an outline alone", async () => {
		const scripts = join(root, ".workflows", "scripts");
		await mkdir(scripts, { recursive: true });
		const own = [agent("planner", "draft"), loop("rounds", [run("judge", "judge")])];
		const mine = [run("ship", "ship"), loop("items", [loop("rounds", [agent("reviewer", "review")])])];
		await writeFile(join(scripts, "ship.js"), metaOf(own));
		await writeFile(join(scripts, "mine.js"), metaOf(mine));
		await writeFile(join(scripts, "plain.js"), "return 1");
		await writeFile(join(root, "x.js"), metaOf(own));

		const every = await workflows(["outline"], { cwd: root });
		expect([every.code, every.stdout, every.stderr]).toEqual([
			0,
			[
				...PACKAGE_LINES.slice(0, 6),
				"ship        draft ─ rounds",
				"thermoloop  review ─ fix, in rounds",
				"mine        ship ─ items",
				"plain",
			],
			[],
		]);

		const json = await workflows(["outline", "--json"], { cwd: root });
		expect([json.code, json.stdout.map((line) => JSON.parse(line))]).toEqual([
			0,
			[
				[
					...(["campaign", "fix", "implement", "judge", "optimize", "rpi"] as const).map((workflow) =>
						expect.objectContaining({ workflow, outline: OUTLINES[workflow] }),
					),
					plainEntry("ship", own),
					expect.objectContaining({ workflow: "thermoloop", outline: OUTLINES.thermoloop }),
					plainEntry("mine", mine),
					plainEntry("plain", []),
				],
			],
		]);

		for (const [word, entry] of [
			["mine", plainEntry("mine", mine)],
			["x.js", plainEntry("x", own)],
			["-", plainEntry("stdin", mine)],
		] as const) {
			const shown = await workflows(["outline", word, "--json"], { cwd: root, stdin: metaOf(mine) });
			expect([shown.code, shown.stdout.map((line) => JSON.parse(line))], word).toEqual([0, [entry]]);
		}

		const plain = await workflows(["outline", "plain"], { cwd: root });
		expect([plain.code, plain.stdout]).toEqual([0, ["plain"]]);
	});

	it("fails on an unknown name as check does, and on a bad meta in the text form", async () => {
		const unknown = await workflows(["outline", "nope"], { cwd: root });
		expect([unknown.code, unknown.stderr[0]]).toEqual([2, "workflows: unknown command nope"]);
		const checked = await workflows(["check", "nope"], { cwd: root });
		expect([unknown.code, unknown.stdout, unknown.stderr]).toEqual([checked.code, checked.stdout, checked.stderr]);

		const scripts = join(root, ".workflows", "scripts");
		await mkdir(scripts, { recursive: true });
		await writeFile(
			join(scripts, "bad.js"),
			'export const meta = { outline: [{ kind: "tool", label: "use" }] }\nreturn 1',
		);

		for (const argv of [["outline", "bad"], ["outline"]]) {
			const bad = await workflows(argv, { cwd: root });
			expect([bad.code, bad.stdout, bad.stderr], argv.join(" ")).toEqual([
				1,
				[],
				["workflows: bad: meta.outline/0/kind must be agent, run or loop"],
			]);
		}
	});
});
