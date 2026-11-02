// Model-output: Claude Opus 5.5
// @ts-nocheck
// What the integration tests and tests/soak.ts share: the library that they test, and how they
// connect to the database that tests/bootstrap.ts creates. Nothing here needs vitest or a server.

/** The library that the tests test: src/, or the module that POSTGRES_JS names (e.g. dist/index.js) */
export const postgres = (await import(process.env.POSTGRES_JS || "../src/index.ts")).default;

export const delay = (ms) => new Promise((r) => setTimeout(r, ms));
export const rel = (x) => new URL(x, import.meta.url);
export const idle_timeout = 1;

export const login = {
	user: "postgres_js_test",
};

export const login_md5 = {
	user: "postgres_js_test_md5",
	pass: "postgres_js_test_md5",
};

export const login_scram = {
	user: "postgres_js_test_scram",
	pass: "postgres_js_test_scram",
};

export const options = {
	db: "postgres_js_test",
	user: login.user,
	pass: login.pass,
	idle_timeout,
	connect_timeout: 1,
	max: 1,
	...(process.env.PREPARE === "false" ? { prepare: false } : {}),
	...(process.env.INFER === "true" ? { infer: true } : {}),
};
