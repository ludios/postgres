// Model-output: Claude Opus 5.5
// @ts-nocheck
import { execFile } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { promisify } from "util";

const run = promisify(execFile);

/** Seconds between pg_tmp's checks for a connected client (pg_tmp's -w) */
const check_interval = 120;

const hba_file = fileURLToPath(new URL("pg_hba.conf", import.meta.url));

/**
 * @param {NodeJS.ProcessEnv} env - an environment
 * @returns {NodeJS.ProcessEnv} `env` without the PG* variables, which would otherwise choose the
 *   server, the user, and other settings of PostgreSQL client programs (including pg_tmp's port, and
 *   the user that pg_tmp's checks for a connected client log in as)
 */
export function without_pg_vars(env) {
	return Object.fromEntries(Object.entries(env).filter(([name]) => !name.startsWith("PG")));
}

/**
 * Delete every PG* variable from this process's environment, and then set `vars`.
 *
 * @param {Record<string, string>} vars - the PG* variables to set (or none, to only delete)
 */
export function replace_pg_vars(vars) {
	for (const name of Object.keys(process.env)) {
		if (name.startsWith("PG")) {
			delete process.env[name];
		}
	}
	Object.assign(process.env, vars);
}

/**
 * @param {number} port - the port (on localhost) of a server that `start_pg_tmp` started
 * @returns {{ PGHOST: string, PGPORT: string, PGUSER: string }} the PG* variables that point
 *   PostgreSQL client programs (and this library's defaults) at that server's `postgres` superuser
 */
export function pg_vars(port) {
	return { PGHOST: "localhost", PGPORT: String(port), PGUSER: "postgres" };
}

/**
 * @param {string} s - any string
 * @returns {string} `s` quoted for the shell that pg_ctl starts the server with
 */
function sh_quote(s) {
	return "'" + s.replaceAll("'", "'\\''") + "'";
}

/**
 * Write a self-signed certificate for localhost, for the server to use whenever `ssl` is on.
 *
 * @param {string} dir - the directory to write `server.crt` and `server.key` into
 * @param {NodeJS.ProcessEnv} env - the environment to run openssl in
 * @returns {Promise<{ cert: string, key: string }>} the paths of the certificate and of its private key
 */
async function write_certificate(dir, env) {
	const cert = path.join(dir, "server.crt");
	const key = path.join(dir, "server.key");
	const args = ["req", "-new", "-x509", "-nodes", "-days", "3650", "-subj", "/CN=localhost"];
	await run("openssl", [...args, "-keyout", key, "-out", cert], { env });
	// The server refuses a private key that other users can read
	fs.chmodSync(key, 0o600);
	return { cert, key };
}

/**
 * Start a throwaway PostgreSQL server with pg_tmp, set up for the tests: tests/pg_hba.conf, a
 * certificate (`ssl` itself stays off until ALTER SYSTEM turns it on), logical decoding, prepared
 * transactions, and a `postgres` superuser.
 *
 * pg_tmp checks every `check_interval` seconds whether a client is connected, and the first check
 * that finds no client stops the server and deletes its directory. So the server is gone within
 * about `check_interval` seconds after this process exits; but in a run of more than
 * `check_interval` seconds, a check can find no client during a pause between tests, and stop the
 * server before the run ends.
 *
 * @returns {Promise<{ port: number, socket_dir: string }>} the server's port (on localhost), and the
 *   directory of its Unix socket
 */
export async function start_pg_tmp() {
	const env = without_pg_vars(process.env);
	// With -t (TCP), pg_tmp's URL does not say where the Unix socket is, so we choose the directory (-d)
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "postgres_js_test."));
	let url;
	try {
		const cert = await write_certificate(dir, env);
		const settings = {
			listen_addresses: "localhost",
			hba_file,
			ssl_cert_file: cert.cert,
			ssl_key_file: cert.key,
			wal_level: "logical",
			max_prepared_transactions: "100",
		};
		const pg_options = Object.entries(settings)
			.map(([name, value]) => "-c " + sh_quote(name + "=" + value))
			.join(" ");
		const args = ["-t", "-d", dir, "-w", String(check_interval), "-o", pg_options];
		url = (await run("pg_tmp", args, { env })).stdout;
	} catch (e) {
		// pg_tmp deletes `dir` itself only in some of the ways that it can fail
		fs.rmSync(dir, { recursive: true, force: true });
		throw e;
	}
	const port = new URL(url).port;
	if (!/^[0-9]+$/.test(port)) {
		throw new Error("pg_tmp printed a URL without a port: " + url);
	}

	// initdb named the bootstrap superuser after the user who ran pg_tmp
	if (os.userInfo().username !== "postgres") {
		const create = ["-X", "-q", "-v", "ON_ERROR_STOP=1", "-h", dir, "-p", port, "-d", "test"];
		await run("psql", [...create, "-c", "create role postgres superuser login"], { env });
	}
	return { port: +port, socket_dir: dir };
}
