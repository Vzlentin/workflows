/**
 * The HTTP rules of `workflows web`, the same as those of harness inspect: the `Host` guard, the JSON body of a POST,
 * the JSON replies, and one server on each address, all on one port.
 */
import { createServer, type IncomingMessage, type RequestListener, type Server, type ServerResponse } from "node:http";
import { isIP, isIPv6 } from "node:net";
import { type Static, type TSchema, Type } from "typebox";
import { Value } from "typebox/value";

/** The largest body of a POST route. */
const MAX_BODY_BYTES = 1024 * 1024;

/** The address of a listening server. */
const ListenAddress = Type.Object({ port: Type.Integer() });

/** An error that the reply gives with its HTTP status. */
export class HttpError extends Error {
	readonly status: number;

	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

/** Whether `host` is an IP address or `localhost`, which no DNS name of another site can be. */
export function isAddress(host: string): boolean {
	return host === "localhost" || isIP(host) !== 0;
}

/** Whether the `Host` header names an address, as `isAddress` tells. */
export function addressHost(header: string | undefined): boolean {
	if (header === undefined) return false;
	let hostname: string;

	try {
		hostname = new URL(`http://${header}`).hostname;
	} catch {
		return false;
	}

	return isAddress(hostname.replace(/^\[(.*)\]$/, "$1"));
}

export function sendJson<B>(res: ServerResponse, status: number, body: B): void {
	res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
	res.end(JSON.stringify(body));
}

/**
 * The JSON body of `req`, as `schema` gives it. It throws a 400 error when the body is not `application/json`, is
 * longer than 1 MiB, is not JSON, or does not match. A longer body is read to its end, so that the reply can go on the
 * connection.
 */
export async function bodyOf<T extends TSchema>(req: IncomingMessage, schema: T): Promise<Static<T>> {
	const type = req.headers["content-type"]?.split(";")[0]?.trim().toLowerCase();

	if (type !== "application/json") throw new HttpError(400, "The body must be application/json");
	const chunks: Buffer[] = [];
	let size = 0;

	for await (const chunk of req) {
		size += chunk.length;

		if (size <= MAX_BODY_BYTES) chunks.push(chunk);
	}

	if (size > MAX_BODY_BYTES) throw new HttpError(400, "The body is longer than 1 MiB");
	let body: unknown;

	try {
		body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch {
		throw new HttpError(400, "The body is not JSON");
	}

	if (!Value.Check(schema, body)) {
		const [error] = Value.Errors(schema, body);
		const where = [error?.instancePath, error?.message].filter((part) => part).join(" ");

		throw new HttpError(400, `Invalid body: ${where}`);
	}

	return body;
}

/** The servers of `listenAll`: the URL of `/` on each address, in the order of the addresses, and how to stop them. */
export type Listening = {
	readonly urls: readonly string[];
	/** Stops listening and closes every connection. */
	close(): Promise<void>;
};

/**
 * Serves `listener` on each address of `hosts`, with one server for each. The first address takes `port`, which is a
 * free port for 0, and the others listen on the same one. When an address fails, the servers that listen close.
 */
export async function listenAll(hosts: readonly string[], port: number, listener: RequestListener): Promise<Listening> {
	const servers: Server[] = [];
	let bound = port;

	try {
		for (const host of hosts) {
			const server = createServer(listener);
			servers.push(server);
			bound = await listen(server, host, bound);
		}
	} catch (error) {
		await closeAll(servers);
		throw error;
	}

	return {
		urls: hosts.map((host) => `http://${isIPv6(host) ? `[${host}]` : host}:${bound}/`),
		close: () => closeAll(servers),
	};
}

/** Listens on `port` of `host`, and gives the port, which the system picks for 0. */
function listen(server: Server, host: string, port: number): Promise<number> {
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, host, () => {
			server.off("error", reject);
			resolve(Value.Parse(ListenAddress, server.address()).port);
		});
	});
}

async function closeAll(servers: readonly Server[]): Promise<void> {
	await Promise.all(
		servers.map(
			(server) =>
				new Promise<void>((resolve) => {
					// A server that did not listen calls back with an error, and has nothing to close.
					server.close(() => resolve());
					server.closeAllConnections();
				}),
		),
	);
}
