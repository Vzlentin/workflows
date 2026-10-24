/**
 * The entry of workflows with a stop: once `stopAfterPost.host` is set, the next post of a run's outcome closes that
 * host, and returns after the close aborted the task, before the task commits its end. Vitest inlines harness, so the
 * host of a test loads this module, and the test sets the host here.
 */
import { once } from "node:events";
import type { Context } from "@earendil-works/chord";
import type { ConversationHandle } from "@earendil-works/pi-durable";
import type { Host as HarnessHost } from "@vzlentin/harness/host";
import workflowsEntry from "../src/entry.ts";
import type { Host } from "../src/script.ts";
import type { Runtime } from "../src/task.ts";

type ConversationId = ConversationHandle["id"];

/** The host that the next post of an outcome closes. */
type Stop = { host: HarnessHost | undefined };

export const stopAfterPost: Stop = { host: undefined };

/** `target`, with `method` as its `key`, and its other members bound to `target`. */
function withMethod<T extends object, K extends keyof T>(target: T, key: K, method: T[K]): T {
	return new Proxy(target, {
		get: (_proxy, name) => {
			if (name === key) return method;
			// SAFETY: `name` is a member of `target`, which the proxy gives as it is.
			const value = target[name as keyof T];

			return value instanceof Function ? value.bind(target) : value;
		},
	});
}

/** Closes the host of `stopAfterPost` once, and waits until the close aborts `signal`. */
async function stop(signal: AbortSignal): Promise<void> {
	const { host } = stopAfterPost;

	if (host === undefined) return;
	stopAfterPost.host = undefined;
	// The close aborts the task and then waits for it, so this waits for the abort and not for the close.
	void host.close();

	if (!signal.aborted) await once(signal, "abort");
}

/** The conversation `id` of `runtime`, whose `submit` stops the host after the submission. */
async function conversationOf(runtime: Runtime, id: ConversationId, context: Context) {
	const handle = await runtime.conversation(id, context);

	if (handle === undefined) return undefined;

	return withMethod(handle, "submit", async (submission, at) => {
		const submitted = await handle.submit(submission, at);
		await stop(runtime.signal);

		return submitted;
	});
}

export default function stopEntry(host: Host) {
	const entry = workflowsEntry(host);

	const tasks = entry.tasks.map(({ definition }) => ({
		definition: {
			...definition,
			phases: {
				run: (...[task, runtime, context]: Parameters<typeof definition.phases.run>) =>
					definition.phases.run(
						task,
						withMethod(runtime, "conversation", (id: ConversationId, at: Context) => conversationOf(runtime, id, at)),
						context,
					),
			},
		},
	}));

	return { ...entry, tasks };
}
