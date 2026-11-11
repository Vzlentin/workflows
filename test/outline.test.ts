import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { type OutlineStep, readMeta, readOutline } from "../src/workflow/meta.ts";
import { sandbox, workflows } from "./support.ts";

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
				"usage: workflows mine [--word <value>] [--prompts <folder>] [--agents <name>=<provider/id>:<thinking>,...] [--background] [--json]",
				"Mine.",
			],
		]);
	});

	it("gives each package script its outline, which check passes", async () => {
		const review = loop("review, in rounds", [agent("reviewer", "review"), run("implement", "fix")]);

		const outlines = {
			ship: [
				agent("researcher", "research"),
				agent("planner", "plan"),
				run("implement", "implement"),
				review,
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

		for (const [name, outline] of Object.entries(outlines)) {
			const source = await readFile(new URL(`../workflows/scripts/${name}.js`, import.meta.url), "utf8");
			expect(await readOutline(source, name), name).toEqual(outline);
			const checked = await workflows(["check", name], { cwd: root });
			expect([checked.code, checked.stdout], name).toEqual([0, [`ok ${name}`]]);
		}
	});

	it("reads the outline apart from the meta that a run saves, and no steps without one", async () => {
		const source =
			'export const meta = { description: "Plan.", outline: [{ kind: "agent", role: "planner", label: "plan" }] }\nreturn 1';

		expect(await readOutline(source, "plan")).toEqual([agent("planner", "plan")]);
		expect(await readMeta(source, "plan")).toEqual({ description: "Plan.", args: {}, placement: "here", exit: {} });
		expect(await readOutline('export const meta = { description: "Plan." }\nreturn 1', "plan")).toEqual([]);
		expect(await readOutline("return 1", "plan")).toEqual([]);
	});
});
