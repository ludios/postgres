import os from "os";
import fs from "fs";

import { Types, Parameter } from "./types.ts";
import type { PostgresType } from "./types.ts";

import { Identifier, Builder } from "./build.ts";
import { Query, CLOSE } from "./query.ts";
import type { Handler, QueryOptions } from "./query.ts";
import { Pool, backoff_seconds } from "./pool.ts";
import { Errors, PostgresError, throw_on_casing_transforms } from "./errors.ts";
import Subscribe from "./subscribe.ts";
import largeObject from "./large.ts";
import { channels, active, start, finish, userName } from "./diagnostics.ts";
import type postgres from "../types/index.js";
import type { open } from "./startup.ts";
import type { RawSocket } from "./socket.ts";
import type { Lease } from "./pool.ts";
import type { Failure } from "./errors.ts";

/** A host of the url or the options, with its port if the text gave one */
type Target = [host: string, port: number | null];

/** The callback of a transaction or a savepoint, called with the transaction's `sql` */
type Body = (sql: any) => unknown;

/**
 * A channel that the pool listens on: its `listeners`; its `state`, the connection's `{ pid, secret }`,
 * which is one object for the channel's lifetime, so that a listener sees reconnects in it; `result`,
 * the promise of the latest LISTEN; `listening`, whether that LISTEN succeeded, and onclose() has not
 * seen the listener connection close since; `retries`, how many of the LISTENs that relisten() sent
 * have failed in a row; and `timer`, the timer of the next retry of a failed LISTEN, if one is pending.
 */
type Channel = {
	listeners: Set<Listener>;
	state: { pid?: number; secret?: number };
	result: Promise<unknown> | null;
	listening: boolean;
	retries: number;
	timer: Timer | null;
};

/** A listener of a channel: `fn` gets each notification's payload; `onlisten` is called once listening */
type Listener = { fn: (payload: string) => void; onlisten?: () => void };

/** An entry of `option_rules`: see there */
type Rule = {
	default: unknown;
	variable?: string;
	parameter?: string;
	read?: (value: unknown, source: string) => unknown;
};

export default Object.assign(Postgres, {
	PostgresError,
	BigInt: {
		to: 20,
		from: [20],
		parse: (x: string) => BigInt(x),
		serialize: (x: bigint) => x.toString(),
	},
});

throw_on_casing_transforms(Postgres);

export { PostgresError };

/**
 * @param types - the custom types (of `options.types`), by name
 * @returns `sql.types`: a function that makes a Parameter of a type that is given by its OID, with
 *   a function (for each custom type) that makes a Parameter of that custom type
 */
function typed_parameters(types: Record<string, PostgresType>) {
	// oxlint-disable-next-line unicorn/consistent-function-scoping -- a new function for each pool, since properties are defined on it below
	const typed = (value: unknown, type: number | string) => new Parameter(value, type);

	// Defined, not assigned: assigning throws for `name` and `length` (read-only properties of
	// every function; `name` is also a PostgreSQL type) and for `arguments` and `caller` (whose
	// inherited setters throw in strict mode), and assigning `__proto__` would replace the
	// prototype of `typed`.
	Object.entries(types).forEach(([name, type]) =>
		Object.defineProperty(typed, name, {
			value: (x: unknown) => new Parameter(x, type.to),
			writable: true,
			enumerable: true,
			configurable: true,
		}),
	);
	return typed;
}

function Postgres(a?: string | Record<string, any>, b?: Record<string, any>) {
	const options = parse_options(a, b),
		types = options.shared_types || Types(options),
		pool = Pool(options, types),
		subscribe = options.no_subscribe
			? null
			: Subscribe(Postgres, { ...options, shared_types: types }),
		listener = Listen(options);

	if (types.named && options.fetch_types === false) {
		throw Errors.generic(
			"TYPE_NOT_FOUND",
			"Custom types given by name need fetch_types to look them up",
		);
	}

	options.resolve = types.resolve;
	options.parsers = view(types.parsers, types.parser);
	options.serializers = view(types.serializers, types.serializer);

	const typed = typed_parameters(options.types),
		sql = Sql(handler);

	Object.defineProperties(sql, {
		parameters: { get: () => options.parameters, enumerable: true },
		stats: { get: () => pool.stats, enumerable: true },
	});

	Object.assign(sql, {
		largeObject: largeObject.bind(null, sql),
		subscribe,
		CLOSE,
		END: CLOSE,
		PostgresError,
		options,
		reserve,
		listen: listener.listen,
		begin,
		close,
		end,
	});

	if (Symbol.asyncDispose) {
		sql[Symbol.asyncDispose] = () => end();
	}

	return sql;

	function handler(q: Query) {
		pool.query(q);
	}

	/**
	 * @param fn - called with each Query that the returned `sql` makes, to run it; its `cancel`
	 *   property, if it has one, cancels a Query (else the pool's does)
	 * @returns a new `sql`, without the properties that only some `sql`s have (such as `begin`
	 *   or `release`), which the callers add
	 */
	function Sql(fn: ((q: Query) => void) & { cancel?: Handler["cancel"] }): any {
		const handle: Handler = Object.assign(fn, {
			debug: options.debug,
			options,
			cancel: fn.cancel || pool.cancel,
		});

		Object.assign(sql, {
			types: typed,
			typed,
			unsafe,
			notify,
			array,
			json,
			file,
		});

		return sql;

		function sql(strings: TemplateStringsArray, ...args: any[]): Query;
		function sql(identifier: string): Identifier;
		function sql(first: any, ...rest: any[]): Builder;
		function sql(strings: unknown, ...args: unknown[]) {
			return strings && Array.isArray((strings as TemplateStringsArray).raw)
				? new Query(strings as TemplateStringsArray, args, handle)
				: typeof strings === "string" && !args.length
					? new Identifier(
							options.transform.column.to ? options.transform.column.to(strings) : strings,
						)
					: new Builder(strings, args);
		}

		function unsafe(string: string, args: unknown[] = [], query_options: QueryOptions = {}) {
			if (arguments.length === 2 && !Array.isArray(args)) {
				query_options = args;
				args = [];
			}
			return new Query([string], args, handle, {
				prepare: false,
				...query_options,
				simple: "simple" in query_options ? query_options.simple : args.length === 0,
			});
		}

		async function notify(channel: string, payload: string) {
			// oxlint-disable-next-line typescript/no-unnecessary-type-conversion -- a JavaScript caller may pass a number, which pg_notify(text, text) would refuse
			return await sql`select pg_notify(${channel}, ${"" + payload})`;
		}

		function file(path: string, args: unknown[] = [], query_options: QueryOptions = {}) {
			if (arguments.length === 2 && !Array.isArray(args)) {
				query_options = args;
				args = [];
			}
			// Runs the query once the file is read; otherwise the handler
			const fileHandler: Handler = Object.assign((query: Query) => {
				fs.readFile(path, "utf8", (err, string) => {
					if (err) {
						query.reject(err);
						return;
					}
					query.strings = [string];
					handle(query);
				});
			}, handle);
			return new Query([], args, fileHandler, {
				...query_options,
				simple: "simple" in query_options ? query_options.simple : args.length === 0,
			});
		}
	}

	async function reserve() {
		const lease = await pool.acquire("reserve"),
			reserved = Sql(Object.assign((q: Query) => lease.send(q), { cancel: pool.cancel }));

		reserved.release = () => lease.release();
		if (Symbol.dispose) {
			reserved[Symbol.dispose] = reserved.release;
		}
		if (Symbol.asyncDispose) {
			reserved[Symbol.asyncDispose] = async () => reserved.release();
		}
		return reserved;
	}

	function begin(first: string | Body, second?: Body) {
		const [mode, fn] = second ? [first as string, second] : ["", first as Body],
			t = channels.transaction;
		if (!t || !active(t)) {
			return transaction(mode, fn, null);
		}

		const context: postgres.TransactionTrace = {
			mode,
			database: options.database,
			user: userName(options),
			connection: null,
			host: null,
			port: null,
			outcome: null,
		};
		const promise = start(t, context, () => transaction(mode, fn, context));

		return promise.then(
			(result) => {
				finish(t, context, null, result);
				return result;
			},
			(error) => {
				finish(t, context, error);
				throw error;
			},
		);
	}

	async function transaction(mode: string, fn: Body, context: postgres.TransactionTrace | null) {
		const lease = await pool.acquire("transaction");

		let savepoints = 0,
			prepare: string | null = null;

		if (context) {
			Object.assign(context, {
				connection: lease.connection.id,
				host: lease.connection.host,
				port: lease.connection.port,
			});
		}

		try {
			await control(lease, "begin " + mode.replace(/[^a-z ]/gi, ""));
			const done = scope(fn);
			done.catch(() => {});
			return await Promise.race([done, lease.closed]);
		} finally {
			lease.release();
		}

		/**
		 * Runs `body` in the transaction, or in a savepoint named `name`; `inside` says whether a
		 * nested begin() is the caller, and `above` whether an outer savepoint was rolled back
		 */
		async function scope(body: Body, name?: string | null, inside?: boolean, above = () => false) {
			let uncaught: unknown,
				result: unknown,
				rolled: Promise<void> | null = null,
				after: Failure | null = null;

			if (above()) {
				throw rolledBack();
			}

			const stopped = () => !!rolled || above(),
				scoped = Sql(
					Object.assign(
						(q: Query) => {
							if (stopped()) {
								q.reject(after || (after = rolledBack()));
								return;
							}
							q.catch((e) => uncaught || (uncaught = e));
							lease.send(q);
						},
						{ cancel: pool.cancel },
					),
				);

			scoped.savepoint = savepoint;
			scoped.begin = nested;
			scoped.rollback = () =>
				rolled ||
				(rolled = control(lease, name ? "rollback to " + identifier(name) : "rollback").then(
					() => {},
				));
			scoped.prepare = (x: string) => {
				if (inside) {
					throw Errors.generic(
						"NESTED_TRANSACTION_MODE",
						"A nested transaction can not be prepared, only the outermost one",
					);
				}
				prepare = x.replace(/[^a-z0-9$\-_. ]/gi, "");
			};

			if (name) {
				await control(lease, "savepoint " + identifier(name));
			}
			try {
				result = await new Promise((resolve, reject) => {
					const x = body(scoped);
					Promise.resolve(Array.isArray(x) ? Promise.all(x) : x).then(resolve, reject);
				});
				if (uncaught && !stopped()) {
					throw uncaught;
				}
				if (lease.connection.closed) {
					throw lease.error || lease.connection.closed;
				}
			} catch (error) {
				if (context && !name) {
					context.outcome = "rollback";
				}
				if (stopped()) {
					if (rolled) {
						await rolled.catch(() => {});
					}
				} else if (!lease.connection.closed) {
					await control(lease, name ? "rollback to " + identifier(name) : "rollback");
				}
				throw (error instanceof PostgresError && error.code === "25P02" && uncaught) || error;
			}

			if (stopped()) {
				if (rolled) {
					await rolled;
				}
				if (context && !name) {
					context.outcome = "rollback";
				}

				if (after) {
					throw after;
				}

				return result;
			}

			if (!name) {
				const done = await control(
					lease,
					prepare ? "prepare transaction '" + prepare.replace(/'/g, "''") + "'" : "commit",
				);
				if (context) {
					context.outcome = prepare ? "prepare" : done.command === "COMMIT" ? "commit" : "rollback";
				}

				if (!prepare && done.command !== "COMMIT") {
					throw Errors.generic(
						"TRANSACTION_ROLLED_BACK",
						"The server rolled back the transaction instead of committing it",
					);
				}
			}

			return result;

			function savepoint(label: unknown, callback?: Body) {
				if (label && Array.isArray((label as TemplateStringsArray).raw)) {
					return savepoint((sp: any) => sp.apply(sp, arguments));
				}

				if (arguments.length === 1) {
					callback = label as Body;
					label = null;
				}
				const suffix = label ? "_" + (label as string) : "";
				return scope(callback, "s" + savepoints++ + suffix, false, stopped);
			}

			async function nested(first: string | Body, second?: Body) {
				const [inner, callback] = second ? [first as string, second] : ["", first as Body];

				if (normal(inner) && normal(inner) !== normal(mode)) {
					throw Errors.generic(
						"NESTED_TRANSACTION_MODE",
						"A nested transaction runs in a savepoint, which can not change the transaction mode",
					);
				}

				return scope(callback, "s" + savepoints++, true, stopped);
			}
		}
	}

	function control(lease: Lease, text: string) {
		const q = new Query(
			[text],
			[],
			Object.assign((query: Query) => lease.send(query), { options, cancel: pool.cancel }),
			{ simple: true },
		);
		return q.execute();
	}

	async function end(end_options?: { timeout?: number | null }) {
		await Promise.all([
			listener.end(),
			subscribe && subscribe.sql ? subscribe.sql.end({ timeout: 0 }) : null,
		]);
		return pool.end(end_options);
	}

	function close() {
		return pool.close();
	}
}

function json(x: unknown) {
	return new Parameter(x, 3802);
}

function array() {
	throw Errors.generic("ARRAY_REMOVED", "sql.array() is removed in v4, pass the array as it is");
}

function rolledBack() {
	return Errors.generic(
		"TRANSACTION_ROLLED_BACK",
		"The query was not sent, the transaction was rolled back with sql.rollback()",
	);
}

function normal(x: string | undefined) {
	return (x || "")
		.toLowerCase()
		.replace(/[^a-z ]/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

/**
 * @param x - a name, such as a channel's
 * @returns `x` quoted as an SQL identifier
 */
function identifier(x: string) {
	return '"' + x.replace(/"/g, '""') + '"';
}

function Listen(options: Options) {
	const { setTimeout, clearTimeout } = options.timers,
		// Channel name → channel
		channel_by_name = new Map<string, Channel>();
	// The listener connection: a pool of one connection, opened when a channel is listened on
	let sql: postgres.Sql | null = null,
		// The promise that end() returns (null until end() is called)
		closing: Promise<unknown> | null = null;

	return {
		listen,
		end() {
			channel_by_name.forEach((channel) => clearTimeout(channel.timer));
			if (!closing) {
				closing = sql ? sql.end({ timeout: 0 }) : Promise.resolve();
			}
			return closing;
		},
	};

	/** @returns the listener connection, opened if there is none */
	function connection() {
		if (!sql) {
			const pool = Postgres({
				...options,
				max: 1,
				idle_timeout: null,
				max_lifetime: null,
				fetch_types: false,
				no_subscribe: true,
				onclose() {
					// Not after end(), and not for a connection that retire() ended, which may close
					// after a LISTEN on its replacement succeeded
					if (closing || sql !== pool) {
						return;
					}

					// Only a channel that was listening on the closed connection needs a new LISTEN. A
					// channel whose LISTEN is in flight sees it fail, which rejects the listen() calls
					// that await it, and makes relisten() retry if the LISTEN was its own. A channel
					// that waits to retry is on its way already. A second chain of retries would send a
					// second LISTEN, call each onlisten twice, and leave a timer that end() cannot clear.
					channel_by_name.forEach((channel, name) => {
						if (channel.listening) {
							relisten(channel, name);
						}
					});
				},
				onnotify(channel: string, payload: string) {
					if (channel_by_name.has(channel)) {
						[...channel_by_name.get(channel).listeners].forEach((l) => l.fn(payload));
					}
				},
			});
			sql = pool;
		}
		return sql;
	}

	/**
	 * Sends LISTEN for a channel, as its latest LISTEN.
	 * @param channel - the channel
	 * @param name - the channel's name
	 * @returns the LISTEN's result, once `channel` has recorded the success (also `channel.result`)
	 */
	function send_listen(channel: Channel, name: string) {
		const x = connection();
		channel.listening = false;
		channel.result = x`listen ${x.unsafe(identifier(name))}`.then((result) => {
			channel.listening = true;
			Object.assign(channel.state, result.state);
			return result;
		});
		return channel.result;
	}

	/**
	 * Sends LISTEN for a channel again, and if that fails, again after `options.backoff`, until it
	 * succeeds, the channel has no listeners left, or the listener connection is ending.
	 * @param channel - the channel
	 * @param name - the channel's name
	 */
	function relisten(channel: Channel, name: string) {
		// A listener that joins while this LISTEN is in flight gets its onlisten call from listen()
		const listeners = [...channel.listeners];
		channel.timer = null;
		send_listen(channel, name).then(
			() => {
				channel.retries = 0;
				if (closing) {
					return;
				}
				listeners.forEach((l) => {
					if (channel.listeners.has(l) && l.onlisten) {
						try {
							l.onlisten();
						} catch {
							// As for a listener's fn in onnotify: one listener's error must not stop the
							// calls of the others, or reject this promise, which nothing handles
						}
					}
				});
			},
			() => {
				if (closing || channel_by_name.get(name) !== channel) {
					return;
				}

				channel.retries++;
				channel.timer = setTimeout(
					() => {
						if (!closing && channel_by_name.get(name) === channel) {
							relisten(channel, name);
						}
					},
					backoff_seconds(options.backoff, channel.retries) * 1000,
				);
			},
		);
	}

	/**
	 * Forgets a channel that has no listeners left, and ends the listener connection if no channel
	 * remains.
	 * @param channel - the channel
	 * @param name - the channel's name
	 * @param failed - whether the channel's latest LISTEN failed, so that the server has nothing to
	 *   UNLISTEN, and a retry of the LISTEN may be pending
	 */
	async function retire(channel: Channel, name: string, failed: boolean) {
		if (channel_by_name.get(name) === channel) {
			channel_by_name.delete(name);
		}
		clearTimeout(channel.timer);
		const x = sql;
		if (closing || !x) {
			return;
		}

		if (!failed) {
			await x`unlisten ${x.unsafe(identifier(name))}`.catch((e) => {
				if (!String(e.code).startsWith("CONNECTION_")) {
					throw e;
				}
			});
		}
		if (channel_by_name.size === 0 && sql === x) {
			sql = null;
			await x.end();
		}
	}

	/**
	 * Listens on a channel, on the listener connection, which is opened if there is none.
	 * @param name - the channel's name
	 * @param fn - called with the payload of each notification on the channel
	 * @param onlisten - called once the channel is listening, and again each time it is listening
	 *   again, after its connection closed. If the first call throws, listen() removes the listener
	 *   and rejects with the error.
	 * @returns the channel's `state` (see `channel_by_name`) and `unlisten()`, which removes this listener
	 */
	async function listen(name: string, fn: Listener["fn"], onlisten?: Listener["onlisten"]) {
		if (closing) {
			throw Errors.connection("CONNECTION_ENDED", options, options.host[0], options.port[0]);
		}

		const listener = { fn, onlisten };
		let channel = channel_by_name.get(name);
		if (!channel) {
			channel = {
				listeners: new Set<Listener>(),
				state: {},
				result: null,
				listening: false,
				retries: 0,
				timer: null,
			};
			// Not stored if the LISTEN cannot be sent, which connection() may throw for
			void send_listen(channel, name);
			channel_by_name.set(name, channel);
		} else if (channel.timer !== null) {
			// The channel's latest LISTEN failed, and the channel waits to send it again. Sending it
			// now makes this listen() await a new attempt, instead of rejecting with the failed
			// LISTEN's error. relisten() runs before this listener joins, so that only listen() calls
			// this listener's onlisten.
			clearTimeout(channel.timer);
			relisten(channel, name);
		}

		channel.listeners.add(listener);
		try {
			await channel.result;
		} catch (error) {
			channel.listeners.delete(listener);
			if (channel.listeners.size === 0) {
				await retire(channel, name, true);
			}
			throw error;
		}
		if (onlisten) {
			try {
				onlisten();
			} catch (error) {
				// As when the LISTEN fails, a listen() that rejects leaves no listener behind. It
				// rejects with onlisten's error even if the UNLISTEN fails.
				await unlisten().catch(() => {});
				throw error;
			}
		}

		return { state: channel.state, unlisten };

		async function unlisten() {
			if (!channel.listeners.delete(listener) || channel.listeners.size) {
				return;
			}

			// A pending retry means that the latest LISTEN failed
			await retire(channel, name, channel.timer !== null);
		}
	}
}

/** The longest delay, in milliseconds (about 24.8 days), that `setTimeout` waits for. */
const max_delay = 2 ** 31 - 1;

/**
 * @returns the timers to use when the options give none: the global timer functions as they are
 *          now, taken together so that a timer is always cleared by the implementation that set
 *          it, with a `setTimeout` that waits at most `max_delay`, because Node.js runs a timer
 *          whose delay is longer than `max_delay` after 1 ms instead
 */
function default_timers() {
	const set_timeout = setTimeout;
	return {
		setTimeout: (fn: (...args: any[]) => void, ms: number, ...args: any[]) =>
			set_timeout(fn, Math.min(ms, max_delay), ...args),
		clearTimeout,
		setImmediate,
		clearImmediate,
		now: () => performance.now(),
	};
}

/**
 * @param value - the value of an option
 * @returns `value` as an error shows it: text in double quotes, and anything else as `String()`
 *          writes it
 */
function shown(value: unknown) {
	// oxlint-disable-next-line typescript/no-base-to-string -- an option's value may be anything; String() shows it as the errors always have
	return typeof value === "string" ? JSON.stringify(value) : String(value);
}

/**
 * Reads an option that may be turned off, and that has no other checks.
 *
 * @param value - the value of the option
 * @returns `false` if `value` is the text `disable` or `false`, which turn an option off;
 *          otherwise `value`
 */
function off(value: unknown) {
	return value === "disable" || value === "false" ? false : value;
}

/**
 * @param value - the value of an option that is on or off, among other things that it may be
 * @returns `true` for the text `true`; `false` for `null`, which turns an option off, as it turns
 *          off an option that is a number of seconds; otherwise what `off` returns for `value`
 */
function on_or_off(value: unknown) {
	if (value === null) {
		return false;
	}
	return value === "true" ? true : off(value);
}

/**
 * @param value - the value of a numeric option
 * @returns `value` if it is a number; the number that `value` writes if it is the text of a
 *          non-negative decimal number, with or without whitespace around it; otherwise NaN
 */
function number(value: unknown) {
	if (typeof value === "number") {
		return value;
	}
	return typeof value === "string" && /^\s*\d+(\.\d+)?\s*$/.test(value) ? +value : NaN;
}

/**
 * Reads an option that is a number of seconds.
 *
 * @param value  - the value of the option
 * @param source - where the value comes from, such as `The option idle_timeout`, which begins the
 *                 message of the error
 * @returns the number of seconds; `false` for the text `disable` or `false`; and `value` itself
 *          if it is neither a number nor text, such as `null` or a function that computes the
 *          number
 * @throws if `value` is a number that is NaN, negative or infinite, or text that is not a
 *         non-negative decimal number
 */
function seconds(value: unknown, source: string) {
	const x = off(value);
	if (typeof x !== "string" && typeof x !== "number") {
		return x;
	}
	const n = number(x);
	if (!Number.isFinite(n) || n < 0) {
		throw new Error(source + " must be a non-negative decimal number, but it is " + shown(value));
	}
	return n;
}

/**
 * @param least - the least value that the option may have
 * @returns a reader of an option that counts something; the reader takes the value of the option
 *          and where it comes from (as `seconds` does), returns the option's integer, and throws if
 *          the value is neither an integer of at least `least` nor the text of one
 */
function integer(least: number) {
	return (value: unknown, source: string) => {
		const n = number(value);
		if (!Number.isInteger(n) || n < least) {
			throw new Error(
				source + " must be an integer of at least " + least + ", but it is " + shown(value),
			);
		}
		return n;
	};
}

/**
 * @param allowed - every value that the option may have
 * @returns a reader that takes the value of the option and where it comes from (as `seconds`
 *          does), returns the value if it is one of `allowed`, and throws otherwise
 */
function one_of(...allowed: unknown[]) {
	return (value: unknown, source: string) => {
		if (!allowed.includes(value)) {
			throw new Error(
				source + " must be one of " + allowed.map(shown).join(", ") + ", but it is " + shown(value),
			);
		}
		return value;
	};
}

/**
 * @param other     - tells whether a value is one of the other things, besides on or off, that the
 *                    option may be; such a value is used as it is
 * @param described - every kind of value that the option may have, as an error lists them
 * @returns a reader of an option that is on or off, or else one of the other things: the reader
 *          takes the value of the option and where it comes from (as `seconds` does), returns the
 *          value if `other` accepts it, and otherwise `true` or `false` as `on_or_off` reads it,
 *          and throws for any other value
 */
function on_off_or(other: (value: unknown) => boolean, described: string) {
	return (value: unknown, source: string) => {
		if (other(value)) {
			return value;
		}
		const x = on_or_off(value);
		if (typeof x !== "boolean") {
			throw new Error(source + " must be " + described + ", but it is " + shown(value));
		}
		return x;
	};
}

/**
 * Reads an option that is on or off: `true` for `true` and the text `true`, and `false` for
 * `false`, `null`, and the texts `false` and `disable`
 */
const boolean = on_off_or(() => false, "true or false");

/** Reads an option that is on or off, as `boolean` does, or a function, such as `debug` */
const boolean_or_function = on_off_or(
	(value) => typeof value === "function",
	"true, false or a function",
);

/** The modes of ssl besides `disable`, as libpq names them, but without `verify-ca` */
const ssl_modes = ["allow", "prefer", "require", "verify-full"];

/** Reads any ssl except `verify-ca`: on or off, as `boolean` does, TLS options, or one of `ssl_modes` */
const ssl_mode = on_off_or(
	(value) => (value !== null && typeof value === "object") || ssl_modes.includes(value as string),
	"true, false, an object of TLS options, or one of " +
		["disable", ...ssl_modes].map(shown).join(", "),
);

/**
 * Reads ssl, which says whether and how to encrypt the connection.
 *
 * @param value  - the value of the option
 * @param source - where the value comes from (as for `seconds`)
 * @returns what `ssl_mode` returns for `value`
 * @throws for `verify-ca`, which would check only that one of the certificate authorities that
 *         the runtime trusts by default signed the certificate (libpq refuses `verify-ca` with
 *         `sslrootcert=system` for this reason), and for any value that `ssl_mode` throws for
 */
function ssl_option(value: unknown, source: string) {
	if (value === "verify-ca") {
		throw new Error(
			source +
				' is "verify-ca", which would check only that a certificate authority signed the ' +
				"certificate. A mode can check it only against the certificate authorities that the " +
				"runtime trusts by default, and they sign a certificate for any host name that its " +
				'requester controls. Use "verify-full", or ' +
				"ssl: { ca, checkServerIdentity: () => undefined } with a certificate authority of your own",
		);
	}
	return ssl_mode(value, source);
}

/** Reads the value of target_session_attrs, which may be `any` too, as in libpq. */
const session_attrs = one_of(
	null,
	"any",
	"read-write",
	"read-only",
	"primary",
	"standby",
	"prefer-standby",
);

/**
 * Reads target_session_attrs, the kind of server to settle on when there are several hosts.
 *
 * @param value  - the value of the option
 * @param source - where the value comes from (as for `seconds`)
 * @returns `value`, or `null` for `any`, as `null` already means that any server will do
 * @throws if `value` is not one of the kinds that `session_attrs` allows
 */
function target_session_attrs(value: unknown, source: string) {
	const x = session_attrs(value, source);
	return x === "any" ? null : x;
}

/**
 * @param retries - how many tries in a row have failed
 * @returns the number of seconds to wait before the next try: 3^retries / 100, but at most 20,
 *          times a random factor from 0.5 to 1
 */
function backoff(retries: number) {
	return (0.5 + Math.random() / 2) * Math.min(3 ** retries / 100, 20);
}

/** @returns the number of seconds that a connection may be open, between 30 and 60 minutes */
function max_lifetime() {
	return 60 * (30 + Math.random() * 30);
}

/**
 * The options that the url and environment variables can set too. Each has its value when nothing
 * sets it (`default`); its environment variable, if that is not `PG` followed by its name in upper
 * case (`variable`); its other name in the url, as libpq names it, if it has one (`parameter`); and
 * the reader that checks a value of it and turns text into what the option holds (`read`), if the
 * option has one. An option without a reader, such as the name of a replication slot, is used as
 * it is given.
 */
const option_rules: Record<string, Rule> = {
	max: { default: (globalThis as { Cloudflare?: unknown }).Cloudflare ? 3 : 10, read: integer(1) },
	min: { default: 0, read: integer(0) },
	max_pipeline: { default: 100, read: integer(0) },
	idle_timeout: { default: null, read: seconds },
	connect_timeout: { default: 30, read: seconds },
	queue_timeout: { default: 0, read: seconds },
	max_lifetime: { default: max_lifetime, read: seconds },
	backoff: { default: backoff, read: seconds },
	keep_alive: { default: 60, read: seconds },
	scheduler: { default: true, read: boolean },
	prepare: { default: true, read: boolean },
	fetch_types: { default: true, read: boolean },
	infer: { default: false, read: boolean },
	// parse_options gives the default: verify-full when sslrootcert, or else PGSSLROOTCERT, is
	// "system", and otherwise false
	ssl: { default: undefined, variable: "PGSSLMODE", parameter: "sslmode", read: ssl_option },
	// Or a function that is called with every query
	debug: { default: false, read: boolean_or_function },
	sslnegotiation: { default: null, read: one_of(null, "postgres", "direct") },
	channel_binding: {
		default: "prefer",
		variable: "PGCHANNELBINDING",
		read: one_of("disable", "prefer", "require"),
	},
	target_session_attrs: {
		default: null,
		variable: "PGTARGETSESSIONATTRS",
		read: target_session_attrs,
	},
	publications: { default: "alltables" },
	slot: { default: null },
};

/** The parameters of a url that the client reads, and so does not send to the server */
const client_parameters = new Set([
	"host",
	"port",
	...Object.entries(option_rules).flatMap(([k, rule]) =>
		rule.parameter ? [k, rule.parameter] : [k],
	),
]);

/**
 * Reads an option from the first of these places that sets it: the options object, the query of
 * the url (by the option's name, or else by its other name there), and the option's environment
 * variable.
 *
 * @param k     - the name of the option
 * @param rule  - the option's entry in `option_rules`
 * @param o     - the options object given to `postgres()`
 * @param query - the parameters in the query of the url, by name
 * @param env   - the environment variables
 * @returns the value of the option, as `rule.read` returns it if the option has a reader, or
 *          `rule.default` if no place sets the option
 * @throws whatever `rule.read` throws for a value that the option may not have
 */
function read_option(
	k: string,
	rule: Rule,
	o: Record<string, any>,
	query: Record<string, string>,
	env: NodeJS.ProcessEnv,
) {
	const variable = rule.variable || "PG" + k.toUpperCase(),
		parameter = Object.hasOwn(query, k) ? k : rule.parameter;
	let value: unknown, source: string;
	if (o[k] !== undefined) {
		value = o[k];
		source = "The option " + k;
	} else if (parameter !== undefined && Object.hasOwn(query, parameter)) {
		value = query[parameter];
		source = "The url parameter " + parameter;
	} else if (env[variable]) {
		value = env[variable];
		source = "The environment variable " + variable;
	} else {
		return rule.default;
	}
	return rule.read ? rule.read(value, source) : value;
}

/**
 * Reads the options of a pool from the url, the options object and the environment variables.
 *
 * @param a - the url; or the options object, if there is no url; or options that this function
 *            returned before, which it returns as they are
 * @param b - the options object, if `a` is the url
 * @returns the options of the pool
 * @throws if an option has a value that it may not have
 */
/** The timer functions that a pool uses: the globals, unless the options gave others (tests do) */
export type Timers = ReturnType<typeof default_timers>;
/** A timer of Timers' setTimeout() */
export type Timer = ReturnType<Timers["setTimeout"]>;

/**
 * The options of a pool, as parse_options() makes them from the url, the options object and the
 * environment: every option has its value or its default. The public ParsedOptions, plus what only
 * the library reads.
 */
export type Options = postgres.ParsedOptions<Record<string, any>> & {
	onnotice?: false | ((notice: postgres.Notice) => void);
	onnotify?: (channel: string, payload: string, pid: number) => void;
	onparameter?: (key: string, value: string) => void;
	onclose?: (connection: number) => void;
	/** Opens the socket of a connection instead of socket.ts; Cloudflare Workers give one */
	socket?: (
		options: Options,
		host: string | undefined,
		port: number | undefined,
	) => RawSocket | Promise<RawSocket>;
	/** Opens a connection instead of startup.ts's open(); tests give one */
	open?: typeof open;
	/** Whether the pool makes no Subscribe (which would make a pool of its own) */
	no_subscribe?: boolean;
	/** The password file (PGPASSFILE, or ~/.pgpass) */
	passfile: string | undefined;
	/** The types of the pool that made this one (a Subscribe's), so that they are looked up once */
	shared_types?: ReturnType<typeof Types>;
	/** What the pools made from one set of options share */
	shared: { retries: number };
	timers: Timers;
	/** Resolves a type given by name to its oid, once the types are loaded */
	resolve: ReturnType<typeof Types>["resolve"];
};

function parse_options(a?: string | Record<string, any>, b?: Record<string, any>): Options {
	if (a && typeof a === "object" && a.shared) {
		return a as Options;
	}

	const env = process.env,
		o = (!a || typeof a === "string" ? b : a) || {},
		url = parseUrl(a),
		query = Object.fromEntries(url.url.searchParams),
		targets = hosts(o, query, url, env),
		port = o.port || query.port || env.PGPORT || 5432,
		user = o.user || o.username || url.url.username || env.PGUSERNAME || env.PGUSER || osUsername();

	// v3 read ssl from PGSSL, which only postgres.js read. If it were ignored without a word now, a
	// pool that it gave TLS would connect without TLS.
	if (env.PGSSL && !env.PGSSLMODE) {
		throw new Error(
			"The environment variable PGSSL is not read any more; set PGSSLMODE, which libpq reads " +
				"too, instead",
		);
	}
	if (o.no_prepare) {
		o.prepare = false;
	}
	if ("timeout" in o) {
		console.warn("The timeout option is deprecated, use idle_timeout instead");
		o.idle_timeout = o.timeout;
	}
	// As in libpq, the url's sslrootcert, or else PGSSLROOTCERT, names the certificate authorities
	// to check the server's certificate against. With "system", verify-full is the mode when
	// nothing gives one, and any other mode is an error. A file is not read here, so any mode that
	// encrypts is an error with a file: libpq would check the certificate against the file in each
	// of those modes. TLS options in ssl replace both. Both are handled below, once ssl is read.
	const [roots_source, roots] = Object.hasOwn(query, "sslrootcert")
		? ["The url parameter sslrootcert", query.sslrootcert]
		: ["The environment variable PGSSLROOTCERT", env.PGSSLROOTCERT];
	delete query.sslrootcert;

	const options: Record<string, any> = {
		host: targets.map((x) => x[0]),
		port: Array.isArray(port)
			? port
			: targets.map((x) => (o.port || query.port ? +port : x[1] || +port)),
		path:
			o.path ||
			(targets[0][0].indexOf("/") > -1 && targets[0][0] + "/.s.PGSQL." + (targets[0][1] || port)),
		database:
			o.database ||
			o.db ||
			(url.url.pathname || "").slice(1) ||
			env.PGDATABASE ||
			(typeof user === "function" ? null : user),
		user: user,
		pass: o.pass || o.password || url.url.password || env.PGPASSWORD || "",
		...Object.fromEntries(
			Object.entries(option_rules).map(([k, rule]) => [k, read_option(k, rule, o, query, env)]),
		),
		connection: {
			application_name: env.PGAPPNAME || "postgres.js",
			...o.connection,
			...Object.fromEntries(Object.entries(query).filter(([k]) => !client_parameters.has(k))),
		},
		types: o.types || {},
		onnotice: o.onnotice,
		onnotify: o.onnotify,
		onclose: o.onclose,
		onparameter: o.onparameter,
		socket: o.socket,
		onread: o.onread !== false,
		open: o.open,
		no_subscribe: o.no_subscribe,
		unref_sockets: !!o.unref_sockets,
		passfile: passfile(env),
		shared_types: o.shared_types,
		transform: parseTransform(o.transform || { undefined: undefined }),
		parameters: {},
		shared: { retries: 0 },
		timers: o.timers || default_timers(),
	};

	if (options.ssl === undefined) {
		options.ssl = roots === "system" ? "verify-full" : false;
	}
	// TLS options give their own certificate authorities, or none
	const tls_options = options.ssl !== null && typeof options.ssl === "object";
	// true checks the certificate as verify-full does
	if (roots === "system" && !tls_options && options.ssl !== "verify-full" && options.ssl !== true) {
		throw new Error(
			roots_source +
				' is "system", which, as in libpq, needs the ssl mode "verify-full", but ssl is ' +
				shown(options.ssl),
		);
	}
	// ssl is now false, true or a mode that encrypts, unless it is TLS options; a Unix-domain
	// socket has no TLS
	if (roots && roots !== "system" && options.ssl !== false && !tls_options && !options.path) {
		throw new Error(
			roots_source +
				" is " +
				shown(roots) +
				", a file of certificate authorities, which postgres.js does not read, so the " +
				"server's certificate could not be checked against them. Pass them as ssl: { ca } " +
				"instead, with checkServerIdentity: () => undefined if the host name is not to be " +
				"checked, as libpq's require and verify-ca do not check it",
		);
	}
	// As in libpq, direct needs a mode that never connects without TLS
	const always_tls =
		options.ssl === true ||
		options.ssl === "require" ||
		options.ssl === "verify-full" ||
		tls_options;
	if (options.sslnegotiation === "direct" && !always_tls) {
		throw new Error(
			'sslnegotiation is "direct", which, as in libpq, needs an ssl that always encrypts: true, ' +
				'"require", "verify-full" or TLS options, but ssl is ' +
				shown(options.ssl),
		);
	}
	if (options.max === 1) {
		options.scheduler = false;
	}
	return options as Options;
}

/** A transform's `from` and `to` */
type Pair = { from?: (...args: any[]) => any; to?: (...args: any[]) => any };

function parseTransform(x: NonNullable<postgres.Options["transform"]>) {
	return { undefined: x.undefined, column: pair(x.column), value: pair(x.value), row: pair(x.row) };
}

/**
 * @returns the `from` and `to` of transform `x`, which a user gives as an object, or as a function:
 *   its `from`, and its `to` property, if it has one, as the `to`
 */
function pair(x: (((...args: any[]) => any) & { to?: Pair["to"] }) | Pair | undefined): Pair {
	return typeof x === "function" ? { from: x, to: x.to } : { from: x && x.from, to: x && x.to };
}

function parseUrl(url: unknown) {
	if (!url || typeof url !== "string") {
		return { url: { searchParams: new Map() }, targets: [] as Target[] };
	}

	const rest = url.slice(url.indexOf("://") + 3),
		end = rest.search(/[/?]/),
		authority = end === -1 ? rest : rest.slice(0, end),
		at = authority.lastIndexOf("@"),
		userinfo = at === -1 ? "" : authority.slice(0, at),
		colon = userinfo.indexOf(":"),
		tail = new URL("postgres://x" + (end === -1 ? "" : rest.slice(end)));

	return {
		url: {
			username: decode(colon === -1 ? userinfo : userinfo.slice(0, colon)),
			password: colon === -1 ? "" : decode(userinfo.slice(colon + 1)),
			pathname: decode(tail.pathname),
			searchParams: tail.searchParams,
		},
		targets: authority.slice(at + 1) ? split(authority.slice(at + 1), decode) : [],
	};
}

function decode(x: string) {
	try {
		return decodeURIComponent(x);
	} catch {
		return x;
	}
}

function hosts(
	o: Record<string, any>,
	query: Record<string, string>,
	url: ReturnType<typeof parseUrl>,
	env: NodeJS.ProcessEnv,
): Target[] {
	const given = o.hostname || o.host || query.host;
	if (given) {
		return Array.isArray(given) ? given.map((x: string): Target => [x, null]) : split(given);
	}

	if (url.targets.some(([x]) => x)) {
		return url.targets;
	}

	return split(env.PGHOST || "localhost").map(([x, p], i): Target => [
		x,
		p || (url.targets[i] && url.targets[i][1]) || null,
	]);
}

function split(x: string, decoded = (s: string) => s) {
	return x
		.split(",")
		.filter(Boolean)
		.map((item): Target => {
			const m = item.match(/^\[([^\]]*)\](?::(\d*))?$/) ||
				item.match(/^([^:]*)(?::(\d*))?$/) || [item, item];
			return [decoded(m[1]), m[2] ? +m[2] : null];
		});
}

function passfile(env: NodeJS.ProcessEnv) {
	try {
		return (
			env.PGPASSFILE ||
			(process.platform === "win32"
				? (env.APPDATA || "") + "\\postgresql\\pgpass.conf"
				: os.homedir() + "/.pgpass")
		);
	} catch {
		return null;
	}
}

function osUsername() {
	try {
		return os.userInfo().username;
	} catch {
		return process.env.USERNAME || process.env.USER || process.env.LOGNAME;
	}
}

/** @returns `known` seen through `get`: reading an oid gives what get() gives for it */
function view<T extends object>(known: T, get: (oid: number) => unknown) {
	return new Proxy(known, {
		get: (x, oid) => (typeof oid === "symbol" ? Reflect.get(x, oid) : get(+oid)),
	});
}
