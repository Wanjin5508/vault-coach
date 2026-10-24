import tseslint from 'typescript-eslint';
import obsidianmd from "eslint-plugin-obsidianmd";
import globals from "globals";
import { globalIgnores } from "eslint/config";

export default tseslint.config(
	{
		languageOptions: {
			globals: {
				...globals.browser,
			},
			parserOptions: {
				projectService: {
					allowDefaultProject: [
						'eslint.config.js',
						'manifest.json'
					]
				},
				tsconfigRootDir: import.meta.dirname,
				extraFileExtensions: ['.json']
			},
		},
	},
	...obsidianmd.configs.recommended,
	globalIgnores([
		"node_modules",
		"dist",
		"esbuild.config.mjs",
		"eslint.config.js",
		"version-bump.mjs",
		"versions.json",
		"main.js",
		"kb/**",
		".history/**",
		".m4-smoke-plugin/**",
		".m4-model-cache/**",
		"benchmark-results/local-ai/**",
	]),
	{
		files: ["scripts/**/*.mjs"],
		languageOptions: {
			globals: {
				...globals.node,
				...globals.browser,
			},
		},
		rules: {
			"import/no-nodejs-modules": "off",
		},
	},
	{
		files: ["tests/**/*.ts", "vitest.config.ts"],
		languageOptions: {
			globals: {
				...globals.node,
			},
		},
		rules: {
			"import/no-nodejs-modules": "off",
		},
	},
);
