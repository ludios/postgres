import { spawn } from "child_process";
import type { TestProject } from "vitest/node";
import { bootstrap } from "./bootstrap.ts";
import { pg_env, pg_vars, type PgVars } from "./pg_env.ts";
import { start_pg_tmp } from "./pg_tmp.ts";

declare module "vitest" {
	export interface ProvidedContext {
		/** The PG* variables that point at the `postgres` superuser of the server that the tests use */
		pg_vars: PgVars;
		/** The port (on localhost) of a second server, for tests that connect to several hosts */
		second_pg_port: number;
		/** The directory of the Unix socket of the server that `pg_vars` point at */
		pg_socket_dir: string;
	}
}

/**
 * Open a psql session that stays idle, so that pg_tmp does not stop the server: pg_tmp stops it at
 * the first periodic check that finds no session, and the servers must last as long as vitest runs
 * (in watch mode, vitest reruns the tests with the same servers, maybe hours later).
 *
 * @param port - the port (on localhost) of a server that `start_pg_tmp` started
 * @returns a function that ends the session
 */
function hold_session(port: number): () => void {
	const psql = spawn("psql", ["-X", "-q", "-d", "postgres"], {
		env: pg_env(port),
		stdio: ["pipe", "ignore", "inherit"],
	});
	let ending = false;
	const report = (what: string) => {
		if (!ending) {
			console.error(
				"The psql that holds a session to the server at port " +
					port +
					" " +
					what +
					", so pg_tmp will stop that server at its next check for a connected client",
			);
		}
	};
	psql.on("error", (error) => report("failed: " + error.message));
	psql.on("exit", (code, signal) => report("exited (code " + code + ", signal " + signal + ")"));
	return () => {
		ending = true;
		psql.stdin.end();
	};
}

/**
 * Start the two PostgreSQL servers that the integration tests use (once for the whole run), set up
 * the first one, and provide what tests/setup.ts needs to connect to them.
 *
 * @param project - the vitest project whose tests connect to the servers
 * @returns the teardown, which lets pg_tmp stop the servers
 */
export async function setup(project: TestProject): Promise<() => void> {
	const [first, second] = await Promise.all([start_pg_tmp(), start_pg_tmp()]);
	bootstrap(pg_env(first.port));
	const end_sessions = [first, second].map((server) => hold_session(server.port));

	project.provide("pg_vars", pg_vars(first.port));
	project.provide("second_pg_port", second.port);
	project.provide("pg_socket_dir", first.socket_dir);
	return () => {
		for (const end of end_sessions) {
			end();
		}
	};
}
