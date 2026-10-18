/**
 * The Pi prompt templates in `prompts/`. Each template is frontmatter, the instructions, then a last line `$@`, where
 * interactive Pi puts its arguments. The engine sends the instructions followed by its named inputs.
 */

/** The instructions of `prompts/<name>.md`: its body without frontmatter or the last `$@`. */
export function instructions(template: string): string {
	const body = template.startsWith("---\n") ? template.slice(template.indexOf("\n---\n", 4) + 5) : template;
	const trimmed = body.trim();

	return (trimmed.endsWith("$@") ? trimmed.slice(0, -2) : trimmed).trim();
}

/** The instructions, then each non-empty input as a `## <name>` section. */
export function render(body: string, inputs: Record<string, string> = {}): string {
	const sections = Object.entries(inputs)
		.map(([name, value]) => [name, value.trim()] as const)
		.filter(([, value]) => value !== "")
		.map(([name, value]) => `## ${name}\n${value}`);

	return [body, ...sections].join("\n\n");
}
