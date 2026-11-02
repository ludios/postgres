// Model-output: Claude Opus 5.5
// @ts-nocheck
import { spawnSync } from "child_process";

/**
 * Run a PostgreSQL client program (on the server that the PG* variables point at).
 *
 * @param {string} cmd - the program, e.g. "psql"
 * @param {string[]} args - its arguments
 * @throws {string} the program's stderr, unless it only said that something already exists,
 *   that something does not exist, or warned
 */
export function exec(cmd, args) {
	const { stderr } = spawnSync(cmd, args, { stdio: "pipe", encoding: "utf8" });
	if (
		stderr &&
		!stderr.includes("already exists") &&
		!stderr.includes("does not exist") &&
		!stderr.includes("WARNING:")
	) {
		throw stderr;
	}
}

/**
 * Create the roles and the database that the tests use (replacing any from an earlier run), and
 * turn on `ssl`, on the server that the PG* variables point at.
 */
export function bootstrap() {
	exec("dropdb", ["--force", "postgres_js_test"]);

	exec("psql", ["-c", "alter system set ssl=on"]);
	exec("psql", ["-c", "drop user postgres_js_test"]);
	exec("psql", ["-c", "create user postgres_js_test"]);
	exec("psql", ["-c", "alter system set password_encryption=md5"]);
	exec("psql", ["-c", "select pg_reload_conf()"]);
	exec("psql", ["-c", "drop user if exists postgres_js_test_md5"]);
	exec("psql", ["-c", "create user postgres_js_test_md5 with password 'postgres_js_test_md5'"]);
	exec("psql", ["-c", "alter system set password_encryption='scram-sha-256'"]);
	exec("psql", ["-c", "select pg_reload_conf()"]);
	exec("psql", ["-c", "drop user if exists postgres_js_test_scram"]);
	exec("psql", ["-c", "create user postgres_js_test_scram with password 'postgres_js_test_scram'"]);

	exec("createdb", ["postgres_js_test"]);
	exec("psql", ["-c", "grant all on database postgres_js_test to postgres_js_test"]);
	exec("psql", ["-c", "alter database postgres_js_test owner to postgres_js_test"]);
}
