// Helpers for the unit tests and the integration tests alike. Importing this module has no side
// effects (unlike tests/common.ts, which imports the library).
import type net from "net";
import util from "util";

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

/**
 * @param f - a function that the caller expects to throw synchronously (a promise that `f` returns
 * is not awaited)
 * @returns the value that `f` threw (usually an Error, whose `code` or `message` the caller checks);
 * or, if `f` returned without throwing, an Error with the code DID_NOT_THROW whose message shows what
 * `f` returned, so that the caller's check fails and its diff shows which call did not throw
 */
export function thrown(f: () => unknown): any {
	let returned;
	try {
		returned = f();
	} catch (e) {
		return e;
	}
	return Object.assign(
		new Error("Returned without throwing: " + util.inspect(returned, { depth: 0 })),
		{ code: "DID_NOT_THROW" },
	);
}

/**
 * @param name  - the name of an environment variable
 * @param value - the value to give it, or `undefined` to unset it
 */
function set_env(name: string, value: string | undefined) {
	if (value === undefined) {
		delete process.env[name];
	} else {
		process.env[name] = value;
	}
}

/**
 * @param vars - the environment variables to set while `f` runs, by name; `undefined` unsets one
 * @param f    - a function to run; a promise that it returns is not awaited
 * @returns what `f` returns; whether `f` returns or throws, each variable in `vars` then has the
 * value that it had before `with_env` was called, or is unset if it was unset then
 */
export function with_env<T>(vars: Record<string, string | undefined>, f: () => T): T {
	const before = Object.keys(vars).map((name) => [name, process.env[name]] as const);
	for (const [name, value] of Object.entries(vars)) {
		set_env(name, value);
	}
	try {
		return f();
	} finally {
		for (const [name, value] of before) {
			set_env(name, value);
		}
	}
}

/**
 * @param fn - a cleanup, such as one that drops a table or ends a pool; what it returns is awaited
 * @returns a resource that runs `fn` when the scope that declared it with `await using` exits,
 * even when the scope exits by throwing
 */
export function defer(fn: () => unknown): AsyncDisposable {
	return {
		async [Symbol.asyncDispose]() {
			await fn();
		},
	};
}
