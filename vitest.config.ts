import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		// Vite transforms harness, so the hosts of the tests load the entry of this checkout in the module graph of the tests.
		server: { deps: { inline: ["@vzlentin/harness"] } },
	},
});
