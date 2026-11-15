/**
 * The asks of the `input` calls of a run: the questions that a root run puts to the user, in the store of the host of
 * its project, through the `ask` requests of harness. The run is the asker, and the answer of the ask is the answer of
 * the call.
 */
import { request } from "@vzlentin/harness/client";
import { Ask, AskList, AskWrite, type Replies, type Request } from "@vzlentin/harness/protocol";
import type { Static, TSchema } from "typebox";
import { Value } from "typebox/value";

/** An `ask` request. */
type AskRequest = Extract<Request, { type: "ask" }>;

/** What sends the `ask` requests to the host of the project of the run, and gives the reply. */
export type Asks = (request: AskRequest) => Promise<Replies["ask"]>;

/** The asker of the asks of the run `runId`. It is not a conversation, so harness pushes its answers to no one. */
export function askerOf(runId: string): string {
	return `workflows:${runId}`;
}

/**
 * `text` as plain text, which an ask title or label must be: without backticks, and with one `*` for each run of `*`. The
 * title of the ask of a question is the question as plain text, and a blank title fails the `input` call.
 */
export function plainText(text: string): string {
	return text.replaceAll("`", "").replace(/\*{2,}/g, "*");
}

/** The value of the answer of `ask` for the `input` call: the words of the user, one on each line, or the label. */
export function answerOf(ask: Extract<Ask, { state: "answered" }>): string {
	return ask.words?.join("\n") ?? ask.label ?? ask.answer;
}

/** The label of an answer of `text`: its first line that is not blank, as plain text. */
function labelOf(text: string): string {
	const line = text
		.split("\n")
		.map((part) => plainText(part).trim())
		.find((part) => part !== "");

	return line ?? "answer";
}

/** The reply of `asks` to `sent`, checked with `schema`. */
async function ask<T extends TSchema>(asks: Asks, sent: AskRequest, schema: T): Promise<Static<T>> {
	const reply = await asks(sent);

	if (!Value.Check(schema, reply)) throw new Error(`the harness host gave a bad reply to ask ${sent.action}`);

	return reply;
}

/** The ask `id`, in any state. */
export function readAsk(asks: Asks, id: number): Promise<Ask> {
	return ask(asks, { type: "ask", action: "read", id }, Ask);
}

/** The open ask of the run `runId` with the title of `question`, if there is one. */
export async function openAsk(asks: Asks, runId: string, question: string): Promise<Ask | undefined> {
	const listed = await ask(asks, { type: "ask", action: "list" }, AskList);
	const asker = askerOf(runId);
	const title = plainText(question);

	return listed.asks.find((found) => found.asker === asker && found.title === title && found.parley === undefined);
}

/** A new open ask of the run `runId` with `question`. `view` keeps the question when its title differs. */
export async function newAsk(asks: Asks, runId: string, question: string): Promise<Ask> {
	const title = plainText(question);
	const input = title === question ? { title } : { title, view: question };
	const caller = askerOf(runId);
	const write = await ask(asks, { type: "ask", action: "round", caller, asks: [input] }, AskWrite);
	const [written] = write.asks;

	if (written === undefined) throw new Error("the harness host wrote no ask");

	return written;
}

/**
 * Answers the ask `id` of the run `runId` with `text`, as the run: an answer `own` with the words `text`. The asker is
 * the caller, so harness queues no delivery of the answer.
 */
export async function answerAsk(asks: Asks, runId: string, id: number, text: string): Promise<void> {
	const answers = [{ id, answer: "own" as const, label: labelOf(text), words: [text] }];
	await ask(asks, { type: "ask", action: "answer", caller: askerOf(runId), answers }, AskWrite);
}

/**
 * The `ask` requests to the host of `project` that runs, the host of the task, each on its own connection. When
 * `signal` aborts, a request rejects with its reason.
 */
export function asksOf(project: string, signal: AbortSignal | undefined): Asks {
	return async (sent) => {
		const reply = await request(sent, { project, start: false, signal });

		if (reply === undefined) throw new Error(`no harness host runs for ${project}`);

		return reply;
	};
}
