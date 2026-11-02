// Model-output: Claude Opus 5.5
// @ts-nocheck
import { beforeEach, inject } from "vitest";
import { exec } from "./bootstrap.ts";

// Point the PG* variables at the `postgres` superuser of the server that tests/global_setup.ts
// started for the tests, replacing any that this process was started with
const pg_vars = inject("pg_vars");
for (const name of Object.keys(process.env)) {
	if (name.startsWith("PG")) {
		delete process.env[name];
	}
}
Object.assign(process.env, pg_vars);

/** The port (on localhost) of the server that the tests use, which the PG* variables point at */
export const pg_port = +pg_vars.PGPORT;
/** The port (on localhost) of a second server, for tests that connect to several hosts */
export const second_pg_port = inject("second_pg_port");
/** The directory of the Unix socket of the server at `pg_port` */
export const pg_socket_dir = inject("pg_socket_dir");

const postgres = (await import(process.env.POSTGRES_JS || "../src/index.ts")).default;

export { exec, postgres };

const log = console.log;
const notice = (x) =>
	x && typeof x === "object" && "severity_local" in x && !/^(ERROR|FATAL|PANIC)$/.test(x.severity);
console.log = (...xs) => (xs.length === 1 && notice(xs[0]) ? undefined : log(...xs));

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

export const sql = postgres(options);

const reset = postgres({ ...options, onnotice: () => {} });
// Before each test of the test file that imports this module (every test file gets its own instance
// of this module), drop the table that many tests create
beforeEach(() => reset`drop table if exists test cascade`.catch(() => {}));
