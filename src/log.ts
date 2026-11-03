import util from "util";
import { getLogger } from "@logtape/logtape";
import type { Logger, LogLevel } from "@logtape/logtape";
import { PostgresError, as_error } from "./errors.ts";
import { user_name } from "./diagnostics.ts";
import type { Options } from "./index.ts";

/**
 * The loggers, one per category under `postgres`. The application configures LogTape; without a
 * configuration, nothing is printed, and a log call costs about 100 ns.
 */
export const log = {
	/** Opening connections, retrying, the queue of queries that wait for a connection, ending */
	pool: getLogger(["postgres", "pool"]),
	/** One connection: its close, protocol errors, handlers that throw, prepared statements */
	connection: getLogger(["postgres", "connection"]),
	/** Queries: every completion at debug, the slow and the unanswered ones at warning */
	query: getLogger(["postgres", "query"]),
	/** The server's NoticeResponse messages, at the level of their severity */
	notice: getLogger(["postgres", "notice"]),
	/** sql.listen(): LISTEN sent, and sent again after the connection closed */
	listen: getLogger(["postgres", "listen"]),
	/** sql.subscribe(): logical replication */
	subscribe: getLogger(["postgres", "subscribe"]),
};

/** Milliseconds that a query runs (from its turn on the connection to its answer) from which it is logged as slow */
export const slow_query_ms = 1000;

/** Milliseconds between repeated lines about one condition that lasts, such as a congestion of the pool */
export const logged_every_ms = 10_000;

/** Milliseconds that a query may go unanswered before the pool's watchdog logs it */
export const unanswered_ms = 10_000;

/** Milliseconds between the watchdog's lines about the same unanswered query */
export const unanswered_again_ms = 60_000;

/**
 * Logs at a level that is known only at run time, such as the level of a notice's severity.
 * @param logger - the logger
 * @param level - the level
 * @param template - the message, with `{name}` for each property that it shows
 * @param properties - the record's properties
 */
export function log_at(
	logger: Logger,
	level: LogLevel,
	template: string,
	properties: Record<string, unknown>,
) {
	switch (level) {
		case "trace":
			logger.trace(template, properties);
			break;
		case "debug":
			logger.debug(template, properties);
			break;
		case "info":
			logger.info(template, properties);
			break;
		case "warning":
			logger.warn(template, properties);
			break;
		case "error":
			logger.error(template, properties);
			break;
		case "fatal":
			logger.fatal(template, properties);
			break;
	}
}

/**
 * @param host - a host name or address
 * @param port - its port
 * @returns `host:port`, with an IPv6 address in brackets
 */
function endpoint(host: string, port: number) {
	return (host.includes(":") ? "[" + host + "]" : host) + ":" + port;
}

/**
 * @param options - the options of a pool
 * @param host - the host of one connection; undefined for a line about the whole pool, which
 *   names every host
 * @param port - the port of that connection
 * @returns the pool's target as log lines name it: `user@host:port/database`, or over a
 *   Unix-domain socket `user@[path]/database`; without `user@` when the user is a function (its
 *   name is not known until it is called); with every host as `host1:5432,host2:5433` for a line
 *   about the whole pool; and with ` (LISTEN)` or ` (replication)` for the pool that sql.listen()
 *   or sql.subscribe() opened
 */
export function target(options: Options, host?: string | null, port?: number) {
	// The options may hold anything, such as a user whose toString() throws (a test gives one)
	try {
		const user = user_name(options),
			where = options.path
				? "[" + options.path + "]"
				: host !== undefined && host !== null && port !== undefined
					? endpoint(host, port)
					: options.host.map((h, i) => endpoint(h, options.port[i] || options.port[0])).join(",");
		return (
			(user ? user + "@" : "") +
			where +
			"/" +
			options.database +
			(options.role ? " (" + options.role + ")" : "")
		);
	} catch {
		return "?";
	}
}

/**
 * @param thrown - an error of PostgreSQL, of this library or of Node, or whatever a callback threw
 * @returns how a log line describes it, in one line: a PostgreSQL error as its code and message
 *   (`28P01 password authentication failed for user "app"`); a connection error of this library
 *   as its code and the address (`CONNECT_TIMEOUT (db1:5432)`); any other error as its message,
 *   with its code first unless the message has the code already (Node's socket errors do:
 *   `connect ECONNREFUSED 127.0.0.1:5432`)
 */
export function reason(thrown: unknown) {
	// What a callback threw may have a `code` or `message` getter that throws
	try {
		const error = as_error(thrown),
			{ code } = error,
			message = typeof error.message === "string" ? error.message : util.inspect(error);
		if (typeof code !== "string") {
			return message;
		}
		if (error instanceof PostgresError) {
			return code + " " + message;
		}
		const written = "write " + code + " ";
		if (message.startsWith(written)) {
			return code + " (" + message.slice(written.length) + ")";
		}
		return message.includes(code) ? message : code + ": " + message;
	} catch {
		return "(an error that cannot be shown)";
	}
}

/**
 * Calls `fn`, a handler of the application's, and logs what it throws, at error, so that a
 * handler that throws neither breaks the caller nor goes unnoticed.
 * @param logger - the logger of the caller's category
 * @param template - what threw, such as `{handler} handler threw on connection {id} to {target}`
 * @param properties - the properties of `template`
 */
export function guarded<A extends unknown[]>(
	logger: Logger,
	template: string,
	properties: Record<string, unknown>,
	fn: (...xs: A) => void,
	...xs: A
) {
	try {
		fn(...xs);
	} catch (error) {
		logger.error(template + "; ignored: {reason}", { ...properties, reason: reason(error), error });
	}
}

/**
 * @param kind - the kind of a lease: "transaction" or "reserve"
 * @returns the call that made it, as log lines name it: `sql.begin()` or `sql.reserve()`
 */
export function lease_name(kind: string) {
	return kind === "transaction" ? "sql.begin()" : "sql.reserve()";
}

/**
 * Logs that the server refused TLS and the connection goes on unencrypted, as `ssl` prefer or
 * allow lets it; once per host of the pool.
 * @param options - the options of the pool
 * @param host - the host that refused
 * @param port - its port
 */
export function tls_refused(options: Options, host: string | null, port: number) {
	const where = target(options, host, port);
	if (once(options, "tls " + where)) {
		log.pool.warn('{target} refused TLS; continuing unencrypted, since ssl is "{mode}"', {
			target: where,
			mode: options.ssl,
		});
	}
}

/**
 * Counts events of one kind, so that a line about them goes out at most once per
 * `logged_every_ms`, and the events between two lines are counted in the second.
 */
export class Throttle {
	/** When the last line went out, by the caller's clock; 0 before the first */
	private at = 0;
	/** The events since the last line */
	private count = 0;

	/**
	 * Counts an event.
	 * @param t - now
	 * @returns what a line reports now: the events since the last line (this one included), and
	 *   the seconds since that line (0 for the first); null if no line goes out yet
	 */
	hit(t: number) {
		this.count++;
		return this.at === 0 || t - this.at >= logged_every_ms ? this.take(t) : null;
	}

	/**
	 * Reports the events counted since the last line, once `logged_every_ms` has passed since it,
	 * so that a burst is reported even if no event follows it; a watchdog calls this.
	 * @param t - now
	 * @returns as hit() does; null if no line goes out yet
	 */
	flush(t: number) {
		return this.count !== 0 && t - this.at >= logged_every_ms ? this.take(t) : null;
	}

	private take(t: number) {
		const x = { count: this.count, since: this.at === 0 ? 0 : tenths(t - this.at) };
		this.count = 0;
		this.at = t;
		return x;
	}
}

/**
 * @param text - the text of a query
 * @param limit - the most characters to keep
 * @returns `text` with its whitespace collapsed to single spaces, and cut to `limit` characters
 *   (the last one an ellipsis) if it is longer
 */
export function excerpt(text: string, limit = 200) {
	const collapsed = text.replace(/\s+/g, " ").trim();
	return collapsed.length > limit ? collapsed.slice(0, limit - 1) + "…" : collapsed;
}

/**
 * @param ms - milliseconds
 * @returns the seconds, rounded to one decimal, as a number (so that a text sink shows it bare)
 */
export function tenths(ms: number) {
	return Math.round(ms / 100) / 10;
}

/**
 * @param options - the options of a pool, whose `shared` the pools that sql.listen() and
 *   sql.subscribe() open share with it
 * @param key - what is to be logged once per `shared`
 * @returns whether `key` has not been seen before (then it is recorded, and the caller logs)
 */
export function once(options: Options, key: string) {
	if (options.shared.once.has(key)) {
		return false;
	}
	options.shared.once.add(key);
	return true;
}

/**
 * @param severity - the severity of a NoticeResponse: PostgreSQL's non-localized one, if sent
 * @returns the level that the notice is logged at
 */
function level_of(severity: string | undefined): LogLevel {
	if (severity === "WARNING") {
		return "warning";
	}
	if (severity === "ERROR" || severity === "FATAL" || severity === "PANIC") {
		return "error";
	}
	if (severity !== undefined && severity.startsWith("DEBUG")) {
		return "debug";
	}
	return "info";
}

/**
 * Logs a NoticeResponse of the server, at the level of its severity.
 * @param x - the notice's fields, as protocol.ts's error() reads them
 * @param where - the part of the line that says what got the notice, with `{name}` placeholders
 *   of `properties`, such as `on connection {id} to {target}`
 * @param properties - the properties that `where` shows
 */
export function notice(
	x: Record<string, string>,
	where: string,
	properties: Record<string, unknown>,
) {
	const template =
		"server notice {severity} {code} " +
		where +
		": {message}" +
		(x.detail ? "; detail: {detail}" : "") +
		(x.hint ? "; hint: {hint}" : "");
	log_at(log.notice, level_of(x.severity), template, { ...x, ...properties });
}
