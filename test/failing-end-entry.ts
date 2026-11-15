/**
 * The entry of workflows with an end that does not commit: once `failEnd.armed` is set, the next commit that ends a
 * task runs its change and then throws, so pi-durable drops all that the change wrote. Vitest inlines harness, so the
 * host of a test loads this module, and the test arms it here.
 */
import type { Context } from "@earendil-works/chord/context";
import workflowsEntry from "../src/entry.ts";
import type { Host, Runtime } from "../src/run/version.ts";

/** Whether the next end commit of a task throws. */
type Fail = { armed: boolean };

export const failEnd: Fail = { armed: false };

/** `runtime`, whose next end commit throws once `failEnd` is armed. */
function failing(runtime: Runtime): Runtime {
	const commit: Runtime["commit"] = (change, context: Context, options) =>
		runtime.commit(
			async (tx, current) => {
				const result = await change(tx, current);

				if (failEnd.armed && result?.status === "terminal") {
					failEnd.armed = false;
					throw new Error("the end did not commit");
				}

				return result;
			},
			context,
			options,
		);

	return new Proxy(runtime, {
		get: (target, name) => {
			if (name === "commit") return commit;
			// SAFETY: `name` is a member of `runtime`, which the proxy gives as it is.
			const value = target[name as keyof Runtime];

			return value instanceof Function ? value.bind(target) : value;
		},
	});
}

export default function failingEndEntry(host: Host) {
	const entry = workflowsEntry(host);

	const tasks = entry.tasks.map(({ definition }) => ({
		definition: {
			...definition,
			phases: {
				run: (...[task, runtime, context]: Parameters<typeof definition.phases.run>) =>
					definition.phases.run(task, failing(runtime), context),
			},
		},
	}));

	return { ...entry, tasks };
}
