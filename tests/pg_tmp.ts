import { execFile } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { promisify } from "util";
import { without_pg_vars } from "./pg_env.ts";

const run = promisify(execFile);

/** Seconds between pg_tmp's checks for a connected client (pg_tmp's -w) */
const check_interval = 120;

const hba_file = fileURLToPath(new URL("pg_hba.conf", import.meta.url));

/**
 * @param {string} s - any string
 * @returns {string} `s` quoted for the shell that pg_ctl starts the server with
 */
function sh_quote(s: string) {
	return "'" + s.replaceAll("'", "'\\''") + "'";
}

/**
 * Write a self-signed certificate for localhost, for the server to use whenever `ssl` is on.
 *
 * @param {string} dir - the directory to write `server.crt` and `server.key` into
 * @param {NodeJS.ProcessEnv} env - the environment to run openssl in
 * @returns {Promise<{ cert: string, key: string }>} the paths of the certificate and of its private key
 */
async function write_certificate(dir: string, env: NodeJS.ProcessEnv) {
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
 * transactions, room for the connections of test files that run in parallel, and a `postgres`
 * superuser.
 *
 * pg_tmp checks every `check_interval` seconds whether a client is connected, and the first check
 * that finds no client stops the server and deletes its directory. So the server is gone within
 * about `check_interval` seconds after its last client disconnects; a caller that needs the server
 * during a longer time without clients (e.g. between tests) must keep a session open.
 *
 * @returns {Promise<{ port: number, socket_dir: string }>} the server's port (on localhost), and the
 *   directory of its Unix socket
 */
export async function start_pg_tmp() {
	// PG* variables would choose pg_tmp's port, and the user that pg_tmp's checks for a connected
	// client log in as
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
			// The default is 100, and the integration test files, which run in parallel, were seen
			// using 64 connections at once
			max_connections: "200",
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
