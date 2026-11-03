// Helpers for the unit tests and the integration tests alike. Importing this module has no side
// effects (unlike tests/common.ts, which imports the library).
import type net from "net";
import util from "util";
import { configure } from "@logtape/logtape";
import type { LogRecord } from "@logtape/logtape";

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
export const camel_case = (x: string) => x.replace(/(?!^)_(.)/g, (_, c: string) => c.toUpperCase());

/**
 * @param x - a name in camelCase
 * @returns `x` in snake_case
 */
export const snake_case = (x: string) => x.replace(/[A-Z]/g, (c) => "_" + c.toLowerCase());

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
 * @param f    - a function to run, which must not return a promise: the variables are restored
 *   as soon as `f` returns, so the rest of an async `f` would run without them
 * @returns what `f` returns; whether `f` returns or throws, each variable in `vars` then has the
 * value that it had before `with_env` was called, or is unset if it was unset then
 */
export function with_env<T>(vars: Record<string, string | undefined>, f: () => T): T {
	const before = Object.keys(vars).map((name) => [name, process.env[name]] as const);
	for (const [name, value] of Object.entries(vars)) {
		set_env(name, value);
	}
	try {
		const result = f();
		if (result instanceof Promise) {
			throw new Error("with_env() was given a function that returned a promise");
		}
		return result;
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

/** The records that the library has logged since log_records() was last called */
const kept: LogRecord[] = [];

/** The configuration of LogTape, once log_records() has made it */
let capturing: Promise<void> | null = null;

/**
 * Configures LogTape (once per test file) to keep every record that the library logs, at every
 * level, and forgets the records kept so far.
 * @returns the array that gets each record from now on, and drops its oldest one beyond 10,000
 */
export async function log_records() {
	capturing ??= configure({
		reset: true,
		sinks: {
			memory(record) {
				// Bounded: the sink stays on for the rest of the test file
				if (kept.length === 10_000) {
					kept.shift();
				}
				kept.push(record);
			},
		},
		loggers: [
			{ category: "postgres", lowestLevel: "trace", sinks: ["memory"] },
			{ category: ["logtape", "meta"], sinks: [] },
		],
	});
	await capturing;
	kept.length = 0;
	return kept;
}

/**
 * @param record - a record of log_records()
 * @returns its message as a text sink shows it, with the values bare
 */
export function rendered(record: LogRecord) {
	return record.message.map((x) => (typeof x === "string" ? x : String(x))).join("");
}

/**
 * @param records - the records of log_records()
 * @param category - the last part of a category, such as "pool" for postgres.pool
 * @param level - a level, to keep only the records of that level; undefined for every level
 * @returns the messages (see rendered()) of the records kept, each prefixed with its level and a space
 */
export function log_lines(records: LogRecord[], category: string, level?: string) {
	return records
		.filter((x) => x.category[1] === category && (level === undefined || x.level === level))
		.map((x) => x.level + " " + rendered(x));
}

/**
 * Waits for what `check` tests for, polling every 10 ms.
 * @param check - truthy (or a promise of something truthy) once what the caller waits for has happened
 * @param ms - how long to wait at most, in milliseconds
 * @param state - describes the state that the error of a timeout then shows, for the reader
 * @throws if `check` is still falsy after `ms`
 */
export async function until(check: () => unknown, ms = 5000, state?: () => string) {
	const deadline = Date.now() + ms;
	while (!(await check())) {
		if (Date.now() > deadline) {
			throw new Error(
				"Gave up waiting after " + ms + " ms for " + check + (state ? " with " + state() : ""),
			);
		}
		await new Promise((r) => setTimeout(r, 10));
	}
}
