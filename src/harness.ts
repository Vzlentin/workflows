/**
 * harness comes with workflows as a dependency. A separate Pi install of harness gives Pi a second `subagent` tool,
 * and Pi refuses to start with two tools of one name.
 */
import { readFileSync, realpathSync } from "node:fs";
import { basename, join, sep } from "node:path";
import { DefaultPackageManager, getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";

export type SeparateHarness = { readonly source: string; readonly scope: "user" | "project" | "temporary" };

function real(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}

function nameOf(dir: string): string | undefined {
	try {
		return (JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { name?: string }).name;
	} catch {
		return undefined;
	}
}

/**
 * The harness package other than the one under `root` whose `subagent` extension Pi loads in `cwd`, as Pi resolves it:
 * after package scope and resource filters, and after project trust when `settings` gives it. Without `settings`, the
 * project counts as trusted: a Pi session can trust a project for itself or with `--approve`, which the saved trust
 * does not show, and two `subagent` tools stop Pi. Missing packages are skipped, not installed.
 */
export async function separateHarness(
	cwd: string,
	root: string,
	settings?: SettingsManager,
): Promise<SeparateHarness | undefined> {
	const agentDir = getAgentDir();
	const settingsManager = settings ?? SettingsManager.create(cwd, agentDir, { projectTrusted: true });
	const resolved = await new DefaultPackageManager({ cwd, agentDir, settingsManager }).resolve(async () => "skip");
	const own = real(root);
	for (const extension of resolved.extensions) {
		const packageRoot = extension.metadata.packageRoot;
		if (!extension.enabled || packageRoot === undefined || basename(extension.path) !== "subagent.ts") continue;
		const dir = real(packageRoot);
		if (dir === own || dir.startsWith(own + sep) || nameOf(dir) !== "harness") continue;
		return { source: extension.metadata.source, scope: extension.metadata.scope };
	}
	return undefined;
}

/** The command that removes `separate` from Pi. */
export function removeCommand(separate: SeparateHarness): string {
	return `pi remove ${separate.source}${separate.scope === "project" ? " -l" : ""}`;
}
