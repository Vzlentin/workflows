/**
 * The entry of workflows with a stop: once `stopAfterPost.host` is set, the next post of a run's outcome closes that
 * host, and returns after the close aborted the task, before the task commits its end. Vitest inlines harness, so the
 * host of a test loads this module, and the test sets the host here.
 */
import { once } from "node:events";
import type { Context } from "@earendil-works/chord";
import type { ConversationHandle, Submission, SubmissionDraft, SubmissionId, Tx } from "@earendil-works/pi-durable";
import type { Host as HarnessHost } from "@vzlentin/harness/host";
import workflowsEntry from "../src/entry.ts";
import type { Host, Runtime } from "../src/run/version.ts";

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

/**
 * `handle.submit`, which stops the host after a submission with a context. A submission inside a commit `tx` goes to
 * `handle` as it is.
 */
function stoppingSubmit(handle: ConversationHandle, signal: AbortSignal): ConversationHandle["submit"] {
	function submit(submission: SubmissionDraft, at: Context): Promise<Submission>;
	function submit(tx: Tx, submission: SubmissionDraft): Promise<SubmissionId>;
	async function submit(first: SubmissionDraft | Tx, second: Context | SubmissionDraft) {
		if (!("type" in first)) {
			// SAFETY: the overloads pair a `Tx`, which has no `type`, with a draft.
			return handle.submit(first, second as SubmissionDraft);
		}

		// SAFETY: the overloads pair a draft, which has a `type`, with a context.
		const submitted = await handle.submit(first, second as Context);
		await stop(signal);

		return submitted;
	}

	return submit;
}

/** The conversation `id` of `runtime`, whose `submit` stops the host after the submission. */
async function conversationOf(runtime: Runtime, id: ConversationId, context: Context) {
	const handle = await runtime.conversation(id, context);

	if (handle === undefined) return undefined;

	return withMethod(handle, "submit", stoppingSubmit(handle, runtime.signal));
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
