/**
 * The entry of workflows with a stop: once `abortFix.armed` is set, the next child run `implement` of a fix round ends
 * as aborted before it runs, as a stop of that child run does. Vitest inlines harness, so the host of a test loads this
 * module, and the test arms it here.
 */
import workflowsEntry from "../src/entry.ts";
import type { Host } from "../src/run/version.ts";

/** Whether the next `implement` of a fix round ends as aborted. */
type Abort = { armed: boolean };

export const abortFix: Abort = { armed: false };

export default function abortEntry(host: Host) {
	const entry = workflowsEntry(host);

	const tasks = entry.tasks.map(({ definition }) => ({
		definition: {
			...definition,
			phases: {
				run: (...[task, runtime, context]: Parameters<typeof definition.phases.run>) => {
					const { name, args } = task.input;

					if (!abortFix.armed || name !== "implement" || !String(args.message).startsWith("fix: ")) {
						return definition.phases.run(task, runtime, context);
					}

					abortFix.armed = false;

					return runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context);
				},
			},
		},
	}));

	return { ...entry, tasks };
}
