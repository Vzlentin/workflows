import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { git, progressOf, repository, runsOf, sandbox, statusesOf, workflows } from "./support.ts";

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

describe("workflows thermoloop", () => {
	it("reviews the branch from its merge base, and commits the fix of each round on it", async () => {
		const head = git(repo, "rev-parse", "HEAD");

		const run = await workflows(["thermoloop", "--json", ITEM], {
			cwd: repo,
			script: { edits: [THANKED], verdicts: ["FIX", "SHIP"] },
		});

		expect(run.code).toBe(0);
		const { result, report } = JSON.parse(run.stdout[1] ?? "");
		expect(report).toEqual([`approved ${ITEM} in 2 rounds, ${git(repo, "rev-parse", "--short", "HEAD")}`]);
		expect(result).toMatchObject({
			status: "approved",
			rounds: 2,
			memory: ["#0 reviewer r1: Handoff 1: one word changes.", "#1 implementer r2: Implement 1: README.md had wrold."],
		});
		expect(progressOf(run.stderr)).toEqual([
			"✓ round 1/3: review",
			"  FIX",
			"✓ round 2/3: implement",
			"  +1 -0 in 1 file",
			"✓ round 2/3: review",
			"  SHIP",
		]);
		expect(statusesOf(run.stderr)).toEqual(["round 1/3: review", "round 2/3: implement", "round 2/3: review", "-"]);
		expect(run.model.calls.map((call) => call.kind)).toEqual([
			"review",
			"verdict",
			"handoff",
			"implement",
			"review",
			"verdict",
		]);

		// The first round reviews the commits of the branch, with no plan and no reply.
		const patch = join(root, "state", "workflows", "runs", run.id ?? "", "round-1.patch");
		expect(run.model.find("review")?.prompt).toMatch(new RegExp(`## item\\n${ITEM}\\n\\n## change\\n${patch}$`));
		expect(await readFile(patch, "utf8")).toContain("+Hello world\n");
		expect(run.model.find("implement")?.prompt).toContain("## plan\nHandoff 1: ");

		// The run opens its own memory, and each session gets the notes only in its first prompt.
		const memory = join(runsOf(root), run.id ?? "", "memory");
		expect(await readFile(join(memory, "LOG.txt"), "utf8")).toMatch(/^#0 \d{4}-\d{2}-\d{2} reviewer r1: Handoff 1: /);
		const calls = (await readFile(join(root, "home", ".optmem", "calls.log"), "utf8")).trim().split("\n");
		expect(calls.map((line) => JSON.parse(line).dir)).toEqual(calls.map(() => memory));
		expect(run.model.find("review")?.prompt).not.toContain("## memory");
		expect(run.model.find("review", 1)?.prompt).toMatch(
			/^## memory\n#0 reviewer r1: Handoff 1: one word changes\.\n#1 implementer r2: Implement 1: README\.md had wrold\.\n\nPerform/,
		);
		expect(run.model.find("verdict", 1)?.prompt).not.toContain("## memory");

		expect(git(repo, "branch", "--show-current")).toBe("feature");
		expect(git(repo, "log", "--format=%s", `${start}..HEAD`)).toBe("round 2\nfix the typo");
		expect(git(repo, "rev-parse", "HEAD^")).toBe(head);
		expect(await readFile(join(repo, "README.md"), "utf8")).toBe(THANKED);
	});

	it("stops after --rounds rounds with exit 1, and refuses a checkout with changes or a branch with no change", async () => {
		const stopped = await workflows(["thermoloop", "--rounds", "1", ITEM], {
			cwd: repo,
			script: { verdicts: ["FIX"] },
		});

		expect([stopped.code, stopped.stdout.slice(1)]).toEqual([1, [`stopped ${ITEM} after 1 rounds`]]);

		await rm(join(root, "home", ".optmem", "memo"));
		const missing = await workflows(["thermoloop", ITEM], { cwd: repo });
		expect(missing.code).toBe(1);
		expect(missing.stderr.join("\n")).toContain("https://github.com/VictorTaelin/OptMem");
		expect(missing.stderr.join("\n")).toContain(
			"curl -fsSL https://raw.githubusercontent.com/VictorTaelin/OptMem/main/install.sh | sh",
		);
		expect(missing.model.calls).toEqual([]);

		await writeFile(join(repo, "README.md"), "local edit\n");
		const dirty = await workflows(["thermoloop", ITEM], { cwd: repo });
		expect(dirty.code).toBe(1);
		expect(dirty.stderr).toContain(
			`failed ${ITEM}: the checkout has changes that are not committed; commit or stash them first`,
		);

		git(repo, "checkout", "-q", "--", "README.md");
		git(repo, "checkout", "-q", "main");
		const empty = await workflows(["thermoloop", ITEM], { cwd: repo });
		expect(empty.code).toBe(1);
		expect(empty.stderr).toContain(`failed ${ITEM}: no change from main`);
		expect(empty.model.calls).toEqual([]);
	});
});
