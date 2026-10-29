import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		// Each test runs a harness host, Git and fake model calls, and slows down with the load of the machine.
		testTimeout: 30_000,
		// Vite transforms harness, so the hosts of the tests load the entry of this checkout in the module graph of the tests.
		server: { deps: { inline: ["@vzlentin/harness"] } },
	},
});
