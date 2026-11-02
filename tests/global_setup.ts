// Model-output: Claude Opus 5.5
import type { TestProject } from "vitest/node";
import { bootstrap } from "./bootstrap.ts";
import { pg_vars, start_pg_tmp, without_pg_vars } from "./pg_tmp.ts";

declare module "vitest" {
	export interface ProvidedContext {
		/** The PG* variables that point at the `postgres` superuser of the server that the tests use */
		pg_vars: { PGHOST: string; PGPORT: string; PGUSER: string };
		/** The port (on localhost) of a second server, for tests that connect to several hosts */
		second_pg_port: number;
		/** The directory of the Unix socket of the server that `pg_vars` point at */
		pg_socket_dir: string;
	}
}

/**
 * Start the two PostgreSQL servers that the integration tests use (once for the whole run), set up
 * the first one, and provide what tests/setup.ts needs to connect to them.
 *
 * @param project - the vitest project whose tests connect to the servers
 */
export async function setup(project: TestProject): Promise<void> {
	const [first, second] = await Promise.all([start_pg_tmp(), start_pg_tmp()]);
	const first_vars = pg_vars(first.port);
	bootstrap({ ...without_pg_vars(process.env), ...first_vars });

	project.provide("pg_vars", first_vars);
	project.provide("second_pg_port", second.port);
	project.provide("pg_socket_dir", first.socket_dir);
}
