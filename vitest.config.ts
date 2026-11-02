// Model-output: Claude Opus 5.5
import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		projects: [
			{
				test: {
					name: "unit",
					include: ["tests/unit/*.ts"],
					exclude: ["tests/unit/build.cases.ts"],
				},
			},
			{
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
