// Model-output: Claude Opus 5.5
import { spawnSync } from "child_process";

/**
 * Run a PostgreSQL client program on the server that the PG* variables point at.
 *
 * @param {string} cmd - the program, e.g. "psql"
 * @param {string[]} args - its arguments
 * @throws {Error} if the program could not run, or did not exit with status 0
 */
export function exec(cmd, args) {
	const { error, status, stderr } = spawnSync(cmd, args, { stdio: "pipe", encoding: "utf8" });
	if (error) {
		throw error;
	}
	if (status !== 0) {
		throw new Error(`${cmd} ${args.join(" ")} exited with status ${status}: ${stderr}`);
	}
}

/**
 * Turn on `ssl`, and create the roles and the database that the tests use, on the server that the
 * PG* variables point at (which must not have those roles and that database yet).
 */
export function bootstrap() {
	const commands = [
		"alter system set ssl=on",
		"select pg_reload_conf()",
		"create user postgres_js_test",
		// In this session only, so that no reload has to happen before the next CREATE USER
		"set password_encryption=md5",
		"create user postgres_js_test_md5 with password 'postgres_js_test_md5'",
		"set password_encryption='scram-sha-256'",
		"create user postgres_js_test_scram with password 'postgres_js_test_scram'",
		"create database postgres_js_test owner postgres_js_test",
	];
	exec("psql", ["-X", "-q", "-v", "ON_ERROR_STOP=1", ...commands.flatMap((sql) => ["-c", sql])]);
}
