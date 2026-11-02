// Model-output: Claude Opus 5.5
// What the integration tests and tests/soak.ts share: the library that they test, and how they
// connect to the database that tests/bootstrap.ts creates. Nothing here needs vitest or a server.

/** The library that the tests test: src/, or the module that POSTGRES_JS names (e.g. dist/index.js) */
export const postgres = (await import(process.env.POSTGRES_JS || "../src/index.ts")).default;

/**
 * @param {number} ms - milliseconds
 * @returns {Promise<void>} a promise that resolves after `ms` milliseconds
 */
export const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {string} x - a path relative to the directory tests/
 * @returns {URL} the file: URL of that path
 */
export const rel = (x) => new URL(x, import.meta.url);

/** The `idle_timeout` (in seconds) of `options` */
export const idle_timeout = 1;

/** The role without a password that tests/bootstrap.ts creates */
export const login = {
	user: "postgres_js_test",
};

/** The role with an MD5 password that tests/bootstrap.ts creates */
export const login_md5 = {
	user: "postgres_js_test_md5",
	pass: "postgres_js_test_md5",
};

/** The role with a SCRAM-SHA-256 password that tests/bootstrap.ts creates */
export const login_scram = {
	user: "postgres_js_test_scram",
	pass: "postgres_js_test_scram",
};

/**
 * The options that connect to the database that tests/bootstrap.ts creates, as the role without a
 * password (the server and port come from the PG* variables). PREPARE=false in the environment
 * turns off prepared statements, and INFER=true turns on `infer`.
 */
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
