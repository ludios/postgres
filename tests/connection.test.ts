import net from "net";
import tls from "tls";
import crypto from "crypto";
import { expect, onTestFinished, test } from "vitest";
import type { Sql, ReservedSql } from "../types/index.js";
import { notable } from "../src/pool.ts";
import {
	postgres,
	library,
	sql,
	options,
	login,
	login_md5,
	login_scram,
	delay,
	idle_timeout,
	pg_port,
	second_pg_port,
	pg_socket_dir,
	port_of,
	server_major,
	terminate,
	until_sleeping,
	exits,
	defer,
	proxy_to_server,
} from "./setup.ts";

test("Connects with no options", async () => {
	await using sql = postgres({ max: 1 });

	const result = (await sql`select 1 as x`)[0].x;

	expect(result).toBe(1);
});

test("Uses default database without slash", async () => {
	const sql = postgres("postgres://localhost");
	expect(sql.options.database).toBe(sql.options.user);
});

test("Uses default database with slash", async () => {
	const sql = postgres("postgres://localhost/");
	expect(sql.options.database).toBe(sql.options.user);
});

test("Connect using uri", async () => {
	expect(
		await new Promise((resolve, reject) => {
			const sql = postgres(
				"postgres://" +
					login.user +
					":" +
					(login.pass || "") +
					"@localhost:" +
					pg_port +
					"/" +
					options.db,
				{
					idle_timeout,
				},
			);
			sql`select 1`.then(() => resolve(true), reject);
		}),
	).toBe(true);
});

test("Options from uri with special characters in user and pass", async () => {
	const opt = postgres({ user: "öla", pass: "pass^word" }).options;
	expect([opt.user, opt.pass]).toEqual(["öla", "pass^word"]);
});

test("Fail with proper error on no host", async () => {
	expect(
		(
			await new Promise<any>((resolve, reject) => {
				const sql = postgres("postgres://localhost:33333/" + options.db, {
					idle_timeout,
				});
				sql`select 1`.then(reject, resolve);
			})
		).code,
	).toBe("ECONNREFUSED");
});

test("Connect using SSL", async () => {
	expect(
		await new Promise((resolve, reject) => {
			postgres({
				ssl: { rejectUnauthorized: false },
				idle_timeout,
			})`select 1`.then(() => resolve(true), reject);
		}),
	).toBe(true);
});

test("Connect using SSL require", async () => {
	expect(
		await new Promise((resolve, reject) => {
			postgres({
				ssl: "require",
				idle_timeout,
			})`select 1`.then(() => resolve(true), reject);
		}),
	).toBe(true);
});

test("Connect using SSL direct", async ({ skip }) => {
	const major = await server_major();
	skip(major < 17, "direct TLS needs PostgreSQL 17 or later");
	expect(
		await new Promise((resolve, reject) => {
			postgres({
				ssl: "require",
				sslnegotiation: "direct",
				idle_timeout,
			})`select 1`.then(() => resolve(true), reject);
		}),
	).toBe(true);
});

test("Connect using SSL prefer to a server without SSL", async () => {
	// The server at second_pg_port has `ssl` off
	const sql = postgres({
		ssl: "prefer",
		idle_timeout,
		port: second_pg_port,
	});

	const [{ ssl }] = await sql`select ssl from pg_stat_ssl where pid = pg_backend_pid()`;
	expect(ssl).toBe(false);
});

test("Reconnect using SSL", async () => {
	const sql = postgres({
		ssl: "require",
		idle_timeout: 0.1,
	});

	await sql`select 1`;
	await delay(200);

	expect((await sql`select 1 as x`)[0].x).toBe(1);
});

test("An ssl object without a ca builds a TLS context per connection, and with one a context its connections share until a value changes", async () => {
	const create = tls.createSecureContext,
		ssl: { rejectUnauthorized: boolean; ca?: string[] } = { rejectUnauthorized: false };
	await using sql = postgres({ ...options, ssl, max: 6 });
	let built = 0;
	tls.createSecureContext = (...xs) => {
		built++;
		return create(...xs);
	};
	onTestFinished(() => {
		tls.createSecureContext = create;
	});
	const reserved = [await sql.reserve(), await sql.reserve(), await sql.reserve()],
		without = built;
	ssl.ca = tls.rootCertificates as string[];
	reserved.push(await sql.reserve(), await sql.reserve());
	const shared = built;
	ssl.ca = [...tls.rootCertificates];
	reserved.push(await sql.reserve());
	reserved.forEach((x) => x.release());
	expect([without, shared, built]).toEqual([3, 4, 5]);
});

test("Login without password", async () => {
	expect((await postgres({ ...options, ...login })`select true as x`)[0].x).toBe(true);
});

test("Login using MD5", async () => {
	expect((await postgres({ ...options, ...login_md5 })`select true as x`)[0].x).toBe(true);
});

test("Login using scram-sha-256", async () => {
	expect((await postgres({ ...options, ...login_scram })`select true as x`)[0].x).toBe(true);
});

test("Parallel connections using scram-sha-256", async () => {
	const sql = postgres({ ...options, ...login_scram });
	expect(
		(
			await Promise.all([
				sql`select true as x, pg_sleep(0.01)`,
				sql`select true as x, pg_sleep(0.01)`,
				sql`select true as x, pg_sleep(0.01)`,
			])
		)[0][0].x,
	).toBe(true);
}, 2000);

test("Support dynamic password function", async () => {
	expect(
		(
			await postgres({
				...options,
				...login_scram,
				pass: () => "postgres_js_test_scram",
			})`select true as x`
		)[0].x,
	).toBe(true);
});

test("Support dynamic async password function", async () => {
	expect(
		(
			await postgres({
				...options,
				...login_scram,
				pass: () => Promise.resolve("postgres_js_test_scram"),
			})`select true as x`
		)[0].x,
	).toBe(true);
});

test("Connection ended promise", async () => {
	const sql = postgres(options);

	await sql.end();

	expect(await sql.end()).toBe(undefined);
});

test("Connection ended timeout", async () => {
	const sql = postgres(options);

	await sql.end({ timeout: 10 });

	expect(await sql.end()).toBe(undefined);
});

test("Connection ended error", async () => {
	const sql = postgres(options);
	await sql.end();
	expect(await sql``.catch((x) => x.code)).toBe("CONNECTION_ENDED");
});

test("Connection end does not cancel query", async () => {
	const sql = postgres(options);

	const promise = sql`select 1 as x`.execute();

	await sql.end();

	expect((await promise)[0].x).toBe(1);
});

test("Connection destroyed", async () => {
	const sql = postgres(options);
	process.nextTick(() => sql.end({ timeout: 0 }));
	expect(await sql``.catch((x) => x.code)).toBe("CONNECTION_DESTROYED");
});

test("Connection destroyed with query before", async () => {
	const sql = postgres(options),
		error = sql`select pg_sleep(0.2)`.catch((err) => err.code);

	void sql.end({ timeout: 0 });
	expect(await error).toBe("CONNECTION_DESTROYED");
});

test("A query that sql.close() waits for gets CONNECTION_CLOSED, not CONNECTION_DESTROYED, if the connection's socket is lost", async () => {
	let raw!: net.Socket;
	await using sql = postgres({
		...options,
		max: 1,
		socket: () => (raw = net.connect(pg_port, "localhost")),
	});
	const [{ pid }] = await sql`select pg_backend_pid() as pid`;
	const error = sql`select pg_sleep(1)`.catch((e) => e.code);
	await until_sleeping(pid);
	const closing = sql.close();
	raw.destroy();
	expect(await error).toBe("CONNECTION_CLOSED");
	await closing;
});

test("A query that sql.close() waits for gets CONNECTION_DESTROYED if the timeout of sql.end({ timeout }) is reached", async () => {
	const sql = postgres({ ...options, max: 1 });
	const [{ pid }] = await sql`select pg_backend_pid() as pid`;
	const error = sql`select pg_sleep(1)`.catch((e) => e.code);
	await until_sleeping(pid);
	const closing = sql.close();
	await sql.end({ timeout: 0 });
	expect(await error).toBe("CONNECTION_DESTROYED");
	await closing;
});

test("responds with server parameters (application_name)", async () => {
	expect(
		await new Promise((resolve, reject) =>
			postgres({
				...options,
				onparameter: (k, v) => k === "application_name" && resolve(v),
			})`select 1`.catch(reject),
		),
	).toBe("postgres.js");
});

test("has server parameters", async () => {
	expect(await sql`select 1`.then(() => sql.parameters.application_name)).toBe("postgres.js");
});

test("connection parameters", async () => {
	const sql = postgres({
		...options,
		connection: {
			"some.var": "yay",
		},
	});

	expect((await sql`select current_setting('some.var') as x`)[0].x).toBe("yay");
});

test("Unix socket", async () => {
	const sql = postgres({
		...options,
		host: pg_socket_dir,
	});

	expect((await sql`select 1 as x`)[0].x).toBe(1);
});

test("Unix socket with ssl: require connects without asking for TLS, as libpq does", async () => {
	await using sql = postgres({ ...options, host: pg_socket_dir, ssl: "require" });
	const [{ ssl }] = await sql`select ssl from pg_stat_ssl where pid = pg_backend_pid()`;
	expect(ssl).toBe(false);
});

test("connect_timeout", async () => {
	const connect_timeout = 0.2;
	const server = net.createServer();
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	await using _close = defer(() => server.close());
	const sql = postgres({ port: port_of(server), host: "127.0.0.1", connect_timeout });
	const start = Date.now();
	const error = await sql`select 1`.then(
			() => null,
			(e) => e,
		),
		end = Date.now();
	expect([error && error.code, Math.round((end - start) / 100) / 10]).toEqual([
		"CONNECT_TIMEOUT",
		connect_timeout,
	]);
}, 20_000);

test("connect_timeout throws proper error", async () => {
	expect(
		await postgres({
			...options,
			...login_scram,
			connect_timeout: 0.001,
		})`select 1`.catch((e) => e.code),
	).toBe("CONNECT_TIMEOUT");
});

test("connect_timeout error message includes host:port", async () => {
	const connect_timeout = 0.2;
	const server = net.createServer();
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	await using _close = defer(() => server.close());
	const sql = postgres({ port: port_of(server), host: "127.0.0.1", connect_timeout });
	const port = port_of(server);
	let err;
	await sql`select 1`.catch((e) => {
		if (e.code !== "CONNECT_TIMEOUT") {
			throw e;
		}
		err = e.message;
	});
	const expected = ["write CONNECT_TIMEOUT 127.0.0.1:", port].join("");
	expect(err).toBe(expected);
}, 20_000);

test("requests works after single connect_timeout", async () => {
	let first = true;

	const sql = postgres({
		...options,
		...login_scram,
		connect_timeout: {
			valueOf() {
				if (first) {
					first = false;
					return 0.0001;
				}
				return 1;
			},
		} as any,
	});

	const first_outcome = await sql`select 1 as x`.then(
		() => "success",
		(x) => x.code,
	);
	await delay(10);
	const [{ x }] = await sql`select 1 as x`;
	expect([first_outcome, x]).toEqual(["CONNECT_TIMEOUT", 1]);
});

test("Catches connection config errors", async () => {
	const sql = postgres({
		...options,
		user: {
			toString: () => {
				throw new Error("wat");
			},
		} as any,
		database: "prut",
	});

	expect(await sql`select 1`.catch((e) => e.message)).toBe("wat");
});

test("Catches connection config errors with end", async () => {
	const sql = postgres({
		...options,
		user: {
			toString: () => {
				throw new Error("wat");
			},
		} as any,
		database: "prut",
	});

	expect(await sql`select 1`.catch((e) => e.message)).toBe("wat");
	await sql.end();
});

test("Multiple hosts", async () => {
	const s1 = postgres({ idle_timeout }),
		s2 = postgres({ idle_timeout, port: second_pg_port }),
		sql = postgres(`postgres://localhost:${pg_port},localhost:${second_pg_port}`, {
			idle_timeout,
			max: 1,
		}),
		result = [];

	const id1 = (await s1`select system_identifier as x from pg_control_system()`)[0].x;
	const id2 = (await s2`select system_identifier as x from pg_control_system()`)[0].x;

	const x1 = await sql`select 1`;
	result.push((await sql`select system_identifier as x from pg_control_system()`)[0].x);
	await s1`select pg_terminate_backend(${x1.state.pid}::int)`;
	await delay(50);

	const x2 = await sql`select 1`;
	result.push((await sql`select system_identifier as x from pg_control_system()`)[0].x);
	await s2`select pg_terminate_backend(${x2.state.pid}::int)`;
	await delay(50);

	result.push((await sql`select system_identifier as x from pg_control_system()`)[0].x);

	expect(result).toEqual([id1, id2, id1]);
}, 1000);

test("multiple queries before connect", async () => {
	const sql = postgres({ ...options, max: 2 });
	const xs = await Promise.all([
		sql`select 1 as x`,
		sql`select 2 as x`,
		sql`select 3 as x`,
		sql`select 4 as x`,
	]);

	expect(xs.map((x) => x[0].x)).toEqual([1, 2, 3, 4]);
});

test("Custom socket", async () => {
	let result;
	const sql = postgres({
		socket: () =>
			new Promise((resolve, reject) => {
				const socket = new net.Socket();
				socket.connect(pg_port);
				socket.once("data", (x) => (result = x[0]));
				socket.on("error", reject);
				socket.on("connect", () => resolve(socket));
			}),
		idle_timeout,
	});

	await sql`select 1`;

	expect(result).toBe(82);
});

test("Ensure drain only dequeues if ready", async () => {
	const sql = postgres(options);

	const res = await Promise.all([
		sql.unsafe("SELECT 0+$1 --" + ".".repeat(100000), [1]),
		sql.unsafe("SELECT 0+$1+$2+$3", [1, 2, 3]),
	]);

	expect(res.length).toBe(2);
});

test("max: undefined uses the default", async () => {
	await using sql = postgres({ ...options, max: undefined });
	expect(sql.options.max).toBe(10);
});

test("A max_lifetime of 30 days, longer than setTimeout can wait, does not close the connection at once", async () => {
	await using sql = postgres({ ...options, max: 1, max_lifetime: 30 * 86400 });
	const [{ pid: first }] = await sql`select pg_backend_pid() as pid`;
	await delay(50);
	const [{ pid: second }] = await sql`select pg_backend_pid() as pid`;
	expect(second).toBe(first);
});

test("onnotice: false silences notices", async () => {
	await using sql = postgres({ ...options, onnotice: false });
	const log = console.log;
	let logged = false;
	console.log = () => (logged = true);
	onTestFinished(() => {
		console.log = log;
	});
	await sql`do $$ begin raise notice 'hi'; end $$`;
	expect(logged).toBe(false);
});

test("Multiple hosts errors when all hosts are down", async () => {
	const sql = postgres({
		...options,
		host: ["localhost", "localhost"],
		port: [1, 2],
		connect_timeout: 1,
	});
	expect(await sql`select 1`.catch((e) => e.code)).toBe("ECONNREFUSED");
});

test("Multiple hosts continues to next host after connect timeout", async () => {
	const server = net.createServer();
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	await using _close = defer(() => server.close());
	await using sql = postgres({
		...options,
		host: ["127.0.0.1", "localhost"],
		port: [port_of(server), pg_port],
		connect_timeout: 1,
	});
	const x = (await sql`select 1 as x`)[0].x;
	expect(x).toBe(1);
});

test("prefer-standby connects to the primary when the standby host is down", async () => {
	await using sql = postgres({
		...options,
		host: ["localhost", "localhost"],
		port: [1, pg_port],
		target_session_attrs: "prefer-standby",
		connect_timeout: 1,
	});
	const x = (await sql`select 1 as x`)[0].x;
	expect(x).toBe(1);
});

test("prefer-standby connects to a primary when no host is a standby", async () => {
	await using sql = postgres({
		idle_timeout,
		max: 1,
		host: ["localhost", "localhost"],
		port: [pg_port, second_pg_port],
		target_session_attrs: "prefer-standby",
	});
	const x = (await sql`select 1 as x`)[0].x;
	expect(x).toBe(1);
});

test("target_session_attrs standby errors when no host is a standby", async () => {
	const sql = postgres({
		idle_timeout,
		max: 1,
		host: ["localhost", "localhost"],
		port: [pg_port, second_pg_port],
		target_session_attrs: "standby",
	});
	expect(await sql`select 1`.catch((e) => e.code)).toBe("CONNECTION_DESTROYED");
});

test("Multiple hosts rejects within connect_timeout × hosts when every host times out", async () => {
	const connect_timeout = 0.3;
	const a = await listening(net.createServer());
	await using _close_a = defer(() => a.close());
	const b = await listening(net.createServer());
	await using _close_b = defer(() => b.close());
	const host = ["127.0.0.1", "127.0.0.1"];
	const port = [port_of(a), port_of(b)];
	await using sql = postgres({ ...options, host, port, connect_timeout });

	const start = Date.now();
	const code = await sql`select 1`.catch((e) => e.code);
	const elapsed = (Date.now() - start) / 1000;

	expect([code, elapsed < connect_timeout * host.length + 1]).toEqual(["CONNECT_TIMEOUT", true]);
});

test("prefer-standby tries every host for a standby before accepting a primary", async () => {
	let probe = 0;
	const server = await listening(
		net.createServer((socket) => {
			probe++;
			socket.destroy();
		}),
	);
	await using _close = defer(() => server.close());
	await using sql = postgres({
		...options,
		host: ["localhost", "127.0.0.1"],
		port: [pg_port, port_of(server)],
		target_session_attrs: "prefer-standby",
	});

	const x = (await sql`select 1 as x`)[0].x;

	expect([x, probe]).toEqual([1, 1]);
});

const backend_message = (type: string, body: Buffer) => {
	const header = Buffer.alloc(5);
	header.write(type);
	header.writeInt32BE(body.length + 4, 1);
	return Buffer.concat([header, body]);
};

/**
 * @param severity - such as "ERROR" or "FATAL"
 * @param code - the SQLSTATE, which is also the message
 * @param localized_only - whether to send the severity only in the localized S field, without the
 *   V field, as PostgreSQL before 9.6 and some poolers do
 * @returns an ErrorResponse message
 */
const error_response = (severity: string, code: string, localized_only = false) =>
	backend_message(
		"E",
		Buffer.from(
			"S" +
				severity +
				"\0" +
				(localized_only ? "" : "V" + severity + "\0") +
				"C" +
				code +
				"\0M" +
				code +
				"\0\0",
		),
	);

const authenticated = Buffer.concat([
	backend_message("R", Buffer.alloc(4)),
	backend_message("Z", Buffer.from("I")),
]);

test("Query runs on a new connection if the backend dies while fetching array types", async () => {
	let killed = false,
		unhandled = 0;

	const onunhandled = () => unhandled++;
	process.on("unhandledRejection", onunhandled);
	onTestFinished(() => {
		process.off("unhandledRejection", onunhandled);
	});

	await using proxy = await proxy_to_server({
		from_client: (x, c) => {
			if (!killed && x.includes("pg_type")) {
				killed = true;
				c.server.destroy();
				c.client.end(error_response("FATAL", "57P01"));
				return true;
			}
			return false;
		},
	});
	const sql = postgres({ ...options, host: proxy.host, port: proxy.port });
	const x = await sql`select 1 as x`.then(
		([row]) => row.x,
		(e) => e.code,
	);
	// Ended before the check, not by `await using` after it, so that the check also counts the
	// unhandled rejections that Node reports while the pool ends
	await sql.end();

	expect([x, unhandled, killed]).toEqual([1, 0, true]);
});

test("Clean closes during startup reject queries and reserves instead of reconnecting forever", async () => {
	let attempts = 0;

	const server = net.createServer((socket) => {
		attempts++;
		socket.end();
	});
	await new Promise<void>((r) => server.listen(0, "localhost", r));
	await using _close = defer(() => server.close());
	await using sql = postgres({ ...options, max: 2, host: "localhost", port: port_of(server) });
	const codes = await Promise.all([
		sql`select 1`.catch((e) => e.code),
		sql`select 2`.catch((e) => e.code),
		sql.reserve().catch((e) => e.code),
	]);

	expect([...codes, attempts < 10]).toEqual([
		"CONNECTION_CLOSED",
		"CONNECTION_CLOSED",
		"CONNECTION_CLOSED",
		true,
	]);
});

test("Clean closes while fetching array types reject queries once connect_timeout has passed", async () => {
	await using proxy = await proxy_to_server({
		from_client: (x, c) => {
			if (x.includes("pg_type")) {
				c.server.destroy();
				c.client.end();
				return true;
			}
			return false;
		},
	});
	await using sql = postgres({
		...options,
		host: proxy.host,
		port: proxy.port,
		connect_timeout: 0.5,
	});
	const start = Date.now();
	const error = await sql`select ${1}::int as x`.catch((e) => e);
	const waited = Date.now() - start,
		attempts = proxy.connections.length;

	expect([error.code, waited >= 500, attempts < 10, error.query, error.parameters]).toEqual([
		"CONNECTION_CLOSED",
		true,
		true,
		"select $1::int as x",
		[1],
	]);
});

test("A clean close while fetching array types is retried when connect_timeout is disabled", async () => {
	let closed = false;

	await using proxy = await proxy_to_server({
		from_client: (x, c) => {
			if (!closed && x.includes("pg_type")) {
				closed = true;
				c.server.destroy();
				c.client.end();
				return true;
			}
			return false;
		},
	});
	await using sql = postgres({
		...options,
		host: proxy.host,
		port: proxy.port,
		connect_timeout: 0,
	});
	const x = await sql`select 1 as x`.then(
		([row]) => row.x,
		(e) => e.code,
	);

	expect([x, closed, proxy.connections.length]).toEqual([1, true, 2]);
});

test("A query refused with a FATAL error rejects with the peer error instead of reconnecting forever", async () => {
	let attempts = 0,
		unhandled = 0;

	const onunhandled = () => unhandled++;
	process.on("unhandledRejection", onunhandled);
	onTestFinished(() => {
		process.off("unhandledRejection", onunhandled);
	});

	const server = net.createServer((socket) => {
		let started = false;
		attempts++;
		socket.on("error", () => socket.destroy());
		socket.on("data", () => {
			if (started) {
				socket.end(error_response("FATAL", "08P01"));
			} else {
				started = true;
				socket.write(authenticated);
			}
		});
	});

	await new Promise<void>((r) => server.listen(0, "localhost", r));
	await using _close = defer(() => server.close());
	const sql = postgres({ ...options, host: "localhost", port: port_of(server) });
	const code = await sql`select 1`.catch((e) => e.code);
	// Ended before the check, not by `await using` after it, so that the check also counts the
	// unhandled rejections that Node reports while the pool ends
	await sql.end();

	expect([code, attempts < 10, unhandled]).toEqual(["08P01", true, 0]);
});

test("A FATAL error with the severity only in the S field rejects the query and sql.begin with it", async () => {
	const server = await listening(
		net.createServer((socket) => {
			let started = false;
			socket.on("error", () => socket.destroy());
			// Accepts the startup, and answers whatever comes next with the FATAL error
			socket.on("data", () => {
				if (started) {
					socket.end(error_response("FATAL", "08P01", true));
				} else {
					started = true;
					socket.write(authenticated);
				}
			});
		}),
	);
	await using _close = defer(() => server.close());
	await using pool = postgres({ ...options, host: "127.0.0.1", port: port_of(server) });
	const query = await pool`select 1`.catch((e) => e.code),
		begin = await pool.begin((tx) => tx`select 1`).catch((e) => e.code);

	expect([query, begin]).toEqual(["08P01", "08P01"]);
});

/**
 * @param answer - `(socket, text) => void` answers a simple query, whose message has `text`
 * @returns a server that accepts a connection's startup, and answers each simple query after it
 *   with `answer`
 */
function answering(answer: (socket: net.Socket, text: string) => void) {
	return listening(
		net.createServer((socket) => {
			let started = false;
			socket.on("error", () => socket.destroy());
			socket.on("data", (x) => {
				if (started) {
					answer(socket, x.toString("latin1"));
				} else {
					started = true;
					socket.write(authenticated);
				}
			});
		}),
	);
}

/** The answer to BEGIN: CommandComplete, and ReadyForQuery in a transaction block */
const began = Buffer.concat([
	backend_message("C", Buffer.from("BEGIN\0")),
	backend_message("Z", Buffer.from("T")),
]);

test("A transaction rejects with the FATAL error that answers a query of it that could not be serialized", async () => {
	const server = await answering((socket, text) => {
		if (text.includes("could not be built")) {
			socket.end(error_response("FATAL", "57P01"));
		} else {
			socket.write(began);
		}
	});
	await using _close = defer(() => server.close());
	await using pool = postgres({
		...options,
		host: "127.0.0.1",
		port: port_of(server),
		fetch_types: false,
	});
	const unserializable = {
		toJSON() {
			throw new Error("unserializable");
		},
	};
	const error = await pool
		.begin((tx) => tx`select ${tx.typed(unserializable, 25)}`)
		.catch((e) => e);

	expect([error.code, error.severity]).toEqual(["57P01", "FATAL"]);
});

test("A transaction whose COMMIT got a FATAL error, and whose connection end() then destroyed, rejects with CONNECTION_CLOSED with the FATAL as cause", async () => {
	const { promise: fatal_sent, resolve: answered } = Promise.withResolvers<void>(),
		server = await answering((socket, text) => {
			if (text.includes("commit")) {
				// Without closing the connection, so that end() destroys it
				socket.write(error_response("FATAL", "57P01"));
				answered();
			} else {
				socket.write(began);
			}
		});
	await using _close = defer(() => server.close());
	const pool = postgres({
		...options,
		host: "127.0.0.1",
		port: port_of(server),
		fetch_types: false,
	});
	const transaction = pool.begin(() => 1).catch((e) => e);
	await fatal_sent;
	// For the client to read the FATAL error
	await delay(50);
	await pool.end({ timeout: 0 });
	const error = await transaction;

	expect([error.code, error.cause && error.cause.code]).toEqual(["CONNECTION_CLOSED", "57P01"]);
});

test("Failed array type fetch on a live connection is not an unhandled rejection", async () => {
	let unhandled = 0;

	const onunhandled = () => unhandled++;
	process.on("unhandledRejection", onunhandled);
	onTestFinished(() => {
		process.off("unhandledRejection", onunhandled);
	});

	const server = net.createServer((socket) => {
		socket.on("error", () => socket.destroy());
		socket.on("data", (x) =>
			x.includes("typarray")
				? socket.write(
						Buffer.concat([
							error_response("ERROR", "57014"),
							backend_message("Z", Buffer.from("I")),
						]),
					)
				: x[0] === 88
					? socket.end()
					: socket.write(authenticated),
		);
	});

	await new Promise<void>((r) => server.listen(0, "localhost", r));
	await using _close = defer(() => server.close());
	const sql = postgres({ ...options, host: "localhost", port: port_of(server) });
	await sql`select 1`.catch((): null => null);
	// Ended before the check, not by `await using` after it, so that the check also counts the
	// unhandled rejections that Node reports while the pool ends
	await sql.end();

	expect(unhandled).toBe(0);
});

test("end() completes after the backend is terminated mid-query", async () => {
	const sql = postgres({ ...options, max: 1 });
	const [{ pid }] = await sql`select pg_backend_pid() as pid`;
	const query = sql`select pg_sleep(1)`.catch((e) => e);
	await delay(10);
	await terminate(pid);
	const error = await query;
	const start = Date.now();
	await sql.end();
	expect([error instanceof Error, Date.now() - start < 1000]).toEqual([true, true]);
});

test("Connection end cancels a pending socket factory", async () => {
	let release!: (socket: net.Socket) => void,
		closes = 0;

	const { promise: connecting, resolve: started } = Promise.withResolvers<void>(),
		socket = new net.Socket(),
		application_name = "postgres.js end socket factory " + crypto.randomBytes(4).toString("hex"),
		client = postgres({
			...options,
			connection: { application_name },
			onclose: () => closes++,
			socket: ({ port, host }) =>
				new Promise((resolve, reject) => {
					release = resolve;
					socket.on("error", reject);
					socket.connect(port[0], host[0], () => started());
				}),
		}),
		query = client`select 1`.catch((x) => x.code);
	await using _cleanup = defer(async () => {
		socket.destroy();
		await client.end({ timeout: 0 });
		await sql`select pg_terminate_backend(pid) from pg_stat_activity where application_name = ${application_name}`;
	});

	await connecting;
	await client.end({ timeout: 0 });
	release(socket);
	await delay(200);
	const [{ count }] =
		await sql`select count(*)::int as count from pg_stat_activity where application_name = ${application_name}`;
	expect([await query, count, socket.destroyed, closes]).toEqual([
		"CONNECTION_DESTROYED",
		0,
		true,
		0,
	]);
});

test("Connection end stops a listen connection that is reconnecting", async () => {
	const application_name = "postgres.js end reconnect " + crypto.randomBytes(4).toString("hex"),
		client = postgres({ ...options, connection: { application_name } });
	await using _cleanup = defer(async () => {
		await client.end({ timeout: 0 });
		await sql`select pg_terminate_backend(pid) from pg_stat_activity where application_name = ${application_name}`;
	});

	const {
		state: { pid },
	} = await client.listen("end_reconnect", () => 0);
	await terminate(pid);
	await delay(0);
	await client.end();
	await delay(400);
	const [{ count }] =
		await sql`select count(*)::int as count from pg_stat_activity where application_name = ${application_name}`;
	expect(count).toBe(0);
});

test("Connection end cancels the first listen attempt", async () => {
	const server = net.createServer((socket) => socket.resume());
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	await using _close = defer(() => server.close());
	const socket = new net.Socket();
	const closed = new Promise((r) => socket.once("close", r));
	const sql = postgres({
		...options,
		connect_timeout: 30,
		socket: () => socket.connect(port_of(server), "127.0.0.1"),
	});
	const listened = sql.listen("end_connecting", () => {}).catch((x) => x.code);
	await sql.end();
	await closed;
	expect(await listened).toBe("CONNECTION_DESTROYED");
});

test("Cancel query while its connection is opening", async () => {
	const { promise: opened, resolve: open } = Promise.withResolvers<void>();
	await using sql = postgres({
		...options,
		socket: async ({ host: [host], port: [port] }) => {
			await opened;
			return new Promise((resolve, reject) => {
				const socket = new net.Socket();
				socket.connect(port, host);
				socket.on("error", reject);
				socket.on("connect", () => resolve(socket));
			});
		},
	});
	const query = sql`select 1 as x`;
	const error = query.catch((x) => x);
	await delay(10);
	void query.cancel();
	const next = sql`select 2 as x`.execute();
	open();
	const [{ x }] = await next;
	expect([(await error).code, x]).toEqual(["57014", 2]);
});

test("A query cancelled while its connection starts up leaves the connection in the pool (#1266)", async () => {
	const results = [];
	for (const [phase, o] of [
		["auth", {}],
		["types", {}],
		["auth", { fetch_types: false }],
	] as const) {
		// The proxy holds back what the server sends, from the start or from the types query on,
		// until the test releases it
		const held: [connection: any, data: Buffer][] = [];
		let holding = phase === "auth";
		await using proxy = await proxy_to_server({
			from_client: (x) => {
				if (phase === "types" && x.includes("typarray")) {
					holding = true;
				}
				return false;
			},
			from_server: (x, c) => {
				if (holding) {
					held.push([c, x]);
					return true;
				}
				return false;
			},
		});
		const release = () => {
			holding = false;
			for (const [c, x] of held.splice(0)) {
				c.client.write(x);
			}
		};
		await using sql = postgres({
			...options,
			...o,
			host: proxy.host,
			port: proxy.port,
			max: 1,
		});
		const query = sql`select 1 as x`,
			outcome = query.then(
				() => "ran",
				(x) => x.code,
			);

		await delay(100);
		await query.cancel();
		release();
		const started = performance.now();
		const [{ x }] = await sql`select 2 as x`;
		results.push([
			phase,
			["57014", "ran"].includes(await outcome),
			x,
			performance.now() - started < 2000,
		]);
	}
	expect(results).toEqual([
		["auth", true, 2, true],
		["types", true, 2, true],
		["auth", true, 2, true],
	]);
});

test("sql.begin works with max_pipeline: 0 and max: 1 (#1264)", async () => {
	await using sql = postgres({ ...options, max: 1, max_pipeline: 0 });
	const x = await sql
		.begin((tx) => tx`select 1 as x`)
		.then(
			(rows) => rows[0].x,
			(e) => e.code,
		);
	const y = await sql
		.begin(async (tx) => {
			await tx`select 1`;
			return (await tx`select 2 as y`)[0].y;
		})
		.then(
			(result) => result,
			(e) => e.code,
		);
	expect([x, y]).toEqual([1, 2]);
});

test("With max_pipeline: 0, a query that waits for the only connection runs once it is free", async () => {
	// Without an idle timeout, the waiting query has to run on the same connection
	await using sql = postgres({ ...options, max: 1, max_pipeline: 0, idle_timeout: null });
	await sql`select 1`;
	const both = Promise.all([sql`select pg_sleep(0.2), 1 as x`, sql`select 2 as x`]).then((xs) =>
		xs.map((x) => x[0].x),
	);
	await delay(50);
	// The second query waits instead of being pipelined behind the first
	const waiting = sql.stats.waiting;
	expect([waiting, await Promise.race([both, delay(3000).then(() => "pending")])]).toEqual([
		1,
		[1, 2],
	]);
});

test("onread: false reads through the socket stream instead of a shared buffer", async () => {
	await using sql = postgres({ ...options, onread: false, max: 1 });
	const [{ x }] = await sql`select 1 as x`;
	const rows = await sql`select generate_series(1, 20000) as n`;
	expect([x, rows.length]).toEqual([1, 20000]);
});

test("sql.stats is current, not a snapshot from creation", async () => {
	await using sql = postgres({ ...options, max: 2 });
	const before = sql.stats.connections;
	const queries = Promise.all([sql`select pg_sleep(0.2)`, sql`select pg_sleep(0.2)`]);
	await delay(100);
	const during = sql.stats;
	await queries;
	const after = sql.stats;
	expect([before, during.connections, during.idle, after.idle]).toEqual([0, 2, 0, 2]);
});

test("A socket error without a close rejects the query in flight instead of hanging (#1246, #1089)", async () => {
	let raw!: net.Socket;
	await using sql = postgres({
		...options,
		max: 1,
		socket: () => (raw = net.connect(pg_port, "localhost")),
	});
	await sql`select 1`;
	const q = sql`select pg_sleep(2)`.then(
		() => "done",
		(e) => e.code,
	);
	await delay(100);
	raw.emit("error", new Error("half open"));
	const start = Date.now();
	const result = await q;
	expect([result, Date.now() - start < 1000, (await sql`select 1 as x`)[0].x]).toEqual([
		"CONNECTION_CLOSED",
		true,
		1,
	]);
});

/**
 * @param query - a query
 * @returns a promise of "ok" if `query` resolves, or of the `code` of its error if it rejects
 */
function code_of(query: Promise<unknown>) {
	return query.then(
		() => "ok",
		(e) => e.code,
	);
}

test("Queries keep working after the backend dies under a burst of pipelined writes (#1250)", async () => {
	await using sql = postgres({ ...options, max: 1, max_pipeline: 100 });
	const [{ pid }] = await sql`select pg_backend_pid() as pid`;
	// The connection gets and writes the sleep and the first 99 queries of the burst, which wait
	// behind the sleep until the backend dies. The other 101 queries wait in the pool for the next
	// connection. The burst gives the type of its parameter (23 is int4), so that the connection
	// does not wait for the server to describe the statement before writing the rest of the burst.
	const sleep = code_of(sql`select pg_sleep(10)`);
	const burst = [...Array(200)].map((_, i) => code_of(sql`select ${sql.typed(i, 23)} as x`));
	await until_sleeping(pid);
	await terminate(pid);
	expect(await Promise.all([sleep, ...burst])).toEqual([
		"57P01",
		...Array(99).fill("CONNECTION_CLOSED"),
		...Array(101).fill("ok"),
	]);
});

function lying_server(final: boolean) {
	const i32 = (n: number) => {
			const b = Buffer.alloc(4);
			b.writeInt32BE(n);
			return b;
		},
		msg = (t: string, body: Buffer) => Buffer.concat([Buffer.from(t), i32(body.length + 4), body]),
		z = (x: string) => Buffer.from(x + "\0"),
		salt = Buffer.from("saltsalt").toString("base64");
	const server = net.createServer((s) => {
		let buf = Buffer.alloc(0),
			started = false,
			nonce: string | null = null;
		s.on("error", () => {});
		s.on("data", (d) => {
			buf = Buffer.concat([buf, d]);
			let more = true;
			while (more) {
				more = started ? message() : startup();
			}
		});

		function startup() {
			if (buf.length < 8 || buf.length < buf.readInt32BE(0)) {
				return false;
			}

			const code = buf.readInt32BE(4);
			buf = buf.subarray(buf.readInt32BE(0));
			if (code === 80877103) {
				s.write("N");
			} else {
				started = true;
				s.write(msg("R", Buffer.concat([i32(10), z("SCRAM-SHA-256"), z("")])));
			}
			return true;
		}

		function message() {
			if (buf.length < 5 || buf.length < buf.readInt32BE(1) + 1) {
				return false;
			}

			const type = String.fromCharCode(buf[0]),
				body = buf.subarray(5, buf.readInt32BE(1) + 1);
			buf = buf.subarray(buf.readInt32BE(1) + 1);
			if (type === "p" && !nonce) {
				nonce = /r=([^,\0]+)/.exec(body.toString())![1];
				s.write(
					msg(
						"R",
						Buffer.concat([i32(11), Buffer.from("r=" + nonce + "srv,s=" + salt + ",i=4096")]),
					),
				);
			} else if (type === "p") {
				s.write(
					Buffer.concat([
						...(final
							? [
									msg(
										"R",
										Buffer.concat([
											i32(12),
											Buffer.from("v=" + Buffer.from("not the signature").toString("base64")),
										]),
									),
								]
							: []),
						msg("R", i32(0)),
						msg("K", Buffer.concat([i32(1), i32(2)])),
						msg("Z", Buffer.from("I")),
					]),
				);
			} else if (type === "X") {
				s.end();
			}
			return true;
		}
	});
	return new Promise<net.Server>((r) => server.listen(0, "127.0.0.1", () => r(server)));
}

test("A server whose SCRAM signature is wrong is not trusted", async () => {
	const server = await lying_server(true);
	await using _close = defer(() => server.close());
	await using sql = postgres({
		host: "127.0.0.1",
		port: port_of(server),
		user: "u",
		pass: "p",
		db: "d",
		fetch_types: false,
		max: 1,
	});
	const code = await sql`select 1`.then(
		() => "connected",
		(e) => e.code,
	);
	expect(code).toBe("SASL_SIGNATURE_MISMATCH");
});

test("A server that ends SCRAM without its signature is not trusted", async () => {
	const server = await lying_server(false);
	await using _close = defer(() => server.close());
	await using sql = postgres({
		host: "127.0.0.1",
		port: port_of(server),
		user: "u",
		pass: "p",
		db: "d",
		fetch_types: false,
		max: 1,
	});
	const code = await sql`select 1`.then(
		() => "connected",
		(e) => e.code,
	);
	expect(code).toBe("SASL_SIGNATURE_MISMATCH");
});

test("A cancel request on a TLS connection is sent over TLS", async () => {
	await using proxy = await proxy_to_server();
	await using sql = postgres({
		...options,
		host: proxy.host,
		port: proxy.port,
		ssl: "require",
		max: 1,
	});
	await sql`select 1`;
	const q = sql`select pg_sleep(2)`;
	setTimeout(() => q.cancel(), 200);
	const code = await q.then(
		() => "not cancelled",
		(e) => e.code,
	);
	// Both connections, the pool's and the cancel request's, began with an SSLRequest
	const firsts = proxy.connections.map((c) => c.first!.readInt32BE(4));
	expect([code, firsts]).toEqual(["57014", [80877103, 80877103]]);
});

test("sql.close() lets a running transaction and a reserved connection finish first", async () => {
	await using sql = postgres(options);
	await sql`create table test (a int)`;
	const transaction = sql
		.begin(async (tx) => {
			await tx`insert into test values (1)`;
			await delay(200);
			await tx`insert into test values (2)`;
			return "committed";
		})
		.catch((e) => e.code);
	await delay(50);
	const closed = sql.close();
	const result = await transaction;
	await closed;
	const [{ n }] = await sql`select count(*)::int as n from test`;
	using reserved = await sql.reserve();
	await reserved`select 1`;
	const closing = sql.close();
	const after = await reserved`select 1 as x`.then(
		(x) => x[0].x,
		(e) => e.code,
	);
	reserved.release();
	await closing;
	expect([result, n, after]).toEqual(["committed", 2, 1]);
});

test("With several hosts every new connection tries the first host first, as in v3", async () => {
	const hosts = "localhost:" + pg_port + ",localhost:" + second_pg_port;
	await using sql = postgres({
		...options,
		user: "postgres",
		pass: "",
		db: "postgres",
		host: hosts,
		max: 3,
	});
	const ports = [];
	const reserved: ReservedSql[] = [];
	await using _release = defer(() => reserved.forEach((r) => r.release()));
	for (let i = 0; i < 3; i++) {
		const r = await sql.reserve();
		reserved.push(r);
		ports.push((await r`select inet_server_port() as p`)[0].p);
	}
	expect(ports).toEqual([pg_port, pg_port, pg_port]);
});

test("A query waiting while new connections fail and the only one is reserved is rejected instead of waiting forever", async () => {
	await using admin = postgres({ ...options, user: "postgres", pass: "", max: 1 });
	await admin`drop role if exists postgres_js_test_limit`;
	await admin`create role postgres_js_test_limit login connection limit 1`;
	await using _drop_role = defer(() => admin`drop role postgres_js_test_limit`);
	await using sql = postgres({
		...options,
		host: pg_socket_dir,
		user: "postgres_js_test_limit",
		pass: "",
		max: 2,
		connect_timeout: 1,
	});
	using _reserved = await sql.reserve();
	const code = await sql`select 1`.then(
		() => "ran",
		(e) => e.code,
	);
	expect(code).toBe("53300");
});

test("Falsy connection parameters are left out of the startup message, as in v3", async () => {
	await using sql = postgres({ ...options, connection: { search_path: "" } });
	const [{ search_path }] = await sql`show search_path`;
	expect(search_path).toBe('"$user", public');
});

test("sql.options.parsers and sql.options.serializers are objects keyed by oid", async () => {
	await using sql = postgres(options);
	const { parsers, serializers } = sql.options;
	expect([
		parsers[23]("5"),
		Object.keys(parsers).length > 0,
		typeof serializers[23] === "function",
	]).toEqual([5, true, true]);
});

test("Queries and transactions fail fast with the connection error while connections keep failing", async () => {
	await using sql = postgres({ ...options, port: 1, max: 2 });
	const times = [];
	for (let i = 0; i < 4; i++) {
		const start = Date.now();
		times.push(await sql`select 1`.catch((e) => e.code), Date.now() - start);
	}
	for (let i = 0; i < 3; i++) {
		const start = Date.now();
		times.push(await sql.begin((tx) => tx`select 1`).catch((e) => e.code), Date.now() - start);
	}
	const codes = times.filter((x, i) => i % 2 === 0);
	const slow = times.filter((x, i) => i % 2 === 1 && i > 3 && x > 200);
	expect([codes, slow]).toEqual([Array(7).fill("ECONNREFUSED"), []]);
});

test("Errors from fast failures are separate objects for each query", async () => {
	await using sql = postgres({ ...options, port: 1 });
	const errors = [];
	for (let i = 0; i < 4; i++) {
		errors.push(await sql.unsafe("select " + i).catch((e) => e));
	}
	expect([new Set(errors).size, errors.map((e) => [e.query, typeof e.stack, e.code])]).toEqual([
		4,
		[0, 1, 2, 3].map((i) => ["select " + i, "string", "ECONNREFUSED"]),
	]);
});

test("A failed connection attempt does not give up on queries a connection still loading types will serve", async () => {
	await using admin = postgres({ ...options, user: "postgres", pass: "", max: 1 });
	await admin`drop role if exists postgres_js_test_loading`;
	await admin`create role postgres_js_test_loading login connection limit 1`;
	await using _drop_role = defer(() => admin`drop role postgres_js_test_loading`);
	await using sql = postgres({
		...options,
		host: pg_socket_dir,
		user: "postgres_js_test_loading",
		pass: "",
		max: 2,
		connect_timeout: 1,
	});
	const results = await Promise.all([
		sql`select 1 as x`.then(
			(rows) => rows[0].x,
			(e) => e.code,
		),
		sql.reserve().then(
			(r) => {
				r.release();
				return "reserved";
			},
			(e) => e.code,
		),
	]);
	expect(results).toEqual([1, "reserved"]);
});

test("Connections refused for too many connections are retried until connect_timeout", async () => {
	await using admin = postgres({ ...options, user: "postgres", pass: "", max: 1 });
	await admin`drop role if exists postgres_js_test_burst`;
	await admin`create role postgres_js_test_burst login connection limit 0`;
	await using _drop_role = defer(() => admin`drop role postgres_js_test_burst`);
	await using sql = postgres({
		...options,
		host: pg_socket_dir,
		user: "postgres_js_test_burst",
		pass: "",
		max: 4,
		connect_timeout: 5,
	});
	const results = Promise.all(
		Array.from({ length: 4 }, (_, i) =>
			sql`select ${i}::int as x`.then(
				(x) => x[0].x,
				(e) => e.code,
			),
		),
	);
	await delay(300);
	await admin`alter role postgres_js_test_burst connection limit 1`;
	const got = await results;
	expect(got).toEqual([0, 1, 2, 3]);
});

test("Connections refused for too many connections reject once connect_timeout has passed", async () => {
	await using admin = postgres({ ...options, user: "postgres", pass: "", max: 1 });
	await admin`drop role if exists postgres_js_test_none`;
	await admin`create role postgres_js_test_none login connection limit 0`;
	await using _drop_role = defer(() => admin`drop role postgres_js_test_none`);
	await using sql = postgres({
		...options,
		host: pg_socket_dir,
		user: "postgres_js_test_none",
		pass: "",
		max: 2,
		connect_timeout: 0.5,
	});
	const start = Date.now();
	const code = await sql`select 1`.then(
		() => "ran",
		(e) => e.code,
	);
	const waited = Date.now() - start;
	expect([code, waited]).toEqual([
		"53300",
		expect.toSatisfy((x) => x >= 400 && x < 4000, "at least 400 ms and less than 4000 ms"),
	]);
});

test("unref_sockets lets the process exit while connections are idle", async () => {
	const script = (idle: boolean) =>
		[
			"const postgres = (await import(" +
				JSON.stringify(new URL("../src/index.ts", import.meta.url).href) +
				")).default",
			"const sql = postgres(" +
				JSON.stringify({ ...options, idle_timeout: 60, unref_sockets: idle }) +
				")",
			"await sql`select 1`",
			"await sql.begin(tx => tx`select 2`)",
			'console.log("done")',
		].join("\n");
	const [unref, kept] = await Promise.all([exits(script(true)), exits(script(false))]);
	expect([unref.out, unref.exited, kept.exited]).toEqual(["done", true, false]);
}, 20_000);

test("unref_sockets lets the process exit after a connection waited for the types to load", async () => {
	// min: 2 opens a second connection while the first one loads the types: both `open`s come
	// before the `lease`, which the pool grants only once the types are loaded. If the second
	// connection opened late instead, the script ends that pool and tries again.
	const script = [
		'import dc from "node:diagnostics_channel"',
		"const postgres = (await import(" +
			JSON.stringify(new URL("../src/index.ts", import.meta.url).href) +
			")).default",
		"for (let attempt = 0; attempt < 20; attempt++) {",
		"\tconst events = [], record = (x) => events.push(x.event)",
		'\tdc.subscribe("postgres:pool", record)',
		"\tconst sql = postgres(" +
			JSON.stringify({ ...options, min: 2, max: 2, unref_sockets: true }) +
			")",
		"\tconst reserved = await sql.reserve()",
		"\treserved.release()",
		"\twhile (sql.stats.opening) {",
		"\t\tawait new Promise((r) => setTimeout(r, 10))",
		"\t}",
		'\tdc.unsubscribe("postgres:pool", record)',
		'\tif (events.filter((x) => x === "open" || x === "lease").join(" ") === "open open lease") {',
		'\t\tconsole.log("done")',
		"\t\tbreak",
		"\t}",
		"\tawait sql.end()",
		"}",
	].join("\n");
	const { out, exited } = await exits(script);
	expect([out, exited]).toEqual(["done", true]);
}, 20_000);

test("unref_sockets lets the process exit after a query fails before it is sent", async () => {
	// JSON.stringify throws on a BigInt, so the query fails while the connection writes it, and
	// the server never gets the query
	const script = [
		"const postgres = (await import(" +
			JSON.stringify(new URL("../src/index.ts", import.meta.url).href) +
			")).default",
		"const sql = postgres(" +
			JSON.stringify({ ...options, max: 1, idle_timeout: 60, unref_sockets: true }) +
			")",
		"await sql`select 1`",
		"console.log(await sql`select ${sql.json({ x: 1n })}`.catch((e) => e.constructor.name))",
	].join("\n");
	const { out, exited } = await exits(script);
	expect([out, exited]).toEqual(["TypeError", true]);
}, 20_000);

test("sql and reserved connections are async disposable, and disposing sql waits for its queries", async () => {
	// The library's own pool, whose disposal the `postgres` of tests/common.ts replaces
	const sql = library(options);
	// For when a step below throws before the pool is disposed
	await using _end = defer(() => sql.end({ timeout: 0 }));
	const reserved = await sql.reserve();
	await reserved`select 1`;
	await reserved[Symbol.asyncDispose]();
	const released = await reserved`select 1`.then(
		() => "ran",
		(e) => e.code,
	);
	const running = sql`select pg_sleep(0.1), 1 as x`.then(
		([row]) => row.x,
		(e) => e.code,
	);
	await sql[Symbol.asyncDispose]();
	expect([
		released,
		await running,
		await sql`select 1`.then(
			() => "ran",
			(e) => e.code,
		),
	]).toEqual(["UNSAFE_TRANSACTION", 1, "CONNECTION_ENDED"]);
});

function listening(server: net.Server) {
	return new Promise<net.Server>((r) => server.listen(0, "127.0.0.1", () => r(server)));
}

test("user can be a function, called for each connection", async () => {
	let calls = 0;
	await using sql = postgres({
		...options,
		max: 2,
		user: async () => {
			calls++;
			return login.user;
		},
	});
	const users = await Promise.all([
		sql`select current_user as u, pg_sleep(0.05)`,
		sql`select current_user as u, pg_sleep(0.05)`,
	]);
	expect([users.map((x) => x[0].u), calls]).toEqual([[login.user, login.user], 2]);
});

test("min keeps that many connections open once the pool is used", async () => {
	await using sql = postgres({ ...options, max: 4, min: 2, idle_timeout: 0.2 });
	const before = sql.stats.connections;
	await sql`select 1`;
	await delay(100);
	const opened = sql.stats.connections;
	await Promise.all([1, 2, 3, 4].map(() => sql`select pg_sleep(0.1)`));
	const busy = sql.stats.connections;
	await delay(800);
	expect([before, opened, busy, sql.stats.connections]).toEqual([0, 2, 4, 2]);
});

test("One query on a cold pool opens one connection", async () => {
	await using sql = postgres({ ...options, max: 4 });
	await sql`select 1`;
	await delay(100);
	expect(sql.stats.connections).toBe(1);
});

test("A password from PGPASSFILE, as libpq reads it (#964)", async () => {
	const lines = [
		"# comment",
		"otherhost:*:*:*:wrong",
		"*:*:*:" + login_md5.user + ":" + login_md5.pass.replace(/:/g, "\\:"),
	];
	expect(
		await passfile(lines.join("\n"), 0o600, (sql) => sql`select 1 as x`.then((x) => x[0].x)),
	).toBe(1);
});

test("A password file readable by others is ignored, as in libpq", async () => {
	expect(
		await passfile("*:*:*:" + login_md5.user + ":" + login_md5.pass, 0o644, (sql) =>
			sql`select 1`.then(
				() => "ran",
				(e) => e.code,
			),
		),
	).toBe("28P01");
});

/**
 * Runs `fn` with a pool that logs in as `login_md5.user` with no password given, while PGPASSFILE
 * names a new password file.
 * @param content - the content of the password file
 * @param mode - the permissions of the password file, e.g. 0o600
 * @param fn - a function that gets the pool
 * @returns what `fn` returns, awaited
 */
async function passfile(content: string, mode: number, fn: (sql: Sql) => unknown) {
	const fs = await import("fs"),
		os = await import("os"),
		path = await import("path"),
		file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pgpass-")), "pgpass"),
		before = process.env.PGPASSFILE;
	await using _rm = defer(() => fs.rmSync(path.dirname(file), { recursive: true, force: true }));
	fs.writeFileSync(file, content);
	fs.chmodSync(file, mode);
	process.env.PGPASSFILE = file;
	await using _restore = defer(() => {
		if (before === undefined) {
			delete process.env.PGPASSFILE;
		} else {
			process.env.PGPASSFILE = before;
		}
	});
	await using sql = postgres({ ...options, user: login_md5.user, pass: undefined });
	return await fn(sql);
}

test("queue_timeout rejects a query that waits too long for a connection, without sending it", async () => {
	await using sql = postgres({ ...options, max: 1, queue_timeout: 0.2 });
	using reserved = await sql.reserve();
	const start = Date.now();
	const code = await sql`select 1`.then(
		() => "ran",
		(e) => e.code,
	);
	const waited = Date.now() - start;
	reserved.release();
	const after = await sql`select 1 as x`;
	expect([code, waited, after[0].x]).toEqual([
		"QUEUE_TIMEOUT",
		expect.toSatisfy((x) => x >= 150 && x < 500, "at least 150 ms and less than 500 ms"),
		1,
	]);
});

test("queue_timeout applies to transactions and reserves waiting for a connection", async () => {
	await using sql = postgres({ ...options, max: 1, queue_timeout: 0.2 });
	using reserved = await sql.reserve();
	const codes = [
		await sql
			.begin((tx) => tx`select 1`)
			.then(
				() => "ran",
				(e) => e.code,
			),
		await sql.reserve().then(
			() => "reserved",
			(e) => e.code,
		),
	];
	reserved.release();
	expect(codes).toEqual(["QUEUE_TIMEOUT", "QUEUE_TIMEOUT"]);
});

test("A query that waits less than queue_timeout runs", async () => {
	await using sql = postgres({ ...options, max: 1, queue_timeout: 1 });
	using reserved = await sql.reserve();
	const query = sql`select 1 as x`;
	setTimeout(() => reserved.release(), 200);
	expect((await query)[0].x).toBe(1);
});

test("An AbortSignal removes a waiting query and cancels a running one", async () => {
	await using sql = postgres({ ...options, max: 1 });
	using reserved = await sql.reserve();
	const waiting = sql`select 1`.signal(AbortSignal.timeout(100)).then(
		() => "ran",
		(e) => e.code,
	);
	await delay(150);
	reserved.release();
	const running = sql`select pg_sleep(2)`.signal(AbortSignal.timeout(200)).then(
		() => "ran",
		(e) => e.code,
	);
	const aborted = new AbortController();
	aborted.abort();
	const before = await sql`select 1`.signal(aborted.signal).then(
		() => "ran",
		(e) => e.code,
	);
	expect([await running, await waiting, before, (await sql`select 1 as x`)[0].x]).toEqual([
		"57014",
		"57014",
		"57014",
		1,
	]);
});

test("A parameter the server reports after startup reaches onparameter and sql.parameters", async () => {
	const seen: string[] = [];
	await using sql = postgres({
		...options,
		onparameter: (k, v) => k === "application_name" && seen.push(v),
	});
	await sql`set application_name = 'renamed'`;
	expect([seen, sql.parameters.application_name]).toEqual([["postgres.js", "renamed"], "renamed"]);
});

test("An empty query gives an empty result, simple or prepared", async () => {
	const xs = [
		await sql.unsafe(""),
		await sql.unsafe("", [], { prepare: true }),
		await sql.unsafe(" ; "),
	];
	expect(xs.map((x) => [x.length, x.command])).toEqual(Array.from({ length: 3 }, () => [0, null]));
});

/**
 * Measures how long a short query waits in a pool of two connections, while one connection runs a
 * 1-second query and the other runs a 0.1-second query.
 *
 * @param scheduler - The pool's `scheduler` option.
 * @param retried - Whether each connection, before the measurement, retries a 10-millisecond
 *   prepared statement that the server forgot. If true, the pool prepares statements even when
 *   the tests run with PREPARE=false.
 * @returns The number of milliseconds that the short query took.
 */
async function short_query_ms(scheduler: boolean, retried = false) {
	await using sql = postgres({
		...options,
		max: 2,
		idle_timeout: 0,
		scheduler,
		...(retried ? { prepare: true } : {}),
	});
	const slow = () => sql`select pg_sleep(1) as slow`,
		quick = () => sql`select pg_sleep(0.1) as quick`,
		short = () => sql`select 1 as short`;
	await Promise.all([slow(), slow()]);
	await Promise.all([quick(), short()]);
	if (retried) {
		const reserved = await Promise.all([sql.reserve(), sql.reserve()]);
		await Promise.all(
			reserved.map(async (r) => {
				const first = await r`select pg_sleep(0.01) as forgotten`;
				await r`deallocate ${r(first.statement.name)}`;
				await r`select pg_sleep(0.01) as forgotten`;
				r.release();
			}),
		);
	}
	const s = slow().execute();
	await delay(20);
	const q = quick().execute();
	await delay(20);
	const start = Date.now();
	await short();
	const ms = Date.now() - start;
	await Promise.all([s, q]);
	return ms;
}

test("A query is pipelined behind the work that should finish first, not behind a long query, unless the scheduler is off", async () => {
	const [on, off] = [await short_query_ms(true), await short_query_ms(false)];
	expect([on < 500, off > 800]).toEqual([true, true]);
}, 20_000);

test("A query is pipelined behind the work that should finish first, even after each connection retried a statement", async () => {
	expect(await short_query_ms(true, true)).toBeLessThan(500);
}, 20_000);

test("A query rejected during a COPY on a reserved connection doesn't leave the connection notable", async () => {
	await using sql = postgres({ ...options, max: 2 });
	using reserved = await sql.reserve();
	await reserved`create temp table copied (x int)`;
	const writable = await reserved`copy copied from stdin`.writable(),
		rejected = reserved`select 1 as rejected`,
		code = await rejected.then(
			() => "ran",
			(e) => e.code,
		);
	await new Promise((resolve, reject) => {
		writable.on("finish", resolve);
		writable.on("error", reject);
		writable.end("1\n");
	});
	// `costly` is internal: the pool asks it whether a quick query needs the scheduler
	expect([code, (rejected as any).connection.costly(notable)]).toEqual(["COPY_IN_PROGRESS", false]);
});

test("An identifier that looks like many comments after start does not stall the event loop", async () => {
	await using sql = postgres({ ...options, max: 2 });
	const column = "start" + "/**/".repeat(40) + "x",
		started = performance.now();
	const code = await sql`select 1 as x order by ${sql(column)}`.then(
		() => "ran",
		(e) => e.code,
	);
	expect([code, performance.now() - started < 1000]).toEqual(["42703", true]);
});

test("A NUL character in a startup parameter rejects instead of adding parameters (as another user)", async () => {
	const codes = [];
	const attempts = [
		{ database: options.db + "\0user\0postgres" },
		{ user: login.user + "\0database\0postgres" },
		{ connection: { application_name: "x\0replication\0database" } },
	];
	for (const o of attempts) {
		await using sql = postgres({ ...options, ...o });
		codes.push(
			await sql`select current_user`.then(
				(x) => x[0].current_user,
				(e) => e.code,
			),
		);
	}
	expect(codes).toEqual(["NUL_CHARACTER", "NUL_CHARACTER", "NUL_CHARACTER"]);
});

test("A NUL character in query text is rejected by the server and leaves the connection usable", async () => {
	await using sql = postgres({ ...options, max: 1 });
	const codes = [
		await sql`select 1 as ${sql("x\0y")}`.then(
			() => "ran",
			(e) => e.code,
		),
		await sql.unsafe("select 1 \0").then(
			() => "ran",
			(e) => e.code,
		),
	];
	const [{ x }] = await sql`select 1 as x`;
	expect([codes, x]).toEqual([["08P01", "08P01"], 1]);
});
