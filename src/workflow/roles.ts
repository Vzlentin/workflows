/**
 * The roles of a run. A role is a name, given by `session(name)` or `as`. The `agents.json` tables give each name, or
 * `"*"` for every name, a model and a thinking level; a field that no table gives comes from the project agent.
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

/** An entry of an `agents.json` file. */
const ENTRY = Type.Object(
	{
		model: Type.Optional(Type.String({ pattern: "^[^/]+/.+$" })),
		thinking: Type.Optional(Type.String({ minLength: 1 })),
	},
	{ additionalProperties: false },
);

/** A role of a saved bundle. A saved role can have other fields, such as `instructions`, which the engine ignores. */
export const ROLE = Type.Object({
	model: Type.Optional(Type.Object({ provider: Type.String(), modelId: Type.String() })),
	thinking: Type.Optional(Type.String()),
});

export type Role = Readonly<Static<typeof ROLE>>;

/** The roles of one table, or of the merged tables, by name; `"*"` gives the fields that a name does not give. */
export type Roles = Readonly<Record<string, Role>>;

/** The path of the user table: `$XDG_CONFIG_HOME/workflows/agents.json`, or `~/.config/workflows/agents.json`. */
export function userTablePath(): string {
	const config = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");

	return join(config, "workflows", "agents.json");
}

/** The `agents.json` file: an object of role names. */
const TABLE = Type.Record(Type.String(), ENTRY);

type ValidationError = ReturnType<typeof Value.Errors>[number];

/** The role name of a JSON pointer segment. */
const segment = (part: string) => part.replaceAll("~1", "/").replaceAll("~0", "~");

/** The problem that `error`, the deepest error of a table, names: the role name, its field, and what it must be. */
function tableProblem(error: ValidationError | undefined): string {
	const [, name, field] = (error?.instancePath ?? "").split("/").map(segment);

	if (name === undefined) return "must be an object of role names";

	if (field === "model") return `${name}.model must be <provider>/<id>`;

	if (field === "thinking") return `${name}.thinking must be a non-empty string`;

	if (error?.keyword === "additionalProperties") return `${name} must have only the fields model and thinking`;

	return `${name} must be an object`;
}

/** The model of `text`, `<provider>/<id>`, which the pattern of `ENTRY` checked. */
function modelRef(text: string): NonNullable<Role["model"]> {
	const slash = text.indexOf("/");

	return { provider: text.slice(0, slash), modelId: text.slice(slash + 1) };
}

/** A role with `model` and `thinking` when each is given. */
function roleWith(model: Role["model"], thinking: string | undefined): Role {
	const role: Static<typeof ROLE> = {};

	if (model !== undefined) role.model = model;

	if (thinking !== undefined) role.thinking = thinking;

	return role;
}

/** The role of a checked entry. */
function entryRole(entry: Static<typeof ENTRY>): Role {
	return roleWith(entry.model === undefined ? undefined : modelRef(entry.model), entry.thinking);
}

/**
 * The table of the file `path`. A missing file is an empty table; bad JSON or a bad entry throws `<path>: <problem>`.
 */
export async function readRoles(path: string): Promise<Roles> {
	if (!existsSync(path)) return {};
	const text = await readFile(path, "utf8");
	let table: unknown;

	try {
		table = JSON.parse(text);
	} catch (error) {
		throw new Error(`${path}: ${error instanceof Error ? error.message : String(error)}`);
	}

	if (!Value.Check(TABLE, table)) {
		const deepest = Value.Errors(TABLE, table).reduce<ValidationError | undefined>(
			(found, error) => (found === undefined || error.instancePath.length > found.instancePath.length ? error : found),
			undefined,
		);

		throw new Error(`${path}: ${tableProblem(deepest)}`);
	}

	return Object.fromEntries(Object.entries(table).map(([name, entry]) => [name, entryRole(entry)]));
}

/** The role of one part `<name>=<provider>/<id>:<thinking>` of `parseRoles`, which throws the problem of `part`. */
function partRole(part: string): readonly [string, Role] {
	const malformed = `'${part}' must be <name>=<provider>/<id>:<thinking>`;
	const equals = part.indexOf("=");

	if (equals < 0) throw new Error(malformed);
	const name = part.slice(0, equals).trim();
	const value = part.slice(equals + 1);
	const colon = value.lastIndexOf(":");
	const model = (colon < 0 ? value : value.slice(0, colon)).trim();
	const thinking = colon < 0 ? "" : value.slice(colon + 1).trim();
	const entry: Static<typeof ENTRY> = {};

	if (model !== "") entry.model = model;

	if (thinking !== "") entry.thinking = thinking;

	if (name === "" || (entry.model === undefined && entry.thinking === undefined)) throw new Error(malformed);

	if (!Value.Check(ENTRY, entry)) throw new Error(`'${part}' has a model that is not <provider>/<id>`);

	return [name, entryRole(entry)];
}

/**
 * The roles of the text of `--agents`: parts `<name>=<provider>/<id>:<thinking>`, split on `,`, where `*` is every
 * role. The value splits on its last `:`; without one it is the model. An empty half is not given. Throws the problem
 * of the first bad part.
 */
export function parseRoles(text: string): Roles {
	const roles = new Map<string, Role>();

	for (const raw of text.split(",")) {
		const part = raw.trim();
		const [name, role] = partRole(part);

		if (roles.has(name)) throw new Error(`'${part}' gives ${name} again`);
		roles.set(name, role);
	}

	return Object.fromEntries(roles);
}

/** The role of `name` in `table`: each field of `table[name]`, else of `table["*"]`. */
export function roleOf(table: Roles, name: string): Role {
	const own = Object.hasOwn(table, name) ? table[name] : undefined;
	const all = Object.hasOwn(table, "*") ? table["*"] : undefined;

	return roleWith(own?.model ?? all?.model, own?.thinking ?? all?.thinking);
}

/**
 * One table of `layers`, first layer first: for each name and each field, the first layer whose `roleOf` gives it
 * wins. `roleOf` of the result gives what a lookup layer by layer gives.
 */
export function mergeRoles(layers: readonly Roles[]): Roles {
	const names = new Set(["*", ...layers.flatMap((layer) => Object.keys(layer))]);

	return Object.fromEntries(
		[...names].map((name) => {
			const roles = layers.map((layer) => roleOf(layer, name));

			return [name, roleWith(roles.find((r) => r.model)?.model, roles.find((r) => r.thinking)?.thinking)];
		}),
	);
}
