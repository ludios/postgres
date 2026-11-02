import { spawn } from "child_process";
import { once } from "events";
import fs from "fs";
import net from "net";
import os from "os";
import path from "path";
import { beforeEach, expect, inject } from "vitest";
import { delay, login, options as common_options, postgres } from "./common.ts";
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
/**
 * The port (on localhost) of a second server, which has `ssl` off, for tests that connect to
 * several hosts or need a server without SSL
 */
export const second_pg_port = inject("second_pg_port");
/** The directory of the Unix socket of the server at `pg_port` */
export const pg_socket_dir = inject("pg_socket_dir");

export * from "./common.ts";

/**
 * Create the database of the test file that is importing this module (unless the database exists
 * from an earlier run of that file, in watch mode), so that each file's tables are its own.
 *
 * @returns the name of the database, e.g. "postgres_js_test_queries" for tests/queries.test.ts
 */
async function create_file_database(): Promise<string> {
	const test_path = expect.getState().testPath;
	if (!test_path?.endsWith(".test.ts")) {
		throw new Error("tests/setup.ts must be imported by a *.test.ts file, not by " + test_path);
	}
	const name = "postgres_js_test_" + path.basename(test_path, ".test.ts");
	await using admin = postgres({ db: "postgres", max: 1 });
	const [{ exists }] = await admin`select exists (select from pg_database where datname = ${name})`;
	if (!exists) {
		await admin`create database ${admin(name)} owner ${admin(login.user)}`;
	}
	return name;
}

const db = await create_file_database();

/**
 * The `options` of tests/common.ts, but connecting to the database of the test file that imports
 * this module, which no other test file uses
 */
export const options = { ...common_options, db };

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

/**
 * The pool that the helpers below use, so that a test that leaves `sql` reserved or busy does not
 * delay them
 */
const helper_pool = postgres(options);

/**
 * Sends a backend of the server at `pg_port` the signal to terminate. Does not wait for the backend
 * to exit, or for its client to see the connection close.
 * @param pid - the process ID of the backend (from `pg_backend_pid()`, or the `state.pid` of a
 *   result or of `listen()`)
 * @throws if no backend of that server has the process ID `pid`
 */
export async function terminate(pid: number) {
	const [{ terminated }] =
		await helper_pool`select pg_terminate_backend(${pid}::int) as terminated`;
	if (!terminated) {
		throw new Error("No backend of the server at port " + pg_port + " has the process ID " + pid);
	}
}

/**
 * Waits until a backend of the server at `pg_port` is in `pg_sleep()`.
 * @param pid - the process ID of the backend
 * @throws if no backend of that server has the process ID `pid`
 */
export async function until_sleeping(pid: number) {
	for (;;) {
		const [backend] =
			await helper_pool`select wait_event = 'PgSleep' as sleeping from pg_stat_activity where pid = ${pid}::int`;
		if (!backend) {
			throw new Error("No backend of the server at port " + pg_port + " has the process ID " + pid);
		}
		if (backend.sleeping) {
			return;
		}
		await delay(1);
	}
}

/** A connection through the proxy of proxy_to_server(): the proxy's two sockets */
export type Proxied = {
	/** Which connection through the proxy this is: 1 for the first that a client made */
	number: number;
	/** The proxy's socket to the client */
	client: net.Socket;
	/** The proxy's socket to the server */
	server: net.Socket;
	/** The first chunk that the client sent, once it has sent one */
	first?: Buffer;
};

/** What the proxy of proxy_to_server() does with what passes through it */
export type ProxyHooks = {
	/**
	 * Called with each chunk that the client of connection `c` sends. Returns true to have the proxy
	 * leave the chunk alone (the hook may have written it, or something else, to `c.server` or
	 * `c.client` itself), or false to have the proxy write it to the server. Without the hook, the
	 * proxy forwards every chunk. The proxy does not wait for a chunk that a hook holds back: when
	 * a side closes, the proxy passes the close on at once.
	 */
	from_client?: (chunk: Buffer, c: Proxied) => boolean;
	/**
	 * The same, for each chunk that the server sends on connection `c`: false has the proxy write
	 * the chunk to the client
	 */
	from_server?: (chunk: Buffer, c: Proxied) => boolean;
	/**
	 * Called when the server has closed its side of connection `c`. Returns true to have the proxy
	 * leave its socket to the client as it is, or false to have the proxy end that socket, as it
	 * does without the hook.
	 */
	server_closed?: (c: Proxied) => boolean;
};

/**
 * Starts a TCP proxy to the server at `pg_port`, for a test that meddles with what a client and the
 * server send each other, or with when a connection closes. A side's close reaches the other side
 * only through the proxy, after whatever that side wrote before it, so a client that closes right
 * after a write (as one sending a cancel request does) still gets the write through.
 * @param hooks - what the proxy does with the chunks and the closes of each connection
 * @returns the proxy: `host` and `port` to connect to, and `connections`, one entry per connection
 *   that a client made, oldest first. Declare it with `await using`: its disposal destroys the
 *   connections and closes the proxy.
 */
export async function proxy_to_server(hooks: ProxyHooks = {}) {
	const connections: Proxied[] = [];
	const proxy = net.createServer({ allowHalfOpen: true }, (client) => {
		const c: Proxied = {
			number: connections.length + 1,
			client,
			server: net.connect({ port: pg_port, host: "localhost", allowHalfOpen: true }),
		};
		connections.push(c);
		client.on("data", (x) => {
			c.first ??= x;
			if (!hooks.from_client?.(x, c) && c.server.writable) {
				c.server.write(x);
			}
		});
		c.server.on("data", (x) => {
			if (!hooks.from_server?.(x, c) && client.writable) {
				client.write(x);
			}
		});
		// end() first writes what is still to be written, also on a socket that is still connecting
		client.on("end", () => c.server.end());
		c.server.on("end", () => {
			if (!hooks.server_closed?.(c)) {
				client.end();
			}
		});
		client.on("error", () => c.server.destroy());
		c.server.on("error", () => client.destroy());
	});
	proxy.listen(0, "localhost");
	await once(proxy, "listening");
	const { address, port } = proxy.address() as net.AddressInfo;
	return {
		host: address,
		port,
		connections,
		async [Symbol.asyncDispose]() {
			for (const c of connections) {
				c.client.destroy();
				c.server.destroy();
			}
			await new Promise<void>((r) => proxy.close(() => r()));
		},
	};
}

/**
 * The superuser's pool for the beforeEach below. Only a superuser can drop a `test` that another
 * role created (such as the superuser's own pools in tests/subscribe.test.ts) on PostgreSQL 13 and
 * 14, where the schema public belongs to the superuser, not to the owner of the database.
 */
const reset = postgres({ ...options, user: pg_vars.PGUSER, onnotice: () => {} });
// Before each test of the test file that imports this module (every test file gets its own instance
// of this module), drop the table that many tests create and leave to this hook to drop
beforeEach(async () => {
	await reset`drop table if exists test cascade`;
});

/**
 * Runs `source` as an ES module in a child Node.js process, to see whether that process exits by
 * itself.
 * @param source - the module's source
 * @returns what the child wrote to stdout (trimmed), and whether it exited within 5 seconds (if
 *   not, it was killed)
 */
export async function exits(source: string) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "exits-")),
		file = path.join(dir, "x.mjs");
	fs.writeFileSync(file, source);
	const child = spawn(process.execPath, [file], { env: process.env });
	let out = "";
	child.stdout.on("data", (x) => {
		out += x;
	});
	const exited = await new Promise<boolean>((resolve) => {
		const timer = setTimeout(() => {
			child.kill();
			resolve(false);
		}, 5000);
		child.on("exit", () => {
			clearTimeout(timer);
			resolve(true);
		});
	});
	fs.rmSync(dir, { recursive: true, force: true });
	return { out: out.trim(), exited };
}
