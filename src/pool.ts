import { open as startup } from "./startup.ts";
import type { Signal } from "./startup.ts";
import { Connection } from "./connection.ts";
import { Query } from "./query.ts";
import { Errors, PostgresError, copy_error, query_error } from "./errors.ts";
import { channels, listened } from "./diagnostics.ts";
import {
	Throttle,
	guarded,
	lease_name,
	log,
	log_at,
	logged_every_ms,
	reason,
	slow_query_ms,
	target,
	tenths,
} from "./log.ts";
import type { Options, Timer } from "./index.ts";
import type { Ready } from "./startup.ts";
import type { Built } from "./build.ts";
import type { Failure } from "./errors.ts";
import type { Types } from "./types.ts";

/**
 * Milliseconds. A query estimated to take at least this long is slow, and the scheduler keeps slow
 * queries together, so that quick queries don't wait behind them.
 */
const slow = 100;

/**
 * Milliseconds. A query estimated to take less than this long is quick, and the pool places it
 * without the scheduler, unless a connection that can take it has an exchange estimated to take at
 * least this long.
 */
export const notable = 5;

/**
 * Milliseconds that the queue of requests waiting for a connection stays non-empty before the pool
 * logs it: a shorter wait is a burst that the pool absorbs.
 */
const congested_after = 1000;

/** Milliseconds between the watchdog's checks: see watch() */
const watch_every = 10_000;

/**
 * A congestion of the pool (a time in which requests wait for a connection without a break): when
 * it began, and when it was last logged (null before the first line)
 */
type Congestion = { since: number; logged: number | null };

const begins = /\bbegin\b/i,
	starts = /\bstart\b/gi,
	transaction = /^transaction\b/i;

/** A Connection, with the fields that the pool keeps on it, all of which `opened` sets */
type Pooled = Connection & {
	/** The index of the host (in `options.host`) that the connection went to. */
	index: number;
	/**
	 * Whether the connection waits for the pool's types to load (on this connection or on
	 * another one) before it takes queries.
	 */
	loading: boolean;
	/** When the connection last became idle; 0 if never. */
	idle_since: number;
	/** Closes the connection after `idle_timeout`. */
	idle_timer: Timer | null;
	/** Retires the connection after `max_lifetime`. */
	life_timer: Timer | null;
	/**
	 * The kind of the lease ("transaction" or "reserve") that released the connection while queries
	 * were still in flight; null if none did.
	 */
	releasing: string | null;
	/** Why the connection closes as soon as it has no lease and nothing in flight; null if it does not */
	retiring: string | null;
	/** Called once the connection closes. */
	retired: Array<() => void>;
};

/**
 * A connection leased to one job (a transaction, or a reserve()) until released; the job's queries
 * are sent through it.
 */
export type Lease = {
	/** The job's kind: "transaction" or "reserve" */
	kind: string;
	/** The error that closed the connection while it was leased, if any */
	error: Error | null;
	connection: Pooled;
	/** Rejects with the error that closed the connection while it was leased; never resolves */
	closed: Promise<never>;
	readonly released: boolean;
	/** Sends `q` on the connection, once the queries sent before it have been written */
	send(q: Query): void;
	/** Gives the connection back to the pool, or closes it if it is not idle */
	release(): void;
	onclose(error: Error): void;
};

/** The scheduler's knowledge of a statement text */
export type Cost = {
	/** The estimated time that the text takes to run, in ms; undefined until it has run */
	est: number | undefined;
};

/** A statement text that the scheduler knows */
type Known = Cost & {
	text: string;
	/** Whether the text opens a transaction, so that its query must run alone; undefined until tested */
	alone: boolean | undefined;
};

/** What waits for a connection: a query to run on one, a describe, or a lease */
type Job = Waiting & (QueryJob | DescribeJob | LeaseJob);

/** What every job has while it waits */
type Waiting = {
	/** The `queue_timeout` timer, while the job waits with a `queue_timeout` */
	timer: Timer | null;
	/** When the job began to wait for a connection; 0 while it has not waited */
	since: number;
};

/** A query to send on a connection */
type QueryJob = {
	kind: "query";
	q: Query;
	/** The text, for a query of the simple protocol; null for one of the extended protocol */
	simple: string | null;
	/** The statement, for a query of the extended protocol, which pick() prefers a connection that has prepared */
	statement: Statement | null;
	/** Whether the query needs the connection to itself */
	exclusive: boolean;
};

/** A Describe of query `q`: `run` sends it on the connection */
type DescribeJob = {
	kind: "describe";
	q: Query;
	run: (c: Pooled) => void;
};

/** A lease of a connection, for a transaction or a reserve() */
type LeaseJob = {
	kind: "lease";
	/** The lease's kind: "transaction" or "reserve" */
	lease: Lease["kind"];
	resolve: (lease: Lease) => void;
	reject: (error: Error) => void;
	/** When the job was queued, for the "lease" event; 0 if nobody listens to the pool channel */
	queued: number;
};

/** A statement text's entry in the cache of prepared statements */
export type Statement = {
	/** The parameter types and the text, which the cache is keyed by; null for an unnamed statement */
	key: string | null;
	/** Whether the entry is still in the cache */
	live: boolean;
	/** The statement's name on the server; "" for an unnamed statement */
	name: string;
	text: string;
	/** Whether the text ends a transaction; undefined until tested */
	ends: boolean | undefined;
	/** The parameter and column types that the server described last; undefined until described */
	shape: string | undefined;
	/** Counts the changes of `shape`, so that a connection's entry for an older shape is stale */
	version: number;
	/** The cache's clock when the statement was last used, for eviction */
	used: number;
	/** The scheduler's cost of the text, or null without the scheduler */
	cost: Cost | null;
	/** Whether the text opens a transaction, so that its query must run alone; undefined until tested */
	alone?: boolean | undefined;
};

/** A statement of the cache, which is keyed by `key`: the parameter types and the text */
type Named = Statement & { key: string };

/**
 * @param backoff - the `backoff` option: a function of how many attempts have failed in a row, or
 *   the seconds to wait, or false for no wait
 * @param retries - how many attempts have failed in a row
 * @returns how many seconds to wait before the next attempt
 */
export function backoff_seconds(backoff: Options["backoff"], retries: number) {
	return typeof backoff === "function" ? backoff(retries) : Number(backoff);
}

export function Pool(options: Options, types: ReturnType<typeof Types>) {
	const { setTimeout, clearTimeout, now } = options.timers,
		statements = Statements(options.scheduler),
		connections = new Set<Pooled>(),
		waiting = Queue<Job>(queue_emptied),
		events = {
			parser: types.parser,
			decoder: types.decoder,
			binary: types.binary,
			serializer: types.serializer,
			onready,
			onclose,
			onnotify: options.onnotify,
			onparameter,
			ontimed,
			trouble: new Throttle(),
		},
		work = { fast: 0, slow: 0, at: 0 },
		// How many queries a connection may have in flight before the pool places no more queries on
		// it: max_pipeline, but at least 1. A lease's queries go to its connection without this limit.
		max_inflight = Math.max(1, options.max_pipeline);

	const signal: Signal = { aborted: false, sockets: new Set() },
		replacing: number[] = [],
		// The pool's target, as its log lines name it
		where = target(options),
		// Counts the waits for a connection that timed out, for the lines about them
		queue_timeouts = new Throttle();

	let opening = 0,
		ending: Promise<void> | null = null,
		// Resolves `ending`, once the pool has finished ending.
		resolve_ending: (() => void) | null = null,
		used = false,
		end_timer: Timer | null = null,
		retries = 0,
		failing_since: number | null = null,
		next_attempt = 0,
		retry_timer: Timer | null = null,
		types_loaded = options.fetch_types === false,
		types_error: Failure | null = null,
		types_failed = 0,
		// The error of the connection attempts that fail fast, while they do
		failure: { error: Failure } | null = null,
		types_loading = false,
		// How many requests the pool has rejected since its connection attempts began to fail
		rejected = 0,
		// Whether the pool has had a connection
		ever = false,
		// Whether the pool lost its last connection (not through an orderly close) since it last had one
		reconnect = false,
		// The congestion that the pool is in, if any: see congested()
		congestion: Congestion | null = null,
		// The timer of the watchdog, while it runs: see watch()
		watchdog: Timer | null = null,
		// When end() was called, and when the watchdog last logged that the pool is still ending
		ending_since = 0,
		ending_logged = 0;

	const pool = {
		query,
		acquire,
		cancel,
		end,
		close,
		get stats() {
			return {
				connections: connections.size,
				opening,
				idle: [...connections].filter((x) => x.inflight === 0 && !x.lease).length,
				leased: [...connections].filter((x) => x.lease).length,
				waiting: waiting.length,
			};
		},
	};

	return pool;

	function query(q: Query, lease?: Lease) {
		if (ending && !lease) {
			q.reject(
				query_error(
					Errors.connection("CONNECTION_ENDED", options, options.host[0], options.port[0]),
					q,
					options.debug,
				),
			);
			return;
		}

		let built: Built;
		try {
			built = q.build();
		} catch (error) {
			unbuilt(q, error, lease);
			return;
		}

		const free = !lease && options.max !== 1;

		if (q.options.simple && !built.values.length) {
			const known = free || options.scheduler ? statements.known(built.text) : null;
			q.alone = !!known && free && alone(known);
			if (options.scheduler) {
				q.cost = known;
			}
			place(
				{
					kind: "query",
					q,
					simple: built.text,
					statement: null,
					exclusive: q.streaming || q.alone,
					timer: null,
					since: 0,
				},
				lease,
			);
			return;
		}

		if (q.only_describe) {
			describe_only(q, built, lease);
			return;
		}

		const statement = statements.get(built, options.prepare && q.options.prepare !== false);
		q.alone = free && alone(statement.live ? statement : statements.known(built.text));
		q.wire = { statement, built };
		if (options.scheduler) {
			q.cost = statement.cost;
		}
		place(
			{
				kind: "query",
				q,
				simple: null,
				statement,
				exclusive: !!q.cursor_fn || q.streaming || q.alone,
				timer: null,
				since: 0,
			},
			lease,
		);
	}

	function describe_only(q: Query, built: Built, lease?: Lease) {
		const start = (c: Pooled) => {
			q.connection = c;
			c.describe(built.text, built.oids, () => {
				q.written = now();
			}).then(
				({ params, columns }) =>
					q.resolve({ string: built.text, types: params, name: "", columns }),
				(error: Error) => q.reject(query_error(error, q, options.debug)),
			);
			if (q.onwrite) {
				q.onwrite();
			}
		};
		place({ kind: "describe", q, run: start, timer: null, since: 0 }, lease);
	}

	function unbuilt(q: Query, thrown: unknown, lease?: Lease) {
		const error = query_error(thrown, q, options.debug);
		if (!lease || lease.released || lease.connection.closed) {
			q.reject(error);
			return;
		}

		q.connection = lease.connection;
		lease.connection.local(q, error);
		if (q.onwrite) {
			q.onwrite();
		}
	}

	function place(job: Waiting & (QueryJob | DescribeJob), lease?: Lease) {
		used = true;
		const missing = !lease && retype();

		if (missing) {
			reject(job, missing);
			return;
		}

		if (job.q.cancelled) {
			job.q.reject(query_error(Errors.canceled(), job.q, options.debug));
			return;
		}

		if (lease) {
			if (lease.connection.closed) {
				job.q.reject(query_error(copy_error(lease.connection.closed), job.q, options.debug));
			} else if (lease.released) {
				job.q.reject(query_error(ended(lease), job.q, options.debug));
			} else {
				run(lease.connection, job);
			}
			return;
		}

		if (signal.aborted) {
			reject(
				job,
				Errors.connection("CONNECTION_DESTROYED", options, options.host[0], options.port[0]),
			);
			return;
		}

		const failing = failing_fast();
		if (failing) {
			rejected++;
			reject(job, copy_error(failing.error));
			return;
		}

		const c = waiting.length === 0 && pick(job);
		if (c) {
			run(c, job);
			return;
		}

		waiting.push(wait(job));
		drain();
	}

	function wait(job: Job) {
		job.since = now();
		watch();
		if (!options.queue_timeout) {
			return job;
		}

		job.timer = setTimeout(() => {
			job.timer = null;
			if (waiting.remove((x) => x === job)) {
				timed_out(job);
				reject(
					job,
					Errors.generic(
						"QUEUE_TIMEOUT",
						"Waited more than " + options.queue_timeout + " seconds for a connection",
					),
				);
			}
		}, options.queue_timeout * 1000);
		if (typeof job.timer.unref === "function") {
			job.timer.unref();
		}
		return job;
	}

	function started(job: Job) {
		if (job.timer) {
			clearTimeout(job.timer);
			job.timer = null;
		}
	}

	function run(c: Pooled, job: Waiting & (QueryJob | DescribeJob)) {
		started(job);
		hold(c);

		if (job.kind === "describe") {
			job.run(c);
			return;
		}

		job.q.connection = c;
		if (job.simple !== null) {
			c.simple(job.q, job.simple);
		} else {
			c.send(job.q);
		}
		if (job.q.onwrite) {
			job.q.onwrite();
		}
	}

	function drain() {
		for (let job = waiting.peek(); job !== undefined; job = waiting.peek()) {
			const c = pick(job);

			if (!c && !copying(job)) {
				break;
			}

			waiting.shift();
			if (!c) {
				reject(job, Errors.generic("COPY_IN_PROGRESS", "You cannot execute queries during copy"));
			} else if (job.kind === "lease") {
				grant(c, job);
			} else {
				run(c, job);
			}
		}
		if (waiting.length) {
			event("wait", null, { waiting: waiting.length });
		}
		congested();
		grow();
	}

	function copying(job: Job) {
		if (
			job.kind === "lease" ||
			connections.size + opening < options.max ||
			connections.size === 0
		) {
			return false;
		}

		for (const c of connections) {
			if (!c.copying) {
				return false;
			}
		}
		return true;
	}

	/**
	 * Whether the pool may put one more query on connection `c`, behind the exchanges in flight:
	 * `c` is usable() and has fewer than `max_inflight` exchanges in flight. A job that asks for a
	 * lease, and an exclusive job, also need `c` to have nothing in flight (see pick()).
	 *
	 * @param c - One of `connections`, in any state.
	 */
	function has_room(c: Pooled) {
		return c.inflight < max_inflight && usable(c);
	}

	function pick(job: Job) {
		const statement = job.kind === "query" ? job.statement : null,
			any = !statement || !statement.name;

		let best: Pooled | null = null;

		for (const c of connections) {
			const room = has_room(c);
			if (room && c.inflight === 0) {
				if (any || c.prepared.has(statement.name)) {
					return c;
				}
				best = best && best.inflight === 0 ? best : c;
			} else if (room && pipelined(job) && (!best || c.inflight < best.inflight)) {
				best = c;
			}
		}

		if (best && best.inflight === 0) {
			return best;
		}

		if (connections.size + opening < options.max && !failing_since) {
			return null;
		}

		if (best && options.scheduler && job.kind !== "lease" && needed(job)) {
			best = scheduled(job) || best;
		}
		return best && opening && best.inflight >= Math.ceil(waiting.length / (opening + 1))
			? null
			: best;
	}

	/**
	 * Whether the scheduler should place `job`, rather than leaving it on the connection with the
	 * fewest exchanges. It should when `job` isn't known to be quick, or when a connection that can
	 * take `job` has a notable exchange that `job` could wait behind.
	 *
	 * Only the connections where has_room() is true are scanned: any other connection can't take
	 * `job`, so it can't make `job` wait. The connections skipped this way are also the ones that
	 * would cost the most to scan: a reserved connection has no limit on its exchanges, and in a
	 * saturated pool, most connections are full.
	 *
	 * @param job - A job that pick() would pipeline on a busy connection (so it is not a lease and
	 *   not exclusive). needed() reads only the estimate in `job.q.cost`.
	 */
	function needed(job: QueryJob | DescribeJob) {
		if (!job.q.cost || job.q.cost.est === undefined || job.q.cost.est >= notable) {
			return true;
		}

		for (const c of connections) {
			if (has_room(c) && c.costly(notable)) {
				return true;
			}
		}

		return false;
	}

	function scheduled(job: QueryJob | DescribeJob) {
		const t = now(),
			e = job.q.cost ? job.q.cost.est : undefined;

		if (e === undefined || e < slow) {
			return soonest(t, Infinity, false);
		}

		let heavy = 0;
		for (const c of connections) {
			if (c.inflight && c.costly(slow)) {
				heavy++;
			}
		}

		decay(t);
		const reserve = Math.max(
			1,
			Math.min(
				Math.ceil((work.fast / 2000) * 1.5) + 1,
				connections.size - Math.ceil(work.slow / 2000),
			),
		);
		return heavy < connections.size - reserve
			? soonest(t, Infinity, false)
			: soonest(t, 2 * e, true) || soonest(t, Infinity, false);
	}

	function soonest(t: number, most: number, heavy: boolean) {
		let best: Pooled | null = null,
			value = Infinity,
			ties = 0;

		for (const c of connections) {
			const v = has_room(c) && (!heavy || c.costly(slow)) ? c.backlog(t) : Infinity;
			if (v <= most && v < value) {
				best = c;
				value = v;
				ties = 1;
			} else if (v <= most && v === value && v !== Infinity && Math.random() * ++ties < 1) {
				best = c;
			}
		}

		return best;
	}

	function ontimed(sample: number, t: number) {
		decay(t);
		if (sample < slow) {
			work.fast += sample;
		} else {
			work.slow += sample;
		}
	}

	function decay(t: number) {
		const d = Math.exp((work.at - t) / 2000);
		work.fast *= d;
		work.slow *= d;
		work.at = t;
	}

	function grow() {
		if (ending && waiting.length === 0) {
			return;
		}

		if (failing_since !== null) {
			if (opening || !waiting.length || retry_timer || [...connections].some((x) => x.loading)) {
				return;
			}
			const remaining = next_attempt - now();
			if (remaining > 0) {
				retry_timer = setTimeout(() => {
					retry_timer = null;
					grow();
				}, remaining);
			} else {
				connect();
			}
			return;
		}

		let loading = 0;
		for (const c of connections) {
			if (c.loading) {
				loading++;
			}
		}

		const wanted = Math.max(
			Math.min(waiting.length - opening - loading, options.max - connections.size - opening),
			used && !ending ? Math.min(options.min, options.max) - connections.size - opening : 0,
		);

		for (let i = 0; i < wanted; i++) {
			connect();
		}
	}

	function connect() {
		opening++;
		watch();
		if (retry_timer) {
			clearTimeout(retry_timer);
			retry_timer = null;
		}
		(options.open || startup)(options, signal, replacing.length ? replacing.shift() : 0).then(
			opened,
			failed,
		);
	}

	/**
	 * @returns `failure`, while the pool fails new jobs with it at once: its connection attempts keep
	 *   failing, none is in progress, the next is not due yet, and no connection could take a job;
	 *   else null
	 */
	function failing_fast() {
		return failure && retries > 1 && opening === 0 && now() < next_attempt && stuck()
			? failure
			: null;
	}

	function stuck() {
		for (const c of connections) {
			if (!c.lease) {
				return false;
			}
		}
		return true;
	}

	function opened(ready: Ready) {
		opening--;

		if (signal.aborted || (ending && waiting.length === 0)) {
			ready.socket.destroy();
			return finishing();
		}

		const c: Pooled = Object.assign(Connection(ready, options, events), {
			index: ready.index || 0,
			loading: false,
			idle_since: 0,
			idle_timer: null,
			life_timer: null,
			releasing: null,
			retiring: null,
			retired: [],
		});
		connections.add(c);
		lifetime(c);
		log_at(
			log.pool,
			ready.elapsed >= slow_query_ms ? "warning" : !ever || retries || reconnect ? "info" : "debug",
			retries
				? "connected to {target} in {ms} ms, after {retries} failed attempts spanning {down} s" +
						(rejected ? " ({rejected} requests rejected meanwhile)" : "") +
						": connection {id}, backend pid {pid}, tls {tls}, auth {auth}"
				: "connected to {target} in {ms} ms: connection {id}, backend pid {pid}, tls {tls}, auth {auth}",
			{
				target: target(options, c.host, c.port),
				retries,
				down: tenths(failing_since === null ? 0 : now() - failing_since),
				rejected,
				ms: Math.round(ready.elapsed),
				id: c.id,
				pid: ready.backend ? ready.backend.pid : null,
				tls: ready.tls,
				auth: ready.auth,
			},
		);
		ever = true;
		reconnect = false;
		watch();
		event("open", c);
		if (types_loaded || types_loading) {
			c.loading = !types_loaded;
		} else {
			load_types(c);
		}
		if (!c.loading) {
			recovered();
		}
		drain();
		idle(c);
	}

	function recovered() {
		retries = 0;
		rejected = 0;
		failing_since = null;
		failure = null;
	}

	function retype() {
		if (!types_error) {
			return null;
		}

		if (now() - types_failed < 1000) {
			return copy_error(types_error);
		}

		types_error = null;
		connections.forEach((x) => (x.loading = true));
		const first_open = [...connections].find((x) => !x.closed);
		if (first_open) {
			load_types(first_open);
		}
		return null;
	}

	/**
	 * Loads the pool's types on connection `c`, then lets the connections go on: the waiting
	 * queries run, or, if a type does not exist, are rejected, and each connection that waited
	 * for the types and is left with nothing to do settles into idleness, or closes if the pool
	 * is ending.
	 * @param c - an open connection
	 */
	function load_types(c: Pooled) {
		hold(c);
		types_loading = true;
		c.loading = true;
		void types
			.load(
				(text) =>
					new Promise<Record<string, any>[]>((resolve, fail) => {
						const q = new Query(
							[text],
							[],
							Object.assign(() => {}, { options }),
							{ simple: true },
						);
						q.executed = true;
						q.then(resolve, fail);
						c.simple(q, text);
					}),
			)
			.then(
				() => {
					types_loaded = true;
				},
				(error: Failure) => {
					if (error instanceof PostgresError) {
						// The server answered a lookup with an error: the pool goes on as if loaded
						types_loaded = true;
						log.pool.error(
							"fetching types from {target} failed, and is not retried; this pool may return values of domains and of custom types as text: {reason}",
							{ target: where, reason: reason(error), error },
						);
					} else if (error && error.code === "TYPE_NOT_FOUND") {
						types_error = error;
						types_failed = now();
						log.pool.warn(
							"custom types missing on {target}; requests fail until they are found (looked up again by the first request after 1 s): {reason}",
							{ target: where, reason: reason(error), error },
						);
					}
					// Otherwise the load did not finish (`c` closed, say): another connection tries below
				},
			)
			.then(() => {
				types_loading = false;
				const waited = [...connections].filter((x) => x.loading);
				connections.forEach((x) => (x.loading = !types_loaded && !types_error));
				if (types_loaded || types_error) {
					recovered();
				}
				if (types_error) {
					for (const job of waiting.take()) {
						reject(job, copy_error(types_error));
					}
				} else if (!types_loaded) {
					const other = [...connections].find((x) => !x.closed);
					if (other) {
						load_types(other);
					}
				}
				drain();
				if (ending && waiting.length === 0) {
					finishing();
				}
				for (const x of waited) {
					idle(x);
				}
			});
	}

	function failed(error: Failure) {
		opening--;
		if (signal.aborted) {
			return finishing();
		}

		attempted(error);
		if (ending) {
			finishing();
		} else {
			grow();
		}
	}

	function attempted(error: Failure) {
		if (failing_since === null) {
			failing_since = now();
		}
		retries++;
		const delay_s = backoff_seconds(options.backoff, retries);
		next_attempt = now() + 1000 * delay_s;

		const transient = !!error && (error.code === "CONNECTION_CLOSED" || error.code === "53300"),
			expired = options.connect_timeout && now() - failing_since >= options.connect_timeout * 1000;

		failure = !transient || expired ? { error } : null;
		const rejecting = stuck() && opening === 0 && (failure || ending) ? waiting.length : 0,
			left = waiting.length - rejecting,
			rejections = rejecting ? "; rejecting {rejecting} waiting requests with this error" : "";
		if (ending) {
			log.pool.debug(
				"connecting to {target} failed while the pool was ending; not retrying" +
					rejections +
					": {reason}",
				{ target: where, rejecting, reason: reason(error), error },
			);
		} else {
			log.pool.warn(
				"connecting to {target} failed ({retries} in a row)" +
					rejections +
					(left
						? "; next attempt in {delay} ms ({waiting} waiting)"
						: "; next attempt when a request comes, {delay} ms from now at the earliest") +
					": {reason}",
				{
					target: where,
					retries,
					rejecting,
					delay: Math.round(1000 * delay_s),
					waiting: left,
					reason: reason(error),
					error,
				},
			);
		}
		if (rejecting) {
			rejected += rejecting;
			for (const job of waiting.take()) {
				reject(job, copy_error(error));
			}
		}
	}

	function reject(job: Job, error: Error) {
		started(job);
		if (job.kind === "lease") {
			job.reject(error);
		} else {
			job.q.reject(query_error(error, job.q, options.debug));
		}
	}

	/**
	 * Starts connection `c`'s `max_lifetime` timer, if `max_lifetime` is set: when the timer
	 * fires, `c` closes as soon as it has no lease and nothing in flight.
	 * @param c - a connection that just opened
	 */
	function lifetime(c: Pooled) {
		const life =
			typeof options.max_lifetime === "function" ? options.max_lifetime() : options.max_lifetime;
		if (!life) {
			return;
		}

		const why = "max_lifetime (" + Math.round(life) + " s) reached";
		c.life_timer = unref(
			setTimeout(() => {
				c.retiring = why;
				if (c.inflight === 0 && !c.lease) {
					void c.close(why);
				}
			}, life * 1000),
		);
	}

	/**
	 * Publishes a message on the pool channel, if anyone listens to it.
	 * @param name - the event
	 * @param c - the connection that the event is about, or null
	 * @param extra - more fields for the message
	 */
	function event(name: string, c: Pooled | null, extra?: Record<string, unknown>) {
		const channel = channels.pool;
		if (!channel || !listened(channel)) {
			return;
		}

		channel.publish({
			event: name,
			connection: c ? c.id : null,
			host: c ? c.host : null,
			port: c ? c.port : null,
			database: options.database,
			stats: pool.stats,
			...extra,
		});
	}

	/**
	 * Logs that requests wait for a connection, once the queue has been non-empty for
	 * `congested_after` without a break, and again every `logged_every_ms` while it stays so; the
	 * queue's emptying ends the congestion (see queue_emptied()). The line gives the counts that
	 * tell a pool too small for its load, or a server too slow, from one that cannot connect.
	 * drain() and tick() call this, so the first line comes between `congested_after` and a
	 * watchdog period after the first wait.
	 */
	function congested() {
		const t = now();
		if (waiting.length === 0) {
			return;
		}

		if (congestion === null) {
			congestion = { since: t, logged: null };
			return;
		}
		if (
			t - congestion.since < congested_after ||
			(congestion.logged !== null && t - congestion.logged < logged_every_ms)
		) {
			return;
		}

		congestion.logged = t;
		const oldest = waiting.peek();
		log.pool.warn(
			"queue for a connection to {target} not empty for {secs} s: {waiting} requests waiting, the oldest for {oldest} s; {open} of {max} connections open ({leased} leased), {opening} opening",
			{
				target: where,
				secs: tenths(t - congestion.since),
				waiting: waiting.length,
				oldest: tenths(oldest === undefined ? 0 : t - oldest.since),
				open: connections.size,
				max: options.max,
				leased: leased(),
				opening,
			},
		);
	}

	/**
	 * Ends the congestion, if any, as the queue has emptied (the queue calls this): logs it if it
	 * was logged, and the requests were served; if they were rejected or timed out, the lines
	 * about that say so.
	 * @param how - how the queue emptied
	 */
	function queue_emptied(how: Emptied) {
		if (how === "served" && congestion !== null && congestion.logged !== null) {
			log.pool.info("queue for a connection to {target} empty again after {secs} s", {
				target: where,
				secs: tenths(now() - congestion.since),
			});
		}
		congestion = null;
	}

	/**
	 * Counts a wait for a connection that timed out, and logs it: at once, or, within
	 * `logged_every_ms` of the last such line, with the ones that came since (see Throttle).
	 * @param job - the request that timed out
	 */
	function timed_out(job: Job) {
		const x = queue_timeouts.hit(now());
		if (x === null) {
			return;
		}
		log_timeouts(x, job.kind === "lease" ? lease_name(job.lease) : "a query");
	}

	/**
	 * Logs waits for a connection that timed out.
	 * @param x - what the throttle reports: how many, in the last how many seconds
	 * @param kind - what the one request was, if `x.count` is 1 and that is known: `a query`,
	 *   `sql.begin()` or `sql.reserve()`; else `a request`
	 */
	function log_timeouts(x: { count: number; since: number }, kind = "a request") {
		if (x.count === 1) {
			log.pool.warn(
				"{kind} waited {queue_timeout} s for a connection to {target} and was rejected with QUEUE_TIMEOUT",
				{ kind, queue_timeout: options.queue_timeout, target: where },
			);
		} else {
			log.pool.warn(
				"{count} requests for a connection to {target} timed out in the last {since} s (queue_timeout {queue_timeout} s) and were rejected with QUEUE_TIMEOUT",
				{ count: x.count, since: x.since, queue_timeout: options.queue_timeout, target: where },
			);
		}
	}

	/**
	 * Starts the watchdog, unless it runs: every `watch_every`, while connections are open or
	 * opening, requests wait, or throttled counts wait to be reported, it checks for congestion
	 * (congested()), for unfinished queries (each connection's unanswered()), for an end() that
	 * does not finish, and reports the counts. The timer keeps no process alive.
	 */
	function watch() {
		if (watchdog !== null) {
			return;
		}
		watchdog = setTimeout(tick, watch_every);
		if (typeof watchdog.unref === "function") {
			watchdog.unref();
		}
	}

	function tick() {
		watchdog = null;
		congested();
		const t = now();
		connections.forEach((c) => c.unanswered(t));
		const timeouts = queue_timeouts.flush(t);
		if (timeouts !== null) {
			log_timeouts(timeouts);
		}
		const trouble = events.trouble.flush(t);
		if (trouble !== null) {
			log.connection.error(
				trouble.count === 1
					? "one more server error about the server's own trouble (SQLSTATE class 53, 58 or XX) came from {target} in the last {since} s"
					: "{count} more server errors about the server's own trouble (SQLSTATE classes 53, 58 and XX) came from {target} in the last {since} s",
				{ count: trouble.count, target: where, since: trouble.since },
			);
		}
		if (ending && resolve_ending && t - ending_logged >= logged_every_ms) {
			ending_logged = t;
			log.pool.warn(
				"pool for {target} still ending after {secs} s: {connections} connections open ({leased} leased), {inflight} operations in flight, {waiting} requests waiting for a connection",
				{
					target: where,
					secs: tenths(t - ending_since),
					connections: connections.size,
					leased: leased(),
					inflight: inflight(),
					waiting: waiting.length,
				},
			);
		}
		if (
			connections.size ||
			opening ||
			waiting.length ||
			queue_timeouts.pending ||
			events.trouble.pending
		) {
			watch();
		}
	}

	function unwatch() {
		if (watchdog !== null) {
			clearTimeout(watchdog);
			watchdog = null;
		}
	}

	/** @returns how many exchanges the connections have in flight, in all */
	function inflight() {
		let n = 0;
		connections.forEach((c) => (n += c.inflight));
		return n;
	}

	/** @returns how many connections are leased */
	function leased() {
		let n = 0;
		connections.forEach((c) => (n += c.lease ? 1 : 0));
		return n;
	}

	/**
	 * Logs that connection `c` still has a transaction block open after its lease released it, and
	 * closes it, as the pool cannot reuse it.
	 * @param kind - the lease's kind: "transaction" (sql.begin()) or "reserve" (sql.reserve())
	 */
	function released_open(c: Pooled, kind: string) {
		log.pool.warn(
			"{lease} released connection {id} to {target} inside {state}; closing it instead of reusing it",
			{
				lease: lease_name(kind),
				id: c.id,
				target: target(options, c.host, c.port),
				state:
					c.status === "E" ? "a failed transaction (status E)" : "an open transaction (status T)",
			},
		);
		void c.close("released inside a transaction");
	}

	/**
	 * Settles connection `c` into idleness, if it has nothing in flight, no lease, is not closing
	 * and is not waiting for the pool's types to load: publishes `idle` for it, unless a cancel
	 * request holds it (then, when the hold ends, onready() calls this again, unless onready()
	 * closes the connection instead or the connection has already closed); with `unref_sockets`,
	 * lets its socket go (unless queries wait that `c` could not take); and with `idle_timeout`,
	 * starts its idle timer, or, if that is already running, counts the timeout from now again.
	 * @param c - a connection that just opened, finished the last query it had in flight, was
	 *   released, stopped waiting for the types, or stopped being held for a cancel request, after
	 *   the pool has given it whatever waiting work it could
	 */
	function idle(c: Pooled) {
		if (c.inflight || c.lease || c.closing || c.loading) {
			return;
		}

		if (!c.held) {
			event("idle", c);
		}
		if (options.unref_sockets && waiting.length === 0) {
			c.unref();
		}
		const timeout = options.idle_timeout;
		if (!timeout) {
			return;
		}

		c.idle_since = now();
		if (!c.idle_timer) {
			c.idle_timer = unref(setTimeout(() => idled(c, timeout), timeout * 1000));
		}
	}

	function hold(c: Pooled) {
		if (options.unref_sockets) {
			c.ref();
		}
	}

	function unref<T extends { unref?: () => unknown } | null | undefined>(timer: T): T {
		if (options.unref_sockets && timer && typeof timer.unref === "function") {
			timer.unref();
		}
		return timer;
	}

	/**
	 * Closes connection `c` when its idle timer fires, if `c` has been idle for `idle_timeout`
	 * and the pool has more than `min` connections; if `c` became idle again after the timer was
	 * set, waits the rest of the timeout first. A connection that is busy, leased or waiting for
	 * the pool's types is left alone: it gets a new timer when it next settles into idleness.
	 * @param c - the connection whose idle timer fired
	 * @param timeout - `idle_timeout`, in seconds
	 */
	function idled(c: Pooled, timeout: number) {
		c.idle_timer = null;
		if (c.inflight || c.lease || c.closed || c.loading) {
			return;
		}

		if (connections.size <= options.min) {
			return;
		}

		const left = timeout * 1000 - (now() - c.idle_since);
		if (left >= 1) {
			c.idle_timer = unref(setTimeout(() => idled(c, timeout), left));
		} else {
			void c.close("idle for " + timeout + " s");
		}
	}

	function onready(c: Pooled) {
		if (c.releasing) {
			if (c.inflight) {
				return;
			}

			const kind = c.releasing;
			c.releasing = null;
			if (c.status !== "I") {
				released_open(c, kind);
				return;
			}
		}
		if (c.inflight === 0 && !c.lease && (c.retiring || (ending && waiting.length === 0))) {
			void c.close(c.retiring || "sql.end() called");
			return;
		}

		for (
			let next = waiting.peek();
			waiting.length > connections.size && has_room(c) && plain(next);
			next = waiting.peek()
		) {
			waiting.shift();
			run(c, next);
		}

		if (waiting.length && !c.lease && c.inflight < max_inflight) {
			drain();
		}
		idle(c);
		if (ending && waiting.length === 0) {
			finishing();
		}
	}

	/**
	 * @param c - the connection that closed
	 * @param error - the error that says that `c` closed (which no query's properties were added to)
	 * @param lease_error - the error that `c`'s lease (if any) rejects with instead of `error`, or
	 *   null for `error`
	 * @param orderly - whether `c` closed in an orderly way: it sent Terminate, and had nothing in
	 *   flight when it closed
	 */
	function onclose(c: Pooled, error: Failure, lease_error: Failure | null, orderly: boolean) {
		connections.delete(c);
		if (!orderly && connections.size === 0) {
			reconnect = true;
		}
		// An orderly close is one that the pool asked for, not a failed attempt to open a connection
		if (c.loading && !orderly && !signal.aborted) {
			attempted(copy_error(error));
		}
		if (!ending) {
			replacing.push((c.index + 1) % (options.path ? 1 : options.host.length));
		}
		if (replacing.length > options.max) {
			replacing.shift();
		}
		c.retired.forEach((r) => r());
		if (c.idle_timer) {
			clearTimeout(c.idle_timer);
		}
		if (c.life_timer) {
			clearTimeout(c.life_timer);
		}
		if (c.lease && c.lease.onclose) {
			let lost = lease_error || error;
			// To the lease, the connection closed, with the same cause, such as a FATAL error that
			// answered COMMIT
			if (lost.code === "CONNECTION_DESTROYED") {
				const cause = lost.cause;
				lost = Errors.connection("CONNECTION_CLOSED", options, c.host, c.port);
				if (cause !== undefined) {
					lost.cause = cause;
				}
			}
			c.lease.onclose(lost);
		}
		if (options.onclose) {
			guarded(
				log.connection,
				"onclose handler threw on connection {id} to {target}",
				{ id: c.id, target: target(options, c.host, c.port) },
				options.onclose,
				c.id,
			);
		}
		event("close", c, orderly ? {} : { error });
		if (connections.size === 0 && opening === 0) {
			statements.clear();
		}
		drain();
		if (ending) {
			finishing();
		}
	}

	/**
	 * Records a ParameterStatus of connection `c`, and tells the `onparameter` handler if the
	 * value is new to the pool.
	 */
	function onparameter(k: string, v: string, c: Connection) {
		if (options.parameters[k] === v) {
			return;
		}

		// A change of these means that the server was promoted or demoted
		const standby = k === "in_hot_standby" || k === "default_transaction_read_only",
			changed = k in options.parameters;
		options.parameters[k] = v;
		log_at(
			log.pool,
			standby && changed ? "info" : "debug",
			"connection {id} to {target} reports {name} = {value}",
			{ id: c.id, target: target(options, c.host, c.port), name: k, value: v },
		);
		if (options.onparameter) {
			guarded(
				log.connection,
				"onparameter handler threw on connection {id} to {target}",
				{ id: c.id, target: target(options, c.host, c.port) },
				options.onparameter,
				k,
				v,
			);
		}
	}

	async function acquire(kind: string) {
		used = true;
		// Yield one microtask, so that a query issued just before this call reaches the pool first:
		// Query.handle() defers its dispatch by one microtask.
		await Promise.resolve();
		if (ending) {
			throw Errors.connection("CONNECTION_ENDED", options, options.host[0], options.port[0]);
		}

		const failing = failing_fast();
		if (failing) {
			rejected++;
			throw copy_error(failing.error);
		}

		const missing = retype();
		if (missing) {
			throw missing;
		}

		return new Promise<Lease>((resolve, fail) => {
			waiting.push(
				wait({
					kind: "lease",
					lease: kind,
					resolve,
					reject: fail,
					queued: channels.pool && listened(channels.pool) ? now() : 0,
					timer: null,
					since: 0,
				}),
			);
			drain();
		});
	}

	/**
	 * Leases connection `c` to `job`, and resolves the job's promise with the lease.
	 * @returns the lease (whose type is `Lease`)
	 */
	function grant(c: Pooled, job: Waiting & LeaseJob) {
		started(job);
		hold(c);
		if (c.idle_timer) {
			clearTimeout(c.idle_timer);
			c.idle_timer = null;
		}
		let chain = Promise.resolve(),
			released = false,
			lost: (error: Error) => void;

		const closed = new Promise<never>((_, fail) => (lost = fail));
		closed.catch(() => {});

		const x: Lease = {
			kind: job.lease,
			error: null,
			connection: c,
			closed,
			get released() {
				return released;
			},
			send(q) {
				if (c.closed) {
					q.reject(query_error(copy_error(c.closed), q, options.debug));
					return;
				}

				if (released) {
					q.reject(query_error(ended(x), q, options.debug));
					return;
				}

				chain = chain.then(
					() =>
						new Promise((resolve) => {
							q.onwrite = resolve;
							q.then(resolve, resolve);
							query(q, x);
						}),
				);
			},
			release() {
				if (released) {
					return;
				}
				released = true;
				if (c.lease === x) {
					c.lease = null;
				}
				event("release", c, { kind: job.kind });
				if (c.closed) {
					return;
				}

				if (c.inflight) {
					c.releasing = x.kind;
					return;
				}

				if (c.status === "I") {
					onready(c);
				} else {
					released_open(c, x.kind);
				}
			},
			onclose(error) {
				x.error = error;
				lost(error);
			},
		};

		c.lease = x;
		event("lease", c, { kind: job.lease, waited: job.queued ? now() - job.queued : 0 });
		job.resolve(x);
		return x;
	}

	function cancel(q: Query) {
		const removed = waiting.remove((x) => {
			if (x.kind === "lease" || x.q !== q) {
				return false;
			}
			started(x);
			return true;
		});
		if (removed) {
			q.reject(query_error(Errors.canceled(), q, options.debug));
			return Promise.resolve();
		}

		if (q.connection) {
			return q.connection.cancel(q);
		}

		q.cancelled = true;
		return Promise.resolve();
	}

	function end({ timeout = null }: { timeout?: number | null } = {}) {
		if (ending) {
			return ending;
		}

		ending_since = ending_logged = now();
		log.pool.debug(
			"pool for {target} ending" +
				(timeout === null ? " with no timeout" : " with a timeout of {timeout} s") +
				": {connections} connections open ({leased} leased), {opening} opening, {inflight} operations in flight, {waiting} requests waiting for a connection",
			{
				target: where,
				timeout,
				connections: connections.size,
				leased: leased(),
				opening,
				inflight: inflight(),
				waiting: waiting.length,
			},
		);
		ending = new Promise<void>((resolve) => {
			resolve_ending = resolve;
			if (timeout !== null) {
				end_timer = setTimeout(() => destroy(timeout), timeout * 1000);
			}
			if (retry_timer) {
				clearTimeout(retry_timer);
				retry_timer = null;
			}
			queueMicrotask(finishing);
		});

		return ending;
	}

	function finishing() {
		if (!resolve_ending) {
			return;
		}

		if (waiting.length === 0) {
			for (const c of connections) {
				if (c.inflight === 0 && !c.lease) {
					void c.close("sql.end() called");
				}
			}
		}

		if (connections.size === 0 && opening === 0 && waiting.length) {
			log.pool.warn(
				"pool for {target} is ending with no connection left; rejecting the {waiting} requests waiting for one (CONNECTION_ENDED)",
				{ target: where, waiting: waiting.length },
			);
			for (const job of waiting.take()) {
				reject(
					job,
					Errors.connection("CONNECTION_ENDED", options, options.host[0], options.port[0]),
				);
			}
		}

		if (connections.size === 0 && (opening === 0 || signal.aborted) && waiting.length === 0) {
			if (end_timer) {
				clearTimeout(end_timer);
			}
			if (retry_timer) {
				clearTimeout(retry_timer);
			}
			const resolve = resolve_ending;
			resolve_ending = null;
			unwatch();
			log.pool.debug("pool for {target} ended", { target: where });
			resolve();
		}
	}

	/**
	 * Destroys every connection and rejects every waiting job: end()'s timeout has elapsed.
	 * @param timeout - the timeout, in seconds
	 */
	function destroy(timeout: number) {
		end_timer = null;
		log_at(
			log.pool,
			inflight() || waiting.length || leased() ? "warning" : "debug",
			"pool for {target} did not end within {timeout} s; destroying {connections} connections ({leased} leased), failing {inflight} operations in flight and {waiting} requests waiting for a connection",
			{
				target: where,
				timeout,
				connections: connections.size,
				leased: leased(),
				inflight: inflight(),
				waiting: waiting.length,
			},
		);
		signal.aborted = true;
		signal.sockets.forEach((x) => x.destroy());
		for (const job of waiting.take()) {
			reject(
				job,
				Errors.connection("CONNECTION_DESTROYED", options, options.host[0], options.port[0]),
			);
		}
		connections.forEach((c) => c.destroy());
		if (connections.size === 0) {
			finishing();
		}
	}

	function close() {
		used = false;
		return Promise.all(
			[...connections].map((c) =>
				c.lease
					? new Promise<void>((r) => {
							c.retiring = "sql.close() called";
							c.retired.push(r);
						})
					: c.close("sql.close() called"),
			),
		);
	}
}

/** @returns whether `job` is a query that may be pipelined behind other queries on a connection */
function plain(job: Job | undefined): job is Waiting & QueryJob {
	return job !== undefined && job.kind === "query" && !job.exclusive;
}

/** @returns whether `job` may go on a connection that has queries in flight: it is not a lease, and not exclusive */
function pipelined(job: Job) {
	return job.kind === "describe" || plain(job);
}

function usable(c: Pooled) {
	return (
		!c.closed && !c.closing && !c.lease && !c.releasing && !c.retiring && !c.exclusive && !c.loading
	);
}

function ended(lease: Lease) {
	return Errors.generic("UNSAFE_TRANSACTION", "The " + lease.kind + " has ended");
}

/** How a Queue emptied: an element was shifted, every element was taken, or one was removed */
export type Emptied = "served" | "taken" | "removed";

/**
 * A FIFO queue of T, whose shift() is O(1)
 * @param onempty - called whenever shift(), take() or remove() empties the queue, with which did
 */
export function Queue<T>(onempty: (how: Emptied) => void = () => {}) {
	// Shifted slots are cleared, so that the queue does not keep what it gave out
	let xs: (T | undefined)[] = [],
		head = 0;

	return {
		get length() {
			return xs.length - head;
		},
		push(x: T) {
			xs.push(x);
		},
		/** @returns the first element, or undefined if the queue is empty */
		peek: () => xs[head],
		/** @returns the first element, which the queue drops; throws if the queue is empty */
		shift() {
			const x = xs[head];
			if (x === undefined) {
				throw new Error("Bug: shift() of an empty Queue");
			}
			xs[head++] = undefined;
			if (head === xs.length) {
				xs = [];
				head = 0;
				onempty("served");
			} else if (head > 1024 && head * 2 > xs.length) {
				xs = xs.slice(head);
				head = 0;
			}
			return x;
		},
		take() {
			const all = xs.slice(head).filter((x): x is T => x !== undefined);
			xs = [];
			head = 0;
			if (all.length) {
				onempty("taken");
			}
			return all;
		},
		remove(fn: (x: T) => boolean) {
			for (let i = head; i < xs.length; i++) {
				const x = xs[i];
				if (x !== undefined && fn(x)) {
					xs.splice(i, 1);
					if (head === xs.length) {
						xs = [];
						head = 0;
						onempty("removed");
					}
					return true;
				}
			}
			return false;
		},
	};
}

const limit = 2000;

function alone(x: Known | Statement) {
	return x.alone === undefined ? (x.alone = opens(x.text)) : x.alone;
}

function opens(text: string) {
	if (begins.test(text)) {
		return true;
	}

	starts.lastIndex = 0;
	let match: RegExpExecArray | null;
	while ((match = starts.exec(text))) {
		const from = match.index + 5;
		let i = from;
		while (true) {
			while (i < text.length && /\s/.test(text[i])) {
				i++;
			}

			if (text[i] !== "/" || text[i + 1] !== "*") {
				break;
			}

			const end = text.indexOf("*/", i + 2);
			if (end === -1) {
				return false;
			}

			i = end + 2;
		}

		if (i > from && transaction.test(text.slice(i, i + 12))) {
			return true;
		}

		starts.lastIndex = Math.max(starts.lastIndex, i);
	}

	return false;
}

function Statements(scheduler: boolean) {
	const prefix = Math.random().toString(36).slice(2, 10),
		map = new Map<string, Named>(),
		templates = new WeakMap<TemplateStringsArray | string[], Map<string, Statement>>();

	let counter = 1,
		clock = 0;

	const texts = new Map<string, Known>();

	return { get, clear, known };

	function known(text: string) {
		let x = texts.get(text);
		if (x) {
			return x;
		}

		texts.set(text, (x = { text, est: undefined, alone: undefined }));
		if (texts.size > limit) {
			for (const oldest of texts.keys()) {
				texts.delete(oldest);
				break;
			}
		}
		return x;
	}

	function get(built: Built, prepare: boolean) {
		if (!prepare) {
			return unnamed(built.text);
		}

		const tagged = !built.dynamic && (templates.get(built.strings) || set(built.strings)),
			cached = tagged && tagged.get(built.types);

		if (cached && cached.live) {
			cached.used = clock++;
			return cached;
		}

		const key = built.types + "\0" + built.text;
		let statement = map.get(key);
		if (statement) {
			statement.used = clock++;
		} else {
			statement = add(key, built.text);
		}
		if (tagged) {
			tagged.set(built.types, statement);
		}
		return statement;
	}

	function unnamed(text: string): Statement {
		return {
			key: null,
			live: false,
			name: "",
			text,
			ends: undefined,
			shape: undefined,
			version: 0,
			used: 0,
			cost: scheduler ? known(text) : null,
		};
	}

	function add(key: string, text: string) {
		const statement: Named = {
			key,
			live: true,
			name: prefix + counter++,
			text,
			ends: undefined,
			shape: undefined,
			version: 0,
			used: clock++,
			cost: { est: undefined },
			alone: undefined,
		};
		map.set(key, statement);
		if (map.size > limit) {
			evict();
		}
		return statement;
	}

	function evict() {
		let oldest: Named | undefined;
		for (const x of map.values()) {
			if (oldest === undefined || x.used < oldest.used) {
				oldest = x;
			}
		}
		if (oldest !== undefined) {
			oldest.live = false;
			map.delete(oldest.key);
		}
	}

	function set(strings: TemplateStringsArray | string[]) {
		const x = new Map<string, Statement>();
		templates.set(strings, x);
		return x;
	}

	function clear() {
		map.forEach((x) => (x.live = false));
		map.clear();
	}
}
