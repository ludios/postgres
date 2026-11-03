import net from "net";
import { expect, onTestFinished, test } from "vitest";
import {
	postgres,
	options,
	login,
	login_md5,
	login_scram,
	pg_port,
	port_of,
	defer,
} from "./setup.ts";
import type { Options } from "../src/index.ts";
import { open } from "../src/startup.ts";
import { Query, Frames } from "../src/protocol.ts";

const base: Partial<Options> = {
	host: ["localhost"],
	port: [pg_port],
	database: options.db,
	connect_timeout: 3,
	timers: { setTimeout, clearTimeout, setImmediate, clearImmediate, now: () => performance.now() },
	shared: { once: new Set() },
	...login,
};

const session = async (overrides?: Partial<Options>) => {
	const ready = await open({ ...base, ...overrides } as Options);
	ready.socket.end();
	return ready;
};

const server = (fn: (socket: net.Socket) => void) =>
	new Promise<net.Server>((r) => {
		const x = net.createServer(fn).listen(0, "localhost", () => r(x));
	});

test("Startup reaches ReadyForQuery", async () => {
	const { status, backend, parameters, rest } = await session();
	expect([
		status,
		backend !== null && backend.pid > 0,
		parameters.client_encoding,
		rest.length,
	]).toEqual(["I", true, "UTF8", 0]);
});

test("Startup with md5", async () => {
	expect((await session(login_md5)).status).toBe("I");
});

test("Startup with SCRAM", async () => {
	expect((await session(login_scram)).status).toBe("I");
});

test("Startup with a wrong SCRAM password", async () => {
	expect(await session({ ...login_scram, pass: "nope" }).catch((e) => e.code)).toBe("28P01");
});

test("Startup with ssl: require", async () => {
	expect((await session({ ssl: "require" })).status).toBe("I");
});

test("Startup with ssl: prefer", async () => {
	expect((await session({ ssl: "prefer" })).status).toBe("I");
});

test("Startup rejects with the server error", async () => {
	const error = await session({ database: "nope" }).catch((e) => e);
	expect([error.name, error.severity]).toEqual(["PostgresError", "FATAL"]);
});

test("Startup rejects with the socket error", async () => {
	expect(await session({ port: [1] }).catch((e) => e.code)).toBe("ECONNREFUSED");
});

test("Startup tries the next host", async () => {
	expect((await session({ host: ["localhost", "localhost"], port: [1, pg_port] })).status).toBe(
		"I",
	);
});

test("Startup rejects after connect_timeout", async () => {
	const x = await server(() => {});
	await using _close = defer(() => x.close());
	const start = Date.now();
	const code = await session({ port: [port_of(x)], connect_timeout: 0.2 }).catch((e) => e.code);
	expect([code, Date.now() - start < 1000]).toEqual(["CONNECT_TIMEOUT", true]);
});

test("Startup rejects on a clean close", async () => {
	const x = await server((socket) => socket.end());
	await using _close = defer(() => x.close());
	const code = await session({ port: [port_of(x)] }).catch((e) => e.code);
	expect(code).toBe("CONNECTION_CLOSED");
});

test("Startup with target_session_attrs read-write", async () => {
	expect((await session({ target_session_attrs: "read-write" })).status).toBe("I");
});

test("Startup with target_session_attrs standby and no standby", async () => {
	expect(await session({ target_session_attrs: "standby" }).catch((e) => e.code)).toBe(
		"CONNECTION_DESTROYED",
	);
});

test("Cancel reaches the backend", async () => {
	const ready = await open(base as Options),
		types: string[] = [],
		frames = Frames((type) => types.push(String.fromCharCode(type)));
	await using _end = defer(() => ready.socket.end());
	ready.socket.ondata = (x) => frames.push(x);
	ready.socket.resume();
	ready.socket.write(Query("select pg_sleep(5)"));
	await new Promise((r) => setTimeout(r, 100));
	await ready.cancel();
	await new Promise((r) => setTimeout(r, 100));
	expect(types).toEqual(["T", "E", "Z"]);
});

const message = (type: string, body: Buffer) => {
	const head = Buffer.alloc(5);
	head[0] = type.charCodeAt(0);
	head.writeInt32BE(body.length + 4, 1);
	return Buffer.concat([head, body]);
};

const int32 = (x: number) => {
	const b = Buffer.alloc(4);
	b.writeInt32BE(x);
	return b;
};

const fake = (respond: (socket: net.Socket, type: string, body?: Buffer) => unknown) =>
	server((socket) => {
		let buffer = Buffer.alloc(0),
			started = false;
		socket.on("error", () => {});
		socket.on("data", (data: Buffer) => {
			buffer = Buffer.concat([buffer, data]);
			while (started ? one() : first()) {}
		});

		function first() {
			if (buffer.length < 8 || buffer.length < buffer.readInt32BE(0)) {
				return false;
			}

			const code = buffer.readInt32BE(4);
			buffer = buffer.subarray(buffer.readInt32BE(0));
			if (code === 80877103) {
				socket.write("N");
			} else {
				started = true;
				respond(socket, "startup");
			}
			return true;
		}

		function one() {
			if (buffer.length < 5 || buffer.length < buffer.readInt32BE(1) + 1) {
				return false;
			}

			const type = String.fromCharCode(buffer[0]),
				body = buffer.subarray(5, buffer.readInt32BE(1) + 1);
			buffer = buffer.subarray(buffer.readInt32BE(1) + 1);
			respond(socket, type, body);
			return true;
		}
	});

const ready = Buffer.concat([
	message("K", Buffer.concat([int32(1), int32(2)])),
	message("Z", Buffer.from("I")),
]);

test("Startup rejects a server that is ready before it accepted the authentication", async () => {
	const x = await fake((socket, type) => {
		if (type === "startup") {
			socket.write(message("R", Buffer.concat([int32(10), Buffer.from("SCRAM-SHA-256\0\0")])));
		}
		if (type === "p") {
			socket.write(ready);
		}
	});
	await using _close = defer(() => x.close());
	const code = await session({ port: [port_of(x)], user: "u", pass: "p" }).catch((e) => e.code);
	expect(code).toBe("AUTHENTICATION_INCOMPLETE");
});

test("Startup rejects a server that sends ReadyForQuery without any authentication", async () => {
	const x = await fake((socket, type) => type === "startup" && socket.write(ready));
	await using _close = defer(() => x.close());
	const code = await session({ port: [port_of(x)] }).catch((e) => e.code);
	expect(code).toBe("AUTHENTICATION_INCOMPLETE");
});

test("Startup with a throwing onnotice still connects", async () => {
	const notice = message("N", Buffer.from("SNOTICE\0Mhello\0\0"));
	const x = await fake(
		(socket, type) =>
			type === "startup" && socket.write(Buffer.concat([message("R", int32(0)), notice, ready])),
	);
	await using _close = defer(() => x.close());
	const status = await session({
		port: [port_of(x)],
		onnotice: () => {
			throw new Error("nope");
		},
	}).then(
		(opened) => opened.status,
		(e) => e.message,
	);
	expect(status).toBe("I");
});

test("Startup destroys a TCP connection still in progress when connect_timeout passes", async () => {
	const connect = net.connect,
		sockets: net.Socket[] = [];
	net.connect = (...xs: [any, any?, any?]) => {
		const socket = connect(...xs);
		sockets.push(socket);
		return socket;
	};
	// Unlike a finally block, this runs even if the test times out while the session is pending
	onTestFinished(() => {
		net.connect = connect;
	});
	const code = await session({
		host: ["10.255.255.1"],
		port: [pg_port],
		connect_timeout: 0.2,
	}).catch((e) => e.code);
	expect([code, sockets.map((x) => x.destroyed)]).toEqual(["CONNECT_TIMEOUT", [true]]);
});

const refused = async (auth: Buffer, overrides?: Partial<Options>) => {
	const x = await fake((socket, type) => {
		if (type === "startup") {
			socket.write(message("R", auth));
		}
		if (type === "p") {
			socket.write(
				message("R", Buffer.concat([int32(11), Buffer.from("r=other,s=c2FsdA==,i=4096")])),
			);
		}
	});
	await using _close = defer(() => x.close());
	const code = await session({ port: [port_of(x)], user: "u", pass: "p", ...overrides }).catch(
		(e) => e.code,
	);
	return code;
};

test("Startup rejects an authentication type it does not implement", async () => {
	expect(await refused(int32(7))).toBe("AUTH_TYPE_NOT_IMPLEMENTED");
});

test("Startup rejects SASL without SCRAM-SHA-256", async () => {
	expect(await refused(Buffer.concat([int32(10), Buffer.from("SCRAM-SHA-256-PLUS\0\0")]))).toBe(
		"SASL_MECHANISM_NOT_SUPPORTED",
	);
});

test("Startup rejects a SCRAM server nonce that does not extend the client nonce", async () => {
	expect(await refused(Buffer.concat([int32(10), Buffer.from("SCRAM-SHA-256\0\0")]))).toBe(
		"SASL_NONCE_MISMATCH",
	);
});

test("Startup with ssl: require rejects a server without SSL", async () => {
	expect(await refused(int32(0), { ssl: "require" })).toBe("SSL_NOT_SUPPORTED");
});

test("Startup asks the server for its state when it does not report it, for target_session_attrs", async () => {
	const row = (x: string) =>
		message("D", Buffer.concat([Buffer.from([0, 1]), int32(x.length), Buffer.from(x)]));
	const x = await fake((socket, type) => {
		if (type === "startup") {
			socket.write(Buffer.concat([message("R", int32(0)), ready]));
		}
		if (type === "Q") {
			socket.write(Buffer.concat([row("on"), row("t"), message("Z", Buffer.from("I"))]));
		}
	});
	await using _close = defer(() => x.close());
	const { attributes } = await session({
		port: [port_of(x)],
		target_session_attrs: "standby",
	});
	expect([attributes.readOnly, attributes.standby]).toEqual([true, true]);
});

test("Startup reads the password file as libpq does, and ignores what it can not use", async () => {
	const fs = await import("fs"),
		os = await import("os"),
		path = await import("path"),
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "pgpass-")),
		file = path.join(dir, "pgpass"),
		sent: string[] = [];
	await using _rm = defer(() => fs.rmSync(dir, { recursive: true, force: true }));
	const x = await fake((socket, type, body) => {
		if (type === "startup") {
			socket.write(message("R", int32(3)));
		}
		if (type === "p") {
			sent.push(body!.subarray(0, -1).toString("utf8"));
			socket.write(Buffer.concat([message("R", int32(0)), ready]));
		}
	});
	await using _close = defer(() => x.close());
	const port = port_of(x),
		log_in = (passfile: string | undefined) =>
			session({
				host: ["localhost"],
				port: [port],
				user: "u",
				database: "db",
				pass: undefined,
				passfile,
			});
	fs.writeFileSync(
		file,
		[
			"# localhost:*:*:u:comment",
			"localhost:*:*",
			"localhost:" + port + ":other:u:wrong",
			"localhost:" + port + ":db:u:a\\:b\\\\c:d",
		].join("\n"),
	);
	fs.chmodSync(file, 0o600);
	await log_in(file);
	await log_in(dir);
	await log_in(path.join(dir, "missing"));
	await log_in(undefined);
	expect(sent).toEqual(["a:b\\c:d", "", "", ""]);
});

test("A message the client does not support rejects the query with MESSAGE_NOT_SUPPORTED", async () => {
	const x = await fake((socket, type) => {
		if (type === "startup") {
			socket.write(Buffer.concat([message("R", int32(0)), ready]));
		}
		if (type === "Q") {
			socket.write(Buffer.concat([message("V", int32(0)), message("Z", Buffer.from("I"))]));
		}
	});
	await using _close = defer(() => x.close());
	await using sql = postgres({
		host: "localhost",
		port: port_of(x),
		user: "u",
		fetch_types: false,
		max: 1,
	});
	const error = await sql.unsafe("select 1").catch((e) => [e.code, e.name]);
	expect(error).toEqual(["MESSAGE_NOT_SUPPORTED", "FunctionCallResponse"]);
});

test("Startup with SCRAM-SHA-256-PLUS over TLS when channel_binding is require", async () => {
	expect(
		(await session({ ...login_scram, ssl: "require", channel_binding: "require" })).status,
	).toBe("I");
});

test("channel_binding: require rejects a connection without TLS, or authenticated without SCRAM", async () => {
	expect([
		await session({ ...login_scram, channel_binding: "require" }).catch((e) => e.code),
		await session({ ...login_md5, ssl: "require", channel_binding: "require" }).catch(
			(e) => e.code,
		),
	]).toEqual(["CHANNEL_BINDING_REQUIRED", "CHANNEL_BINDING_REQUIRED"]);
});

test("channel_binding: disable and prefer connect over TLS and without it", async () => {
	const statuses = [];
	for (const channel_binding of ["disable", "prefer"] as const) {
		for (const ssl of [false, "require"] as const) {
			statuses.push((await session({ ...login_scram, ssl, channel_binding })).status);
		}
	}
	expect(statuses).toEqual(["I", "I", "I", "I"]);
});

const header = (type: string, length: number) => {
	const x = Buffer.alloc(5);
	x[0] = type.charCodeAt(0);
	x.writeInt32BE(length, 1);
	return x;
};

test("A message with an invalid length during startup rejects with PROTOCOL_ERROR", async () => {
	const codes = [];
	for (const length of [-1, 0, 3, 0x40000001]) {
		const x = await fake(
			(socket, type) =>
				type === "startup" && socket.write(Buffer.concat([header("R", length), Buffer.alloc(8)])),
		);
		await using _close = defer(() => x.close());
		codes.push(await session({ port: [port_of(x)] }).catch((e) => e.code));
	}
	expect(codes).toEqual(["PROTOCOL_ERROR", "PROTOCOL_ERROR", "PROTOCOL_ERROR", "PROTOCOL_ERROR"]);
});

test("A message with an invalid length after startup rejects the query and closes the connection", async () => {
	const x = await fake((socket, type) => {
		if (type === "startup") {
			socket.write(Buffer.concat([message("R", int32(0)), ready]));
		}
		if (type === "Q") {
			socket.write(Buffer.concat([header("Z", -1), Buffer.alloc(8)]));
		}
	});
	await using _close = defer(() => x.close());
	await using sql = postgres({
		host: "localhost",
		port: port_of(x),
		user: "u",
		fetch_types: false,
		max: 1,
	});
	const error = await sql.unsafe("select 1").catch((e) => e.code + " " + (e.cause && e.cause.code));
	expect(error).toMatch(/PROTOCOL_ERROR/);
});

test("channel_binding: require sends no password when the server asks for cleartext or MD5", async () => {
	const received: unknown[] = [],
		codes: string[] = [];
	for (const kind of [3, 5]) {
		const x = await fake((socket, type) => {
			if (type === "startup") {
				socket.write(message("R", Buffer.concat([int32(kind), Buffer.alloc(kind === 5 ? 4 : 0)])));
			}
			if (type === "p") {
				received.push(kind);
			}
		});
		await using _close = defer(() => x.close());
		codes.push(
			await session({
				port: [port_of(x)],
				user: "u",
				pass: "secret",
				channel_binding: "require",
			}).catch((e) => e.code),
		);
	}
	expect([codes, received]).toEqual([["CHANNEL_BINDING_REQUIRED", "CHANNEL_BINDING_REQUIRED"], []]);
});
