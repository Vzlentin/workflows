/**
 * What a run serves: the item or the parley that its start named, which the host of its project keeps. A root task
 * checks it when it starts, and links the run to the item, through the requests of harness to that host.
 */
import { request } from "@vzlentin/harness/client";
import { type ServesInput, StagedItem } from "@vzlentin/harness/protocol";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { askerOf } from "./asks.ts";

const PARLEY = Type.Object({ parley: Type.Object({ slug: Type.String(), status: Type.String() }) });

/** `reply`, the reply of the host of `project`, which is undefined when no host runs. */
export function hostReply<T>(project: string, reply: T | undefined): T {
	if (reply === undefined) throw new Error(`no harness host runs for ${project}`);

	return reply;
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
