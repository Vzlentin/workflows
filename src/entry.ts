/**
 * The entry of workflows in the harness host. The host of a project loads it, from harness's `entries.json`, and starts its script task for
 * `workflows <wf>`, so a run executes in the host, with its sessions on the host's children library.
 */
import type { Children, Place } from "@vzlentin/harness/children";
import { scriptTask } from "./task.ts";

export default function workflowsEntry({ children, place }: { readonly children: Children; readonly place: Place }) {
	return { extensions: [], tasks: [scriptTask({ children, place })], close: async () => {} };
}
