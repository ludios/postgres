import os from "os";
import fs from "fs";

import { Types, Parameter } from "./types.ts";
import type { PostgresType } from "./types.ts";

import { Identifier, Builder } from "./build.ts";
import { Query, CLOSE } from "./query.ts";
import { Pool } from "./pool.ts";
import { Errors, PostgresError, throw_on_casing_transforms } from "./errors.ts";
import Subscribe from "./subscribe.ts";
import largeObject from "./large.ts";
import { channels, active, start, finish, userName } from "./diagnostics.ts";

export default Object.assign(Postgres, {
	PostgresError,
	BigInt: {
		to: 20,
		from: [20],
		parse: (x) => BigInt(x),
		serialize: (x) => x.toString(),
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
	const typed = (value, type) => new Parameter(value, type);

	// Defined, not assigned: assigning throws for `name` and `length` (read-only properties of
	// every function; `name` is also a PostgreSQL type) and for `arguments` and `caller` (whose
	// inherited setters throw in strict mode), and assigning `__proto__` would replace the
	// prototype of `typed`.
	Object.entries(types).forEach(([name, type]) =>
		Object.defineProperty(typed, name, {
			value: (x) => new Parameter(x, type.to),
			writable: true,
			enumerable: true,
			configurable: true,
		}),
	);
	return typed;
}

function Postgres(a?, b?) {
	const options = parse_options(a, b),
		types = options.shared_types || Types(options),
		pool = Pool(options, types),
		subscribe = options.no_subscribe || Subscribe(Postgres, { ...options, shared_types: types }),
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

	function handler(q) {
		pool.query(q);
	}

	/**
	 * @param handler - called with each Query that the returned `sql` makes, to run it
	 * @returns a new `sql`, without the properties that only some `sql`s have (such as `begin`
	 *   or `release`), which the callers add
	 */
	function Sql(handler): any {
		handler.debug = options.debug;
		handler.options = options;
		handler.cancel = handler.cancel || pool.cancel;

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
		function sql(strings, ...args) {
			return strings && Array.isArray(strings.raw)
				? new Query(strings, args, handler)
				: typeof strings === "string" && !args.length
					? new Identifier(
							options.transform.column.to ? options.transform.column.to(strings) : strings,
						)
					: new Builder(strings, args);
		}

		function unsafe(string, args = [], options = {}) {
			if (arguments.length === 2 && !Array.isArray(args)) {
				options = args;
				args = [];
			}
			return new Query([string], args, handler, {
				prepare: false,
				...options,
				simple: "simple" in options ? options.simple : args.length === 0,
			});
		}

		async function notify(channel, payload) {
			return await sql`select pg_notify(${channel}, ${"" + payload})`;
		}

		function file(path, args = [], options = {}) {
			if (arguments.length === 2 && !Array.isArray(args)) {
				options = args;
				args = [];
			}
			const fileHandler = (query) =>
				fs.readFile(path, "utf8", (err, string) => {
					if (err) {
						query.reject(err);
						return;
					}
					query.strings = [string];
					handler(query);
				});
			Object.assign(fileHandler, handler);
			return new Query([], args, fileHandler, {
				...options,
				simple: "simple" in options ? options.simple : args.length === 0,
			});
		}
	}

	async function reserve() {
		const lease = await pool.lease("reserve"),
			reserved = Sql(Object.assign((q) => lease.send(q), { cancel: pool.cancel }));

		reserved.release = () => lease.release();
		if (Symbol.dispose) {
			reserved[Symbol.dispose] = reserved.release;
		}
		if (Symbol.asyncDispose) {
			reserved[Symbol.asyncDispose] = async () => reserved.release();
		}
		return reserved;
	}

	function begin(mode, fn) {
		if (!fn) {
			fn = mode;
			mode = "";
		}
		if (!active(channels.transaction)) {
			return transaction(mode, fn, null);
		}

		const context = {
			mode,
			database: options.database,
			user: userName(options),
			connection: null,
			host: null,
			port: null,
			outcome: null,
		};
		let promise;
		start(channels.transaction, context, () => (promise = transaction(mode, fn, context)));

		return promise.then(
			(result) => {
				finish(channels.transaction, context, null, result);
				return result;
			},
			(error) => {
				finish(channels.transaction, context, error);
				throw error;
			},
		);
	}

	async function transaction(mode, fn, context) {
		const lease = await pool.lease("transaction");

		let savepoints = 0,
			prepare = null;

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

		async function scope(fn, name?, inside?, above = () => false) {
			let uncaught,
				result,
				rolled = null,
				after = null;

			if (above()) {
				throw rolledBack();
			}

			const stopped = () => !!rolled || above(),
				scoped = Sql(
					Object.assign(
						(q) => {
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
			scoped.prepare = (x) => {
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
					const x = fn(scoped);
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

			function savepoint(name, fn?) {
				if (name && Array.isArray(name.raw)) {
					return savepoint((sql) => sql.apply(sql, arguments));
				}

				if (arguments.length === 1) {
					fn = name;
					name = null;
				}
				return scope(fn, "s" + savepoints++ + (name ? "_" + name : ""), false, stopped);
			}

			async function nested(inner, fn) {
				if (!fn) {
					fn = inner;
					inner = "";
				}

				if (normal(inner) && normal(inner) !== normal(mode)) {
					throw Errors.generic(
						"NESTED_TRANSACTION_MODE",
						"A nested transaction runs in a savepoint, which can not change the transaction mode",
					);
				}

				return scope(fn, "s" + savepoints++, true, stopped);
			}
		}
	}

	function control(lease, text) {
		const q = new Query(
			[text],
			[],
			Object.assign((q) => lease.send(q), { options, cancel: pool.cancel }),
			{ simple: true },
		);
		return q.execute();
	}

	async function end(options?) {
		await Promise.all([listener.end(), subscribe.sql ? subscribe.sql.end({ timeout: 0 }) : null]);
		return pool.end(options);
	}

	function close() {
		return pool.close();
	}
}

function json(x) {
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

function normal(x) {
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
function identifier(x) {
	return '"' + x.replace(/"/g, '""') + '"';
}

function Listen(options) {
	const { setTimeout, clearTimeout } = options.timers,
		/**
		 * Channel name → channel: its `listeners` (each a `{ fn, onlisten }`); its `state`, the
		 * connection's `{ pid, secret }`, which is one object for the channel's lifetime, so that a
		 * listener sees reconnects in it; `result`, the promise of the latest LISTEN; `listening`,
		 * whether that LISTEN succeeded, and onclose() has not seen the listener connection close
		 * since; `retries`, how many of the LISTENs that relisten() sent have failed in a row; and
		 * `timer`, the timer of the next retry of a failed LISTEN, if one is pending.
		 */
		channels = new Map();
	let sql = null,
		// The promise that end() returns (null until end() is called)
		closing = null;

	return {
		listen,
		end() {
			channels.forEach((channel) => clearTimeout(channel.timer));
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
					channels.forEach((channel, name) => {
						if (channel.listening) {
							relisten(channel, name);
						}
					});
				},
				onnotify(channel, payload) {
					if (channels.has(channel)) {
						[...channels.get(channel).listeners].forEach((l) => l.fn(payload));
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
	function send_listen(channel, name) {
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
	function relisten(channel, name) {
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
				if (closing || channels.get(name) !== channel) {
					return;
				}

				channel.retries++;
				const seconds =
					typeof options.backoff === "function"
						? options.backoff(channel.retries)
						: options.backoff;
				channel.timer = setTimeout(() => {
					if (!closing && channels.get(name) === channel) {
						relisten(channel, name);
					}
				}, seconds * 1000);
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
	async function retire(channel, name, failed) {
		if (channels.get(name) === channel) {
			channels.delete(name);
		}
		clearTimeout(channel.timer);
		const x = sql;
		if (closing || !x) {
			return;
		}

		if (!failed) {
			await x`unlisten ${x.unsafe(identifier(name))}`.catch((e) => {
				if (!/^CONNECTION_/.test(e.code)) {
					throw e;
				}
			});
		}
		if (channels.size === 0 && sql === x) {
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
	 * @returns the channel's `state` (see `channels`) and `unlisten()`, which removes this listener
	 */
	async function listen(name, fn, onlisten) {
		if (closing) {
			throw Errors.connection("CONNECTION_ENDED", options, options.host[0], options.port[0]);
		}

		const listener = { fn, onlisten };
		let channel = channels.get(name);
		if (!channel) {
			channel = {
				listeners: new Set(),
				state: {},
				result: null,
				listening: false,
				retries: 0,
				timer: null,
			};
			// Not stored if the LISTEN cannot be sent, which connection() may throw for
			send_listen(channel, name);
			channels.set(name, channel);
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
		setTimeout: (fn, ms, ...args) => set_timeout(fn, Math.min(ms, max_delay), ...args),
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
function shown(value) {
	return typeof value === "string" ? JSON.stringify(value) : String(value);
}

/**
 * Reads an option that may be turned off, and that has no other checks.
 *
 * @param value - the value of the option
 * @returns `false` if `value` is the text `disable` or `false`, which turn an option off;
 *          otherwise `value`
 */
function off(value) {
	return value === "disable" || value === "false" ? false : value;
}

/**
 * @param value - the value of an option that is on or off, among other things that it may be
 * @returns `true` for the text `true`; `false` for `null`, which turns an option off, as it turns
 *          off an option that is a number of seconds; otherwise what `off` returns for `value`
 */
function on_or_off(value) {
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
function number(value) {
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
function seconds(value, source) {
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
function integer(least) {
	return (value, source) => {
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
function one_of(...allowed) {
	return (value, source) => {
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
function on_off_or(other, described) {
	return (value, source) => {
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
	(value) => (value !== null && typeof value === "object") || ssl_modes.includes(value),
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
function ssl_option(value, source) {
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
function target_session_attrs(value, source) {
	const x = session_attrs(value, source);
	return x === "any" ? null : x;
}

/**
 * @param retries - how many tries in a row have failed
 * @returns the number of seconds to wait before the next try: 3^retries / 100, but at most 20,
 *          times a random factor from 0.5 to 1
 */
function backoff(retries) {
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
const option_rules: Record<
	string,
	{
		default: unknown;
		variable?: string;
		parameter?: string;
		read?: (value: unknown, source: string) => unknown;
	}
> = {
	max: { default: globalThis.Cloudflare ? 3 : 10, read: integer(1) },
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
function read_option(k, rule, o, query, env) {
	const variable = rule.variable || "PG" + k.toUpperCase(),
		parameter = Object.hasOwn(query, k) ? k : rule.parameter;
	let value, source;
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
function parse_options(a, b) {
	if (a && a.shared) {
		return a;
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
		console.log("The timeout option is deprecated, use idle_timeout instead");
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
	return options;
}

function parseTransform(x) {
	return {
		undefined: x.undefined,
		column: {
			from: typeof x.column === "function" ? x.column : x.column && x.column.from,
			to: x.column && x.column.to,
		},
		value: {
			from: typeof x.value === "function" ? x.value : x.value && x.value.from,
			to: x.value && x.value.to,
		},
		row: {
			from: typeof x.row === "function" ? x.row : x.row && x.row.from,
			to: x.row && x.row.to,
		},
	};
}

function parseUrl(url) {
	if (!url || typeof url !== "string") {
		return { url: { searchParams: new Map() }, targets: [] };
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

function decode(x) {
	try {
		return decodeURIComponent(x);
	} catch {
		return x;
	}
}

function hosts(o, query, url, env) {
	const given = o.hostname || o.host || query.host;
	if (given) {
		return Array.isArray(given) ? given.map((x) => [x, null]) : split(given);
	}

	if (url.targets.some(([x]) => x)) {
		return url.targets;
	}

	return split(env.PGHOST || "localhost").map(([x, p], i) => [
		x,
		p || (url.targets[i] && url.targets[i][1]) || null,
	]);
}

function split(x, decoded = (x) => x) {
	return x
		.split(",")
		.filter(Boolean)
		.map((x) => {
			const m = x.match(/^\[([^\]]*)\](?::(\d*))?$/) || x.match(/^([^:]*)(?::(\d*))?$/) || [x, x];
			return [decoded(m[1]), m[2] ? +m[2] : null];
		});
}

function passfile(env) {
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

function view(known, get) {
	return new Proxy(known, {
		get: (x, oid) => (typeof oid === "symbol" ? x[oid] : get(+oid)),
	});
}
