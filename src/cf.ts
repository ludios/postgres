import { connect } from "cloudflare:sockets";
import type { Socket } from "cloudflare:sockets";
import { EventEmitter } from "node:events";
import { Buffer } from "node:buffer";
import postgres, { PostgresError } from "./index.ts";
import { Errors, throw_on_casing_transforms } from "./errors.ts";
import { tls_refused } from "./log.ts";
import { secured, direct } from "./socket.ts";
import type { RawSocket } from "./socket.ts";
import type { Options } from "./index.ts";

export default function Postgres(
	a?: string | Record<string, unknown>,
	b?: Record<string, unknown>,
) {
	return typeof a === "string" || !a ? postgres(a, { socket, ...b }) : postgres({ socket, ...a });
}

Object.assign(Postgres, postgres);
throw_on_casing_transforms(Postgres);

export { PostgresError };

export async function socket(options: Options, host: string, port: number): Promise<RawSocket> {
	if (direct(options)) {
		throw Errors.generic(
			"SSL_NEGOTIATION_NOT_SUPPORTED",
			"sslnegotiation: direct needs ALPN, which Cloudflare Workers sockets do not offer",
		);
	}

	const tls = secured(options);
	let raw = connect(
		{ hostname: host, port },
		{ secureTransport: tls ? "starttls" : "off", allowHalfOpen: false },
	);
	await raw.opened;

	let secure = false;
	if (tls) {
		const writer = raw.writable.getWriter(),
			reader = raw.readable.getReader();
		await writer.write(ssl_request);
		const { value, done } = await reader.read();
		writer.releaseLock();
		reader.releaseLock();

		if (done) {
			throw Errors.connection("CONNECTION_CLOSED", options, host, port);
		}

		if (value[0] === 83) {
			raw = raw.startTls();
			await raw.opened;
			secure = true;
		} else if (options.ssl !== "prefer" && options.ssl !== "allow") {
			raw.close().catch(() => {});
			throw Errors.generic("SSL_NOT_SUPPORTED", "The server does not support SSL connections");
		} else {
			tls_refused(options, host, port);
		}
	}

	// Stream() adds what wrap() (socket.ts) reads of a net.Socket
	return Stream(raw, secure, host, port) as unknown as RawSocket;
}

const ssl_request = Buffer.from([0, 0, 0, 8, 4, 210, 22, 47]),
	chunk = 16384;

function Stream(raw: Socket, secure: boolean, host: string, port: number) {
	// Looks like a net.Socket: the Object.assign below adds its properties.
	const x: EventEmitter & Record<string, any> = new EventEmitter(),
		writer = raw.writable.getWriter(),
		reader = raw.readable.getReader();

	let paused = false,
		wake: (() => void) | null = null,
		closed = false,
		pending = 0,
		answered = !secure;

	const written = () => --pending === 0 && x.emit("drain");

	Object.assign(x, {
		secure,
		negotiated: true,
		destroyed: false,
		write(data: Buffer) {
			if (closed) {
				return false;
			}

			for (let i = 0; i < data.length; i += chunk) {
				pending++;
				writer.write(data.subarray(i, i + chunk)).then(written, fail);
			}
			return pending < 16;
		},
		end(data?: Buffer) {
			if (data) {
				x.write(data);
			}
			writer.close().catch(() => {});
		},
		destroy() {
			x.destroyed = true;
			raw.close().catch(() => {});
			finish();
		},
		pause() {
			paused = true;
		},
		resume() {
			paused = false;
			if (wake) {
				wake();
				wake = null;
			}
		},
		setKeepAlive() {},
		setNoDelay() {},
	});

	void read();
	return x;

	function resumed() {
		return new Promise<void>((r) => (wake = r));
	}

	async function read() {
		try {
			while (true) {
				if (paused) {
					await resumed();
				}
				const { value, done } = await reader.read();

				if (done) {
					break;
				}

				answered = true;
				x.emit("data", Buffer.from(value.buffer, value.byteOffset, value.byteLength));
			}
		} catch (error) {
			if (!closed) {
				x.emit("error", handshake(error));
			}
		}
		finish();
	}

	function fail(error: unknown) {
		if (!closed) {
			x.emit("error", handshake(error));
		}
		x.destroy();
	}

	function finish() {
		if (closed) {
			return;
		}

		if (!answered && !x.destroyed) {
			x.emit("error", handshake());
		}
		closed = true;
		x.emit("close");
	}

	function handshake(error?: unknown) {
		if (answered) {
			return error;
		}

		answered = true;

		return Object.assign(
			Errors.generic(
				"TLS_HANDSHAKE_FAILED",
				"The TLS connection to " +
					host +
					":" +
					port +
					" was lost before the server answered. " +
					"Workers could not complete the TLS handshake, most often because the server certificate is not trusted by a public CA",
			),
			{ cause: error },
		);
	}
}
