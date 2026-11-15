import { execFile } from "node:child_process";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vite-plus/test";
import { git, repository, restoreEnvironment, sandbox } from "./support.ts";

const run = promisify(execFile);

/** Set in the child test run: the folder where its test makes a repository. */
const MARKER = "WORKFLOWS_TEST_REPOSITORY";
const target = process.env[MARKER];
const caller = { ...process.env };

const records = (path: string) => ({
	refs: git(path, "for-each-ref"),
	head: git(path, "rev-parse", "HEAD"),
	bare: git(path, "config", "--get", "core.bare"),
	status: git(path, "status", "--porcelain"),
});

if (target === undefined) {
	it("keeps the Git of the tests out of the repository that GIT_DIR of the caller names", async () => {
		const root = await sandbox();

		try {
			const first = join(root, "first");
			const second = join(root, "second");
			await repository(second);
			const before = records(second);
			const repo = join(import.meta.dirname, "..");
			const vp = join(repo, "node_modules", "vite-plus", "bin", "vp");

			await run(process.execPath, [vp, "test", "run", "test/git-environment.test.ts"], {
				cwd: repo,
				env: { ...caller, GIT_DIR: join(second, ".git"), GIT_WORK_TREE: second, [MARKER]: first },
			});

			expect(records(second)).toEqual(before);
			expect(git(first, "log", "-1", "--format=%s")).toBe("initial");
		} finally {
			restoreEnvironment();
			await rm(root, { recursive: true, force: true });
		}
	}, 120_000);
} else {
	it("makes a commit in its own repository", async () => {
		const root = await sandbox();

		try {
			await repository(target);
		} finally {
			restoreEnvironment();
			await rm(root, { recursive: true, force: true });
		}
	});
}
