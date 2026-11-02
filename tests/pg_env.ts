// Model-output: Claude Opus 5.5
// The PG* environment variables choose the server, the user, and other settings of PostgreSQL
// client programs, and also the defaults of this library's options.

/** The PG* variables that point at the `postgres` superuser of a server on localhost */
export type PgVars = { PGHOST: string; PGPORT: string; PGUSER: string };

/**
 * @param env - an environment
 * @returns `env` without its PG* variables
 */
export function without_pg_vars(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	return Object.fromEntries(Object.entries(env).filter(([name]) => !name.startsWith("PG")));
}

/**
 * @param port - the port (on localhost) of a server that `start_pg_tmp` (in tests/pg_tmp.ts)
 *   started
 * @returns the PG* variables that point at that server's `postgres` superuser
 */
export function pg_vars(port: number): PgVars {
	return { PGHOST: "localhost", PGPORT: String(port), PGUSER: "postgres" };
}

/**
 * @param port - the port (on localhost) of a server that `start_pg_tmp` (in tests/pg_tmp.ts)
 *   started
 * @returns this process's environment, with its PG* variables replaced by `pg_vars(port)`
 */
export function pg_env(port: number): NodeJS.ProcessEnv {
	return { ...without_pg_vars(process.env), ...pg_vars(port) };
}

/**
 * Delete every PG* variable from this process's environment, and then set the variables in `vars`.
 *
 * @param vars - the PG* variables to set (`{}` to set none)
 * @throws {Error} if the name of a variable in `vars` does not start with "PG"
 */
export function replace_pg_vars(vars: Record<string, string>): void {
	for (const name of Object.keys(vars)) {
		if (!name.startsWith("PG")) {
			throw new Error("replace_pg_vars sets only PG* variables, not " + name);
		}
	}
	for (const name of Object.keys(process.env)) {
		if (name.startsWith("PG")) {
			delete process.env[name];
		}
	}
	Object.assign(process.env, vars);
}
