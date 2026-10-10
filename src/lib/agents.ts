/**
 * What sessions run with: the tools, and the system prompt sections with the project instructions and skills that Pi
 * loads for the session's directory. Sessions get no tools from Pi extension packages.
 */
import type { ImageContent, ModelThinkingLevel, Static, TextContent, TSchema } from "@earendil-works/pi-ai";
import {
	createFindTool,
	createGrepTool,
	createLsTool,
	formatSkillsForPrompt,
	getAgentDir,
	loadProjectContextFiles,
	loadSkills,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
	type AgentChange,
	defineExtension,
	defineTool,
	type ModelRef,
	type PromptInput,
	section,
	type ToolRegistration,
} from "@earendil-works/pi-durable";
import { createBashTool, createEditTool, createReadTool, createWriteTool } from "@earendil-works/pi-durable/tools";

/** The model, thinking level and tool names of a session. */
export type AgentChoice = {
	readonly model: ModelRef;
	readonly thinkingLevel: ModelThinkingLevel;
	readonly tools: readonly string[];
};

/** The part of a Pi coding agent tool that a durable tool needs. */
type PiTool<T extends TSchema> = {
	readonly name: string;
	readonly description: string;
	readonly parameters: T;
	execute(
		id: string,
		args: Static<T>,
		signal?: AbortSignal,
	): Promise<{ readonly content: (TextContent | ImageContent)[] }>;
};

/** A Pi coding agent tool as a durable tool that runs in the calling session's directory. */
function piTool<T extends TSchema>(create: (cwd: string) => PiTool<T>): ToolRegistration {
	const { name, description, parameters } = create(".");
	return defineTool({
		name,
		description,
		parameters,
		replay: "safe",
		execute: async (args, api, context) => {
			const { cwd = "." } = await api.agent(context);
			const result = await create(cwd).execute(api.callId, args, context.abortSignal);
			return { content: result.content };
		},
	});
}

const TOOLS: readonly ToolRegistration[] = [
	createReadTool(),
	piTool(createGrepTool),
	piTool(createFindTool),
	piTool(createLsTool),
	createWriteTool(),
	createEditTool(),
	createBashTool(),
];

type Resources = { readonly context?: string; readonly skills?: string };
const resources = new Map<string, Resources>();

/** Project instructions and skills of `cwd`, loaded once per directory as Pi does at startup. */
function resourcesOf(cwd: string): Resources {
	let found = resources.get(cwd);
	if (found === undefined) {
		const agentDir = getAgentDir();
		const files = loadProjectContextFiles({ cwd, agentDir });
		const skillPaths = SettingsManager.create(cwd, agentDir).getSkillPaths();
		const skills = formatSkillsForPrompt(loadSkills({ cwd, agentDir, skillPaths, includeDefaults: true }).skills);
		found = {
			...(files.length === 0
				? {}
				: {
						context: [
							"Project-specific instructions and guidelines:",
							...files.map(
								({ path, content }) => `<project_instructions path="${path}">\n${content}\n</project_instructions>`,
							),
						].join("\n\n"),
					}),
			...(skills.trim() === "" ? {} : { skills: skills.trim() }),
		};
		resources.set(cwd, found);
	}
	return found;
}

const cwdOf = (input: PromptInput): string | undefined => input.env?.cwd ?? input.agent.cwd;

export const Sessions = defineExtension({
	name: "workflows-sessions",
	tools: TOOLS,
	sections: [
		section("project_context", (input) => resourcesOf(cwdOf(input) ?? ".").context, { tag: false }),
		section("skills", (input) => resourcesOf(cwdOf(input) ?? ".").skills, { tag: false }),
		section("cwd", cwdOf),
	],
});

/** The `pi.agent` change that makes a conversation a session of `choice` in `cwd`. */
export function sessionAgent(choice: AgentChoice, cwd: string): AgentChange {
	return {
		model: choice.model,
		thinkingLevel: choice.thinkingLevel,
		extensions: [Sessions],
		tools: choice.tools.map((name) => {
			const tool = TOOLS.find((candidate) => candidate.name === name);
			if (tool === undefined) throw new Error(`Unknown tool ${name}`);
			return tool;
		}),
		cwd,
	};
}
