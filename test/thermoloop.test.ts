import { readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fake, git, progressOf, repository, runsOf, sandbox, statusesOf, workflows, worktreeAt } from "./support.ts";

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

		const run = await workflows(["thermoloop", "--json", "--item", ITEM], {
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
		expect(run.model.calls.map((call) => call.kind)).toEqual(["review", "handoff", "implement", "review"]);

		// The first round reviews the commits of the branch, with no plan and no reply.
		const patch = join(root, "state", "workflows", "runs", run.id ?? "", "round-1.patch");
		expect(run.model.find("review")?.prompt).toMatch(
			new RegExp(`## item\\n${ITEM}\\n\\n## change\\n${patch}\\n\\nWhen you are done`),
		);
		expect(await readFile(patch, "utf8")).toContain("+Hello world\n");
		expect(run.model.find("implement")?.prompt).toContain("## plan\nHandoff 1: ");

		// The run opens its own memory, and the review of each later round gets the notes.
		const memory = join(runsOf(root), run.id ?? "", "memory");
		expect(await readFile(join(memory, "LOG.txt"), "utf8")).toMatch(/^#0 \d{4}-\d{2}-\d{2} reviewer r1: Handoff 1: /);
		const calls = (await readFile(join(root, "home", ".optmem", "calls.log"), "utf8")).trim().split("\n");
		expect(calls.map((line) => JSON.parse(line).dir)).toEqual(calls.map(() => memory));
		expect(run.model.find("review")?.prompt).not.toContain("## memory");
		expect(run.model.find("review", 1)?.prompt).toMatch(
			/^## memory\n#0 reviewer r1: Handoff 1: one word changes\.\n#1 implementer r2: Implement 1: README\.md had wrold\.\n\nPerform/,
		);

		expect(git(repo, "branch", "--show-current")).toBe("feature");
		expect(git(repo, "log", "--format=%s", `${start}..HEAD`)).toBe("round 2\nfix the typo");
		expect(git(repo, "rev-parse", "HEAD^")).toBe(head);
		expect(await readFile(join(repo, "README.md"), "utf8")).toBe(THANKED);
	});

	it("keeps plain notes without memo, and warns with the install command", async () => {
		await rm(join(root, "home", ".optmem", "memo"));

		const run = await workflows(["thermoloop", "--json", "--item", ITEM], {
			cwd: repo,
			script: { edits: [THANKED], verdicts: ["FIX", "SHIP"] },
		});

		expect(run.code).toBe(0);
		expect(run.stderr.join("\n")).toContain(
			"memo of OptMem is missing, so the run memory keeps plain notes without summaries. Install it with: " +
				"curl -fsSL https://raw.githubusercontent.com/VictorTaelin/OptMem/main/install.sh | sh",
		);

		const notes = [
			"#0 reviewer r1: Handoff 1: one word changes.",
			"#1 implementer r2: Implement 1: README.md had wrold.",
		];

		expect(JSON.parse(run.stdout[1] ?? "").result.memory).toEqual(notes);
		const memory = join(runsOf(root), run.id ?? "", "memory");
		expect(await readFile(join(memory, "notes.txt"), "utf8")).toBe(`${notes.join("\n")}\n`);
		expect(run.model.find("review", 1)?.prompt).toMatch(new RegExp(`^## memory\\n${notes.join("\\n")}\\n\\nPerform`));
	});

	it("stops after --rounds rounds with exit 1, and refuses a branch with no change", async () => {
		const stopped = await workflows(["thermoloop", "--rounds", "1", "--item", ITEM], {
			cwd: repo,
			script: { verdicts: ["FIX"] },
		});

		expect([stopped.code, stopped.stdout.slice(1)]).toEqual([1, [`stopped ${ITEM} after 1 rounds`]]);

		git(repo, "checkout", "-q", "main");
		const empty = await workflows(["thermoloop", "--item", ITEM], { cwd: repo });
		expect(empty.code).toBe(1);
		expect(empty.stderr).toContain(`failed ${ITEM}: no change from main`);
		expect(empty.model.calls).toEqual([]);
	});

	it("takes the pull request of the branch as the intent, from an empty stdin", async () => {
		await fake(
			root,
			"gh",
			`echo "$@" >> "${root}/gh.log"
[ "$*" = "pr view feature --json title,body" ] || exit 1
echo '{"title":"Fix the typo of the README","body":"It says wrold."}'
`,
		);

		const run = await workflows(["thermoloop"], { cwd: repo, stdin: "", script: { verdicts: ["SHIP"] } });

		expect(run.code).toBe(0);
		expect(run.stdout.slice(1)).toEqual([
			`approved Fix the typo of the README in 1 rounds, ${git(repo, "rev-parse", "--short", "HEAD")}`,
		]);
		expect(run.model.find("review")?.prompt).toContain("## item\n# Fix the typo of the README\n\nIt says wrold.\n\n");

		// The intent names the run, also without a work item.
		const listed = await workflows(["list"], { cwd: repo });
		expect(listed.stdout).toEqual([`${run.id} thermoloop approved Fix the typo of the README`]);
		const shown = await workflows(["show", run.id ?? ""], { cwd: repo });
		expect(shown.stdout[0]).toBe(`run ${run.id} thermoloop approved Fix the typo of the README`);
	});

	it("commits the changes of the checkout as wip, and reviews a ref with the commit messages as the intent", async () => {
		await writeFile(join(repo, "NOTES.md"), "notes\n");

		const run = await workflows(["thermoloop", "HEAD~1"], { cwd: repo, script: { verdicts: ["SHIP"] } });

		expect(run.code).toBe(0);
		expect(git(repo, "log", "--format=%s", `${start}..HEAD`)).toBe("wip\nfix the typo");
		expect(git(repo, "status", "--porcelain")).toBe("");
		expect(run.stdout.slice(1)).toEqual([
			`approved fix the typo in 1 rounds, ${git(repo, "rev-parse", "--short", "HEAD")}`,
		]);
		expect(run.model.find("review")?.prompt).toContain("## item\nfix the typo\n\nwip\n\n");
		const patch = join(runsOf(root), run.id ?? "", "round-1.patch");
		expect(await readFile(patch, "utf8")).toContain("+notes\n");
		expect(await readFile(patch, "utf8")).toContain("+Hello world\n");
	});

	it("reviews a range on a branch that no worktree has in a worktree of its own", async () => {
		git(repo, "checkout", "-q", "main");
		const tip = git(repo, "rev-parse", "feature");

		const run = await workflows(["thermoloop", "--json", "main..feature"], {
			cwd: repo,
			script: { edits: [THANKED], verdicts: ["FIX", "SHIP"] },
		});

		expect(run.code).toBe(0);
		const { report } = JSON.parse(run.stdout[1] ?? "");
		const path = String(report.at(-1)).slice("worktree ".length);
		expect(report).toEqual([
			`approved fix the typo in 2 rounds, ${git(repo, "rev-parse", "--short", "feature")}`,
			`worktree ${path}`,
		]);
		expect(dirname(path)).toBe(dirname(worktreeAt(repo, run.id)));
		expect(git(path, "branch", "--show-current")).toBe("feature");
		expect(git(repo, "log", "--format=%s", `${tip}..feature`)).toBe("round 2");
		expect(await readFile(join(path, "README.md"), "utf8")).toBe(THANKED);
		// The checkout of the start stays as it was.
		expect([git(repo, "branch", "--show-current"), git(repo, "rev-parse", "HEAD")]).toEqual(["main", start]);
		expect(await readFile(join(repo, "README.md"), "utf8")).toBe("# Demo\n\nHello wrold\n");

		// A branch that another worktree has checked out runs there.
		const again = await workflows(["thermoloop", "main..feature"], { cwd: repo });
		expect(again.code).toBe(1);
		expect(again.stderr).toContain(`failed thermoloop: feature is checked out at ${path}; run there`);
	});

	it("fetches a pull request that is not here, and fixes it in a worktree of its own", async () => {
		const origin = join(root, "origin.git");
		git(root, "clone", "-q", "--bare", repo, origin);
		git(repo, "remote", "add", "origin", origin);
		git(repo, "push", "-q", "origin", "feature:refs/pull/74/head");
		git(repo, "checkout", "-q", "main");
		git(repo, "branch", "-q", "-D", "feature");

		await fake(
			root,
			"gh",
			`echo "$@" >> "${root}/gh.log"
[ "$*" = "pr view 74 --json number,title,body,headRefName,baseRefName,isCrossRepository" ] || exit 1
echo '{"number":74,"title":"Fix the README typo","body":"It says wrold.","headRefName":"fix-readme","baseRefName":"main","isCrossRepository":false}'
`,
		);

		const run = await workflows(["thermoloop", "--json", "74"], {
			cwd: repo,
			script: { edits: [THANKED], verdicts: ["FIX", "SHIP"] },
		});

		expect(run.code).toBe(0);
		const { report } = JSON.parse(run.stdout[1] ?? "");
		const path = String(report.at(-1)).slice("worktree ".length);
		expect(report).toEqual([
			`approved ${ITEM} in 2 rounds, ${git(repo, "rev-parse", "--short", "fix-readme")}`,
			`worktree ${path}`,
		]);
		expect(run.model.find("review")?.prompt).toContain(`## item\n# ${ITEM}\n\nIt says wrold.\n\n`);
		expect(git(path, "branch", "--show-current")).toBe("fix-readme");
		expect(git(repo, "log", "--format=%s", `${start}..fix-readme`)).toBe("round 2\nfix the typo");
		expect([git(repo, "branch", "--show-current"), git(repo, "rev-parse", "HEAD")]).toEqual(["main", start]);
		expect(git(repo, "status", "--porcelain")).toBe("");
	});
});
