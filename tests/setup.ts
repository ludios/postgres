// Model-output: Claude Opus 5.5
// @ts-nocheck
import { bootstrap, exec } from "./bootstrap.js";
import { start_pg_tmp } from "./pg_tmp.js";
import { t } from "./test.js";

if (process.env.POOLER_PORT) {
	throw new Error(
		"POOLER_PORT is not supported: PgBouncer cannot point at the servers that pg_tmp starts for this run",
	);
}

// The second server is for the tests that connect to several hosts
const [first, second] = await Promise.all([start_pg_tmp(), start_pg_tmp()]);

// Point the PG* variables at the first server's `postgres` superuser, replacing any that this
// process was started with
for (const name of Object.keys(process.env)) {
	if (name.startsWith("PG")) {
		delete process.env[name];
	}
}
process.env.PGHOST = "localhost";
process.env.PGPORT = String(first.port);
process.env.PGUSER = "postgres";
bootstrap();

/** The port (on localhost) of the server that the tests use, which the PG* variables point at */
export const pg_port = first.port;
/** The port (on localhost) of a second server, for tests that connect to several hosts */
export const second_pg_port = second.port;
/** The directory of the Unix socket of the server at `pg_port` */
export const pg_socket_dir = first.socket_dir;

const postgres = (await import(process.env.POSTGRES_JS || "../src/index.js")).default;

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
t.before = () => reset`drop table if exists test cascade`.catch(() => {});
