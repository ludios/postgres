// Model-output: Claude Opus 5.5
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
					include: ["tests/unit/*.ts"],
					exclude: ["tests/unit/build.cases.ts"],
				},
			},
			{
				extends: true,
				test: {
					name: "integration",
					include: [
						"tests/{queries,types,rows,build,transactions,reserve,connection,errors}.ts",
						"tests/{prepared,transform,cursors,copy,listen,subscribe,startup,tracing}.ts",
					],
					globalSetup: ["tests/global_setup.ts"],
					// One file at a time, because they share the servers, and tables such as `test`
					fileParallelism: false,
				},
			},
		],
	},
});
