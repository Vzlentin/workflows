/**
 * What a run serves: the item or the parley that its start named, which the host of its project keeps. A root task
 * checks it when it starts, and links the run to the item, through the requests of harness to that host. It owns the
 * requests of a run to that host and their schema, and the close of the item when the work of a run lands, which
 * `land` and `sweep` share.
 */
import type { JsonValue } from "@earendil-works/chord/json";
import { request } from "@vzlentin/harness/client";
import {
	EdgeInput,
	ItemState,
	type Replies,
	type ServesInput,
	StagedItem,
	TreeReply,
} from "@vzlentin/harness/protocol";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { askerOf } from "./asks.ts";

const PARLEY = Type.Object({ parley: Type.Object({ slug: Type.String(), status: Type.String() }) });

/** `reply`, the reply of the host of `project`, which is undefined when no host runs. */
export function hostReply<T>(project: string, reply: T | undefined): T {
	if (reply === undefined) throw new Error(`no harness host runs for ${project}`);

	return reply;
}

/**
 * The args of a `harness` call: one request to the host of the run's project, `item read`, `item link`, `item set` with
 * a state, or `tree`. The call adds the caller of a `link` and a `set`.
 */
export const HARNESS_ARGS = Type.Union([
	Type.Object(
		{ type: Type.Literal("item"), action: Type.Literal("read"), id: Type.Integer({ minimum: 1 }) },
		{ additionalProperties: false },
	),
	Type.Object(
		{ type: Type.Literal("item"), action: Type.Literal("link"), ...EdgeInput.properties },
		{ additionalProperties: false },
	),
	Type.Object(
		{ type: Type.Literal("item"), action: Type.Literal("set"), id: Type.Integer({ minimum: 1 }), state: ItemState },
		{ additionalProperties: false },
	),
	Type.Object({ type: Type.Literal("tree") }, { additionalProperties: false }),
]);

/** The args of a `harness` call. */
export type HarnessArgs = Readonly<Static<typeof HARNESS_ARGS>>;

/**
 * Sends the request `sent` of the run `runId` to the host of `project`, which it never starts, and returns its reply.
 * The run is the caller of a `link` and a `set`. It throws when no host runs, and for an error of the host.
 */
export async function runRequest(
	project: string,
	runId: string,
	sent: HarnessArgs,
	signal?: AbortSignal,
): Promise<Replies["item"] | Replies["tree"]> {
	const options = { project, start: false, signal };

	const withCaller = sent.type === "tree" || sent.action === "read" ? sent : { ...sent, caller: askerOf(runId) };

	return hostReply(project, await request(withCaller, options));
}

/** What `closeItem` did: the state of the item after it, and the line of the report. */
export type Closed = { readonly state: "done" | "open"; readonly line: string };

/**
 * Links the item `item` to the commit `head` with a `landed` edge, and sets it to `done` when no live agent serves it,
 * through `send`, which sends one request to the host and returns its reply. Returns the state of the item after it,
 * with the line of the report: `item <n> done`, or `item <n> stays open: <name> serves it`. Never sets an item to
 * `open`. The host writes the same edge only once, so a second close of the same item does no harm.
 */
export async function closeItem(
	send: (request: HarnessArgs) => Promise<JsonValue>,
	item: number,
	head: string,
): Promise<Closed> {
	await send({ type: "item", action: "link", from: `item:${item}`, kind: "landed", to: `commit:${head}` });
	const read = await send({ type: "item", action: "read", id: item });

	if (!Value.Check(StagedItem, read)) throw badReply("item read");

	// Only the tree tells whether an agent lives, and only an agent that serves the item has a `serves` edge from `agent:`.
	if (read.edges.some((edge) => edge.kind === "serves" && edge.from.startsWith("agent:"))) {
		const tree = await send({ type: "tree" });

		if (!Value.Check(TreeReply, tree)) throw badReply("tree");

		const live = tree.nodes.find(
			(node) =>
				node.kind === "agent" && node.serves?.kind === "item" && node.serves.id === item && node.state !== "ended",
		);

		if (live !== undefined) return { state: "open", line: `item ${item} stays open: ${live.name} serves it` };
	}

	await send({ type: "item", action: "set", id: item, state: "done" });

	return { state: "done", line: `item ${item} done` };
}

/** The error of a reply to the request `name` that does not have the expected shape. */
function badReply(name: string): Error {
	return new Error(`the harness host gave a bad reply to ${name}`);
}

/**
 * Checks that the run `runId` of `project` can serve `serves`, as harness checks what an agent serves: a parley that is
 * open or a contract, or an open item. It throws for any other, and for a parley or an item that the host does not
 * know. For an item, it then writes the edge `run:<runId> serves item:<id>`, which the host writes only once.
 */
export async function checkServes(
	project: string,
	runId: string,
	serves: ServesInput,
	signal: AbortSignal | undefined,
): Promise<void> {
	const options = { project, start: false, signal };

	if ("parley" in serves) {
		const reply = hostReply(project, await request({ type: "parley", action: "read", slug: serves.parley }, options));

		if (!Value.Check(PARLEY, reply)) throw badReply("parley read");
		const { parley } = reply;

		if (parley.status !== "open" && parley.status !== "contract") {
			throw new Error(`Parley ${parley.slug} is ${parley.status}: a run cannot serve it`);
		}

		return;
	}

	const item = hostReply(project, await request({ type: "item", action: "read", id: serves.item }, options));

	if (!Value.Check(StagedItem, item)) throw badReply("item read");

	if (item.state !== "open") throw new Error(`Item ${item.id} is ${item.state}: a run cannot serve it`);

	const link = {
		type: "item",
		action: "link",
		caller: askerOf(runId),
		from: `run:${runId}`,
		kind: "serves",
		to: `item:${item.id}`,
	} as const;

	hostReply(project, await request(link, options));
}
