/**
 * harness's `subagent` tool, `/subagent` command and widget, from the harness that workflows installs. Skipped when Pi
 * also loads a separate harness package, which registers the same tool: Pi does not start with two tools of one name.
 */
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import subagent from "harness/extensions/subagent.ts";
import { removeCommand, separateHarness } from "../src/harness.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

export default async function subagentExtension(pi: ExtensionAPI) {
	const separate = await separateHarness(process.cwd(), ROOT);
	if (separate === undefined) {
		subagent(pi);
		return;
	}
	pi.on("session_start", (_event, ctx) => {
		// A project package loads only in a trusted project, so an untrusted one has no subagent tool at all.
		const off =
			separate.scope === "project" && !ctx.isProjectTrusted() ? " The subagent tool is off in this session." : "";
		ctx.ui.notify(
			`workflows includes harness. Remove the separate install with: ${removeCommand(separate)}.${off}`,
			"warning",
		);
	});
}
