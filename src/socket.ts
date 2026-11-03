import net from "net";
import tls from "tls";
import type { Options } from "./index.ts";

const noop = (..._: any[]) => {},
	agent = (globalThis.navigator && globalThis.navigator.userAgent) || "",
	workers = agent.startsWith("Cloudflare-Workers"),
	onreadSafe =
		!agent || agent.startsWith("Node.js") || agent.startsWith("Bun") || agent.startsWith("Deno"),
	node = !agent || agent.startsWith("Node.js"),
	contexts = new WeakMap<
		object,
		{ values: tls.ConnectionOptions; secureContext: tls.SecureContext }
	>();

/**
 * A net.Socket as connect() sets it up, with the properties that wrap() reads. Cloudflare Workers
 * imitate it (cf.ts).
 */
export type RawSocket = net.Socket & {
	/** Whether `onread` reads into one buffer that is reused, so that a chunk kept must be copied */
	shared?: boolean;
	/** Whether the socket was TLS from the start */
	secure?: boolean;
	/** Whether TLS was negotiated after connecting (Cloudflare's startTls) */
	negotiated?: boolean;
	/** Called with each chunk that `onread` reads */
	ondata?: (x: Buffer) => void;
	getPeerCertificate?: tls.TLSSocket["getPeerCertificate"];
};

export async function Socket(
	options: Options,
	host: string | null,
	port: number,
	track: (socket: RawSocket) => void = noop,
) {
	const raw = options.socket
		? await options.socket(options, host, port)
		: await connect(options, host, port, track);

	return wrap(raw, host);
}

export function secureOptions(ssl: Options["ssl"]) {
	return ssl === "require" || ssl === "allow" || ssl === "prefer"
		? workers
			? {}
			: { rejectUnauthorized: false }
		: typeof ssl === "object"
			? context(ssl)
			: {};
}

function context(ssl: tls.ConnectionOptions) {
	if (!node || ssl.secureContext || !ssl.ca) {
		return ssl;
	}

	const values = { ...ssl };
	let last = contexts.get(ssl);
	if (!last || !same(values, last.values)) {
		contexts.set(ssl, (last = { values, secureContext: tls.createSecureContext(values) }));
	}
	return { ...values, secureContext: last.secureContext };
}

/** @returns whether `a` and `b` have the same keys, with identical values */
function same(a: object, b: object) {
	const x = a as Record<string, unknown>,
		y = b as Record<string, unknown>;
	return [...Object.keys(x), ...Object.keys(y)].every((k) => x[k] === y[k]);
}

/**
 * @param options - the options of the pool
 * @returns whether a connection asks for TLS: when `ssl` is set, except over a Unix-domain socket,
 *          where libpq never asks for it, and the server always says no
 */
export const secured = (options: Options) => !!options.ssl && !options.path;

export const direct = (options: Options) => secured(options) && options.sslnegotiation === "direct";

function connect(
	options: Options,
	host: string | null,
	port: number,
	track: (socket: RawSocket) => void,
) {
	return new Promise<RawSocket>((resolve, reject) => {
		const tlsNow = direct(options),
			plain = !secured(options),
			reads: net.OnReadOpts | false = (plain || tlsNow) &&
				onreadSafe &&
				options.onread !== false && {
					buffer: Buffer.allocUnsafe(65536),
					// `b` is `buffer`, the Buffer above; true keeps the socket reading (false would pause it)
					callback: (n, b) => {
						socket.ondata?.((b as Buffer).subarray(0, n));
						return true;
					},
				},
			target: net.NetConnectOpts = options.path
				? { path: options.path }
				: { port, host: host ?? undefined };
		if (reads) {
			target.onread = reads;
		}
		const socket: RawSocket = tlsNow
			? tls.connect({
					...target,
					servername: net.isIP(host || "") || options.path ? undefined : (host ?? undefined),
					...secureOptions(options.ssl),
					ALPNProtocols: ["postgresql"],
				})
			: net.connect(target);
		track(socket);
		socket.shared = !!reads;
		socket.secure = tlsNow;
		socket.ondata = noop;
		socket.once("error", reject);
		socket.once(tlsNow ? "secureConnect" : "connect", () => {
			socket.off("error", reject);
			socket.setNoDelay(true);
			resolve(socket);
		});
	});
}

function wrap(socket: RawSocket, host: string | null) {
	let closed = false,
		failure: Error | null = null;

	if (socket.shared) {
		socket.ondata = data;
	}

	const x = {
		ondata: noop,
		ondrain: noop,
		onclose: noop,
		get raw() {
			return socket;
		},
		get closed() {
			return closed;
		},
		get shared() {
			return socket.shared === true;
		},
		get negotiated() {
			return socket.secure === true || socket.negotiated === true;
		},
		certificate() {
			const cert = typeof socket.getPeerCertificate === "function" && socket.getPeerCertificate();
			return (cert && cert.raw) || null;
		},
		write: (chunk: Buffer | string) => !closed && socket.write(chunk),
		upgrade,
		pause: () => socket.pause(),
		resume: () => socket.resume(),
		ref: () => socket.ref && socket.ref(),
		unref: () => socket.unref && socket.unref(),
		end(chunk?: Buffer | string) {
			if (!closed) {
				if (chunk) {
					socket.end(chunk);
				} else {
					socket.end();
				}
			}
		},
		destroy(reason?: Error) {
			if (reason && !failure) {
				failure = reason;
			}
			socket.destroy();
		},
		keepAlive(seconds: number | null) {
			if (seconds && socket.setKeepAlive) {
				socket.setKeepAlive(true, 1000 * seconds);
			}
		},
	};

	listen();
	return x;

	function listen() {
		socket.on("data", data);
		socket.on("drain", drain);
		socket.on("error", error);
		socket.on("close", close);
	}

	function unlisten() {
		socket.off("data", data);
		socket.off("drain", drain);
		socket.off("error", error);
		socket.off("close", close);
	}

	function data(buffer: Buffer) {
		x.ondata(buffer);
	}
	function drain() {
		x.ondrain();
	}
	function error(err: Error) {
		if (!failure) {
			failure = err;
		}
		socket.destroy();
		close();
	}

	function close() {
		if (closed) {
			return;
		}

		closed = true;
		x.onclose(failure);
	}

	function upgrade(options: tls.ConnectionOptions = {}) {
		return new Promise<typeof x>((resolve, reject) => {
			unlisten();
			const secure = tls.connect({
				socket,
				servername: net.isIP(host || "") ? undefined : (host ?? undefined),
				...options,
			});
			const fail = (err: Error) => {
				secure.off("secureConnect", ready);
				reject(err);
			};
			function ready() {
				secure.off("error", fail);
				socket = secure;
				listen();
				resolve(x);
			}
			secure.once("secureConnect", ready);
			secure.once("error", fail);
		});
	}
}
