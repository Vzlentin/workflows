import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { optimizeWith, score } from "../src/workflows/optimize.ts";
import { git, repository, sandbox, workflows } from "./support.ts";

let root: string;
let start: string;

beforeEach(async () => {
	root = await sandbox();
	start = await repository(join(root, "repo"));
});

afterEach(() => rm(root, { recursive: true, force: true }));

/**
 * A fake `workflows` command that logs its arguments. A ship run creates its branch and passes 6 of 8 judge questions,
 * or 8 when a prompt of its `--prompts` folder has a reflected text. The first such run of the second item fails, and
 * its resume passes 8.
 */
const fake = (root: string) => `
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const root = ${JSON.stringify(root)};
const args = process.argv.slice(2);
appendFileSync(join(root, "cli.log"), JSON.stringify(args) + "\\n");
const count = join(root, "cli.count");
const n = existsSync(count) ? Number(readFileSync(count, "utf8")) + 1 : 1;
writeFileSync(count, String(n));
const shipped = (passes) => ({
	status: "shipped",
	rounds: 1,
	head: "abc",
	answers: Array.from({ length: 8 }, (_, index) => (index < passes ? "PASS" : "FAIL")),
	findings: ["4 FAIL README.md:3 is wrong"],
	memory: ["#1 planner 0: a note"],
});
const finished = (runId, result) => console.log(JSON.stringify({ runId, status: "finished", result, report: [] }));
if (args[0] === "resume") {
	console.log("run " + args[1]);
	finished(args[1], shipped(8));
} else {
	const option = (name) => args[args.indexOf(name) + 1];
	const id = "fake-" + n;
	execFileSync("git", ["branch", "ship/" + id, option("--base")], { cwd: option("--repo") });
	console.log("run " + id);
	const folder = option("--prompts");
	const improved = readdirSync(folder).some((file) => readFileSync(join(folder, file), "utf8").includes("Improved"));
	if (improved && args.at(-1).includes("Second") && !existsSync(join(root, "failed"))) {
		writeFileSync(join(root, "failed"), "");
		console.log(JSON.stringify({ runId: id, status: "failed", error: "boom" }));
		process.exitCode = 1;
	} else {
		finished(id, shipped(improved ? 8 : 6));
	}
}
`;

async function promptsHash(): Promise<string> {
	const folder = fileURLToPath(new URL("../prompts/", import.meta.url));
	const hash = createHash("sha256");
	for (const file of (await readdir(folder)).sort()) hash.update(file).update(await readFile(join(folder, file)));
	return hash.digest("hex");
}

describe("workflows optimize", () => {
	it("scores a shipped run by its passes and rounds, and any other run as 0", () => {
		const answers = ["PASS", "PASS", "PASS", "FAIL", "PASS", "PASS", "PASS", "FAIL"] as const;
		expect(score({ status: "shipped", rounds: 2, head: "abc", answers, memory: [] })).toBeCloseTo(0.65);
		expect(score({ status: "blocked", rounds: 1, reply: "nothing", memory: [] })).toBe(0);
		expect(score({ status: "stopped", rounds: 3, memory: [] })).toBe(0);
	});

	it("stops at a failed ship run, resumes it and reuses every finished evaluation and reflect turn", async () => {
		const items = join(root, "items");
		await mkdir(items);
		for (const name of ["First", "Second"]) {
			const text = `---\nrepo: ../repo\nstart: "${start}"\n---\n# ${name} item\n\nFix the README.\n`;
			await writeFile(join(items, `${name.toLowerCase()}.md`), text);
		}
		await writeFile(join(root, "fake.mjs"), fake(root));
		const installed = [optimizeWith([process.execPath, join(root, "fake.mjs")])];
		const before = await promptsHash();

		const first = await workflows(["optimize", "ship", "--items", "items"], { cwd: root, installed });

		expect(first.code).toBe(1);
		expect(first.stderr).toEqual([
			"failed ship: ship run fake-4 failed on second: boom; continue with: workflows resume fake-4",
			`continue with: workflows optimize resume ${first.id}`,
		]);
		expect(first.model.calls.map((call) => call.kind)).toEqual(["reflect"]);
		expect(first.model.calls[0]?.prompt).toMatch(/^Improve this prompt[\s\S]*\n\n## records\n\[\n/);

		const resumed = await workflows(["optimize", "resume", first.id ?? ""], { cwd: root, installed });

		const directory = join(root, "state", "workflows", "runs", first.id ?? "");
		const diff = join(directory, "prompts.diff");
		expect(resumed.code).toBe(0);
		expect(resumed.stdout).toEqual([`run ${first.id}`, `optimized ship: baseline 0.75, best 1.00, ${diff}`]);
		expect(resumed.model.calls).toEqual([]);
		const log = (await readFile(join(root, "cli.log"), "utf8")).trim().split("\n");
		const commands = log.map((line) => JSON.parse(line).slice(0, 2).join(" "));
		expect(commands).toEqual([...Array(4).fill("ship --repo"), "resume fake-4"]);
		const text = await readFile(diff, "utf8");
		expect(text).toMatch(/^first: baseline 0\.75, best 1\.00\nsecond: baseline 0\.75, best 1\.00\ndiff --git /);
		expect(text).toMatch(/\n--- a\/prompts\/\w+\.md\n\+\+\+ b\/prompts\/\w+\.md\n/);
		expect(text).toContain("\n+Improved prompt 1.\n");
		expect(git(join(root, "repo"), "branch", "--list", "ship/*")).toBe("");
		expect(await promptsHash()).toBe(before);
	});
});
