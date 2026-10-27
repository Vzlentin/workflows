import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { git, progressOf, repository, sandbox, workflows } from "./support.ts";

let root: string;
let repo: string;
let start: string;

beforeEach(async () => {
	root = await sandbox();
	repo = join(root, "repo");
	start = await repository(repo);
});

afterEach(() => rm(root, { recursive: true, force: true }));

const PLAN = "# Fix the README typo\n\nReplace wrold with world in README.md.";
const SUBJECT = "Fix the README typo";
const FIXED = "# Demo\n\nHello world\n";

describe("workflows implement", () => {
	it("implements a plan in the current directory and commits the change", async () => {
		const run = await workflows(["implement", "--json", PLAN], { cwd: repo, script: { edits: [FIXED] } });

		expect(run.code).toBe(0);
		const { result, report } = JSON.parse(run.stdout[1] ?? "");
		const head = git(repo, "rev-parse", "--short", "HEAD");
		expect(report).toEqual([`implemented ${SUBJECT}, ${head}`]);
		expect(result).toEqual({
			status: "implemented",
			head,
			reply: "I fixed the typo in README.md.",
			memory: ["#1 implementer 1: Implement 1: README.md had wrold."],
			report,
		});
		expect(progressOf(run.stderr)).toEqual(["+1 -1 in 1 file"]);
		expect(run.model.calls.map((call) => call.kind)).toEqual(["implement"]);
		expect(git(repo, "log", "--format=%s", `${start}..HEAD`)).toBe(SUBJECT);
		expect(git(repo, "branch", "--show-current")).toBe("main");
	});

	it("is blocked when the plan leads to no change", async () => {
		const run = await workflows(["implement", "--json", PLAN], { cwd: repo });

		expect(run.code).toBe(1);
		const { result, report } = JSON.parse(run.stdout[1] ?? "");
		expect(report).toEqual([`blocked ${SUBJECT}`, "I found nothing to change."]);
		expect(result).toMatchObject({ status: "blocked", reply: "I found nothing to change." });
		expect(result).not.toHaveProperty("head");
		expect(git(repo, "rev-parse", "HEAD")).toBe(start);
	});

	it("refuses a checkout with changes when no start is given", async () => {
		await writeFile(join(repo, "README.md"), "local edit\n");
		const run = await workflows(["implement", PLAN], { cwd: repo });

		expect(run.code).toBe(1);
		expect(run.stderr).toContain(
			`failed ${SUBJECT}: the checkout has changes that are not committed; commit or stash them first`,
		);
		expect(run.model.calls).toEqual([]);
	});

	it("logs the size of the change under the step of its caller, with the caller's memory", async () => {
		const scripts = join(repo, ".workflows", "workflows");
		await mkdir(scripts, { recursive: true });
		await writeFile(
			join(scripts, "parent.js"),
			`phase("fix")
const { report: _report, runId: _runId, ...result } = await run("implement", {
	plan: ${JSON.stringify(PLAN)},
	round: 2,
	start: await sh(["git", "rev-parse", "HEAD"]),
	message: "round 2",
	memory: ["#1 planner 0: one word changes."],
})
return result`,
		);
		git(repo, "add", ".workflows");
		git(repo, "commit", "-qm", "add the parent script");

		const run = await workflows(["parent", "--json"], { cwd: repo, script: { edits: [FIXED] } });

		expect(run.code).toBe(0);
		const { result } = JSON.parse(run.stdout[1] ?? "");
		expect(result).toMatchObject({
			status: "implemented",
			memory: ["#1 planner 0: one word changes.", "#2 implementer 2: Implement 1: README.md had wrold."],
		});
		expect(progressOf(run.stderr)).toEqual(["✓ fix", "  +1 -1 in 1 file"]);
		expect(run.model.find("implement")?.prompt).toMatch(/^## memory\n#1 planner 0: one word changes\.\n\n/);
		expect(git(repo, "log", "--format=%s", "HEAD^..HEAD")).toBe("round 2");
		expect(git(repo, "log", "--format=%s", "-1", "HEAD^")).toBe("add the parent script");
	});
});
