import { beforeEach, inject } from "vitest";
import { options, postgres } from "./common.ts";
import { replace_pg_vars } from "./pg_env.ts";

// Point the PG* variables at the `postgres` superuser of the server that tests/global_setup.ts
// started for the tests, replacing any that this process was started with
const pg_vars = inject("pg_vars");
if (!pg_vars) {
	throw new Error(
		"tests/setup.ts works only in the vitest project `integration`, whose globalSetup starts the servers",
	);
}
replace_pg_vars(pg_vars);

/** The port (on localhost) of the server that the tests use, which the PG* variables point at */
export const pg_port = +pg_vars.PGPORT;
/** The port (on localhost) of a second server, for tests that connect to several hosts */
export const second_pg_port = inject("second_pg_port");
/** The directory of the Unix socket of the server at `pg_port` */
export const pg_socket_dir = inject("pg_socket_dir");

export * from "./common.ts";

const log = console.log;
const notice = (x) =>
	x && typeof x === "object" && "severity_local" in x && !/^(ERROR|FATAL|PANIC)$/.test(x.severity);
console.log = (...xs) => (xs.length === 1 && notice(xs[0]) ? undefined : log(...xs));

export const sql = postgres(options);

/**
 * @returns {Promise<number>} the major version of PostgreSQL (e.g. 17) that the server at `pg_port` runs
 */
export async function server_major() {
	const [{ version_num }] =
		await sql`select current_setting('server_version_num')::int as version_num`;
	// Since PostgreSQL 10, server_version_num is the major version × 10000 + the minor version
	return Math.floor(version_num / 10000);
}

const reset = postgres({ ...options, onnotice: () => {} });
// Before each test of the test file that imports this module (every test file gets its own instance
// of this module), drop the table that many tests create
beforeEach(() => reset`drop table if exists test cascade`.catch(() => {}));
