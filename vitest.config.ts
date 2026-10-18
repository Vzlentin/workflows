import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		// harness is TypeScript under node_modules, which Node does not strip, so Vite transforms it.
		server: { deps: { inline: ["harness"] } },
	},
});
