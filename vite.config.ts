import { defineConfig } from "vite-plus";
import type { OxlintOverride } from "vite-plus/lint";

// The groups of `src/` in the order of the import chain of `AGENTS.md`.
const CHAIN = ["workflow", "launch", "run", "records", "cli"];

function banImports(files: string[], group: string[], message: string): OxlintOverride {
	return {
		files,
		rules: { "no-restricted-imports": ["error", { patterns: [{ group, allowTypeImports: true, message }] }] },
	};
}

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
		// The `plugins` key replaces the defaults, so it keeps them. The `import` plugin only finds cycles when it is on here.
		plugins: ["unicorn", "typescript", "oxc", "import"],
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
			{
				// No module import cycle in `src/`. A type-only import does not count, as in `AGENTS.md`.
				files: ["src/**/*.ts"],
				rules: { "import/no-cycle": ["error", { ignoreTypes: true }] },
			},
			// The chain of `CHAIN`: a group imports at runtime only the groups before it.
			...CHAIN.slice(0, -1).map((name, index) =>
				banImports(
					[`src/${name}/**`],
					CHAIN.slice(index + 1).map((later) => `**/${later}/**`),
					`${name}/ imports at runtime only the groups before it in the chain ${CHAIN.join(" ← ")}.`,
				),
			),
			// Pi loads `dist/tool.js` alone in Node, so `tool.ts` imports at runtime only typebox and Node built-in modules.
			banImports(
				["src/tool.ts"],
				["*", "!typebox", "!typebox/*", "!node:*", "!node:*/*"],
				"tool.ts imports at runtime only typebox and node:* modules.",
			),
			// `git.ts`, `githost.ts` and `command.ts` are leaves that every group can import, so they import no group at runtime.
			banImports(
				["src/git.ts", "src/githost.ts", "src/command.ts"],
				CHAIN.map((name) => `**/${name}/**`),
				"A top-level leaf imports no group of src/ at runtime.",
			),
		],
		options: { typeAware: true, typeCheck: true },
	},
	test: {
		// Each test runs a harness host, Git and fake model calls, and slows down with the load of the machine.
		testTimeout: 30_000,
		// Removes the `GIT_*` variables of the caller before each test file loads.
		setupFiles: ["test/setup.ts"],
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
