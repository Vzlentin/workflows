import { existsSync } from "node:fs";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { join } from "node:path";
import type { JsonValue } from "@earendil-works/chord";
import { createModels } from "@earendil-works/pi-ai/models";
import type { Host } from "@vzlentin/harness/host";
import { addProject } from "@vzlentin/harness/projects";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { main } from "../src/cli/main.ts";
import { listenAll } from "../src/web/http.ts";
import { streamRun } from "../src/web/runs.ts";
import { hostModel, repository, rootTasks, sandbox, startHost, untimed, workflows, worktreeAt } from "./support.ts";

let root: string;
let host: Host;
let web: Web | undefined;

beforeEach(async () => {
	root = await sandbox();
	// `./gate.sh <name>` waits until `<name>.open` exists, after it creates `<name>.reached`.
	await writeFile(
		join(root, "gate.sh"),
		'#!/bin/sh\ntouch "$1.reached"\nwhile [ ! -f "$1.open" ]; do [ -d "$PWD" ] || exit 1; sleep 0.02; done\n',
	);
	await chmod(join(root, "gate.sh"), 0o755);
	await writeFile(join(root, "gated.js"), 'await sh("./gate.sh g")\nreturn "done"');
	await writeFile(
		join(root, "x.js"),
		'phase("a")\nawait agent("Script: one")\nphase("b")\nreturn await agent("Script: two")',
	);
	host = await startHost("main", hostModel().models);
});

// The server closes first: a stream of the inspect view whose host stops would start a real harness host.
afterEach(async () => {
	await web?.stop();
	web = undefined;
	await host.close();
	await rm(root, { recursive: true, force: true });
});

/** A `workflows web` that runs in this process: the URL of its page, and its stop, which gives its exit code. */
type Web = { readonly base: string; stop(): Promise<number> };

/** Runs `workflows web --port 0` in `cwd` until `stop()`, as Ctrl+C stops it. */
async function startWeb(cwd = root): Promise<Web> {
	const interrupt = new AbortController();
	const { promise: url, resolve } = Promise.withResolvers<string>();
	const stderr: string[] = [];

	const code = main(["web", "--port", "0"], {
		cwd,
		stdin: async () => undefined,
		stdout: (line) => {
			if (line.startsWith("http://")) resolve(line);
		},
		stderr: (line) => stderr.push(line),
		interrupt: interrupt.signal,
		stop: new AbortController().signal,
		following: () => {},
		models: async () => createModels(),
	});

	const failed = code.then((exit) => {
		throw new Error(`workflows web exited with ${exit}: ${stderr.join("\n")}`);
	});

	const base = await Promise.race([url, failed]);

	return {
		base,
		stop: () => {
			interrupt.abort();

			return code;
		},
	};
}

/** The status and the JSON body of a request to the server. */
async function api(path: string, init?: RequestInit): Promise<{ status: number; body: unknown }> {
	const response = await fetch(`${web?.base}${path.slice(1)}`, init);

	return { status: response.status, body: await response.json() };
}

function post(path: string, body: JsonValue, type = "application/json") {
	return api(path, { method: "POST", headers: { "content-type": type }, body: JSON.stringify(body) });
}

/** The frames of an open stream of Server-Sent Events as they come, and the abort of its request. */
async function openStream(path: string): Promise<{ frames: unknown[]; close(): void }> {
	const abort = new AbortController();
	const response = await fetch(`${web?.base}${path.slice(1)}`, { signal: abort.signal });
	const { body } = response;
	const frames: unknown[] = [];

	if (body === null) throw new Error("no body");
	expect(response.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");

	void (async () => {
		const decoder = new TextDecoder();
		let buffer = "";

		try {
			for await (const chunk of body) {
				buffer += decoder.decode(chunk, { stream: true });

				for (let end = buffer.indexOf("\n\n"); end !== -1; end = buffer.indexOf("\n\n")) {
					frames.push(JSON.parse(buffer.slice("data: ".length, end)));
					buffer = buffer.slice(end + 2);
				}
			}
		} catch {
			// `close()` ends the body with the error of the abort.
		}
	})();

	return { frames, close: () => abort.abort() };
}

async function until(check: () => Promise<boolean> | boolean): Promise<void> {
	while (!(await check())) await new Promise((resolve) => setTimeout(resolve, 20));
}

/** Waits until the gate `name` in the sandbox is reached. */
function reached(name: string): Promise<void> {
	return until(() => existsSync(join(root, `${name}.reached`)));
}

const SNAPSHOT = Type.Object({
	badge: Type.String(),
	status: Type.String(),
	ended: Type.Boolean(),
	waitingQuestion: Type.Optional(Type.String()),
	entries: Type.Array(Type.Object({ text: Type.String(), conversation: Type.Optional(Type.Number()) })),
	end: Type.Unknown(),
});

/** The snapshot of the run `id` from `GET /api/runs/<id>`. */
async function snapshot(id: string) {
	const { status, body } = await api(`/api/runs/${id}`);
	expect(status).toBe(200);

	return Value.Parse(SNAPSHOT, body);
}

/** The step lines of a snapshot, without durations, each with whether it has a conversation. */
function steps({ entries }: { entries: { text: string; conversation?: number }[] }) {
	return entries.map(({ text, conversation }) => [untimed(text), conversation !== undefined]);
}

/** Waits until the snapshot of the run `id` has the badge `badge`. */
function badged(id: string, badge: string): Promise<void> {
	return until(async () => (await snapshot(id)).badge === badge);
}

const STARTED = Type.Object({ runId: Type.String(), status: Type.Literal("started") });

/** Starts `workflow` through `POST /api/runs/start` in the sandbox, and gives the run ID. */
async function started(workflow: string): Promise<string> {
	const { status, body } = await post("/api/runs/start", { workflow, cwd: root });
	expect(status).toBe(200);

	return Value.Parse(STARTED, body).runId;
}

describe("workflows web", () => {
	it("lists the runs of every project, with their project and badge, and the workflows of a project", async () => {
		const ran = await workflows(["x.js"], { cwd: root, host });
		expect(ran.code).toBe(0);
		await mkdir(join(root, "other", ".workflows", "scripts"), { recursive: true });
		const other = addProject("other", join(root, "other"));
		await writeFile(join(other, "y.js"), 'return "other"');
		await writeFile(
			join(other, ".workflows", "scripts", "z.js"),
			'export const meta = { description: "Zed." }\nreturn 1',
		);
		const second = await workflows(["y.js"], { cwd: other });
		expect(second.code).toBe(0);
		web = await startWeb();

		const run = (project: string, id: string | undefined, workflow: string) => ({
			project,
			runId: id,
			workflow,
			title: workflow,
			status: "done",
			repository: null,
			badge: "done",
		});

		// Both runs can start in the same second, so their random part orders them.
		const newestFirst = [run("other", second.id, "y"), run("main", ran.id, "x")].sort((a, b) =>
			String(b.runId).localeCompare(String(a.runId)),
		);

		expect(await api("/api/runs")).toEqual({ status: 200, body: { runs: newestFirst } });

		expect(await api("/api/runs?project=main")).toEqual({ status: 200, body: { runs: [run("main", ran.id, "x")] } });

		expect(await api("/api/runs?project=nope")).toEqual({
			status: 400,
			body: { error: "Unknown harness project: nope" },
		});

		const listed = await api("/api/workflows?project=other");
		expect(listed.status).toBe(200);

		const names = Value.Parse(
			Type.Object({ workflows: Type.Array(Type.Object({ name: Type.String() })) }),
			listed.body,
		);

		expect(names.workflows.map(({ name }) => name)).toEqual(expect.arrayContaining(["ship", "fix", "implement", "z"]));
		expect(listed.body).toMatchObject({ workflows: expect.arrayContaining([{ name: "z", description: "Zed." }]) });

		const here = Value.Parse(
			Type.Object({ workflows: Type.Array(Type.Object({ name: Type.String() })) }),
			(await api("/api/workflows")).body,
		);

		expect(here.workflows.map(({ name }) => name)).not.toContain("z");
		expect(await web.stop()).toBe(0);
	});

	it("gives the steps of a run with the conversation of each step, and streams that conversation on the same port", async () => {
		const ran = await workflows(["x.js"], { cwd: root, host });
		const id = ran.id ?? "";
		web = await startWeb();

		const shown = await snapshot(id);
		expect([shown.badge, shown.status, shown.ended, shown.end]).toEqual([
			"done",
			"done",
			true,
			{ report: ["Reply to two"] },
		]);
		expect(steps(shown)).toEqual([
			["✓ a", true],
			["✓ b", true],
		]);
		expect(await api(`/api/runs/${id}`)).toMatchObject({
			body: { runId: id, project: "main", workflow: "x", footer: ["Reply to two"] },
		});

		const stream = await openStream(`/api/runs/${id}/stream`);
		await until(() => stream.frames.length > 0);
		expect(steps(Value.Parse(SNAPSHOT, stream.frames[0]))).toEqual(steps(shown));
		stream.close();

		const conversation = shown.entries[0]?.conversation;
		const view = await openStream(`/api/inspect/stream?project=main&conversation=${conversation}`);
		await until(() => view.frames.some((frame) => JSON.stringify(frame).includes("Script: one")));
		view.close();

		expect(await api("/api/runs/20000101T000000-00000000")).toMatchObject({ status: 404 });
		expect(await api("/api/runs/a%2Fb")).toEqual({ status: 400, body: { error: "a/b is not a run ID" } });
		expect((await api("/api/runs/20000101T000000-00000000/stream")).status).toBe(404);
	});

	it("starts no stream for a client that left during the first read", async () => {
		const ran = await workflows(["x.js"], { cwd: root, host });
		const { promise: arrived, resolve: arrive } = Promise.withResolvers<void>();
		const { promise: headersSent, resolve, reject } = Promise.withResolvers<boolean>();

		// The stream begins after the client left, so the response closed before the first read ended.
		const server = await listenAll(["127.0.0.1"], 0, (_req, res) => {
			res.once("close", () => void streamRun(res, ran.id ?? "").then(() => resolve(res.headersSent), reject));
			arrive();
		});

		const sent = request(server.urls[0] ?? "");
		sent.on("error", () => {});
		sent.end();
		await arrived;
		sent.destroy();
		expect(await headersSent).toBe(false);
		await server.close();
	});

	it("streams a run that the server starts, and stops and resumes it", async () => {
		web = await startWeb();
		const id = await started("gated.js");
		await reached("g");
		const stream = await openStream(`/api/runs/${id}/stream`);

		const streamed = (badge: string) =>
			until(() => stream.frames.some((frame) => Value.Parse(SNAPSHOT, frame).badge === badge));

		await streamed("running");
		expect(await post(`/api/runs/${id}/stop`, {})).toEqual({ status: 200, body: { ok: true } });
		expect(await rootTasks(id)).toEqual([{ status: "terminal", outcome: "aborted" }]);
		const stopped = await snapshot(id);
		expect([stopped.badge, stopped.status, stopped.ended]).toEqual(["stopped", "aborted", true]);
		expect((await post(`/api/runs/${id}/stop`, {})).status).toBe(500);
		await streamed("stopped");

		expect(await post(`/api/runs/${id}/resume`, {})).toEqual({ status: 200, body: { ok: true } });
		await writeFile(join(root, "g.open"), "");
		await streamed("done");
		stream.close();
		expect((await snapshot(id)).end).toEqual({ report: ["done"] });

		expect(await post(`/api/runs/${id}/resume`, {})).toEqual({
			status: 409,
			body: { error: `run ${id} finished: "done"` },
		});
	});

	it("answers a run that waits for an answer", async () => {
		await writeFile(join(root, "ask.js"), 'return await input("Go?")');
		web = await startWeb();
		const id = await started("ask.js");
		await badged(id, "waiting");
		expect(await snapshot(id)).toMatchObject({ status: "waiting", waitingQuestion: "Go?", ended: true });
		expect(await post(`/api/runs/${id}/resume`, { answer: "yes" })).toEqual({ status: 200, body: { ok: true } });
		await badged(id, "done");
		expect((await snapshot(id)).end).toEqual({ report: ["yes"] });
	});

	it("starts a run in the directory of the project of the body, not in the directory of the server", async () => {
		await mkdir(join(root, "other"));
		const other = addProject("other", join(root, "other"));
		// Only the project has the script, so a start in the directory of the server fails.
		await writeFile(
			join(other, "h.js"),
			'export const meta = { args: { item: { type: "string", positional: true } } }\nreturn args.item',
		);
		const otherHost = await startHost("other", hostModel().models);

		try {
			web = await startWeb(root);

			const { status, body } = await post("/api/runs/start", {
				workflow: "h.js",
				args: ["--", "- fix the parser"],
				project: "other",
			});

			expect(status).toBe(200);
			const id = Value.Parse(STARTED, body).runId;
			await badged(id, "done");
			expect(await api(`/api/runs/${id}`)).toMatchObject({
				body: { project: "other", end: { report: ["- fix the parser"] } },
			});

			expect(await post("/api/runs/start", { workflow: "h.js", project: "other", cwd: other })).toEqual({
				status: 400,
				body: { error: "Use project or cwd, not both" },
			});
			expect(await post("/api/runs/prune", { project: "nope" })).toEqual({
				status: 400,
				body: { error: "Unknown harness project: nope" },
			});
		} finally {
			await web?.stop();
			web = undefined;
			await otherHost.close();
		}
	});

	it("refuses a project whose directory is gone", async () => {
		await mkdir(join(root, "gone"));
		const gone = addProject("gone", join(root, "gone"));
		await rm(gone, { recursive: true });
		web = await startWeb();
		const refused = { status: 400, body: { error: `Not an absolute path of a directory: ${gone}` } };

		expect(await post("/api/runs/start", { workflow: "x.js", project: "gone" })).toEqual(refused);
		expect(await post("/api/runs/prune", { project: "gone" })).toEqual(refused);
		expect(await api("/api/workflows?project=gone")).toEqual(refused);
	});

	it("prunes the given runs", async () => {
		const repo = join(root, "repo");
		await repository(repo);
		await mkdir(join(repo, ".workflows", "scripts"), { recursive: true });
		await writeFile(
			join(repo, ".workflows", "scripts", "w.js"),
			'export const meta = { worktree: true }\nreturn "done"',
		);
		const ran = await workflows(["w"], { cwd: repo, host });
		expect(ran.code).toBe(0);
		const id = ran.id ?? "";
		const worktree = worktreeAt(repo, id);
		expect(existsSync(worktree)).toBe(true);
		web = await startWeb();

		expect(await post("/api/runs/prune", { runIds: [id], cwd: repo })).toEqual({
			status: 200,
			body: { pruned: [id] },
		});

		expect(existsSync(worktree)).toBe(false);
		expect((await post("/api/runs/prune", { runIds: ["--install-hook"], cwd: repo })).status).toBe(500);
		expect(existsSync(join(repo, ".git", "hooks", "post-merge"))).toBe(false);
	});

	it("refuses a Host header that is not an address, a body that is not JSON, and a start that is not a workflow", async () => {
		web = await startWeb();
		const { port } = new URL(web.base);

		const refused = await new Promise<number | undefined>((resolve, reject) => {
			const sent = request({ host: "127.0.0.1", port, path: "/", headers: { host: "evil.example" } }, (res) => {
				res.resume();
				resolve(res.statusCode);
			});

			sent.on("error", reject);
			sent.end();
		});

		expect(refused).toBe(403);
		expect(await post("/api/runs/start", { workflow: "x.js" }, "text/plain")).toEqual({
			status: 400,
			body: { error: "The body must be application/json" },
		});
		expect(await post("/api/runs/start", {})).toEqual({
			status: 400,
			body: { error: "Invalid body: must have required properties workflow" },
		});
		expect(await post("/api/runs/start", { workflow: "prune" })).toEqual({
			status: 400,
			body: { error: "prune is not a workflow" },
		});
		const unknown = await post("/api/runs/start", { workflow: "nope" });
		expect(unknown).toMatchObject({
			status: 400,
			body: { error: expect.stringMatching(/^workflows: unknown command nope\n/) },
		});
		expect(await post("/api/runs/start", { workflow: "x.js", cwd: "relative" })).toEqual({
			status: 400,
			body: { error: "Not an absolute path of a directory: relative" },
		});
		expect((await post("/api/runs/20000101T000000-00000000/stop", {})).status).toBe(404);
	});

	it("exits 2 for a bad port, and 1 for a host that is not an address", async () => {
		const port = await workflows(["web", "--port", "x"], { cwd: root });
		expect([port.code, port.stderr]).toEqual([
			2,
			[
				"workflows: --port must be an integer from 0 to 65535",
				"usage: workflows web [--port <n>] [--host <ip> | --tailscale]",
			],
		]);
		const named = await workflows(["web", "--host", "example.com"], { cwd: root });
		expect([named.code, named.stderr]).toEqual([
			1,
			["workflows: The host must be an IP address or localhost: example.com"],
		]);
	});
});
