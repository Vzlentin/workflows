/**
 * The entry of workflows whose children library fails the second `find` of each host: the one that ends the session of
 * a script with one ask. Vitest inlines harness, so the host of a test loads this module.
 */
import workflowsEntry from "../src/entry.ts";
import type { Host } from "../src/run/version.ts";

export default function sessionsEntry(host: Host) {
	let finds = 0;

	const children = new Proxy(host.children, {
		get: (target, name) => {
			// SAFETY: `name` is a member of the library, which the proxy gives as it is.
			const value = target[name as keyof typeof target];

			if (name !== "find" || !(value instanceof Function))
				return value instanceof Function ? value.bind(target) : value;

			return (...args: Parameters<typeof target.find>) => {
				finds++;

				if (finds === 2) return Promise.reject(new Error("the library failed to find the session"));

				return target.find(...args);
			};
		},
	});

	return workflowsEntry({ ...host, children });
}
