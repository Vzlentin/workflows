/** `workflows web`: serves the control center, a web page of the runs and their agents, until Ctrl+C or SIGTERM. */
import { parseArgs } from "node:util";
import { resolveBindHosts } from "@vzlentin/harness/inspect";
import { startWebServer } from "../../web/server.ts";
import { UsageError, withUsage } from "../../workflow/find.ts";
import { setWorkflowsEntry } from "../host.ts";
import type { Terminal } from "../main.ts";

export const WEB = "workflows web [--port <n>] [--host <ip> | --tailscale]";

/** The port of the server without `--port`. */
const DEFAULT_PORT = 7502;

/**
 * Serves the control center on `127.0.0.1`, on `--host`, or on `127.0.0.1` and the Tailscale addresses with
 * `--tailscale`, and prints the URL of each address. It sets the entry of workflows first, because a stream of the
 * inspect view starts the host of its project when none runs. It stops at Ctrl+C or SIGTERM, closes its connections,
 * and exits 0.
 */
export async function web(args: readonly string[], terminal: Terminal): Promise<number> {
	const { values, positionals } = withUsage(
		() =>
			parseArgs({
				args: [...args],
				options: { port: { type: "string" }, host: { type: "string" }, tailscale: { type: "boolean" } },
				allowPositionals: true,
				strict: true,
			}),
		WEB,
	);

	if (positionals.length > 0) throw new UsageError("web takes no arguments", WEB);
	const port = values.port === undefined ? DEFAULT_PORT : Number(values.port);

	if (!Number.isInteger(port) || port < 0 || port > 65535) {
		throw new UsageError("--port must be an integer from 0 to 65535", WEB);
	}

	const hosts = await resolveBindHosts({ host: values.host, tailscale: values.tailscale });
	setWorkflowsEntry();
	const server = await startWebServer({ hosts, port, cwd: terminal.cwd });

	for (const url of server.urls) terminal.stdout(url);
	await stopped(terminal.interrupt);
	await server.close();

	return 0;
}

/** Resolves when `signal` aborts or the process gets SIGTERM, and then stops listening to both. */
function stopped(signal: AbortSignal): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	const stop = () => resolve();
	signal.addEventListener("abort", stop, { once: true });
	process.once("SIGTERM", stop);

	if (signal.aborted) stop();

	return promise.finally(() => {
		signal.removeEventListener("abort", stop);
		process.off("SIGTERM", stop);
	});
}
