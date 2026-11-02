import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		// `vitest run --coverage` prints the coverage of each file in src/
		coverage: {
			provider: "v8",
			include: ["src/**"],
			reporter: ["text"],
		},
		// A test that never calls `expect` fails, instead of passing without checking anything
		expect: { requireAssertions: true },
		projects: [
			{
				extends: true,
				test: {
					name: "unit",
					include: ["tests/unit/*.test.ts"],
					setupFiles: ["tests/unit/setup.ts"],
				},
			},
			{
				extends: true,
				test: {
					name: "integration",
					include: ["tests/*.test.ts"],
					globalSetup: ["tests/global_setup.ts"],
					// Many of these tests need more than vitest's default of 5 seconds
					// A test that needs more than 10 seconds passes its timeout as the
					// third argument of test, after the function. oxfmt keeps the first line
					// of a test call unbroken only in that form, not when the timeout is in
					// an options object before the function.
					testTimeout: 10_000,
				},
			},
		],
	},
});
