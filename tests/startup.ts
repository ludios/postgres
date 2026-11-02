import net from "net";
import { expect, test } from "vitest";
import { postgres, login, login_md5, login_scram, pg_port } from "./setup.ts";
import { open } from "../src/startup.ts";
import { Query, Frames } from "../src/protocol.ts";

const base = {
	host: ["localhost"],
	port: [pg_port],
	database: "postgres_js_test",
	connect_timeout: 3,
	timers: { setTimeout, clearTimeout },
	...login,
};

const session = async (options?) => {
	const ready = await open({ ...base, ...options });
	ready.socket.end();
	return ready;
};

const server = (fn) =>
	new Promise((r) => {
		const x = net.createServer(fn).listen(0, "localhost", () => r(x));
	});

test("Startup reaches ReadyForQuery", async () => {
	const { status, backend, parameters, rest } = await session();
	expect([status, backend.pid > 0, parameters.client_encoding, rest.length].join()).toBe(
		"I,true,UTF8,0",
	);
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
	expect(error.name + "," + error.severity).toBe("PostgresError,FATAL");
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
	const start = Date.now();
	const code = await session({ port: [x.address().port], connect_timeout: 0.2 }).catch(
		(e) => e.code,
	);
	x.close();
	expect(code + "," + (Date.now() - start < 1000)).toBe("CONNECT_TIMEOUT,true");
});

test("Startup rejects on a clean close", async () => {
	const x = await server((socket) => socket.end());
	const code = await session({ port: [x.address().port] }).catch((e) => e.code);
	x.close();
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
	const ready = await open(base),
		types = [],
		frames = Frames((type) => types.push(String.fromCharCode(type)));
	ready.socket.ondata = (x) => frames.push(x);
	ready.socket.resume();
	ready.socket.write(Query("select pg_sleep(5)"));
	await new Promise((r) => setTimeout(r, 100));
	await ready.cancel();
	await new Promise((r) => setTimeout(r, 100));
	ready.socket.end();
	expect(types.join("")).toBe("TEZ");
});

const message = (type, body) => {
	const head = Buffer.alloc(5);
	head[0] = type.charCodeAt(0);
	head.writeInt32BE(body.length + 4, 1);
	return Buffer.concat([head, body]);
};

const int32 = (x) => {
	const b = Buffer.alloc(4);
	b.writeInt32BE(x);
	return b;
};

const fake = (respond) =>
	server((socket) => {
		let buffer = Buffer.alloc(0),
			started = false;
		socket.on("error", () => {});
		socket.on("data", (data) => {
			buffer = Buffer.concat([buffer, data]);
			while (started ? one() : first());
		});

		function first() {
			if (buffer.length < 8 || buffer.length < buffer.readInt32BE(0)) return false;

			const code = buffer.readInt32BE(4);
			buffer = buffer.subarray(buffer.readInt32BE(0));
			code === 80877103 ? socket.write("N") : ((started = true), respond(socket, "startup"));
			return true;
		}

		function one() {
			if (buffer.length < 5 || buffer.length < buffer.readInt32BE(1) + 1) return false;

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
		type === "startup" &&
			socket.write(message("R", Buffer.concat([int32(10), Buffer.from("SCRAM-SHA-256\0\0")])));
		type === "p" && socket.write(ready);
	});
	const code = await session({ port: [x.address().port], user: "u", pass: "p" }).catch(
		(e) => e.code,
	);
	x.close();
	expect(code).toBe("AUTHENTICATION_INCOMPLETE");
});

test("Startup rejects a server that sends ReadyForQuery without any authentication", async () => {
	const x = await fake((socket, type) => type === "startup" && socket.write(ready));
	const code = await session({ port: [x.address().port] }).catch((e) => e.code);
	x.close();
	expect(code).toBe("AUTHENTICATION_INCOMPLETE");
});

test("Startup with a throwing onnotice still connects", async () => {
	const notice = message("N", Buffer.from("SNOTICE\0Mhello\0\0"));
	const x = await fake(
		(socket, type) =>
			type === "startup" && socket.write(Buffer.concat([message("R", int32(0)), notice, ready])),
	);
	const status = await session({
		port: [x.address().port],
		onnotice: () => {
			throw new Error("nope");
		},
	}).then(
		(x) => x.status,
		(e) => e.message,
	);
	x.close();
	expect(status).toBe("I");
});

test("Startup destroys a TCP connection still in progress when connect_timeout passes", async () => {
	const connect = net.connect,
		sockets = [];
	net.connect = (...xs) => {
		const socket = connect(...xs);
		sockets.push(socket);
		return socket;
	};
	const code = await session({
		host: ["10.255.255.1"],
		port: [pg_port],
		connect_timeout: 0.2,
	}).catch((e) => e.code);
	net.connect = connect;
	expect(code + " " + sockets.length + " " + sockets.every((x) => x.destroyed)).toBe(
		"CONNECT_TIMEOUT 1 true",
	);
});

const refused = async (auth, options?) => {
	const x = await fake((socket, type) => {
		type === "startup" && socket.write(message("R", auth));
		type === "p" &&
			socket.write(
				message("R", Buffer.concat([int32(11), Buffer.from("r=other,s=c2FsdA==,i=4096")])),
			);
	});
	const code = await session({ port: [x.address().port], user: "u", pass: "p", ...options }).catch(
		(e) => e.code,
	);
	x.close();
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
	const row = (x) =>
		message("D", Buffer.concat([Buffer.from([0, 1]), int32(x.length), Buffer.from(x)]));
	const x = await fake((socket, type) => {
		type === "startup" && socket.write(Buffer.concat([message("R", int32(0)), ready]));
		type === "Q" &&
			socket.write(Buffer.concat([row("on"), row("t"), message("Z", Buffer.from("I"))]));
	});
	const { attributes } = await session({
		port: [x.address().port],
		target_session_attrs: "standby",
	});
	x.close();
	expect(attributes.readOnly + " " + attributes.standby).toBe("true true");
});

test("Startup reads the password file as libpq does, and ignores what it can not use", async () => {
	const fs = await import("fs"),
		os = await import("os"),
		path = await import("path"),
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "pgpass-")),
		file = path.join(dir, "pgpass"),
		sent = [];
	const x = await fake((socket, type, body) => {
		type === "startup" && socket.write(message("R", int32(3)));
		type === "p" &&
			(sent.push(body.toString("utf8", 0, body.length - 1)),
			socket.write(Buffer.concat([message("R", int32(0)), ready])));
	});
	const port = x.address().port,
		login = (passfile) =>
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
	await login(file);
	await login(dir);
	await login(path.join(dir, "missing"));
	await login(null);
	x.close();
	fs.rmSync(dir, { recursive: true, force: true });
	const expected = JSON.stringify(["a:b\\c:d", "", "", ""]);
	expect(JSON.stringify(sent)).toBe(expected);
});

test("A message the client does not support rejects the query with MESSAGE_NOT_SUPPORTED", async () => {
	const x = await fake((socket, type) => {
		type === "startup" && socket.write(Buffer.concat([message("R", int32(0)), ready]));
		type === "Q" &&
			socket.write(Buffer.concat([message("V", int32(0)), message("Z", Buffer.from("I"))]));
	});
	const sql = postgres({
		host: "localhost",
		port: x.address().port,
		user: "u",
		fetch_types: false,
		max: 1,
	});
	const error = await sql.unsafe("select 1").catch((e) => e.code + " " + e.name);
	await sql.end({ timeout: 0 });
	x.close();
	expect(error).toBe("MESSAGE_NOT_SUPPORTED FunctionCallResponse");
});

test("Startup with SCRAM-SHA-256-PLUS over TLS when channel_binding is require", async () => {
	expect(
		(await session({ ...login_scram, ssl: "require", channel_binding: "require" })).status,
	).toBe("I");
});

test("channel_binding: require rejects a connection without TLS, or authenticated without SCRAM", async () => {
	expect(
		[
			await session({ ...login_scram, channel_binding: "require" }).catch((e) => e.code),
			await session({ ...login_md5, ssl: "require", channel_binding: "require" }).catch(
				(e) => e.code,
			),
		].join(" "),
	).toBe("CHANNEL_BINDING_REQUIRED CHANNEL_BINDING_REQUIRED");
});

test("channel_binding: disable and prefer connect over TLS and without it", async () => {
	const statuses = [];
	for (const channel_binding of ["disable", "prefer"]) {
		for (const ssl of [false, "require"])
			statuses.push((await session({ ...login_scram, ssl, channel_binding })).status);
	}
	expect(statuses.join()).toBe("I,I,I,I");
});

const header = (type, length) => {
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
		codes.push(await session({ port: [x.address().port] }).catch((e) => e.code));
		x.close();
	}
	expect(codes.join()).toBe("PROTOCOL_ERROR,PROTOCOL_ERROR,PROTOCOL_ERROR,PROTOCOL_ERROR");
});

test("A message with an invalid length after startup rejects the query and closes the connection", async () => {
	const x = await fake((socket, type) => {
		type === "startup" && socket.write(Buffer.concat([message("R", int32(0)), ready]));
		type === "Q" && socket.write(Buffer.concat([header("Z", -1), Buffer.alloc(8)]));
	});
	const sql = postgres({
		host: "localhost",
		port: x.address().port,
		user: "u",
		fetch_types: false,
		max: 1,
	});
	const error = await sql.unsafe("select 1").catch((e) => e.code + " " + (e.cause && e.cause.code));
	await sql.end({ timeout: 0 });
	x.close();
	expect(/PROTOCOL_ERROR/.test(error)).toBe(true);
});

test("channel_binding: require sends no password when the server asks for cleartext or MD5", async () => {
	const received = [],
		codes = [];
	for (const kind of [3, 5]) {
		const x = await fake((socket, type) => {
			type === "startup" &&
				socket.write(message("R", Buffer.concat([int32(kind), Buffer.alloc(kind === 5 ? 4 : 0)])));
			type === "p" && received.push(kind);
		});
		codes.push(
			await session({
				port: [x.address().port],
				user: "u",
				pass: "secret",
				channel_binding: "require",
			}).catch((e) => e.code),
		);
		x.close();
	}
	expect(codes.join() + " " + received.length).toBe(
		"CHANNEL_BINDING_REQUIRED,CHANNEL_BINDING_REQUIRED 0",
	);
});
