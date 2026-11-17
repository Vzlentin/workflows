import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { request } from "@vzlentin/harness/client";
import { AskWrite, type Request, type ServesInput } from "@vzlentin/harness/protocol";
import { type Static, type TSchema, Type } from "typebox";
import { Value } from "typebox/value";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { LISTED } from "../src/cli/commands/list.ts";
import { SHOWN, SHOWN_AGENTS } from "../src/cli/commands/show.ts";
import { ROW } from "../src/cli/saved.ts";
import { LABELS, type Labels } from "../src/records/tree.ts";
import type { CallKind } from "../src/run/calls.ts";
import { conversationOf, hostModel, inputsOf, logLine, sandbox, startHost, untimed, workflows } from "./support.ts";

let root: string;

beforeEach(async () => {
	root = await sandbox();
});

afterEach(() => rm(root, { recursive: true, force: true }));

/** The models of the roles of an agents table, by role name. */
type Agents = Readonly<Record<string, { readonly model: string }>>;

/** Writes the workflow scripts `scripts`, by name, and the agents table `agents` in the `.workflows` of the sandbox. */
async function workflowsDir(scripts: Readonly<Record<string, string>>, agents: Agents = {}): Promise<void> {
	const folder = join(root, ".workflows");
	await mkdir(join(folder, "scripts"), { recursive: true });
	await writeFile(join(folder, "agents.json"), JSON.stringify(agents));

	for (const [name, source] of Object.entries(scripts)) await writeFile(join(folder, "scripts", `${name}.js`), source);
}

/** Sends the `todo` request `sent` on the list of the project agent to a host of the sandbox, and gives the reply. */
async function projectTodo(sent: { action: "add"; text: string } | { action: "set"; id: number; state: "done" }) {
	const host = await startHost();

	try {
		return await request({ type: "todo", caller: "test", handle: "agent", ...sent }, { start: false });
	} finally {
		await host.close();
	}
}

/** The JSON of the one stdout line of `workflows <argv>` in the sandbox, which must match `schema`. */
async function printed<T extends TSchema>(schema: T, argv: string[]): Promise<Static<T>> {
	const run = await workflows(argv, { cwd: root });
	expect([run.code, run.stderr]).toEqual([0, []]);
	const value: unknown = JSON.parse(run.stdout[0] ?? "");

	if (!Value.Check(schema, value)) throw new Error(`${argv.join(" ")} printed JSON that its schema refuses`);

	return value;
}

describe("the JSON of list and show", () => {
	it("matches the schemas of list, show and show --agents, with a call of each kind and the model of a role", async () => {
		await workflowsDir(
			{
				all: [
					'const s = session({ as: "j" })',
					'await s.ask("Script: one")',
					'await sh("true")',
					'await ok("false")',
					'await pastRuns("all")',
					'await todo.add("first")',
					'await run("child", {})',
					'return await input("Q?")',
				].join("\n"),
				child: 'await todo.add("child")\nreturn "c"',
			},
			{ j: { model: "other/o-1" } },
		);
		const run = await workflows(["all"], { cwd: root });
		expect(run.code).toBe(3);
		const id = run.id ?? "";

		const listed = await printed(Type.Array(LISTED), ["list", "--json"]);
		expect(listed).toEqual([expect.objectContaining({ runId: id, state: "waiting", question: "Q?" })]);

		const shown = await printed(SHOWN, ["show", id, "--json"]);
		const kinds: CallKind[] = ["session", "ask", "sh", "ok", "pastRuns", "todo", "run", "input"];
		expect(shown.calls.map((call) => call.kind)).toEqual(kinds);
		expect(shown.calls[0]).toMatchObject({ model: { provider: "other", model: "o-1" } });
		const conversation = await conversationOf(/Script: one/);
		expect(shown).toMatchObject({
			state: "waiting",
			question: "Q?",
			startedAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT/),
			agent: { conversation, project: "main" },
			todos: [{ id: 1, text: "first", state: "open" }],
		});

		const agents = await printed(SHOWN_AGENTS, ["show", id, "--agents", "--json"]);
		expect(agents.agent).toEqual({ conversation, project: "main" });
		expect(agents.agents).toEqual([
			expect.objectContaining({ kind: "agent", conversation, model: expect.objectContaining({ model: "o-1" }) }),
			expect.objectContaining({ kind: "run" }),
		]);
		const text = await workflows(["show", id, "--agents"], { cwd: root });
		expect(text.stdout[1]).toMatch(/^ {2}✓ Script: one {2}o-1 {2}1 ask {2}\d+s$/);
	});

	it("names each step line of show as log takes it, and gives null to a log line", async () => {
		await workflowsDir({
			caller: 'await run("child", {})\nphase("a")\nlog("note")\nawait sh("true")\nphase("b")\nawait sh("true")',
			child: 'phase("c1")\nawait sh("true")\nphase("c2")\nawait sh("true")\nreturn {}',
		});
		const run = await workflows(["caller"], { cwd: root });
		expect(run.code).toBe(0);
		const id = run.id ?? "";

		const shown = await printed(SHOWN, ["show", id, "--json"]);
		const call = shown.calls.find((each) => each.kind === "run");
		const ended = call?.end?.kind === "done" ? call.end.result : undefined;
		const child = Value.Parse(Type.Object({ runId: Type.String() }), ended).runId;
		expect(child).toMatch(/^\d{8}T\d{6}-[0-9a-f]{8}$/);
		expect(shown.stepNames).toEqual(["s1", `${child}/s1`, `${child}/s2`, null, "s2"]);
		expect(shown.steps.map(untimed)).toEqual(["✓ a", "  ✓ c1", "  ✓ c2", "  note", "✓ b"]);

		for (const [i, name] of shown.stepNames.entries()) {
			if (name === null) continue;
			const logged = await workflows(["log", id, name], { cwd: root });
			expect([logged.code, logged.stderr], name).toEqual([0, []]);
			const text = untimed(shown.steps[i] ?? "").replace(/^ *[✓◉✗·] /, "");
			const path = name.includes("/") ? "caller/child" : "caller";
			expect(logged.stdout[0], name).toEqual(logLine(`\\[${path}\\] ${text}  \\d+s  1 call  0 B  ${name}`));
		}
	});

	it("has a label for each kind of call", () => {
		const { todo, ...others } = LABELS;
		// @ts-expect-error A table of labels without a kind fails the type check.
		const labels: Labels = others;
		expect(todo).toBeTypeOf("function");
		expect(Object.keys(labels).sort()).toEqual(["ask", "input", "ok", "pastRuns", "run", "session", "sh"]);
		expect(Object.keys(LABELS).sort()).toEqual(["ask", "input", "ok", "pastRuns", "run", "session", "sh", "todo"]);
	});
});

describe("serves", () => {
	it("saves the todo that a run serves, gives it in the JSON, and keeps it in the child runs", async () => {
		await workflowsDir({ parent: 'return await run("child", {})', child: 'return "c"' });
		expect(await projectTodo({ action: "add", text: "Build it" })).toMatchObject({ id: 1 });

		const served = await workflows(["parent", "--serves", "1"], { cwd: root });
		expect(served.code).toBe(0);
		const inputs = await inputsOf(served.id);
		expect(inputs.map((input) => input.serves)).toEqual([{ todo: 1 }, { todo: 1 }]);
		const shown = await printed(SHOWN, ["show", served.id ?? "", "--json"]);
		expect(shown.serves).toEqual({ todo: 1 });

		const plain = await workflows(["parent"], { cwd: root });
		expect(plain.code).toBe(0);
		// Every run of this list has a task, so each row is a run with the run fields.
		const listed = await printed(Type.Array(ROW), ["list", "--json"]);
		expect(listed.find((row) => row.runId === served.id)?.serves).toEqual({ todo: 1 });
		expect(listed.find((row) => row.runId === plain.id)).not.toHaveProperty("serves");
	});

	it("fails a run that serves an unknown todo or parley, or a todo that is done", async () => {
		await workflowsDir({ plain: 'return "x"' });

		const failed = async (serves: string) => {
			const run = await workflows(["plain", "--serves", serves], { cwd: root });

			return [run.code, run.stderr.join("\n")];
		};

		expect(await failed("99")).toEqual([1, expect.stringContaining("Unknown todo: 99")]);
		expect(await failed("no-such")).toEqual([1, expect.stringContaining("Unknown parley: no-such")]);
		await projectTodo({ action: "add", text: "Built" });
		await projectTodo({ action: "set", id: 1, state: "done" });
		expect(await failed("1")).toEqual([1, expect.stringContaining("Todo 1 is done: a run cannot serve it")]);
		const bad = await workflows(["plain", "--serves", "Not_A_Slug"], { cwd: root });
		expect([bad.code, bad.stderr[0]]).toEqual([2, "workflows: --serves Not_A_Slug is not a todo ID or a parley slug"]);
	});

	it("accepts and refuses what a harness spawn accepts and refuses", async () => {
		await workflowsDir({ plain: 'return "x"' });
		const host = await startHost("main", hostModel().models);
		const spawned: boolean[] = [];

		try {
			await servedThings();

			for (const [index, { input }] of SERVED.entries()) {
				const spawn: Request = {
					type: "spawn",
					requestId: `served-${index}`,
					caller: "test",
					notify: false,
					provider: "anthropic",
					model: "claude-haiku-5",
					callerThinking: "medium",
					cwd: root,
					prompt: `Served ${index}`,
					serves: input,
				};

				const accepted = await request(spawn, { start: false }).then(
					() => true,
					() => false,
				);

				spawned.push(accepted);
			}
		} finally {
			await host.close();
		}

		const ran: boolean[] = [];

		for (const { flag } of SERVED) ran.push((await workflows(["plain", "--serves", flag], { cwd: root })).code === 0);

		expect(ran).toEqual(spawned);
		// An open parley, a contract and an open todo are accepted; a closed parley and a done or dropped todo are not.
		expect(ran).toEqual([true, true, false, true, false, false]);
	});
});

/** The things that a run or a spawn can serve, in the order that `servedThings` makes them: the flag and the input. */
const SERVED: readonly { readonly flag: string; readonly input: ServesInput }[] = [
	{ flag: "served-open", input: { parley: "served-open" } },
	{ flag: "served-contract", input: { parley: "served-contract" } },
	{ flag: "served-closed", input: { parley: "served-closed" } },
	{ flag: "1", input: { todo: 1 } },
	{ flag: "2", input: { todo: 2 } },
	{ flag: "3", input: { todo: 3 } },
];

/** Sends `sent` to the running host of the sandbox. */
async function send(sent: Request): Promise<void> {
	await request(sent, { start: false });
}

/**
 * Makes the things of `SERVED` in the running host of the sandbox: an open parley, a contract and a closed parley, and
 * an open, a done and a dropped todo of the list of the project.
 */
async function servedThings(): Promise<void> {
	for (const [slug, end] of [
		["served-open", "open"],
		["served-contract", "contract"],
		["served-closed", "done"],
	] as const) {
		const parley = { slug, title: "Served", goal: "Serve it.", design_sense: "One writer." };
		const where = { title: "Where", kind: "your call" as const, options: [{ key: "a", label: "Here" }], plan: "a" };
		const round: Request = { type: "ask", action: "round", caller: "test", parley, asks: [where, { title: "Terms" }] };
		const written = Value.Parse(AskWrite, await request(round, { start: false }));
		const [call, readBack] = (written.parleys[0]?.asks ?? []).map((ask) => ask.id);

		if (call === undefined || readBack === undefined) throw new Error(`the parley ${slug} has no asks`);

		if (end === "open") continue;

		const answers = [
			{ id: call, answer: "a" },
			{ id: readBack, answer: "ok" },
		];

		await send({ type: "ask", action: "answer", caller: "user", answers });

		if (end === "done") await send({ type: "parley", action: "end", caller: "test", slug, status: end });
	}

	for (const text of ["Open", "Done", "Dropped"]) {
		await send({ type: "todo", caller: "test", handle: "agent", action: "add", text });
	}

	await send({ type: "todo", caller: "test", handle: "agent", action: "set", id: 2, state: "done" });
	await send({ type: "todo", caller: "test", handle: "agent", action: "set", id: 3, state: "dropped" });
}
