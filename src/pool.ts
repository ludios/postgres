import { open as startup } from "./startup.ts";
import type { Signal } from "./startup.ts";
import { Connection } from "./connection.ts";
import { Query } from "./query.ts";
import { Errors, PostgresError, copy_error, queryError } from "./errors.ts";
import { channels, listened } from "./diagnostics.ts";
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

const begins = /\bbegin\b/i,
	starts = /\bstart\b/gi,
	transaction = /^transaction\b/i;

/**
 * A Connection, with the fields that the pool keeps on it. `opened` sets `index` and `loading`;
 * the pool adds the other fields later, so each of them is undefined until then.
 */
type Pooled = Connection & {
	/** The index of the host (in `options.host`) that the connection went to. */
	index: number;
	/**
	 * Whether the connection waits for the pool's types to load (on this connection or on
	 * another one) before it takes queries.
	 */
	loading: boolean;
	/** When the connection last became idle. */
	idleSince?: number;
	/** Closes the connection after `idle_timeout`. */
	idleTimer?: Timer | null;
	/** Retires the connection after `max_lifetime`. */
	lifeTimer?: Timer | null;
	/** Whether the lease was released while queries were still in flight. */
	releasing?: boolean;
	/** Whether the connection closes as soon as it has no lease and nothing in flight. */
	retiring?: boolean;
	/** Called once the connection closes. */
	retired?: Array<() => void>;
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
type Job = {
	/** The query, for a query or a describe */
	q?: Query;
	/** The text, for a query of the simple protocol */
	simple?: string;
	/** The statement, for a query of the extended protocol */
	statement?: Statement;
	/** Whether the query needs the connection to itself */
	exclusive?: boolean;
	/** Runs the job on the connection, instead of sending `q` (a describe) */
	run?: (c: Pooled) => void;
	/** For a lease: true, with its `kind`, and `resolve` for the lease */
	lease?: boolean;
	kind?: string;
	resolve?: (lease: Lease) => void;
	/** Rejects the describe's or the lease's promise */
	reject?: (error: Error) => void;
	/** When the job was queued, for the "lease" event; 0 if nobody listens to the pool channel */
	queued?: number;
	/** The `queue_timeout` timer */
	timer?: Timer | null;
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
		waiting = Queue<Job>(),
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
		},
		work = { fast: 0, slow: 0, at: 0 },
		// How many queries a connection may have in flight before the pool places no more queries on
		// it: max_pipeline, but at least 1. A lease's queries go to its connection without this limit.
		max_inflight = Math.max(1, options.max_pipeline);

	const signal: Signal = { aborted: false, sockets: new Set() },
		replacing: number[] = [];

	let opening = 0,
		ending: Promise<void> | null = null,
		// Resolves `ending`, once the pool has finished ending.
		resolve_ending: (() => void) | null = null,
		used = false,
		endTimer: Timer | null = null,
		retries = 0,
		failingSince: number | null = null,
		nextAttempt = 0,
		retryTimer: Timer | null = null,
		typesLoaded = options.fetch_types === false,
		typesError: Failure | null = null,
		typesFailed = 0,
		// The error of the connection attempts that fail fast, while they do
		failure: { error: Failure } | null = null,
		typesLoading = false;

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
				queryError(
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
			place({ q, simple: built.text, exclusive: q.streaming || q.alone }, lease);
			return;
		}

		if (q.onlyDescribe) {
			describeOnly(q, built, lease);
			return;
		}

		const statement = statements.get(built, options.prepare && q.options.prepare !== false);
		q.alone = free && alone(statement.live ? statement : statements.known(built.text));
		q.wire = { statement, built };
		if (options.scheduler) {
			q.cost = statement.cost;
		}
		place({ q, statement, exclusive: !!q.cursorFn || q.streaming || q.alone }, lease);
	}

	function describeOnly(q: Query, built: Built, lease?: Lease) {
		const start = (c: Pooled) => {
			q.connection = c;
			c.describe(built.text, built.oids).then(
				({ params, columns }) =>
					q.resolve({ string: built.text, types: params, name: "", columns }),
				(error: Error) => q.reject(queryError(error, q, options.debug)),
			);
			if (q.onwrite) {
				q.onwrite();
			}
		};
		place(
			{ run: start, q, reject: (error: Error) => q.reject(queryError(error, q, options.debug)) },
			lease,
		);
	}

	function unbuilt(q: Query, thrown: unknown, lease?: Lease) {
		const error = queryError(thrown, q, options.debug);
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

	function place(job: Job, lease?: Lease) {
		used = true;
		const missing = !lease && retype();

		if (missing) {
			reject(job, missing);
			return;
		}

		if (job.q && job.q.cancelled) {
			job.q.reject(queryError(Errors.canceled(), job.q, options.debug));
			return;
		}

		if (lease) {
			if (lease.connection.closed) {
				job.q.reject(queryError(copy_error(lease.connection.closed), job.q, options.debug));
			} else if (lease.released) {
				job.q.reject(queryError(ended(lease), job.q, options.debug));
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

		if (failingFast()) {
			reject(job, copy_error(failure.error));
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
		if (!options.queue_timeout) {
			return job;
		}

		job.timer = setTimeout(() => {
			job.timer = null;
			if (waiting.remove((x) => x === job)) {
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

	function run(c: Pooled, job: Job) {
		started(job);
		hold(c);

		if (job.run) {
			job.run(c);
			return;
		}

		job.q.connection = c;
		if (job.simple !== undefined) {
			c.simple(job.q, job.simple);
		} else {
			c.send(job.q);
		}
		if (job.q.onwrite) {
			job.q.onwrite();
		}
	}

	function drain() {
		while (waiting.length) {
			const job = waiting.peek(),
				c = pick(job);

			if (!c && !copying(job)) {
				break;
			}

			waiting.shift();
			if (!c) {
				reject(job, Errors.generic("COPY_IN_PROGRESS", "You cannot execute queries during copy"));
			} else if (job.lease) {
				grant(c, job);
			} else {
				run(c, job);
			}
		}
		if (waiting.length) {
			event("wait", null, { waiting: waiting.length });
		}
		grow();
	}

	function copying(job: Job) {
		if (!job.q || connections.size + opening < options.max || connections.size === 0) {
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
		const statement = job.statement,
			any = !statement || !statement.name;

		let best: Pooled | null = null;

		for (const c of connections) {
			const room = has_room(c);
			if (room && c.inflight === 0) {
				if (any || c.prepared.has(statement.name)) {
					return c;
				}
				best = best && best.inflight === 0 ? best : c;
			} else if (room && !job.lease && !job.exclusive && (!best || c.inflight < best.inflight)) {
				best = c;
			}
		}

		if (best && best.inflight === 0) {
			return best;
		}

		if (connections.size + opening < options.max && !failingSince) {
			return null;
		}

		if (best && options.scheduler && job.q && needed(job)) {
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
	function needed(job: Job) {
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

	function scheduled(job: Job) {
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

		if (failingSince !== null) {
			if (opening || !waiting.length || retryTimer || [...connections].some((x) => x.loading)) {
				return;
			}
			const remaining = nextAttempt - now();
			if (remaining > 0) {
				retryTimer = setTimeout(() => {
					retryTimer = null;
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
		if (retryTimer) {
			clearTimeout(retryTimer);
			retryTimer = null;
		}
		(options.open || startup)(options, signal, replacing.length ? replacing.shift() : 0).then(
			opened,
			failed,
		);
	}

	function failingFast() {
		return !!failure && retries > 1 && opening === 0 && now() < nextAttempt && stuck();
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

		Object.entries(ready.parameters).forEach(([k, v]) => onparameter(k, v));
		const c = Connection(ready, options, events) as Pooled;
		c.index = ready.index || 0;
		connections.add(c);
		lifetime(c);
		event("open", c);
		if (typesLoaded || typesLoading) {
			c.loading = !typesLoaded;
		} else {
			loadTypes(c);
		}
		if (!c.loading) {
			recovered();
		}
		drain();
		idle(c);
	}

	function recovered() {
		retries = 0;
		failingSince = null;
		failure = null;
	}

	function retype() {
		if (!typesError) {
			return null;
		}

		if (now() - typesFailed < 1000) {
			return copy_error(typesError);
		}

		typesError = null;
		connections.forEach((x) => (x.loading = true));
		const first_open = [...connections].find((x) => !x.closed);
		if (first_open) {
			loadTypes(first_open);
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
	function loadTypes(c: Pooled) {
		hold(c);
		typesLoading = true;
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
					typesLoaded = true;
				},
				(error: Failure) => {
					if (error instanceof PostgresError) {
						// The server answered a lookup with an error: the pool goes on as if loaded
						typesLoaded = true;
					} else if (error && error.code === "TYPE_NOT_FOUND") {
						typesError = error;
						typesFailed = now();
					}
					// Otherwise the load did not finish (`c` closed, say): another connection tries below
				},
			)
			.then(() => {
				typesLoading = false;
				const waited = [...connections].filter((x) => x.loading);
				connections.forEach((x) => (x.loading = !typesLoaded && !typesError));
				if (typesLoaded || typesError) {
					recovered();
				}
				if (typesError) {
					for (const job of waiting.take()) {
						reject(job, copy_error(typesError));
					}
				} else if (!typesLoaded) {
					const other = [...connections].find((x) => !x.closed);
					if (other) {
						loadTypes(other);
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
		if (failingSince === null) {
			failingSince = now();
		}
		retries++;
		nextAttempt = now() + 1000 * backoff_seconds(options.backoff, retries);

		const transient = !!error && (error.code === "CONNECTION_CLOSED" || error.code === "53300"),
			expired = options.connect_timeout && now() - failingSince >= options.connect_timeout * 1000;

		failure = !transient || expired ? { error } : null;
		if (stuck() && opening === 0 && (failure || ending)) {
			for (const job of waiting.take()) {
				reject(job, copy_error(error));
			}
		}
	}

	function reject(job: Job, error: Error) {
		started(job);
		if (job.lease) {
			job.reject(error);
		} else if (job.q) {
			job.q.reject(queryError(error, job.q, options.debug));
		} else {
			job.reject(error);
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

		c.lifeTimer = unref(
			setTimeout(() => {
				c.retiring = true;
				if (c.inflight === 0 && !c.lease) {
					void c.close();
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
		if (!listened(channels.pool)) {
			return;
		}

		channels.pool.publish({
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
	 * Settles connection `c` into idleness, if it has nothing in flight, no lease, is not closing
	 * and is not waiting for the pool's types to load: publishes `idle` for it, unless a cancel
	 * request holds it (then the one `idle` comes when the hold ends, through onready()); with
	 * `unref_sockets`, lets its socket go (unless queries wait that `c` could not take); and with
	 * `idle_timeout`, starts its idle timer, or, if that is already running, counts the timeout
	 * from now again.
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
		if (!options.idle_timeout) {
			return;
		}

		c.idleSince = now();
		if (!c.idleTimer) {
			c.idleTimer = unref(setTimeout(() => idled(c), options.idle_timeout * 1000));
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
	 */
	function idled(c: Pooled) {
		c.idleTimer = null;
		if (c.inflight || c.lease || c.closed || c.loading) {
			return;
		}

		if (connections.size <= options.min) {
			return;
		}

		const left = options.idle_timeout * 1000 - (now() - c.idleSince);
		if (left >= 1) {
			c.idleTimer = unref(setTimeout(() => idled(c), left));
		} else {
			void c.close();
		}
	}

	function onready(c: Pooled) {
		if (c.releasing) {
			if (c.inflight) {
				return;
			}

			c.releasing = false;
			if (c.status !== "I") {
				void c.close();
				return;
			}
		}
		if (c.inflight === 0 && !c.lease && (c.retiring || (ending && waiting.length === 0))) {
			void c.close();
			return;
		}

		while (waiting.length > connections.size && has_room(c) && plain(waiting.peek())) {
			run(c, waiting.shift());
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
		if (c.retired) {
			c.retired.forEach((r) => r());
		}
		if (c.idleTimer) {
			clearTimeout(c.idleTimer);
		}
		if (c.lifeTimer) {
			clearTimeout(c.lifeTimer);
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
			options.onclose(c.id);
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

	function onparameter(k: string, v: string) {
		if (options.parameters[k] !== v) {
			options.parameters[k] = v;
			if (options.onparameter) {
				options.onparameter(k, v);
			}
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

		if (failingFast()) {
			throw copy_error(failure.error);
		}

		const missing = retype();
		if (missing) {
			throw missing;
		}

		return new Promise<Lease>((resolve, fail) => {
			waiting.push(
				wait({
					lease: true,
					kind,
					resolve,
					reject: fail,
					queued: listened(channels.pool) ? now() : 0,
				}),
			);
			drain();
		});
	}

	/**
	 * Leases connection `c` to `job`, and resolves the job's promise with the lease.
	 * @returns the lease (whose type is `Lease`)
	 */
	function grant(c: Pooled, job: Job) {
		started(job);
		hold(c);
		if (c.idleTimer) {
			clearTimeout(c.idleTimer);
			c.idleTimer = null;
		}
		let chain = Promise.resolve(),
			released = false,
			lost: (error: Error) => void;

		const closed = new Promise<never>((_, fail) => (lost = fail));
		closed.catch(() => {});

		const x: Lease = {
			kind: job.kind,
			error: null,
			connection: c,
			closed,
			get released() {
				return released;
			},
			send(q) {
				if (c.closed) {
					q.reject(queryError(copy_error(c.closed), q, options.debug));
					return;
				}

				if (released) {
					q.reject(queryError(ended(x), q, options.debug));
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
					c.releasing = true;
					return;
				}

				if (c.status === "I") {
					onready(c);
				} else {
					void c.close();
				}
			},
			onclose(error) {
				x.error = error;
				lost(error);
			},
		};

		c.lease = x;
		event("lease", c, { kind: job.kind, waited: job.queued ? now() - job.queued : 0 });
		job.resolve(x);
		return x;
	}

	function cancel(q: Query) {
		const removed = waiting.remove((x) => {
			if (x.q !== q) {
				return false;
			}
			started(x);
			return true;
		});
		if (removed) {
			q.reject(queryError(Errors.canceled(), q, options.debug));
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

		ending = new Promise<void>((resolve) => {
			resolve_ending = resolve;
			if (timeout !== null) {
				endTimer = setTimeout(destroy, timeout * 1000);
			}
			if (retryTimer) {
				clearTimeout(retryTimer);
				retryTimer = null;
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
			connections.forEach((c) => c.inflight === 0 && !c.lease && c.close());
		}

		if (connections.size === 0 && opening === 0 && waiting.length) {
			for (const job of waiting.take()) {
				reject(
					job,
					Errors.connection("CONNECTION_ENDED", options, options.host[0], options.port[0]),
				);
			}
		}

		if (connections.size === 0 && (opening === 0 || signal.aborted) && waiting.length === 0) {
			if (endTimer) {
				clearTimeout(endTimer);
			}
			if (retryTimer) {
				clearTimeout(retryTimer);
			}
			const resolve = resolve_ending;
			resolve_ending = null;
			resolve();
		}
	}

	function destroy() {
		endTimer = null;
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
							c.retiring = true;
							if (!c.retired) {
								c.retired = [];
							}
							c.retired.push(r);
						})
					: c.close(),
			),
		);
	}
}

function plain(job: Job) {
	return !!job.q && !job.lease && !job.exclusive && !job.run;
}

function usable(c: Pooled) {
	return (
		!c.closed && !c.closing && !c.lease && !c.releasing && !c.retiring && !c.exclusive && !c.loading
	);
}

function ended(lease: Lease) {
	return Errors.generic("UNSAFE_TRANSACTION", "The " + lease.kind + " has ended");
}

/** A FIFO queue of T, whose shift() is O(1) */
export function Queue<T>() {
	let xs: T[] = [],
		head = 0;

	return {
		get length() {
			return xs.length - head;
		},
		push: (x: T) => xs.push(x),
		peek: () => xs[head],
		shift() {
			const x = xs[head];
			xs[head++] = undefined;
			if (head === xs.length) {
				xs = [];
				head = 0;
			} else if (head > 1024 && head * 2 > xs.length) {
				xs = xs.slice(head);
				head = 0;
			}
			return x;
		},
		take() {
			const all = xs.slice(head);
			xs = [];
			head = 0;
			return all;
		},
		remove(fn: (x: T) => boolean) {
			for (let i = head; i < xs.length; i++) {
				if (fn(xs[i])) {
					xs.splice(i, 1);
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
		map = new Map<string, Statement>(),
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
			texts.delete(texts.keys().next().value);
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
		const statement: Statement = {
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
		let oldest: Statement | null = null;
		for (const x of map.values()) {
			if (!oldest || x.used < oldest.used) {
				oldest = x;
			}
		}
		oldest.live = false;
		map.delete(oldest.key);
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
