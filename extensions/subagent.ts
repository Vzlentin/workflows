/**
 * harness's `subagent` tool, `/subagent` command and widget, from the harness that workflows installs. Skipped when Pi
 * also has a separate harness package, which registers the same tool: Pi does not start with two tools of one name.
 */
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import subagent from "harness/extensions/subagent.ts";
import { separateHarness } from "../src/harness.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

export default function subagentExtension(pi: ExtensionAPI) {
	const separate = separateHarness(process.cwd(), ROOT);
	if (separate === undefined) {
		subagent(pi);
		return;
	}
	pi.on("session_start", (_event, ctx) => {
		ctx.ui.notify(
			`workflows includes harness. Remove the separate install with: pi remove ${separate.source}`,
			"warning",
		);
	});
}
