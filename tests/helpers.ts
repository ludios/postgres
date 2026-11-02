// Helpers for the unit tests and the integration tests alike. Importing this module has no side
// effects (unlike tests/common.ts, which imports the library).
import type net from "net";

/**
 * @param server - a server that listens on a TCP port (not on a Unix socket or a pipe)
 * @returns the TCP port that `server` listens on
 */
export function port_of(server: net.Server): number {
	const address = server.address();
	if (address === null) {
		throw new Error("The server is not listening (it has not started yet, or it has closed)");
	}
	if (typeof address === "string") {
		throw new Error("The server listens on " + address + ", not on a TCP port");
	}
	return address.port;
}

/**
 * @param x - a name in snake_case
 * @returns `x` in camelCase; an underscore at the start of `x` stays, as in v3's postgres.toCamel
 */
export const camel_case = (x) => x.replace(/(?!^)_(.)/g, (_, c) => c.toUpperCase());

/**
 * @param x - a name in camelCase
 * @returns `x` in snake_case
 */
export const snake_case = (x) => x.replace(/[A-Z]/g, (c) => "_" + c.toLowerCase());
