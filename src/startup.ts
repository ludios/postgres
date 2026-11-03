import crypto from "crypto";
import fs from "fs";
import * as p from "./protocol.ts";
import type { Backend } from "./protocol.ts";
import { Socket, secured, secureOptions } from "./socket.ts";
import type { RawSocket } from "./socket.ts";
import type { Options } from "./index.ts";
import { Errors } from "./errors.ts";
import {
	channels,
	active,
	start as trace_start,
	finish as trace_finish,
	userName,
} from "./diagnostics.ts";

const R = 82,
	S = 83,
	K = 75,
	E = 69,
	N = 78,
	D = 68,
	Z = 90;

/** A socket as socket.ts wraps it */
type Connected = Awaited<ReturnType<typeof Socket>>;

/** Lets the pool stop the attempts of `open`, and destroy the sockets that they opened. */
export type Signal = { aborted: boolean; sockets: Set<Connected> };

export async function open(
	options: Options,
	signal: Signal = { aborted: false, sockets: new Set() },
	first = 0,
) {
	const hosts = options.path ? [null] : options.host,
		wanted = options.target_session_attrs,
		passes = wanted === "prefer-standby" ? ["standby", "any"] : [wanted || "any"];

	let last: Error | undefined;

	for (const want of passes) {
		for (let n = 0; n < hosts.length; n++) {
			const i = (first + n) % hosts.length,
				host = hosts[i],
				port = options.port[i] || options.port[0],
				[failed, error, ready] = await traced(options, host, port, signal).then(
					(x): [false, null, Ready] => [false, null, x],
					(x: Error): [true, Error, null] => [true, x, null],
				);
			if (!failed && fits(want, ready.attributes)) {
				ready.index = i;
				return ready;
			}
			if (!failed) {
				ready.socket.end(p.Terminate());
			}
			last = failed ? error : Errors.connection("CONNECTION_DESTROYED", options, host, port);
			if (signal.aborted) {
				throw last;
			}
		}
	}

	throw last;
}

function traced(options: Options, host: string | null, port: number, signal: Signal) {
	const t = channels.connect;
	if (!t || !active(t)) {
		return attempt(options, host, port, signal);
	}

	const context = {
		host: options.path ? null : host,
		port: options.path ? null : port,
		path: options.path || null,
		database: options.database,
		user: userName(options),
		ssl: secured(options),
		sslnegotiation: options.sslnegotiation || "postgres",
	};
	const promise = trace_start(t, context, () => attempt(options, host, port, signal));

	return promise.then(
		(ready) => {
			trace_finish(t, context, null, {
				pid: ready.backend ? ready.backend.pid : null,
				status: ready.status,
				readOnly: ready.attributes.readOnly,
				standby: ready.attributes.standby,
			});
			return ready;
		},
		(error) => {
			trace_finish(t, context, error);
			throw error;
		},
	);
}

function fits(want: string | null, { readOnly, standby }: Ready["attributes"]) {
	return (
		want === "any" ||
		(want === "read-write" && !readOnly) ||
		(want === "read-only" && readOnly) ||
		(want === "primary" && !standby) ||
		(want === "standby" && standby)
	);
}

/** A connection that is ready for queries, as attempt() resolves it */
export type Ready = {
	socket: Connected;
	/** What the socket had read after ReadyForQuery, which the connection's frames get first */
	rest: Buffer;
	/** The backend's key data; null if the server sent none before ReadyForQuery (PostgreSQL always does) */
	backend: Backend | null;
	/** The server's ParameterStatus values, by name */
	parameters: Record<string, string>;
	/** The transaction status of ReadyForQuery: "I", "T" or "E" */
	status: string;
	attributes: { readOnly: boolean; standby: boolean };
	host: string | null;
	port: number;
	/** The index of the host (in `options.host`) that the connection went to; open() sets it */
	index?: number;
	/** Sends a cancel request for the connection's backend */
	cancel: () => ReturnType<typeof cancel>;
};

function attempt(options: Options, host: string | null, port: number, signal: Signal) {
	const { setTimeout, clearTimeout } = options.timers,
		fail = (code: string) => Errors.connection(code, options, host, port);

	return new Promise<Ready>((resolve, reject) => {
		const timer =
			options.connect_timeout &&
			setTimeout(() => give_up(fail("CONNECT_TIMEOUT")), options.connect_timeout * 1000);

		// The socket, once connected; the raw socket while it connects
		let opened: Connected | null = null,
			raw: RawSocket | null = null,
			settled = false;

		session().then(fulfil, give_up);

		/** @returns whether the attempt was still unsettled: then it is settled now, and its timer cleared */
		function settle() {
			if (settled) {
				return false;
			}
			settled = true;
			if (timer) {
				clearTimeout(timer);
			}
			if (opened) {
				signal.sockets.delete(opened);
			}
			return true;
		}

		function fulfil(ready: Ready) {
			if (!settle()) {
				return;
			}
			if (signal.aborted) {
				destroy();
				reject(fail("CONNECTION_DESTROYED"));
				return;
			}
			ready.socket.onclose = () => {};
			resolve(ready);
		}

		function give_up(error: Error) {
			if (!settle()) {
				return;
			}
			destroy();
			reject(error);
		}

		/** Destroys the socket, or the raw socket that is still connecting */
		function destroy() {
			if (opened) {
				opened.destroy();
			} else if (raw) {
				raw.destroy();
			}
		}

		async function session() {
			const socket = await Socket(options, host, port, (x) => (raw = x));
			opened = socket;
			if (settled || signal.aborted) {
				socket.destroy();
				throw fail("CONNECTION_DESTROYED");
			}

			signal.sockets.add(socket);
			socket.onclose = (error) =>
				give_up(
					signal.aborted
						? fail("CONNECTION_DESTROYED")
						: error && error.code
							? error
							: fail("CONNECTION_CLOSED"),
				);
			socket.keepAlive(options.keep_alive);
			await negotiate(socket, options);
			const user = typeof options.user === "function" ? await options.user() : options.user;
			return startup(socket, user, options.database || user);
		}

		function startup(socket: Connected, user: string, database: string) {
			return new Promise<Ready>((succeed, refuse) => {
				const stored = () =>
						pgpass(options.passfile, options.path ? "localhost" : host, port, database, user) || "",
					auth = Auth({
						user,
						pass: options.pass || stored,
						binding: options.channel_binding,
						socket,
					}),
					parameters: Record<string, string> = {},
					frames = p.Frames(frame, false, (error) => {
						refuse(error);
						socket.destroy();
					}),
					rows: string[] = [];

				let probing = false,
					status: string | null = null,
					backend: Backend | null = null,
					authing: Promise<unknown> = Promise.resolve();

				socket.ondata = (x) => frames.push(x);
				socket.write(p.Startup({ user, database, client_encoding: "UTF8", ...options.connection }));

				function frame(type: number, x: Buffer, start: number, end: number) {
					try {
						if (type === R) {
							authenticate(Buffer.from(x.subarray(start, end)));
						} else if (type === S) {
							const [k, v] = p.parameter_status(x, start);
							parameters[k] = v;
						} else if (type === K) {
							backend = p.backend_key_data(x, start);
						} else if (type === E) {
							refuse(Errors.postgres(p.error(x, start, end)));
						} else if (type === N) {
							notice(p.error(x, start, end));
						} else if (type === D) {
							rows.push(x.toString("utf8", start + 11, start + 11 + x.readInt32BE(start + 7)));
						} else if (type === Z) {
							once_authenticated(p.ready_for_query(x, start), Buffer.from(x.subarray(end)));
						}
					} catch (error) {
						refuse(error);
					}
				}

				function notice(x: Record<string, string>) {
					try {
						if (options.onnotice) {
							options.onnotice(x);
						} else if (options.onnotice !== false) {
							// oxlint-disable-next-line no-console -- the default onnotice prints to stdout, as documented
							console.log(x);
						}
					} catch {
						// An onnotice that throws must not break the connection
					}
				}

				function authenticate(x: Buffer) {
					authing = authing.then(() => auth(x)).then((reply) => reply && socket.write(reply));
					authing.catch((error) => {
						refuse(error);
						socket.destroy();
					});
				}

				function once_authenticated(x: string, rest: Buffer) {
					authing.then(
						() => ready(x, rest),
						() => {},
					);
				}

				function ready(x: string, rest: Buffer) {
					if (!auth.authenticated) {
						refuse(
							Errors.generic(
								"AUTHENTICATION_INCOMPLETE",
								"The server was ready before it accepted the authentication",
							),
						);
						return;
					}

					status = x;
					const known =
						"in_hot_standby" in parameters && "default_transaction_read_only" in parameters;

					if (options.target_session_attrs && !known && !probing) {
						probing = true;
						socket.write(
							p.Query("show transaction_read_only; select pg_catalog.pg_is_in_recovery()"),
						);
						return;
					}

					frames.pause();
					socket.ondata = () => {};
					socket.pause();
					succeed({
						socket,
						rest,
						backend,
						parameters,
						status,
						attributes: {
							readOnly: (known ? parameters.default_transaction_read_only : rows[0]) === "on",
							standby: known ? parameters.in_hot_standby === "on" : rows[1] === "t",
						},
						host,
						port,
						cancel: () => (backend ? cancel(options, host, port, backend) : Promise.resolve()),
					});
				}
			});
		}
	});
}

async function negotiate(socket: Connected, options: Options) {
	if (!secured(options) || socket.negotiated) {
		return;
	}

	const ssl = options.ssl,
		tls = secureOptions(ssl);

	if (options.sslnegotiation === "direct") {
		await socket.upgrade({ ...tls, ALPNProtocols: ["postgresql"] });
		return;
	}

	const answer = new Promise<number>((r) => (socket.ondata = (x: Buffer) => r(x[0])));
	socket.write(p.SSLRequest());

	if ((await answer) === S) {
		await socket.upgrade(tls);
		return;
	}

	if (ssl !== "prefer" && ssl !== "allow") {
		throw Errors.generic("SSL_NOT_SUPPORTED", "The server does not support SSL connections");
	}
}

/**
 * Sends a CancelRequest over a new connection to the server at `host` and `port`,
 * and waits for the server to close that connection.
 *
 * @param pid the process ID of the backend whose statement to cancel
 * @param secret that backend's secret key, from its BackendKeyData
 * @returns a promise that resolves once the server has closed the connection,
 *   and rejects if the CancelRequest could not be sent, or with CONNECT_TIMEOUT
 *   after `connect_timeout` seconds, when the CancelRequest may still reach the
 *   server
 */
function cancel(options: Options, host: string | null, port: number, { pid, secret }: Backend) {
	const { setTimeout, clearTimeout } = options.timers;

	return new Promise<void>((resolve, reject) => {
		// The socket, once connected
		let opened: Connected | null = null,
			settled = false;
		const timer =
			options.connect_timeout &&
			setTimeout(
				() => settle(Errors.connection("CONNECT_TIMEOUT", options, host, port)),
				options.connect_timeout * 1000,
			);

		send().then(
			() => settle(null),
			(error) => settle(error),
		);

		async function send() {
			const socket = await Socket(options, host, port);
			opened = socket;
			if (!settled) {
				await negotiate(socket, options);
			}
			// After the timeout, also a socket that only connected since
			if (settled) {
				socket.destroy();
				return;
			}
			await new Promise<void>((closed) => {
				socket.onclose = () => closed();
				socket.end(p.Cancel(pid, secret));
			});
		}

		function settle(error: Error | null) {
			if (settled) {
				return;
			}
			settled = true;
			if (timer) {
				clearTimeout(timer);
			}
			if (!error) {
				resolve();
				return;
			}
			if (opened) {
				opened.destroy();
			}
			reject(error);
		}
	});
}

/** The salted passwords of SCRAM, by the hash of the password, the salt and the iterations */
const salted = new Map<string, Buffer>();

function Auth({
	user,
	pass,
	binding = "prefer",
	socket,
}: {
	user: string;
	pass: Options["pass"];
	binding: Options["channel_binding"];
	socket: Connected;
}) {
	// The client nonce of SCRAM, made now, as one authentication needs at most one
	const nonce = crypto.randomBytes(18).toString("base64");
	let signature: string | undefined,
		verified = true,
		bound: Buffer | false = false,
		header = "n,,";

	respond.authenticated = false;
	return respond;

	async function respond(x: Buffer) {
		const type = x.readInt32BE(5);
		if ((type === 3 || type === 5) && binding === "require") {
			throw unbound(
				"the server asked for " + (type === 3 ? "a cleartext" : "an MD5") + " password",
			);
		}

		return type === 0
			? ok()
			: type === 3
				? p.Password(await password())
				: type === 5
					? p.Password(
							"md5" +
								md5(
									Buffer.concat([Buffer.from(md5((await password()) + user)), x.subarray(9, 13)]),
								),
						)
					: type === 10
						? start(x)
						: type === 11
							? proceed(x, await password())
							: type === 12
								? finish(x)
								: unsupported(type);
	}

	function start(x: Buffer) {
		const offered = x.toString("utf8", 9).split("\0"),
			certificate = binding !== "disable" && socket && socket.certificate && socket.certificate(),
			hash = certificate && endpoint(certificate),
			plus = !!hash && offered.includes("SCRAM-SHA-256-PLUS");

		if (binding === "require" && !plus) {
			throw unbound(
				offered.includes("SCRAM-SHA-256-PLUS")
					? "the server certificate could not be hashed for it"
					: "the server did not offer it",
			);
		}

		if (!plus && !offered.includes("SCRAM-SHA-256")) {
			throw Errors.generic(
				"SASL_MECHANISM_NOT_SUPPORTED",
				"The server offered no supported SASL mechanism",
			);
		}

		header = plus ? "p=tls-server-end-point,," : hash ? "y,," : "n,,";
		bound = plus ? hash : false;
		verified = false;
		return p.SASL(plus ? "SCRAM-SHA-256-PLUS" : "SCRAM-SHA-256", header + "n=*,r=" + nonce);
	}

	function proceed(x: Buffer, password_text: string) {
		const res = x
				.toString("utf8", 9)
				.split(",")
				.reduce<Record<string, string>>((acc, attr) => {
					acc[attr[0]] = attr.slice(2);
					return acc;
				}, {}),
			key = sha256(password_text + "\0" + res.s + "\0" + res.i).toString("base64");

		if (!res.r.startsWith(nonce)) {
			throw Errors.generic(
				"SASL_NONCE_MISMATCH",
				"The server nonce does not start with the client nonce",
			);
		}

		let saltedPassword = salted.get(key);
		if (saltedPassword === undefined) {
			if (salted.size >= 64) {
				for (const oldest of salted.keys()) {
					salted.delete(oldest);
					break;
				}
			}
			saltedPassword = crypto.pbkdf2Sync(
				password_text,
				Buffer.from(res.s, "base64"),
				+res.i,
				32,
				"sha256",
			);
			salted.set(key, saltedPassword);
		}

		const clientKey = hmac(saltedPassword, "Client Key"),
			channel = (
				bound ? Buffer.concat([Buffer.from(header), bound]) : Buffer.from(header)
			).toString("base64"),
			auth =
				"n=*,r=" +
				nonce +
				",r=" +
				res.r +
				",s=" +
				res.s +
				",i=" +
				res.i +
				",c=" +
				channel +
				",r=" +
				res.r;

		signature = hmac(hmac(saltedPassword, "Server Key"), auth).toString("base64");
		return p.SASLResponse(
			"c=" +
				channel +
				",r=" +
				res.r +
				",p=" +
				xor(clientKey, hmac(sha256(clientKey), auth)).toString("base64"),
		);
	}

	function finish(x: Buffer): null {
		if (!signature || x.toString("utf8", 9).split("\0", 1)[0].slice(2) !== signature) {
			throw Errors.generic(
				"SASL_SIGNATURE_MISMATCH",
				"The server did not return the correct signature",
			);
		}

		verified = true;
		return null;
	}

	function ok(): null {
		if (!verified) {
			throw Errors.generic(
				"SASL_SIGNATURE_MISMATCH",
				"The server ended SCRAM authentication without proving it knows the password",
			);
		}

		if (binding === "require" && !bound) {
			throw unbound("the server authenticated without it");
		}

		respond.authenticated = true;
		return null;
	}

	function password() {
		return Promise.resolve(typeof pass === "function" ? pass() : pass);
	}
}

function unsupported(type: number) {
	throw Errors.generic(
		"AUTH_TYPE_NOT_IMPLEMENTED",
		"Authentication type " + type + " is not supported",
	);
}

function unbound(reason: string) {
	return Errors.generic("CHANNEL_BINDING_REQUIRED", "channel_binding is require, but " + reason);
}

/** The hash of a certificate's signature algorithm, by the algorithm's OID (as hex) */
const signatures: Record<string, string> = {
	"2a864886f70d010104": "sha256",
	"2a864886f70d010105": "sha256",
	"2a864886f70d01010e": "sha224",
	"2a864886f70d01010b": "sha256",
	"2a864886f70d01010c": "sha384",
	"2a864886f70d01010d": "sha512",
	"2a8648ce3d0401": "sha256",
	"2a8648ce3d040301": "sha224",
	"2a8648ce3d040302": "sha256",
	"2a8648ce3d040303": "sha384",
	"2a8648ce3d040304": "sha512",
	"2a8648ce380403": "sha256",
	"608648016503040302": "sha256",
};

/** The hash of a digest algorithm, by the algorithm's OID (as hex), for RSA-PSS signatures */
const digests: Record<string, string> = {
	"2b0e03021a": "sha256",
	"608648016503040201": "sha256",
	"608648016503040202": "sha384",
	"608648016503040203": "sha512",
	"608648016503040204": "sha224",
};

function endpoint(certificate: Buffer) {
	try {
		const x = Buffer.from(certificate),
			algorithm = signature_algorithm(x);
		return algorithm ? crypto.createHash(algorithm).update(x).digest() : null;
	} catch {
		return null;
	}
}

function signature_algorithm(x: Buffer) {
	const certificate = der(x, 0),
		tbs = der(x, certificate.body),
		algorithm = der(x, tbs.end),
		oid = der(x, algorithm.body),
		name = x[oid.start] === 0x06 && x.toString("hex", oid.body, oid.end);

	if (name !== "2a864886f70d01010a") {
		return name ? signatures[name] : undefined;
	}

	if (oid.end >= algorithm.end) {
		return "sha256";
	}

	const params = der(x, oid.end),
		first = params.body < params.end && der(x, params.body);

	if (!first || x[first.start] !== 0xa0) {
		return "sha256";
	}

	const hash = der(x, der(x, first.body).body);
	return digests[x.toString("hex", hash.body, hash.end)];
}

function der(x: Buffer, start: number) {
	let length = x[start + 1],
		body = start + 2;

	if (length & 0x80) {
		const n = length & 0x7f;
		length = 0;
		for (let i = 0; i < n; i++) {
			length = length * 256 + x[body + i];
		}
		body += n;
	}

	if (body + length > x.length) {
		throw new Error("Truncated certificate");
	}

	return { start, body, end: body + length };
}

function md5(x: crypto.BinaryLike) {
	return crypto.createHash("md5").update(x).digest("hex");
}

function hmac(key: crypto.BinaryLike, x: crypto.BinaryLike) {
	return crypto.createHmac("sha256", key).update(x).digest();
}

function sha256(x: crypto.BinaryLike) {
	return crypto.createHash("sha256").update(x).digest();
}

function xor(a: Buffer, b: Buffer) {
	const x = Buffer.allocUnsafe(a.length);
	for (let i = 0; i < a.length; i++) {
		x[i] = a[i] ^ b[i];
	}
	return x;
}

function pgpass(
	file: string | undefined,
	host: string | null,
	port: number,
	database: string,
	user: string,
) {
	if (!file) {
		return null;
	}

	let text: string;
	try {
		const stat = fs.statSync(file);
		if (!stat.isFile() || (process.platform !== "win32" && stat.mode & 0o077)) {
			return null;
		}
		text = fs.readFileSync(file, "utf8");
	} catch {
		return null;
	}
	const wanted = [host, String(port), database, user];
	for (const line of text.split(/\r?\n/)) {
		const fields = line && line[0] !== "#" ? split(line) : [];
		if (fields.length === 5 && wanted.every((x, i) => fields[i] === "*" || fields[i] === x)) {
			return fields[4];
		}
	}
	return null;
}

function split(line: string) {
	const fields: string[] = [];
	let field = "";
	for (let i = 0; i < line.length; i++) {
		const c = line[i];
		if (c === "\\" && i + 1 < line.length) {
			field += line[++i];
		} else if (c === ":" && fields.length < 4) {
			fields.push(field);
			field = "";
		} else {
			field += c;
		}
	}
	fields.push(field);
	return fields;
}
