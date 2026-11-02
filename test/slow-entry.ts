/**
 * The entry of workflows whose reads of call records wait for the next turn of the event loop, as the reads of a busy
 * host do. So a call that the script makes right after another one starts before the first one is done. Vitest
 * inlines harness, so the host of a test loads this module.
 */
import { setImmediate } from "node:timers/promises";
import workflowsEntry from "../src/entry.ts";
import type { Host } from "../src/run/version.ts";

export default function slowEntry(host: Host) {
	const entry = workflowsEntry(host);

	const tasks = entry.tasks.map(({ definition }) => ({
		definition: {
			...definition,
			phases: {
				run: (...[task, runtime, context]: Parameters<typeof definition.phases.run>) => {
					const slow = new Proxy(runtime, {
						get: (target, name) => {
							// SAFETY: `name` is a member of the runtime, which the proxy gives as it is.
							const value = target[name as keyof typeof target];

							if (name !== "snapshot" || !(value instanceof Function))
								return value instanceof Function ? value.bind(target) : value;

							return async (...args: Parameters<typeof target.snapshot>) => {
								await setImmediate();

								return target.snapshot(...args);
							};
						},
					});

					return definition.phases.run(task, slow, context);
				},
			},
		},
	}));

	return { ...entry, tasks };
}
