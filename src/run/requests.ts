/**
 * The requests of a run to its host: the schema of the args of a `harness` call, and the send of one
 * request, with the run as its caller when the request names none.
 */
import type { JsonValue } from "@earendil-works/chord/json";
import { request } from "@vzlentin/harness/client";
import type { Request } from "@vzlentin/harness/protocol";
import { type Static, Type } from "typebox";
import { JSON_VALUE } from "../tool.ts";
import { askerOf } from "./asks.ts";

/**
 * The args of a `harness` call: one request to the host of the run, an object with a `type` and other JSON
 * properties. The host checks the request.
 */
export const HARNESS_ARGS = Type.Object({ type: Type.String({ minLength: 1 }) }, { additionalProperties: JSON_VALUE });

/** The args of a `harness` call. */
export type HarnessArgs = Readonly<Static<typeof HARNESS_ARGS>>;

/**
 * Sends the request `sent` of the run `runId` to the host `host`, which it never starts, and returns its reply.
 * The run is the caller of a request that has no `caller`. It throws when no host runs, and for an error of the host.
 */
export async function runRequest(
	host: string,
	runId: string,
	sent: HarnessArgs,
	signal?: AbortSignal,
): Promise<JsonValue> {
	const withCaller = "caller" in sent ? sent : { ...sent, caller: askerOf(runId) };

	// SAFETY: the host checks each request line against its schema and replies with an error for a bad one, so a request
	// that is not a `Request` fails as an error of the host.
	const reply = await request(withCaller as Request, { host, start: false, signal });

	if (reply === undefined) throw new Error(`no harness host runs for ${host}`);

	// SAFETY: the client parses each reply line of the host as JSON, so a reply is a JSON value.
	return reply as JsonValue;
}
