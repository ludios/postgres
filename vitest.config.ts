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
					// One file at a time, because they share the servers, and tables such as `test`
					fileParallelism: false,
				},
			},
		],
	},
});
