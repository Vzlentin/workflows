/**
 * The `piDurable` entry of workflows. The harness host of a project loads it and starts its script task for
 * `workflows <wf>`, so a run executes in the host, with its sessions on the host's children library.
 */
import type { Children, Place } from "harness/src/children.ts";
import { scriptTask } from "./task.ts";

export default function workflowsEntry({ children, place }: { readonly children: Children; readonly place: Place }) {
	return { extensions: [], tasks: [scriptTask({ children, place })], close: async () => {} };
}
