import { defineConfig } from "vite-plus";

export default defineConfig({
	resolve: {
		tsconfigPaths: true,
	},

	fmt: {
		useTabs: true,
		printWidth: 100,
		sortImports: {
			newlinesBetween: false,
			internalPattern: ["@proxy/"],
		},
		// Prose and generated files stay as written.
		ignorePatterns: ["**/*.md", "pnpm-lock.yaml"],
	},

	lint: {
		ignorePatterns: ["dist/**"],
		options: {
			typeAware: true,
			typeCheck: true,
		},
		plugins: ["typescript", "unicorn", "import"],
		jsPlugins: [
			{ name: "zod", specifier: "eslint-plugin-zod" },
			{ name: "@limegrass/import-alias", specifier: "@limegrass/eslint-plugin-import-alias" },
			{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" },
			"./lint/repo-rules.ts",
		],
		rules: {
			// Type-aware safety
			"typescript/no-floating-promises": "error",
			"typescript/no-misused-promises": "error",
			"typescript/no-deprecated": "error",
			"typescript/await-thenable": "error",
			"typescript/strict-boolean-expressions": "error",
			"typescript/consistent-type-assertions": "error",
			"typescript/no-unnecessary-type-assertion": "error",
			"typescript/no-unsafe-type-assertion": "error",
			"typescript/no-unsafe-assignment": "error",
			"typescript/no-unsafe-call": "error",
			"typescript/no-unsafe-member-access": "error",
			"typescript/no-unsafe-return": "error",
			"typescript/no-unsafe-argument": "error",
			"typescript/no-unnecessary-condition": "error",
			"typescript/only-throw-error": "error",

			// Style and correctness (formerly enforced by Biome)
			"typescript/no-explicit-any": "error",
			"typescript/no-invalid-void-type": "error",
			"typescript/consistent-type-imports": "error",
			"typescript/array-type": ["error", { default: "array" }],
			"typescript/no-unnecessary-type-constraint": "error",
			"unicorn/prefer-node-protocol": "error",
			"unicorn/new-for-builtins": "error",
			"unicorn/explicit-length-check": "error",
			"unicorn/no-array-for-each": "error",
			"no-unused-vars": [
				"error",
				{
					args: "all",
					argsIgnorePattern: "^_",
					varsIgnorePattern: "^_",
					caughtErrors: "none",
				},
			],
			"repo/no-enum": "error",
			"repo/no-delete": "error",
			"repo/no-implicit-any-let": "error",
			"import/namespace": "error",

			// Zod
			"zod/array-style": "error",
			"zod/consistent-import": "error",
			"zod/consistent-import-source": ["error", { sources: ["zod", "zod/mini"] }],
			"zod/consistent-object-schema-type": ["error", { allow: ["object", "looseObject"] }],
			"zod/no-any-schema": "error",
			"zod/no-empty-custom-schema": "error",
			"zod/no-number-schema-with-int": "error",
			"zod/no-string-schema-with-uuid": "error",
			"zod/no-optional-and-default-together": ["error", { preferredMethod: "default" }],
			"zod/no-throw-in-refine": "error",
			"zod/no-unknown-schema": "off",
			"zod/prefer-enum-over-literal-union": "error",
			"zod/prefer-meta": "error",
			"zod/prefer-meta-last": "error",
			"zod/prefer-string-schema-with-trim": "error",
			"zod/require-brand-type-parameter": "error",
			"zod/require-error-message": "error",
			"zod/require-schema-suffix": "error",
			"zod/schema-error-property-style": "error",

			"@limegrass/import-alias/import-alias": "error",
			"vite-plus/prefer-vite-plus-imports": "error",
		},
		overrides: [
			{
				files: ["**/*.test.ts"],
				rules: {
					"typescript/await-thenable": "off",
					"typescript/unbound-method": "off",
					"typescript/no-floating-promises": "off",
					"typescript/no-unsafe-assignment": "off",
					"typescript/no-unsafe-member-access": "off",
					"typescript/no-unsafe-argument": "off",
					"typescript/consistent-type-assertions": "off",
					"typescript/no-unnecessary-type-assertion": "off",
					"typescript/no-unsafe-type-assertion": "off",
				},
			},
		],
	},

	test: {
		include: ["test/**/*.test.ts"],
	},

	pack: {
		entry: {
			index: "src/index.ts",
			config: "src/config/schema.ts",
			exposure: "src/openai/model-exposure.ts",
			"sync-zed": "src/sync/zed.ts",
		},
		format: ["esm"],
		dts: true,
		clean: true,
		banner: (chunk) => {
			if (chunk.fileName === "index.mjs") {
				return { js: "#!/usr/bin/env node" };
			}
			return {};
		},
		deps: {
			neverBundle: ["@earendil-works/pi-ai", "@earendil-works/pi-coding-agent"],
		},
	},

	staged: {
		"*": "vp check --fix",
	},
});
