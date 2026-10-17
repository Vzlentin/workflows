/**
 * harness comes with workflows as a dependency. A separate Pi install of harness gives Pi a second `subagent` tool,
 * and Pi refuses to start with two tools of one name.
 */
import { readFileSync, realpathSync } from "node:fs";
import { join, sep } from "node:path";
import { DefaultPackageManager, getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";

/** A Pi package named `harness` in Pi's settings for `cwd`, other than the one under `root`. */
export function separateHarness(
	cwd: string,
	root: string,
): { readonly source: string; readonly dir: string } | undefined {
	const agentDir = getAgentDir();
	const settingsManager = SettingsManager.create(cwd, agentDir);
	const own = realpathSync(root);
	for (const found of new DefaultPackageManager({ cwd, agentDir, settingsManager }).listConfiguredPackages()) {
		if (found.installedPath === undefined) continue;
		let name: string | undefined;
		let dir: string;
		try {
			dir = realpathSync(found.installedPath);
			name = (JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { name?: string }).name;
		} catch {
			continue;
		}
		if (name === "harness" && dir !== own && !dir.startsWith(own + sep)) return { source: found.source, dir };
	}
	return undefined;
}
