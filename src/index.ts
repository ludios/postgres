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
	const options = parseOptions(a, b),
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

	Symbol.asyncDispose && (sql[Symbol.asyncDispose] = () => end());

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
			arguments.length === 2 && !Array.isArray(args) && ((options = args), (args = []));
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
			arguments.length === 2 && !Array.isArray(args) && ((options = args), (args = []));
			const fileHandler = (query) =>
				fs.readFile(path, "utf8", (err, string) => {
					if (err) {
						return query.reject(err);
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

	function json(x) {
		return new Parameter(x, 3802);
	}

	function array() {
		throw Errors.generic("ARRAY_REMOVED", "sql.array() is removed in v4, pass the array as it is");
	}

	async function reserve() {
		const lease = await pool.lease("reserve"),
			reserved = Sql(Object.assign((q) => lease.send(q), { cancel: pool.cancel }));

		reserved.release = () => lease.release();
		Symbol.dispose && (reserved[Symbol.dispose] = reserved.release);
		Symbol.asyncDispose && (reserved[Symbol.asyncDispose] = async () => reserved.release());
		return reserved;
	}

	function begin(mode, fn) {
		!fn && ((fn = mode), (mode = ""));
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
			(result) => (finish(channels.transaction, context, null, result), result),
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

		context &&
			Object.assign(context, {
				connection: lease.connection.id,
				host: lease.connection.host,
				port: lease.connection.port,
			});

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
								return q.reject(after || (after = rolledBack()));
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

			name && (await control(lease, "savepoint " + identifier(name)));
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
				context && !name && (context.outcome = "rollback");
				stopped()
					? rolled && (await rolled.catch(() => {}))
					: lease.connection.closed ||
						(await control(lease, name ? "rollback to " + identifier(name) : "rollback"));
				throw (error instanceof PostgresError && error.code === "25P02" && uncaught) || error;
			}

			if (stopped()) {
				rolled && (await rolled);
				context && !name && (context.outcome = "rollback");

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
				context &&
					(context.outcome = prepare
						? "prepare"
						: done.command === "COMMIT"
							? "commit"
							: "rollback");

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

				arguments.length === 1 && ((fn = name), (name = null));
				return scope(fn, "s" + savepoints++ + (name ? "_" + name : ""), false, stopped);
			}

			async function nested(inner, fn) {
				!fn && ((fn = inner), (inner = ""));

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

	function identifier(x) {
		return '"' + x.replace(/"/g, '""') + '"';
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

function Listen(options) {
	const { setTimeout, clearTimeout } = options.timers,
		channels = new Map();
	let sql = null,
		closing = null;

	return {
		listen,
		end: () => {
			channels.forEach((channel) => clearTimeout(channel.timer));
			return closing || (sql ? (closing = sql.end({ timeout: 0 })) : Promise.resolve());
		},
	};

	function connection() {
		return (
			sql ||
			(sql = Postgres({
				...options,
				max: 1,
				idle_timeout: null,
				max_lifetime: null,
				fetch_types: false,
				no_subscribe: true,
				onclose() {
					if (closing) {
						return;
					}

					channels.forEach((channel, name) => relisten(channel, name));
				},
				onnotify(channel, payload) {
					channels.has(channel) &&
						[...channels.get(channel).listeners].forEach((l) => l.fn(payload));
				},
			}))
		);
	}

	function relisten(channel, name, retries = 0) {
		channel.timer = null;
		channel.result = start(name);
		channel.result.then(
			(result) => {
				Object.assign(channel.state, result.state);
				channel.listeners.forEach((l) => l.onlisten && l.onlisten());
			},
			() => {
				if (closing || channels.get(name) !== channel) {
					return;
				}

				retries++;
				const seconds =
					typeof options.backoff === "function" ? options.backoff(retries) : options.backoff;
				channel.timer = setTimeout(
					() => !closing && channels.get(name) === channel && relisten(channel, name, retries),
					seconds * 1000,
				);
			},
		);
	}

	function start(name) {
		const x = connection();
		return x`listen ${x.unsafe('"' + name.replace(/"/g, '""') + '"')}`;
	}

	async function listen(name, fn, onlisten) {
		const listener = { fn, onlisten };
		if (!channels.has(name)) {
			channels.set(name, { listeners: new Set(), result: start(name), state: {} });
		}

		const channel = channels.get(name);
		channel.listeners.add(listener);
		let result;
		try {
			result = await channel.result;
		} catch (error) {
			channel.listeners.delete(listener);
			channel.listeners.size || channels.delete(name);
			throw error;
		}
		Object.assign(channel.state, result.state);
		listener.onlisten && listener.onlisten();

		return { state: channel.state, unlisten };

		async function unlisten() {
			if (!channel.listeners.delete(listener) || channel.listeners.size) {
				return;
			}

			channels.get(name) === channel && channels.delete(name);
			const x = sql;

			if (closing || !x) {
				return;
			}

			await x`unlisten ${x.unsafe('"' + name.replace(/"/g, '""') + '"')}`.catch((e) => {
				if (!/^CONNECTION_/.test(e.code)) {
					throw e;
				}
			});
			if (channels.size === 0 && sql === x) {
				sql = null;
				await x.end();
			}
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
 * The options that are numbers, which `read_option` also reads from text such as `"30"`. Each
 * option that counts something has the least integer it may be; each of the others has `null`,
 * as it may be any finite, non-negative number.
 */
const numeric_options = {
	max: 1,
	min: 0,
	max_pipeline: 0,
	idle_timeout: null,
	queue_timeout: null,
	connect_timeout: null,
	max_lifetime: null,
	backoff: null,
	keep_alive: null,
};

/**
 * @param text - the text of an option, from the url or an environment variable
 * @returns `false` if `text` is `disable` or `false`, which turn an option off; otherwise `text`
 */
function off_or_text(text) {
	return text === "disable" || text === "false" ? false : text;
}

/**
 * Reads an option from the first of these places that sets it: the options object, the query of
 * the url, and the environment variable named `PG` followed by the option's name in upper case.
 *
 * @param k     - the name of the option
 * @param d     - the value of the option when none of the places sets it
 * @param o     - the options object given to `postgres()`
 * @param query - the parameters in the query of the url, by name
 * @param env   - the environment variables
 * @returns the value of the option, where `disable` and `false` in the url or an environment
 *          variable are `false`, and a string for a numeric option is the number it is written as
 * @throws if a numeric option is a number that is NaN, negative or infinite, or text that is not
 *         a non-negative decimal number with or without whitespace around it, or if an option
 *         that counts something is not an integer of at least its number in `numeric_options`
 */
function read_option(k, d, o, query, env) {
	const variable = "PG" + k.toUpperCase();
	let value, source;
	if (k in o && o[k] !== undefined) {
		value = o[k];
		source = "The option " + k;
	} else if (k in query) {
		value = off_or_text(query[k]);
		source = "The url parameter " + k;
	} else if (env[variable]) {
		value = off_or_text(env[variable]);
		source = "The environment variable " + variable;
	} else {
		return d;
	}

	if (!Object.hasOwn(numeric_options, k)) {
		return value;
	}
	const least = numeric_options[k];
	if (least === null && typeof value !== "string" && typeof value !== "number") {
		return value;
	}
	const number =
		typeof value === "number"
			? value
			: typeof value === "string" && /^\s*\d+(\.\d+)?\s*$/.test(value)
				? +value
				: NaN;
	const shown = typeof value === "string" ? JSON.stringify(value) : String(value);
	if (least !== null && !(Number.isInteger(number) && number >= least)) {
		throw new Error(source + " must be an integer of at least " + least + ", but it is " + shown);
	}
	if (!Number.isFinite(number) || number < 0) {
		throw new Error(source + " must be a non-negative decimal number, but it is " + shown);
	}
	return number;
}

function parseOptions(a, b) {
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

	o.no_prepare && (o.prepare = false);
	query.sslmode && ((query.ssl = query.sslmode), delete query.sslmode);
	"timeout" in o &&
		(console.log("The timeout option is deprecated, use idle_timeout instead"),
		(o.idle_timeout = o.timeout));
	// Only "system" is supported. Any other sslrootcert, such as the path of a CA file, is sent to
	// the server as a setting, which PostgreSQL refuses; connecting without checking the
	// certificate against that CA would be worse.
	if (query.sslrootcert === "system") {
		query.ssl = "verify-full";
		delete query.sslrootcert;
	}

	const defaults = {
		max: globalThis.Cloudflare ? 3 : 10,
		min: 0,
		ssl: false,
		sslnegotiation: null,
		channel_binding: "prefer",
		idle_timeout: null,
		connect_timeout: 30,
		queue_timeout: 0,
		max_lifetime: max_lifetime,
		max_pipeline: 100,
		scheduler: true,
		backoff: backoff,
		keep_alive: 60,
		prepare: true,
		debug: false,
		fetch_types: true,
		infer: false,
		publications: "alltables",
		slot: null,
		target_session_attrs: null,
	};

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
			Object.entries(defaults).map(([k, d]) => [k, read_option(k, d, o, query, env)]),
		),
		connection: {
			application_name: env.PGAPPNAME || "postgres.js",
			...o.connection,
			...Object.fromEntries(
				Object.entries(query).filter(
					([k]) => !Object.hasOwn(defaults, k) && k !== "host" && k !== "port",
				),
			),
		},
		types: o.types || {},
		target_session_attrs: tsa(o, url.url, env),
		channel_binding: binding(o, url.url, env),
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

	options.infer = options.infer === true || options.infer === "true";
	options.max === 1 && (options.scheduler = false);
	return options;
}

function tsa(o, url, env) {
	const x =
		o.target_session_attrs ||
		url.searchParams.get("target_session_attrs") ||
		env.PGTARGETSESSIONATTRS;
	if (!x || ["read-write", "read-only", "primary", "standby", "prefer-standby"].includes(x)) {
		return x;
	}

	throw new Error("target_session_attrs " + x + " is not supported");
}

function binding(o, url, env) {
	const x =
		o.channel_binding ||
		url.searchParams.get("channel_binding") ||
		env.PGCHANNELBINDING ||
		"prefer";
	if (["disable", "prefer", "require"].includes(x)) {
		return x;
	}

	throw new Error("channel_binding " + x + " is not supported");
}

function backoff(retries) {
	return (0.5 + Math.random() / 2) * Math.min(3 ** retries / 100, 20);
}

function max_lifetime() {
	return 60 * (30 + Math.random() * 30);
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
	} catch (_) {
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
	} catch (_) {
		return null;
	}
}

function osUsername() {
	try {
		return os.userInfo().username;
	} catch (_) {
		return process.env.USERNAME || process.env.USER || process.env.LOGNAME;
	}
}

function view(known, get) {
	return new Proxy(known, {
		get: (x, oid) => (typeof oid === "symbol" ? x[oid] : get(+oid)),
	});
}
