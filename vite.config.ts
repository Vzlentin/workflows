import { defineConfig } from "vite-plus";

export default defineConfig({
	fmt: {
		useTabs: true,
		printWidth: 120,
		singleQuote: false,
		sortImports: { newlinesBetween: false },
		// The workflow scripts and `script.d.ts` keep their own style, without semicolons, and release-please writes its
		// manifest. Markdown keeps its own layout, which Oxfmt would rewrite in `docs/spec.md`, the prompts and `SKILL.md`.
		ignorePatterns: [
			"tools/oxlint/anti-slop/**",
			"workflows/scripts/**",
			"workflows/script.d.ts",
			".release-please-manifest.json",
			"**/*.md",
		],
	},
	lint: {
		ignorePatterns: [
			".agent/**",
			".agents/**",
			".claude/**",
			".codex/**",
			".continue/**",
			".cursor/**",
			".gemini/**",
			".opencode/**",
			".pi/**",
			".roo/**",
			".windsurf/**",
			"tools/oxlint/anti-slop/**",
		],
		jsPlugins: [{ name: "anti-slop", specifier: "./tools/oxlint/anti-slop/index.ts" }],
		rules: {
			"oxc/no-accumulating-spread": "error",
			"anti-slop/no-array-filter-map": "error",
			"anti-slop/no-reduce-accumulator-copy": "error",
			"anti-slop/no-chained-type-assertions": "error",
			"anti-slop/no-conditional-empty-object-spread": "error",
			"anti-slop/no-known-value-widening": "error",
			"anti-slop/no-module-mocking": "error",
			"anti-slop/no-object-parameters": "error",
			"anti-slop/no-reflect-apply": "error",
			"anti-slop/no-reflect-get": "error",
			"anti-slop/no-runtime-typeof": "error",
			"anti-slop/no-shape-in-symbol-names": "error",
			"anti-slop/no-unknown-parameters": "error",
			"anti-slop/no-unknown-returns": "error",
			"anti-slop/no-unknown-type-aliases": "error",
			"anti-slop/no-unsafe-dictionary-type": "error",
			"anti-slop/no-widen-then-assert": "error",
			"anti-slop/require-readable-spacing": "error",
			"anti-slop/require-safety-comment-for-type-assertion": "error",
			// The code turns JSON values into text with `String` on purpose, for the labels, the log lines and the prompts.
			"typescript/no-base-to-string": "off",
		},
		overrides: [
			{
				// A lib file only declares helpers. The scripts call them, after the run puts the lib in front of each script.
				files: ["workflows/lib/*.js"],
				rules: { "no-unused-vars": "off" },
			},
		],
		options: { typeAware: true, typeCheck: true },
	},
	test: {
		// Each test runs a harness host, Git and fake model calls, and slows down with the load of the machine.
		testTimeout: 30_000,
		// A test file uses more than one CPU. With a worker for each CPU, the files slow each other down, and the slowest
		// tests come near their timeouts.
		maxWorkers: "50%",
		// Vite transforms harness, so the hosts of the tests load the entry of this checkout in the module graph of the tests.
		server: { deps: { inline: ["@vzlentin/harness"] } },
	},
	pack: {
		entry: ["src/**/*.ts"],
		unbundle: true,
		fixedExtension: false,
		dts: true,
		sourcemap: true,
	},
});
