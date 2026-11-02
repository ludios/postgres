// Model-output: Claude Opus 5.5
// The part of the Cloudflare Workers module "cloudflare:sockets" that src/cf.ts uses; see
// https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/
declare module "cloudflare:sockets" {
	export type Socket = {
		readonly readable: ReadableStream<Uint8Array>;
		readonly writable: WritableStream<Uint8Array>;
		/** Resolves once the connection is established */
		readonly opened: Promise<unknown>;
		readonly closed: Promise<void>;
		close(): Promise<void>;
		/** Upgrades a socket that was opened with `secureTransport: "starttls"` to TLS */
		startTls(): Socket;
	};

	export function connect(
		address: { hostname: string; port: number },
		options?: { secureTransport?: "off" | "on" | "starttls"; allowHalfOpen?: boolean },
	): Socket;
}
