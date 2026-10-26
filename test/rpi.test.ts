import { rm, writeFile } from "node:fs/promises";
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
	git(repo, "checkout", "-qb", "feature");
	await writeFile(join(repo, "README.md"), "# Demo\n\nHello world\n");
	git(repo, "commit", "-qam", "fix the typo");
});

afterEach(() => rm(root, { recursive: true, force: true }));

const ITEM = "Fix the README typo";
const THANKED = "# Demo\n\nHello world\nThanks.\n";

describe("workflows rpi", () => {
	it("researches, plans and implements a work item in one commit on its own branch", async () => {
		const run = await workflows(["rpi", "--json", ITEM], { cwd: repo, script: { edits: [THANKED] } });

		expect(run.code).toBe(0);
		const { result, report } = JSON.parse(run.stdout[1] ?? "");
		const worktree = join(root, "state", "workflows", "runs", run.id ?? "", "worktree");
		const head = git(worktree, "rev-parse", "--short", "HEAD");
		expect(report).toEqual([`implemented ${ITEM}, ${head}`]);
		expect(git(worktree, "branch", "--show-current")).toBe(`rpi/${run.id}`);
		expect(result).toMatchObject({ status: "implemented", head, reply: "I fixed the typo in README.md." });
		expect(result.memory).toEqual([
			"#1 planner 0: Handoff 1: one word changes.",
			"#2 implementer 1: Implement 1: README.md had wrold.",
		]);
		expect(progressOf(run.stderr)).toEqual(["✓ research", "✓ plan", "✓ implement", "  +2 -1 in 1 file"]);
		expect(run.model.calls.map((call) => call.kind)).toEqual(["research", "plan", "challenge", "handoff", "implement"]);
		expect(git(worktree, "log", "--format=%s", `${start}..HEAD`)).toBe(ITEM);
		expect(git(repo, "branch", "--show-current")).toBe("feature");
	});
});
