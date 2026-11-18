/**
 * The sessions of a run: children of harness's children library, owned by the run's task, which the `session` and
 * `ask` calls open, move to the model of their role before a turn, and use, and which the end of the run ends.
 */
import type { Context } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord/json";
import {
	AgentDoc,
	configure,
	type ConversationId,
	defineDocFamily,
	type JsonObject,
	type ModelRef,
} from "@earendil-works/pi-durable";
import { type Child, type Failure, type Owner, resolveModel, type Spec } from "@vzlentin/harness/children";
import { PROJECT_EXTENSION } from "@vzlentin/harness/protocol";
import type { Static } from "typebox";
import type { ScriptInput } from "../launch/input.ts";
import { ENTRY_NAME } from "../tool.ts";
import type { Writable } from "../workflow/bundle.ts";
import { type Roles, roleOf } from "../workflow/roles.ts";
import { CallDoc, type Calls, callOfKind, type SESSION_ARGS, type SESSION_MODEL } from "./calls.ts";
import type { Host, Runtime } from "./version.ts";

/**
 * One session of a run: its run ID, its conversation, the task that opened it, and `label`, the role name that opened
 * it. A record that an earlier version saved can have no `label`.
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

/** The instructions of every session. */
export const INSTRUCTIONS = "You are a session of a workflows run, not the user's main agent.";

type SessionArgs = Readonly<Static<typeof SESSION_ARGS>>;

/** The prefix of the key of a session in the children library: `wf:<key>`, with the key of its `session` call. */
const SESSION_PREFIX = "wf:";

/**
 * The key of the `session` call that opened `child`. Throws when the key of `child` in the children library is not
 * `wf:<key>`.
 */
function sessionCallKey(child: Child): string {
	const { key } = child.lineage;

	if (!key.startsWith(SESSION_PREFIX)) throw new Error(`session ${child.id} was not opened by a session call`);

	return key.slice(SESSION_PREFIX.length);
}

/** The `model` of a `session` call record: the provider and model ID of `model`, and `thinking` when it is defined. */
function recordedModel({ provider, modelId }: ModelRef, thinking: string | undefined): Static<typeof SESSION_MODEL> {
	return thinking === undefined ? { provider, model: modelId } : { provider, model: modelId, thinking };
}

/**
 * The model fields of the session of `args`: each field of `args` over the role of `args.profile` in `table`. A field
 * that neither gives is undefined.
 */
function roleFields(table: Roles, args: SessionArgs) {
	const role = roleOf(table, args.profile);

	return {
		provider: args.provider ?? role.model?.provider,
		model: args.model ?? role.model?.modelId,
		thinking: args.thinking ?? role.thinking,
	};
}

/**
 * Where the sessions of the run sit in the children tree: under the driver of the current task, when it is the project
 * agent or a conversation of the children library, else in the tree `workflows:<root run ID>`.
 */
async function treeOf(calls: Calls): Promise<{ parent: string } | { root: string }> {
	const { runtime, context, host, script } = calls;
	const { driver } = script;

	if (driver === undefined) return { root: `workflows:${script.root}` };

	if (driver === String(runtime.conversationId)) return { parent: driver };
	const lineage = await host.children.lineage(host.place.store, driver, context);

	return lineage === undefined ? { root: `workflows:${script.root}` } : { parent: driver };
}

/**
 * The session of the call `key`, opened in the children library under the key `wf:<key>` in `cwd`, with
 * `INSTRUCTIONS`. Its model fields are those of `roleFields` with the agents table of the bundle; a field that neither
 * gives comes from the project agent. The session does not get the `workflow` tool, nor harness's store tools
 * `thread`, `rule` and `parley`. The commit that opens it saves its conversation and the model that the library set in
 * the call record, and its conversation in the sessions of the run. The same key again gives the same session.
 */
export async function sessionOf(calls: Calls, key: string, cwd: string, args: SessionArgs): Promise<JsonValue> {
	const { runtime, context, host, script } = calls;
	const { provider, model, thinking } = roleFields(script.bundle.agents, args);

	const spec: Writable<Spec> = { ...(await treeOf(calls)), cwd, instructions: INSTRUCTIONS };

	if (provider !== undefined) spec.provider = provider;

	if (model !== undefined) spec.model = model;

	if (thinking !== undefined) spec.thinking = thinking;

	if (script.overlay !== undefined) spec.overlay = script.overlay;

	const child = await host.children.open(
		host.place,
		calls.owner,
		`${SESSION_PREFIX}${key}`,
		spec,
		context,
		async (tx, conversation) => {
			// The library has set the object form of the selection, which adds its answer extension to the host default.
			const agent = await tx.doc(AgentDoc, conversation);
			const selection = agent.extensions;

			if (!Array.isArray(selection)) {
				agent.extensions = { ...selection, remove: [...(selection?.remove ?? []), ENTRY_NAME, PROJECT_EXTENSION] };
			}

			const call = callOfKind(await tx.doc(CallDoc, key, null), "session", key);
			call.conversation = conversation;

			if (agent.model !== undefined) call.model = recordedModel(agent.model, agent.thinkingLevel);

			const opened = await tx.doc(SessionsDoc, script.root, null);
			const record: OpenedSession = { run: script.runId, conversation, task: runtime.taskId };

			if (args.profile !== "") record.label = args.profile;
			opened.sessions.push(record);
		},
	);

	return child.id;
}

/**
 * One turn in the session `conversation`, after `moveToRole`. The call's key is the request ID, so an interrupted ask
 * continues its turn, and the library sends a failed one again as `<key>#2`, `#3`. A turn without an answer that counts
 * throws.
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
	await moveToRole(calls, child);
	const input = { type: "input", content: prompt, requestId: key } as const;

	if (schema !== null) {
		const answer = await child.ask(input, context, { schema });

		if (answer.status === "ok") return answer.value;

		return failed(key, answer);
	}

	const answer = await child.ask(input, context);

	return answer.status === "ok" ? answer.text : failed(key, answer);
}

/**
 * Moves the session `child` to the model and thinking level of its role, as `resolveModel` of harness gives them: the
 * fields of `roleFields` with the args of its `session` call, which `sessionCallKey` names, and the agents table of the
 * current task, and the agent of the session for a field that neither gives. When the model or the thinking level
 * differs, one commit configures the agent of the session and sets the `model` of the call record. Throws when the
 * session has no `session` call record, and harness's error for an unknown model or a thinking level that the model
 * does not have.
 */
async function moveToRole(calls: Calls, child: Child): Promise<void> {
	const { runtime, context, host, script } = calls;
	const key = sessionCallKey(child);
	const record = await runtime.snapshot(CallDoc, key, context);

	if (record === undefined) throw new Error(`the session call ${key} of session ${child.id} is missing`);
	const { args } = callOfKind(record, "session", key);
	const agent = await child.conversation.agent(context);
	const { model, thinkingLevel } = resolveModel(host.place.models, agent, roleFields(script.bundle.agents, args));
	const same = model.provider === agent.model?.provider && model.modelId === agent.model.modelId;

	if (same && thinkingLevel === agent.thinkingLevel) return;
	await runtime.commit(async (tx) => {
		await configure(tx, child.id, { model, thinkingLevel });
		const call = callOfKind(await tx.doc(CallDoc, key, null), "session", key);
		call.model = recordedModel(model, thinkingLevel);

		return undefined;
	}, context);
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
