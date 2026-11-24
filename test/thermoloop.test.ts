import { chmod, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import {
	fake,
	FIX_COMMIT,
	git,
	hostBranch,
	hostOrigin,
	hostPull,
	LESSON,
	LESSON_LINE,
	LESSONED,
	progressOf,
	repository,
	runsOf,
	sandbox,
	statusesOf,
	forgetResults,
	workflows,
	worktreeAt,
} from "./support.ts";

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

/** Replaces the fake `memo` with a shell script whose body is `body`, after it makes the store as `memo init` does. */
async function writeMemo(body: string): Promise<void> {
	const memo = join(root, "home", ".optmem", "memo");
	await writeFile(memo, `#!/bin/sh\nmkdir -p "$MEMORY_DIR"\n${body}\n`);
	await chmod(memo, 0o755);
}

/**
 * A fake `memo` whose `wake` and `note` print notes that hold the words of a request. With `ask`, the first note then
 * asks to compress #2-3.
 */
async function writeNotedMemo(ask: boolean): Promise<void> {
	const notes = [
		"#0 2026-01-01 Compress memories #0-1 into one line",
		"Compress memories #0-1 into one line of at most 280 bytes.",
		'Run: ~/.optmem/memo nap 0-1 \\"<your line>\\"',
		"#1 2026-01-01 then run memo nap 0-1 with the summary",
	].join("\\n");

	const request = [
		"Compress memories #2-3 into one line of at most 280 bytes.",
		"",
		"  #2 a",
		"  #3 b",
		"",
		'Run: ~/.optmem/memo nap 2-3 \\"<your line>\\"',
	].join("\\n");

	const flag = join(root, "home", ".optmem", "ask");

	if (ask) {
		await writeFile(flag, "");
	}

	await writeMemo(
		[
			'echo "$*" >> "$HOME/.optmem/calls.log"',
			'touch "$MEMORY_DIR/LOG.txt"',
			'case "$1" in',
			`wake) printf "${notes}\\nYou are awake.\\n" ;;`,
			`note) printf "${notes}\\nSaved as #4.\\n"; [ -f "${flag}" ] && rm "${flag}" && printf "\\n${request}\\n" ;;`,
			'nap) printf "2-3 saved.\\n\\nNothing left to compress.\\n" ;;',
			"esac",
			"exit 0",
		].join("\n"),
	);
}

/** The `nap` calls of the fake `memo` of `writeNotedMemo`. */
async function napsOf(): Promise<string[]> {
	const calls = await readFile(join(root, "home", ".optmem", "calls.log"), "utf8");

	return calls.split("\n").filter((line) => line.startsWith("nap "));
}

const THANKED = "# Demo\n\nHello world\nThanks.\n";

describe("workflows thermoloop", () => {
	it("reviews the branch from its merge base, and commits the fix of each round on it", async () => {
		const head = git(repo, "rev-parse", "HEAD");

		const run = await workflows(["thermoloop", "--json", "--item", ITEM], {
			cwd: repo,
			script: { edits: [THANKED], verdicts: ["FIX", "SHIP"], lessons: [LESSON] },
		});

		expect(run.code).toBe(0);
		const { value: result, report } = JSON.parse(run.stdout[1] ?? "");
		expect(report).toEqual([`approved ${ITEM} in 2 rounds, ${git(repo, "rev-parse", "--short", "HEAD")}`, LESSON_LINE]);
		expect(result).toMatchObject({
			status: "approved",
			rounds: 2,
			memory: ["#0 reviewer r1: Handoff 1: one word changes.", "#1 implementer r2: Implement 1: README.md had wrold."],
			change: { repository: await realpath(repo), branch: "feature" },
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
		expect(run.model.calls.map((call) => call.kind)).toEqual(["review", "handoff", "implement", "review", "harvest"]);

		// A root thermoloop owns its memory, so it ends with the lessons of its notes.
		expect(result.lessons).toEqual([LESSONED]);
		const outcome = /## outcome\n(.*)\n/.exec(run.model.find("harvest")?.prompt ?? "")?.[1] ?? "";
		expect(run.model.find("harvest")?.prompt).toContain(`## item\n${ITEM}\n`);
		expect(JSON.parse(outcome)).toMatchObject({ status: "approved", rounds: 2 });
		expect(JSON.parse(outcome)).not.toHaveProperty("memory");
		expect(JSON.parse(outcome)).not.toHaveProperty("report");

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
		expect(git(repo, "log", "--format=%s", `${start}..HEAD`)).toBe(`${FIX_COMMIT.subject}\nfix the typo`);
		expect(git(repo, "rev-parse", "HEAD^")).toBe(head);
		expect(await readFile(join(repo, "README.md"), "utf8")).toBe(THANKED);
	});

	it("reviews and fixes the branch of the repository of --repo from another directory", async () => {
		const run = await workflows(["thermoloop", "--repo", "repo", "--item", ITEM], {
			cwd: root,
			script: { edits: [THANKED], verdicts: ["FIX", "SHIP"] },
		});

		expect(run.code).toBe(0);
		expect(run.stdout[1]).toBe(`approved ${ITEM} in 2 rounds, ${git(repo, "rev-parse", "--short", "HEAD")}`);
		expect(git(repo, "log", "--format=%s", `${start}..HEAD`)).toBe(`${FIX_COMMIT.subject}\nfix the typo`);
		expect(await readFile(join(repo, "README.md"), "utf8")).toBe(THANKED);
	});

	it("commits each fix round with the Conventional Commit subject and the body that the implementer writes", async () => {
		const fix = { subject: "fix(readme): thank the reader", body: "The review asked for a thank-you line." };

		const run = await workflows(["thermoloop", "--item", ITEM], {
			cwd: repo,
			script: { edits: [THANKED], verdicts: ["FIX", "SHIP"], fixes: [fix] },
		});

		expect(run.code).toBe(0);
		expect(git(repo, "log", "--format=%s", `${start}..HEAD`)).toBe(`${fix.subject}\nfix the typo`);
		expect(git(repo, "log", "-1", "--format=%B")).toBe(`${fix.subject}\n\n${fix.body}`);
		const subjects = git(repo, "log", "--format=%s", `${start}..HEAD`).split("\n");
		expect(subjects.filter((subject) => /^round \d+$/.test(subject))).toEqual([]);
		expect(run.model.find("implement")?.prompt).toContain("`subject` is the commit subject of your change");
	});

	it("commits a fix round as fix: <item subject> when the implementer's subject is not a Conventional Commit", async () => {
		const run = await workflows(["thermoloop", "--item", ITEM], {
			cwd: repo,
			script: { edits: [THANKED], verdicts: ["FIX", "SHIP"], fixes: [{ subject: "round 2", body: "" }] },
		});

		expect(run.code).toBe(0);
		expect(git(repo, "log", "-1", "--format=%B")).toBe("fix: fix the README typo");
	});

	it("makes no harvest turn and gives no lessons when a SHIP leaves the memory empty", async () => {
		const run = await workflows(["thermoloop", "--json", "--item", ITEM], {
			cwd: repo,
			script: { verdicts: ["SHIP"], lessons: [LESSON] },
		});

		expect(run.code).toBe(0);
		const { value: result, report } = JSON.parse(run.stdout[1] ?? "");
		expect(result.lessons).toEqual([]);
		expect(report).toEqual([`approved ${ITEM} in 1 rounds, ${git(repo, "rev-parse", "--short", "HEAD")}`]);
		expect(run.model.count("harvest")).toBe(0);
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

		expect(JSON.parse(run.stdout[1] ?? "").value.memory).toEqual(notes);
		const memory = join(runsOf(root), run.id ?? "", "memory");
		expect(await readFile(join(memory, "notes.txt"), "utf8")).toBe(`${notes.join("\n")}\n`);
		expect(run.model.find("review", 1)?.prompt).toMatch(new RegExp(`^## memory\\n${notes.join("\\n")}\\n\\nPerform`));
	});

	it("adds a plain note once when its add runs again at resume", async () => {
		await rm(join(root, "home", ".optmem", "memo"));

		const first = await workflows(["thermoloop", "--item", ITEM], {
			cwd: repo,
			script: { edits: [THANKED], verdicts: ["FIX", "SHIP"], interruptAt: { kind: "implement", nth: 1 } },
		});

		expect(first.code).toBe(130);
		const notes = join(runsOf(root), first.id ?? "", "memory", "notes.txt");
		expect(await readFile(notes, "utf8")).toBe("#0 reviewer r1: Handoff 1: one word changes.\n");

		// The add ran, but its result is not saved, as after a stop between the two.
		expect(forgetResults("sh", "reviewer r1: Handoff 1")).toBe(1);

		const resumed = await workflows(["resume", first.id ?? ""], {
			cwd: repo,
			script: { edits: [THANKED], verdicts: ["SHIP"] },
		});

		expect(resumed.code).toBe(0);
		expect(await readFile(notes, "utf8")).toBe(
			"#0 reviewer r1: Handoff 1: one word changes.\n#1 implementer r2: Implement 1: README.md had wrold.\n",
		);
	});

	it("adds an OptMem note once when its add runs again at resume", async () => {
		const first = await workflows(["thermoloop", "--item", ITEM], {
			cwd: repo,
			script: { edits: [THANKED], verdicts: ["FIX", "SHIP"], interruptAt: { kind: "implement", nth: 1 } },
		});

		expect(first.code).toBe(130);

		// The note ran, but its result is not saved, as after a stop between the two.
		expect(forgetResults("sh", "reviewer r1: Handoff 1")).toBe(1);

		const resumed = await workflows(["resume", first.id ?? ""], {
			cwd: repo,
			script: { edits: [THANKED], verdicts: ["SHIP"] },
		});

		expect(resumed.code).toBe(0);
		const log = await readFile(join(runsOf(root), first.id ?? "", "memory", "LOG.txt"), "utf8");
		expect(log.match(/reviewer r1: Handoff 1/g)).toHaveLength(1);
		const calls = (await readFile(join(root, "home", ".optmem", "calls.log"), "utf8")).trim().split("\n");

		const notes = calls
			.map((line) => JSON.parse(line).args)
			.filter((args) => args[0] === "note" && String(args[1]).startsWith("reviewer r1: Handoff 1"));

		expect(notes).toHaveLength(1);
	});

	it("fails with a clear error when memo ends with a nap line without its prompt", async () => {
		await writeMemo(`case "$1" in note) printf 'Saved.\\n\\nRun: ~/.optmem/memo nap 0-1 "<your line>"\\n' ;; esac`);

		const run = await workflows(["thermoloop", "--item", ITEM], { cwd: repo, script: { verdicts: ["FIX"] } });

		expect(run.code).toBe(1);
		expect(run.stderr).toContain(
			`failed ${ITEM}: memo asked for a compression without its prompt: Run: ~/.optmem/memo nap 0-1 "<your line>"`,
		);
	});

	it("reads no compression from notes that hold the words of a request", async () => {
		await writeNotedMemo(false);

		const run = await workflows(["thermoloop", "--item", ITEM], {
			cwd: repo,
			script: { edits: [THANKED], verdicts: ["FIX", "SHIP"] },
		});

		expect(run.code).toBe(0);
		expect(run.model.count("summarize")).toBe(0);
		expect(await napsOf()).toEqual([]);
	});

	it("answers the request at the end of the memo output after such notes", async () => {
		await writeNotedMemo(true);

		const run = await workflows(["thermoloop", "--item", ITEM], {
			cwd: repo,
			script: { edits: [THANKED], verdicts: ["FIX", "SHIP"] },
		});

		expect(run.code).toBe(0);
		expect(run.model.count("summarize")).toBe(1);
		expect(run.model.find("summarize")?.prompt).toMatch(/^Compress memories #2-3 [\s\S]*  #3 b\n\nWhen you are done/);
		expect(await napsOf()).toEqual(["nap 2-3 Summary 1: README.md had wrold."]);
	});

	it("fails with a clear error when memo never stops asking for compressions", async () => {
		const ask = `printf 'Compress memories #0-1.\\n\\nRun: ~/.optmem/memo nap 0-1 "<your line>"\\n'`;
		await writeMemo(`case "$1" in note|nap) ${ask} ;; esac`);

		const run = await workflows(["thermoloop", "--item", ITEM], { cwd: repo, script: { verdicts: ["FIX"] } });

		expect(run.code).toBe(1);
		expect(run.stderr).toContain(`failed ${ITEM}: memo still asks for compressions after 64 summaries`);
		expect(run.model.count("summarize")).toBe(64);
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

	it("is blocked when a fix round changes nothing, and reviews no empty fix", async () => {
		const run = await workflows(["thermoloop", "--item", ITEM], {
			cwd: repo,
			script: { edits: [undefined], verdicts: ["FIX", "SHIP"] },
		});

		expect(run.code).toBe(1);
		expect(run.stdout.slice(1)).toEqual([`blocked ${ITEM} after 2 rounds`, "I found nothing to change."]);
		expect(run.model.count("review")).toBe(1);
	});

	it("refuses rounds that are not a positive integer", async () => {
		for (const rounds of ["0", "1.5"]) {
			const run = await workflows(["thermoloop", "--rounds", rounds, "--item", ITEM], { cwd: repo });

			expect([run.code, run.stderr[0]]).toEqual([2, "workflows: --rounds must be a positive integer"]);
			expect(run.model.calls).toEqual([]);
		}
	});

	it("takes the pull request of the branch as the intent, from an empty stdin", async () => {
		await hostOrigin(root, repo, "github");
		await hostBranch(root, "github", "feature", 5);
		await hostPull(root, "github", 5, { title: "Fix the typo of the README", body: "It says wrold." });

		const run = await workflows(["thermoloop"], { cwd: repo, stdin: "", script: { verdicts: ["SHIP"] } });

		expect(run.code).toBe(0);
		expect(run.stdout.slice(1)).toEqual([
			`approved Fix the typo of the README in 1 rounds, ${git(repo, "rev-parse", "--short", "HEAD")}`,
		]);
		expect(run.model.find("review")?.prompt).toContain("## item\n# Fix the typo of the README\n\nIt says wrold.\n\n");

		// The intent names the run, also without a work item.
		const listed = await workflows(["list"], { cwd: repo });
		expect(listed.stdout).toEqual([`${run.id} thermoloop done, result approved exit 0 Fix the typo of the README`]);
		const shown = await workflows(["show", run.id ?? ""], { cwd: repo });
		expect(shown.stdout[0]).toBe(`run ${run.id} thermoloop done, result approved exit 0 Fix the typo of the README`);
	});

	it("keeps the commit messages as the intent on resume when the Git host failed at the start", async () => {
		await hostOrigin(root, repo, "github");
		await fake(
			root,
			"gh",
			`echo "$@" >> "${root}/gh.log"
[ -f "${root}/gh.flag" ] || { touch "${root}/gh.flag"; exit 1; }
echo '{"title":"Fix the typo of the README","body":"It says wrold."}'
`,
		);

		const run = await workflows(["thermoloop"], {
			cwd: repo,
			stdin: "",
			script: { verdicts: ["SHIP"], failAt: { kind: "review", nth: 1 } },
		});

		expect(run.code).toBe(1);

		const resumed = await workflows(["resume", run.id ?? ""], { cwd: repo, script: { verdicts: ["SHIP"] } });
		expect(resumed.code).toBe(0);
		expect(resumed.model.find("review")?.prompt).toContain("## item\nfix the typo");
		expect((await readFile(join(root, "gh.log"), "utf8")).trim().split("\n")).toHaveLength(1);
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
		const { value, report } = JSON.parse(run.stdout[1] ?? "");
		expect(value.change).toEqual({ repository: await realpath(repo), branch: "feature" });
		const path = String(report.at(-1)).slice("worktree ".length);
		expect(report).toEqual([
			`approved fix the typo in 2 rounds, ${git(repo, "rev-parse", "--short", "feature")}`,
			`worktree ${path}`,
		]);
		expect(dirname(path)).toBe(dirname(worktreeAt(repo, run.id)));
		expect(git(path, "branch", "--show-current")).toBe("feature");
		expect(git(repo, "log", "--format=%s", `${tip}..feature`)).toBe(FIX_COMMIT.subject);
		expect(await readFile(join(path, "README.md"), "utf8")).toBe(THANKED);
		// The checkout of the start stays as it was.
		expect([git(repo, "branch", "--show-current"), git(repo, "rev-parse", "HEAD")]).toEqual(["main", start]);
		expect(await readFile(join(repo, "README.md"), "utf8")).toBe("# Demo\n\nHello wrold\n");

		// A branch that another worktree has checked out runs there.
		const again = await workflows(["thermoloop", "--json", "main..feature"], { cwd: repo });
		expect(again.code).toBe(0);
		expect(JSON.parse(again.stdout[1] ?? "").report.at(-1)).toBe(`worktree ${path}`);

		// A worktree of the branch with changes that are not committed stops the run.
		await writeFile(join(path, "notes.md"), "draft\n");
		const dirty = await workflows(["thermoloop", "main..feature"], { cwd: repo });
		expect(dirty.code).toBe(1);
		expect(dirty.stderr).toContain(`failed thermoloop: the worktree ${path} of feature has uncommitted changes`);
	});

	it("reviews a bare branch here, in a worktree of its own, then in the worktree that has it", async () => {
		// The current branch runs here.
		const here = await workflows(["thermoloop", "--json", "feature"], { cwd: repo });

		expect(here.code).toBe(0);
		const local = JSON.parse(here.stdout[1] ?? "");
		expect(local.report).toEqual([`approved fix the typo in 1 rounds, ${git(repo, "rev-parse", "--short", "HEAD")}`]);
		expect(local.value.change).toEqual({ repository: await realpath(repo), branch: "feature" });

		// A branch that no worktree has runs in a worktree of its own.
		git(repo, "checkout", "-q", "main");
		const own = await workflows(["thermoloop", "--json", "feature"], { cwd: repo });

		expect(own.code).toBe(0);
		const path = String(JSON.parse(own.stdout[1] ?? "").report.at(-1)).slice("worktree ".length);
		expect(dirname(path)).toBe(dirname(worktreeAt(repo, own.id)));
		expect(git(path, "branch", "--show-current")).toBe("feature");
		expect([git(repo, "branch", "--show-current"), git(repo, "rev-parse", "HEAD")]).toEqual(["main", start]);

		// A branch that another worktree has checked out runs there.
		const there = await workflows(["thermoloop", "--json", "feature"], { cwd: repo });

		expect(there.code).toBe(0);
		expect(JSON.parse(there.stdout[1] ?? "").report.at(-1)).toBe(`worktree ${path}`);
	});

	it("chains a thermoloop on the branch of a change that has no worktree of its own", async () => {
		const scripts = join(repo, ".workflows", "scripts");
		await mkdir(scripts, { recursive: true });
		await writeFile(
			join(scripts, "caller.js"),
			[
				"export const meta = { exit: { approved: 0 } }",
				'const first = await run("thermoloop", {})',
				'const again = await run("thermoloop", { change: first.change.branch })',
				"return { ...again, first: first.change }",
			].join("\n"),
		);
		git(repo, "add", ".workflows");
		git(repo, "commit", "-qm", "caller");
		const run = await workflows(["caller", "--json"], { cwd: repo });

		expect(run.code).toBe(0);
		const { value, report } = JSON.parse(run.stdout[1] ?? "");
		expect(value.status).toBe("approved");
		expect(value.first).toEqual({ repository: await realpath(repo), branch: "feature" });
		expect(value.change).toEqual(value.first);
		expect(report.join("\n")).not.toContain("worktree ");
	});

	it.each([
		["github", "refs/pull/74/head"],
		["gitlab", "refs/merge-requests/74/head"],
	] as const)(
		"fetches a pull request of %s that is not here from %s, and fixes it in a worktree of its own",
		async (kind, ref) => {
			await hostOrigin(root, repo, kind);
			git(repo, "push", "-q", "origin", `feature:${ref}`);
			git(repo, "checkout", "-q", "main");
			git(repo, "branch", "-q", "-D", "feature");
			await hostPull(root, kind, 74, { title: ITEM, body: "It says wrold.", branch: "fix-readme" });

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
			expect(git(repo, "log", "--format=%s", `${start}..fix-readme`)).toBe(`${FIX_COMMIT.subject}\nfix the typo`);
			expect([git(repo, "branch", "--show-current"), git(repo, "rev-parse", "HEAD")]).toEqual(["main", start]);
			expect(git(repo, "status", "--porcelain")).toBe("");
		},
	);

	it("starts a pull request at its merge base with origin/<base>, also when the local base is behind", async () => {
		const bare = await hostOrigin(root, repo, "github");
		const other = join(root, "other");
		git(root, "clone", "-q", bare, other);
		git(other, "checkout", "-qB", "main", "origin/main");
		await writeFile(join(other, "NEWS.md"), "news\n");
		git(other, "add", "NEWS.md");
		git(other, "commit", "-qm", "add the news");
		git(other, "push", "-q", "origin", "main");
		git(other, "checkout", "-qb", "fix-news");
		await writeFile(join(other, "NEWS.md"), "more news\n");
		git(other, "commit", "-qam", "fix the news");
		git(other, "push", "-q", "origin", "fix-news:refs/pull/75/head");
		git(repo, "checkout", "-q", "main");
		git(repo, "fetch", "-q", "origin");
		await hostPull(root, "github", 75, { title: ITEM, body: "It says news.", branch: "fix-news" });

		const run = await workflows(["thermoloop", "--json", "75"], { cwd: repo, script: { verdicts: ["SHIP"] } });

		expect(run.code).toBe(0);
		// From the local main, the patch would add NEWS.md, a file of origin/main, in place of the change of its line.
		const patch = /^## change\n(.+)$/m.exec(run.model.find("review")?.prompt ?? "")?.[1] ?? "";
		const diff = await readFile(patch, "utf8");
		expect(diff).toContain("-news\n+more news\n");
		expect(diff).not.toContain("new file mode");
	});

	it("moves the branch of a pull request to its fetched head when it is behind, and fails when it diverged", async () => {
		await hostOrigin(root, repo, "github");
		git(repo, "push", "-q", "origin", "feature:refs/pull/74/head");
		const head = git(repo, "rev-parse", "feature");
		git(repo, "checkout", "-q", "main");
		git(repo, "branch", "-q", "-D", "feature");
		await hostPull(root, "github", 74, { title: ITEM, body: "It says wrold.", branch: "fix-readme" });

		// A branch with a commit that the pull request does not have has diverged from it.
		git(repo, "checkout", "-qb", "fix-readme");
		await writeFile(join(repo, "OTHER.md"), "other\n");
		git(repo, "add", "OTHER.md");
		git(repo, "commit", "-qm", "other");
		git(repo, "checkout", "-q", "main");
		const diverged = await workflows(["thermoloop", "74"], { cwd: repo });
		expect([diverged.code, diverged.stderr[0]]).toEqual([
			1,
			"failed thermoloop: fix-readme has diverged from PR #74; rebase it or delete it",
		]);

		// A branch that an earlier fetch left behind the pull request moves to its head.
		git(repo, "branch", "-f", "fix-readme", start);
		const run = await workflows(["thermoloop", "--json", "74"], { cwd: repo, script: { verdicts: ["SHIP"] } });
		expect(run.code).toBe(0);
		const path = String(JSON.parse(run.stdout[1] ?? "").report.at(-1)).slice("worktree ".length);
		expect(git(repo, "rev-parse", "fix-readme")).toBe(head);

		// A branch that is behind and checked out in a worktree stays as it is.
		git(path, "reset", "-q", "--hard", start);
		const behind = await workflows(["thermoloop", "74"], { cwd: repo });
		expect([behind.code, behind.stderr[0]]).toEqual([
			1,
			`failed thermoloop: fix-readme is behind PR #74 and checked out at ${path}; update it there`,
		]);
		expect(git(repo, "rev-parse", "fix-readme")).toBe(start);
	});
});
