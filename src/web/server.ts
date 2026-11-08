/**
 * The server of `workflows web`: the page of the control center at `/`, its browser files, its routes under
 * `/api/runs` and `/api/workflows`, and the routes of harness inspect, on one port of each address.
 */
import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createInspectHandler, type InspectHandler } from "@vzlentin/harness/inspect";
import { MAIN_PROJECT, readProjects } from "@vzlentin/harness/projects";
import { GoneRun } from "../cli/saved.ts";
import { scriptsOf, UsageError } from "../workflow/find.ts";
import {
	directoryOf,
	PruneBody,
	projectOrBad,
	pruneRuns,
	ResumeBody,
	resumeRun,
	StartBody,
	StopBody,
	startRun,
	stopRun,
} from "./actions.ts";
import { addressHost, bodyOf, HttpError, isAddress, type Listening, listenAll, sendJson } from "./http.ts";
import { PAGE } from "./page.ts";
import { runSnapshot, runsOf, streamRun } from "./runs.ts";

/** The browser files, in the `web/` folder of the package, next to `src/` and `dist/`. */
const WEB = new URL("../../web/", import.meta.url);

/** The browser files, by the path that serves them. */
const ASSETS: ReadonlyMap<string, { readonly file: string; readonly type: string }> = new Map([
	["/assets/control.js", { file: "control.js", type: "text/javascript; charset=utf-8" }],
	["/assets/control.css", { file: "control.css", type: "text/css; charset=utf-8" }],
]);

/** The routes of one run: its snapshot, its stream, and its actions. */
const RUN_PATH = /^\/api\/runs\/([^/]+)(?:\/(stream|stop|resume))?$/;

export type WebServerOptions = {
	/** The addresses to listen on, each an IP address or `localhost`. */
	readonly hosts: readonly string[];
	/** The port of every address. 0 takes a free port, the same one on every address. */
	readonly port: number;
	/** The directory of the actions and of the workflows that have no directory of their own. */
	readonly cwd: string;
};

/**
 * Serves the control center on each address of `hosts`. It refuses a host that is not an IP address or `localhost`,
 * because the routes refuse its name in the `Host` header.
 */
export async function startWebServer({ hosts, port, cwd }: WebServerOptions): Promise<Listening> {
	const name = hosts.find((host) => !isAddress(host));

	if (name !== undefined) throw new Error(`The host must be an IP address or localhost: ${name}`);
	const inspect = createInspectHandler();

	return listenAll(hosts, port, (req, res) => void serve(req, res, inspect, cwd).catch(() => res.destroy()));
}

/**
 * Serves one request. Every request gets 403 when its `Host` header is not an IP address or `localhost`, so that the
 * DNS name of another site that points at the server cannot reach it.
 */
async function serve(req: IncomingMessage, res: ServerResponse, inspect: InspectHandler, cwd: string): Promise<void> {
	if (!addressHost(req.headers.host)) {
		sendJson(res, 403, { error: "The Host header must be an IP address or localhost" });

		return;
	}

	const url = new URL(req.url ?? "/", "http://localhost");
	const asset = ASSETS.get(url.pathname);

	if (req.method === "GET" && url.pathname === "/") {
		res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" }).end(PAGE);

		return;
	}

	if (req.method === "GET" && asset !== undefined) {
		await sendAsset(res, asset.file, asset.type);

		return;
	}

	if (await inspect(req, res)) return;

	if (url.pathname.startsWith("/api/")) {
		await serveApi(req, res, url, cwd);

		return;
	}

	res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("Not found\n");
}

async function sendAsset(res: ServerResponse, file: string, type: string): Promise<void> {
	let text: string;

	try {
		text = await readFile(new URL(file, WEB), "utf8");
	} catch (cause) {
		res.writeHead(500, { "content-type": "text/plain; charset=utf-8" }).end(`${messageOf(cause)}\n`);

		return;
	}

	res.writeHead(200, { "content-type": type, "cache-control": "no-cache" }).end(text);
}

async function serveApi(req: IncomingMessage, res: ServerResponse, url: URL, cwd: string): Promise<void> {
	switch (`${req.method} ${url.pathname}`) {
		case "GET /api/runs":
			return reply(res, async () => ({ runs: await runsOf(projectsOf(url)) }));
		case "GET /api/workflows":
			return reply(res, async () => {
				const directory = await directoryOf({ project: url.searchParams.get("project") ?? undefined }, cwd);

				return { workflows: await scriptsOf(directory) };
			});
		case "POST /api/runs/start":
			return reply(res, async () => startRun(await bodyOf(req, StartBody), cwd));
		case "POST /api/runs/prune":
			return reply(res, async () => pruneRuns(await bodyOf(req, PruneBody), cwd));
	}

	const [, segment, action = ""] = RUN_PATH.exec(url.pathname) ?? [];

	switch (segment === undefined ? "" : `${req.method} ${action}`) {
		case "GET ":
			return reply(res, () => runSnapshot(runIdOf(segment)));
		case "GET stream":
			return openStream(res, segment);
		case "POST stop":
			return reply(res, async () => {
				await bodyOf(req, StopBody);

				return stopRun(runIdOf(segment), cwd);
			});
		case "POST resume":
			return reply(res, async () => resumeRun(runIdOf(segment), await bodyOf(req, ResumeBody), cwd));
		default:
			sendJson(res, 404, { error: `Not found: ${req.method} ${url.pathname}` });
	}
}

/** The projects of the `project` of the query of `url`, or every project, then `main`, without it. */
function projectsOf(url: URL): string[] {
	const project = url.searchParams.get("project");

	if (project === null) return [...Object.keys(readProjects()), MAIN_PROJECT];

	return [projectOrBad(project)];
}

/** The run ID of the path segment `segment`. */
function runIdOf(segment: string | undefined): string {
	try {
		return decodeURIComponent(segment ?? "");
	} catch {
		throw new HttpError(400, `${segment} is not a run ID`);
	}
}

/** Streams the run of the path segment `segment`, or replies with the error of its first read. */
async function openStream(res: ServerResponse, segment: string | undefined): Promise<void> {
	try {
		await streamRun(res, runIdOf(segment));
	} catch (cause) {
		if (res.headersSent) res.destroy();
		else sendJson(res, statusOf(cause), { error: messageOf(cause) });
	}
}

/** Replies with the value that `act` gives, or with the error that it throws and its status. */
async function reply<R>(res: ServerResponse, act: () => Promise<R>): Promise<void> {
	let value: R;

	try {
		value = await act();
	} catch (cause) {
		sendJson(res, statusOf(cause), { error: messageOf(cause) });

		return;
	}

	sendJson(res, 200, value);
}

/** The status of an error: its own for an `HttpError`, 400 for bad usage, such as a run ID that is a path, 404 for a gone run, else 500. */
function statusOf(cause: unknown): number {
	if (cause instanceof HttpError) return cause.status;

	if (cause instanceof UsageError) return 400;

	return cause instanceof GoneRun ? 404 : 500;
}

function messageOf(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}
