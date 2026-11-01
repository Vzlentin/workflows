/**
 * The sessions of a run: children of harness's children library, owned by the run's task, which the `session` and
 * `ask` calls open and use, and which the end of the run ends.
 */
import type { Context, JsonValue } from "@earendil-works/chord";
import { AgentDoc, type ConversationId, defineDocFamily, type JsonObject } from "@earendil-works/pi-durable";
import type { Failure, Owner, Spec } from "@vzlentin/harness/children";
import { type Static, Type } from "typebox";
import type { ScriptInput } from "../launch/input.ts";
import type { Writable } from "../workflow/bundle.ts";
import { CallDoc, type Calls } from "./calls.ts";
import type { Host, Runtime } from "./version.ts";

/** The extension of the `workflow` tool, which the entry gives every conversation of the host but the sessions. */
export const TOOL_EXTENSION = "workflows";

/**
 * One session of a run: its run ID, its conversation, the task that opened it, and `label`, the name of the agent profile
 * that opened it. A record that an earlier version saved can have no `label`.
 */
export type OpenedSession = { run: string; conversation: ConversationId; task: number; label?: string };

/**
 * The sessions of a root run and its child runs, keyed by the root run ID, so the end of a run closes them, also those
 * of an earlier task of the run.
 */
export const SessionsDoc = defineDocFamily<{ sessions: OpenedSession[] }, null>({
	kind: "workflows.sessions",
	version: 1,
	scope: "session",
	family: true,
	checkpointWhen: () => false,
	initial: () => ({ sessions: [] }),
});

/** The args of a `session` call: the profile, and the fields that override it. */
export const SESSION_ARGS = Type.Object({
	profile: Type.String(),
	provider: Type.Optional(Type.String()),
	model: Type.Optional(Type.String()),
	thinking: Type.Optional(Type.String()),
});

type SessionArgs = Readonly<Static<typeof SESSION_ARGS>>;

/**
 * Where the sessions of the run sit in the children tree: under the conversation that started the run, when it is the
 * project agent or a conversation of the children library, else in the tree `workflows:<root run ID>`.
 */
async function treeOf(calls: Calls): Promise<{ parent: string } | { root: string }> {
	const { runtime, context, host, script } = calls;
	const { session } = script;

	if (session === undefined) return { root: `workflows:${script.root}` };

	if (session === String(runtime.conversationId)) return { parent: session };
	const lineage = await host.children.lineage(host.place.store, session, context);

	return lineage === undefined ? { root: `workflows:${script.root}` } : { parent: session };
}

/**
 * The session of the call `key`, opened in the children library under the key `wf:<key>` in `cwd`. Each field of
 * `args` overrides the profile, and the profile fills the rest; a field that neither gives comes from the project
 * agent. The session does not get the `workflow` tool. The commit that opens it saves its conversation in the call
 * record and in the sessions of the run. The same key again gives the same session.
 */
export async function sessionOf(calls: Calls, key: string, cwd: string, args: SessionArgs): Promise<JsonValue> {
	const { runtime, context, host, script } = calls;
	const profile = script.bundle.agents[args.profile];

	if (profile === undefined) throw new Error(`no agent profile ${args.profile}`);
	const provider = args.provider ?? profile.model?.provider;
	const model = args.model ?? profile.model?.modelId;
	const thinking = args.thinking ?? profile.thinking;

	const spec: Writable<Spec> = { ...(await treeOf(calls)), cwd };

	if (provider !== undefined) spec.provider = provider;

	if (model !== undefined) spec.model = model;

	if (thinking !== undefined) spec.thinking = thinking;

	if (profile.instructions !== "") spec.instructions = profile.instructions;

	if (script.overlay !== undefined) spec.overlay = script.overlay;

	const child = await host.children.open(
		host.place,
		calls.owner,
		`wf:${key}`,
		spec,
		context,
		async (tx, conversation) => {
			// The library has set the object form of the selection, which adds its answer extension to the host default.
			const agent = await tx.doc(AgentDoc, conversation);
			const selection = agent.extensions;

			if (!Array.isArray(selection)) {
				agent.extensions = { ...selection, remove: [...(selection?.remove ?? []), TOOL_EXTENSION] };
			}

			(await tx.doc(CallDoc, key, null)).conversation = conversation;
			const opened = await tx.doc(SessionsDoc, script.root, null);
			const record: OpenedSession = { run: script.runId, conversation, task: runtime.taskId };

			if (args.profile !== "") record.label = args.profile;
			opened.sessions.push(record);
		},
	);

	return child.id;
}

/**
 * One turn in the session `conversation`. The call's key is the request ID, so an interrupted ask continues its turn,
 * and the library sends a failed one again as `<key>#2`, `#3`. A turn without an answer that counts throws.
 */
export async function askTurn(
	calls: Calls,
	key: string,
	conversation: number,
	prompt: string,
	schema: JsonObject | null,
): Promise<JsonValue> {
	const { host, context } = calls;
	const child = await host.children.find(host.place, calls.owner, { id: String(conversation) }, context);

	if (child === undefined) throw new Error(`Session ${conversation} is missing`);
	const input = { type: "input", content: prompt, requestId: key } as const;

	if (schema !== null) {
		const answer = await child.ask(input, context, { schema });

		if (answer.status === "ok") return answer.value;

		return failed(key, answer);
	}

	const answer = await child.ask(input, context);

	return answer.status === "ok" ? answer.text : failed(key, answer);
}

/** Throws the error of the turn `key` whose answer does not count. */
function failed(key: string, answer: Failure): never {
	if (answer.reason === "cut") throw new Error(`The ${key} turn stopped: ${answer.stopReason}`);

	if (answer.reason === "no-respond") throw new Error("the answer did not call respond");
	const detail = answer.detail === undefined ? "" : ` ${JSON.stringify(answer.detail)}`;
	throw new Error(`The ${key} turn was not answered: ${answer.cause}${detail}`);
}

/** The owner of the sessions of the run `runId`, whose task `runtime` runs. */
export function ownerOf(runtime: Runtime, runId: string): Owner {
	return { kind: "task", taskId: runtime.taskId, conversation: runtime.conversationId, group: runId };
}

/**
 * Ends the sessions of the run `input`. After a completed root run, it closes the sessions of the run and of its child
 * runs, also of a failed child run that the script caught, with everything under them. After a completed child run, it
 * closes the sessions of that run. After a failed or aborted run, it closes only what is under the sessions of the run,
 * such as their subagents, and keeps them for a resume. The store aborts the turns of the sessions that this task owns,
 * but not of those that an earlier task of the run opened, so it aborts those itself.
 */
export async function endSessions(
	host: Host,
	runtime: Runtime,
	input: ScriptInput,
	completed: boolean,
	context: Context,
): Promise<void> {
	const { children, place } = host;
	const { runId, root } = input;
	const all = completed && runId === root;

	for (const { run, conversation, task } of (await runtime.snapshot(SessionsDoc, root, context))?.sessions ?? []) {
		if (!all && run !== runId) continue;
		const child = await children.find(place, ownerOf(runtime, run), { id: String(conversation) }, context);

		if (child === undefined) continue;

		if (completed) {
			await child.close(context);
			continue;
		}

		await child.close(context, { below: true });

		if (task !== runtime.taskId) await child.conversation.abort(context, { background: true });
	}
}
