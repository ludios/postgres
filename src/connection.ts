import Stream from "stream";
import * as p from "./protocol.ts";
import { Errors, as_error, copy_error, queryError } from "./errors.ts";
import Result from "./result.ts";
import { CLOSE } from "./query.ts";
import type { Query } from "./query.ts";
import type { Column, Value } from "./protocol.ts";
import type { Lease, Statement } from "./pool.ts";
import type postgres from "../types/index.js";
import type { Options } from "./index.ts";
import type { Ready } from "./startup.ts";
import type { Built } from "./build.ts";
import type { Failure } from "./errors.ts";
import type { Types, Serializer } from "./types.ts";
import { now, channels, listened } from "./diagnostics.ts";

const text = p.text,
	noop = (..._: any[]) => {},
	ending = /^\s*(commit|end|abort|rollback(?!\s+to\b)|prepare\s+transaction)\b/i,
	limit = 1000,
	refused = "postgres.js: query could not be built",
	skip = Symbol("skip"),
	unknown = 100,
	states = new WeakMap<Column[], Shape>(),
	after = 16;

let ids = 1,
	compiles = true;

/**
 * One exchange with the server: the messages of a query (Parse to Sync, or one Query), or of the
 * connection's own work, and what the connection learns while they are in flight.
 */
export type Exchange = {
	/**
	 * "query": a query of the extended protocol; "simple": one of the simple protocol; "step": the next
	 * rows of a cursor; "describe": a Describe of a statement; "internal": the connection's own, such
	 * as the rollback of an unsafe transaction; "local": a query that failed before it was written
	 */
	kind: "query" | "simple" | "step" | "describe" | "internal" | "local";
	/** The query, or null for the connection's own work */
	query: Query | null;
	/** The lease that the query is sent through, if any */
	lease: Lease | null;
	/** Writes the exchange's messages; returns `skip` if the query cannot be written */
	write: (x: Exchange) => unknown;
	trace: postgres.QueryTrace | null;
	/** The statement, from the pool's cache */
	statement: Statement | null;
	text: string;
	/** The connection's entry for the prepared statement, once the exchange uses one */
	entry: Entry | null;
	/** The entry made for a statement that this exchange prepares */
	fresh: Entry | null;
	/** For a retry: the entry of the exchange that is retried */
	previous: Entry | null;
	/** The names of the statements whose ParseComplete has not come yet */
	parses: string[];
	/** The parameters, serialized */
	values: (string | Uint8Array | null)[] | null;
	/** The types of the parameters, from ParameterDescription */
	params: number[] | null;
	columns: Column[] | null;
	// The result format of each column for Bind, or null for text
	formats: number[] | null;
	/** The columns that `reader` reads */
	shaped: Column[] | null;
	reader: Shape | null;
	result: Result;
	/** The results of a simple-protocol exchange, one per statement */
	results: Result[] | null;
	/** For a step: the cursor's exchange */
	origin: Exchange | null;
	portal: string;
	/** The rows per Execute of a cursor; 0 for all */
	rows: number;
	end: boolean;
	failure: Failure | null;
	flushing: boolean;
	streaming: boolean;
	open: boolean;
	/** Whether the query must have the connection to itself */
	alone: boolean;
	describing: boolean;
	learn: boolean;
	verify: boolean;
	synced: boolean;
	bound: boolean;
	suspended: boolean;
	finished: boolean;
	done: boolean;
	/** Whether the statement ends a transaction */
	ends: boolean;
	epoch: number;
	retried: boolean;
	/** For a retry: the error of the exchange that is retried */
	original: Failure | null;
	error: Failure | null;
	/** An error of the exchange's own, before any answer of the server, such as a refused build */
	own: Failure | null;
	cancel: PromiseWithResolvers<void> | null;
	// Whether a cancel request has been sent for this exchange
	stopped: boolean;
	// The promise of this exchange's cancel request while that request is in flight; otherwise null
	stopping: Promise<unknown> | null;
	/** The stream of a COPY */
	stream: Stream.Readable | Stream.Writable | null;
	// "in", "out" or "both", once the server has started a COPY FROM, TO or BOTH
	copy: "in" | "out" | "both" | null;
	// Whether we have sent all of the COPY data, for COPY FROM and COPY BOTH
	copied: boolean;
	/** Whether the reader of a COPY TO stream wants more data */
	wanted: boolean;
	/** Whether the cursor's callback is running, for the rows of a step that PortalSuspended ended */
	awaiting: boolean;
	/** The promise of the cursor callback's last call, which the query settles after */
	last: Promise<unknown> | null;
	/** The final callback of a COPY FROM stream, until CommandComplete calls it */
	final: ((error?: Error | null) => void) | null;
	/** Settle the promise of the exchange's kind: with rows, a Description, or nothing */
	resolve: ((value: any) => void) | null;
	reject: ((error: unknown) => void) | null;
	/** The scheduler's estimate of the query's cost */
	cost: number | undefined;
};

/** The connection's cache entry for a prepared statement */
type Entry = {
	/** The name of the prepared statement on the connection */
	name: string;
	/**
	 * The exchange that prepares the statement. ReadyForQuery sets it to null once that exchange has
	 * ended, so that the cache does not keep the exchange's query.
	 */
	owner: Exchange | null;
	/** The types of the parameters, or null until the server has described them */
	oids: number[] | null;
	/** The columns of the statement's rows, once the server has described them */
	columns: Column[] | null;
	// What binary_columns() gives for `columns`, once they are known
	binary: { columns: Column[]; formats: number[] } | null;
	/** The serializer of each parameter, once `oids` are known */
	serializers: ((value: any) => unknown)[] | null;
	/** "parsing" until ParseComplete, then "ready"; "stale" once the statement's shape has changed */
	state: "parsing" | "ready" | "stale";
	/** The version of the statement's shape that the entry was described for; -1 until then */
	version: number;
};

/** Reads the row at `i` of DataRow `x`; compiled by compile() */
type RowReader = (x: Buffer, i: number) => unknown;

/** The row readers of one list of columns, compiled once rows of it have been read `after` times */
type Shape = {
	columns: Column[];
	/** How many times rows of these columns have been read */
	seen: number;
	/** The reader of a row as an object, once compiled */
	object: RowReader | null;
	/** The reader of a row as an array, once compiled */
	array: RowReader | null;
	/** Whether a reader can be compiled: not too many columns, none named __proto__, and compiling works */
	compilable: boolean;
};

/** What the pool gives a connection: the type registry's functions, and the pool's callbacks */
export type Events = Pick<
	ReturnType<typeof Types>,
	"parser" | "decoder" | "binary" | "serializer"
> & {
	// Method signatures: TypeScript checks their parameters bivariantly, so that the pool's callbacks
	// may take the Pooled connection that it made out of the Connection.
	/** Called once the connection may take queries again */
	onready(c: Connection): void;
	/** Called once the connection has closed; pool.ts's onclose() says what the arguments are */
	onclose(c: Connection, error: Failure, lease_error: Failure | null, orderly: boolean): void;
	onnotify: Options["onnotify"];
	onparameter: (key: string, value: string) => void;
	/** Called with how long the head of `sent` took, for the scheduler */
	ontimed: (sample: number, t: number) => void;
};

/** What describe() resolves with: the statement's parameter types and columns */
type Description = { params: number[]; columns: Column[] | null };

/** The `transform.value.from` of the options, or null for a raw() query */
type From = Options["transform"]["value"]["from"] | null;

/** A connection: what Connection() returns */
export type Connection = ReturnType<typeof Connection>;

export function Connection(ready: Ready, options: Options, events: Events) {
	const { socket } = ready,
		timers = options.timers,
		{ transform } = options,
		sent: Exchange[] = [],
		pending: Exchange[] = [],
		running = new Set<Query>(),
		open = new Set<Exchange>(),
		prepared = new Map<string, Entry>(),
		out = p.Writer(),
		frames = p.Frames(frame, socket.shared, abandon);

	let blocker: Exchange | null = null,
		rolling = false,
		// How many CancelRequests are in flight; until there are none, nothing more is written.
		cancelling = 0,
		// How many local exchanges wait for settle_soon() to settle them; they count as in flight.
		settling = 0,
		fence: Exchange | null = null,
		drained: (() => void) | null = null,
		status = ready.status,
		flushing = false,
		closed: ReturnType<typeof Errors.connection> | null = null,
		closing: Promise<void> | null = null,
		// Resolves `closing`.
		resolve_closing: (() => void) | null = null,
		// Whether destroy() was called. If it was called before the socket closed, `closed` gets the
		// code CONNECTION_DESTROYED; otherwise (also after close()), `closed` gets CONNECTION_CLOSED.
		destroyed = false,
		// Whether terminate() sent Terminate, which it does only with nothing in flight
		terminated = false,
		// A fatal error that came with no query to give it to: a broken frame, a frame that no
		// query asked for, or an ErrorResponse while nothing was in flight.
		connection_error: Failure | null = null,
		portals = 0,
		traced = 0,
		epoch = 0,
		headSince = 0;

	const connection = {
		id: ids++,
		host: ready.host,
		port: ready.port,
		backend: ready.backend,
		parameters: ready.parameters,
		prepared,
		lease: null as Lease | null,
		get status() {
			return status;
		},
		get inflight() {
			return sent.length + pending.length + settling;
		},
		/**
		 * Whether an exchange that must run alone, such as a cursor or a stream, is in flight, or a
		 * cancel request holds the connection (see `held`). The pool pipelines nothing onto an
		 * exclusive connection; a query from its lease (if it has one) is sent, and queues
		 */
		get exclusive() {
			return (!!blocker && exclusive(blocker)) || cancelling > 0;
		},
		/**
		 * Whether a cancel request holds the connection: until the server has handled the request,
		 * or the request has failed, the connection writes nothing more, so that the request cannot
		 * hit a later query (see hold())
		 */
		get held() {
			return cancelling > 0;
		},
		get copying() {
			return !!blocker && blocker.streaming && blocker.open;
		},
		get closed() {
			return closed;
		},
		get closing() {
			return !!closing;
		},
		send,
		simple,
		describe,
		local,
		cancel,
		close,
		destroy,
		ref: () => socket.ref(),
		unref: () => socket.unref(),
		backlog,
		costly,
	};

	socket.ondata = (x) => frames.push(x);
	socket.ondrain = ondrain;
	socket.onclose = onclose;
	if (ready.rest && ready.rest.length) {
		frames.push(ready.rest);
	}
	socket.resume();

	return connection;

	function ondrain() {
		const x = drained;
		drained = null;
		if (x) {
			x();
		}
	}

	function schedule(at_once?: boolean) {
		if (at_once || out.length >= 65536) {
			return flush();
		}

		if (!flushing) {
			flushing = true;
			process.nextTick(flush);
		}
		return true;
	}

	function flush() {
		flushing = false;
		if (closed) {
			out.take();
			return true;
		}

		return out.length ? socket.write(out.take()) : true;
	}

	function refresh() {
		if (blocker && !holds(blocker)) {
			blocker = null;
		}
		release();
	}

	function queue(x: Exchange) {
		if (closed) {
			settleError(x, copy_error(closed));
			return;
		}

		if (blocker && blocker.streaming && blocker.open) {
			settleError(x, Errors.generic("COPY_IN_PROGRESS", "You cannot execute queries during copy"));
			return;
		}

		if (x.query) {
			x.query.state = connection.backend;
		}
		if (fence) {
			pending.splice(pending.indexOf(fence), 0, x);
		} else if (x.ends && open.size) {
			pending.push((fence = x));
		} else if (blocker || cancelling || pending.length) {
			pending.push(x);
		} else {
			write(x);
			schedule();
			return;
		}

		release();
	}

	function release() {
		while (!blocker && pending.length && pending[0] !== fence) {
			// Before each write, because write() runs user code (a debug callback, a custom type's
			// serializer) that may cancel a query, and a cancel starts a hold
			if (cancelling) {
				break;
			}
			write(pending.shift());
		}

		schedule();
	}

	/**
	 * Settles local exchange `x` once the code that wrote it has returned, and then, unless the
	 * socket has closed meanwhile, calls notify_ready(), because no ReadyForQuery comes for an
	 * exchange that wrote nothing.
	 *
	 * @param x - a local exchange, with nothing in `sent` ahead of it
	 */
	function settle_soon(x: Exchange) {
		settling++;
		queueMicrotask(() => {
			settling--;
			settle(x);
			if (!closed) {
				notify_ready();
			}
		});
	}

	function write(x: Exchange) {
		const mark = out.length;
		let result;
		try {
			result = x.write(x);
		} catch (error) {
			x.own = as_error(error);
			result = skip;
		}
		if (result === skip) {
			out.truncate(mark);
			x.fresh = null;
			x.parses = [];
			x.portal = "";
			x.describing = x.synced = x.flushing = x.open = false;
			if (!x.own || x.kind === "step" || !connection.lease) {
				x.kind = "local";
				x.cost = undefined;
				if (sent.length === 0) {
					settle_soon(x);
				} else {
					sent.push(x);
				}
				return;
			}

			x.kind = "simple";
			x.text = refused;
			x.results = [];
			x.entry = null;
			sync(x, true);
		}
		if (x.fresh) {
			register(x.fresh);
		}
		if (x.portal && x.kind === "query") {
			open.add(x);
		}
		if (x.query) {
			x.query.active = sent.length === 0;
		}
		if (x.ends) {
			epoch++;
		}
		x.epoch = epoch;
		if (options.scheduler && sent.length === 0) {
			headSince = timers.now();
		}
		sent.push(x);
		if (holds(x)) {
			blocker = x;
		}
		if (x.trace) {
			wrote(x);
		}
	}

	function sync(x: Exchange, refuse?: boolean) {
		if (x.synced) {
			return;
		}

		x.synced = true;
		if (refuse) {
			p.query(out, refused);
		} else {
			p.sync(out);
		}
		schedule();
	}

	function register(entry: Entry) {
		const current = prepared.get(entry.name);
		if (current) {
			prepared.delete(entry.name);
		}
		prepared.set(entry.name, entry);
		entry.owner.entry = entry;
		entry.owner.fresh = null;
		if (prepared.size <= limit) {
			return;
		}

		for (const [name, x] of prepared) {
			if (x.state !== "parsing") {
				prepared.delete(name);
				p.close(out, "S", name);
				return;
			}
		}
	}

	function drop(entry: Entry) {
		if (prepared.get(entry.name) === entry) {
			prepared.delete(entry.name);
		}
	}

	function send(query: Query) {
		const { statement } = query.wire,
			x = Exchange("query", query, connection.lease, extended);

		x.statement = statement;
		x.ends =
			statement.ends === undefined
				? (statement.ends = ending.test(statement.text))
				: statement.ends;
		if (options.scheduler) {
			cost(x);
		}
		queue(x);
	}

	function timed(x: Exchange) {
		const t = timers.now();

		if (x.cost !== undefined) {
			const sample = t - headSince,
				c = x.query.cost;
			c.est = c.est === undefined || sample > c.est ? sample : c.est + (sample - c.est) * 0.1;
			if (events.ontimed) {
				events.ontimed(sample, t);
			}
		}

		headSince = t;
	}

	function backlog(t: number) {
		let w = 0;
		for (let i = 0; i < sent.length; i++) {
			const e = sent[i].cost || 0;
			if (i === 0) {
				const elapsed = t - headSince;
				w += elapsed < e ? e - elapsed : elapsed;
			} else {
				w += e;
			}
		}

		for (let i = 0; i < pending.length; i++) {
			w += pending[i].cost || 0;
		}

		return w;
	}

	/**
	 * Whether some exchange in `sent` or `pending` has a `cost` of at least `ms`: an estimate, made
	 * when its query was sent, of the milliseconds that the whole exchange takes (`unknown` if there
	 * was no estimate yet). The time that an exchange has already run is not subtracted.
	 */
	function costly(ms: number) {
		for (let i = 0; i < sent.length; i++) {
			if (sent[i].cost >= ms) {
				return true;
			}
		}

		for (let i = 0; i < pending.length; i++) {
			if (pending[i].cost >= ms) {
				return true;
			}
		}

		return false;
	}

	function extended(x: Exchange) {
		const { query } = x,
			{ built } = query.wire,
			statement = x.statement,
			name = statement.name,
			current = name ? prepared.get(name) : null;

		if (query.cursorFn) {
			x.rows = query.cursorRows;
			x.portal = transaction() ? "c" + portals++ : "";
			x.flushing = !x.portal;
		}

		x.streaming = x.open = query.streaming;

		if (current && current.state === "parsing" && current.oids === null) {
			throw Errors.generic(
				"STATEMENT_PENDING",
				"A statement was used before its description arrived",
			);
		}

		if (current && current !== x.previous && usable(current, statement)) {
			// raw() gets the bytes of the text
			const binary = query.isRaw === true ? null : current.binary;
			x.entry = current;
			x.columns = binary ? binary.columns : current.columns;
			x.formats = binary ? binary.formats : null;
			x.values = serialize(current.oids, built, current);
			return run(x, name);
		}

		if (x.retried) {
			x.verify = true;
			p.parse(out, "", statement.text, built.oids);
			p.describe(out, "S", "");
			p.flush(out);
			x.describing = true;
			return;
		}

		const typed = !inferred(built);
		if (name) {
			x.fresh = Entry(name, x, typed ? built.oids : null);
		}
		if (current) {
			p.close(out, "S", name);
		}
		parse(x, name, statement.text, built.oids);
		p.describe(out, "S", name);

		if (!typed) {
			p.flush(out);
			x.describing = true;
			return;
		}

		x.learn = true;
		x.values = serialize(built.oids, built, x.fresh || {});
		run(x, name);
	}

	function parse(x: Exchange, name: string, query_text: string, oids: number[]) {
		p.parse(out, name, query_text, oids);
		x.parses.push(name);
	}

	function run(x: Exchange, name: string) {
		const mark = out.length;
		try {
			p.run(out, x.portal, name, x.values, x.rows, x.flushing, x.formats);
		} catch (error) {
			out.truncate(mark);
			throw error;
		}
		if (!x.flushing) {
			x.synced = true;
		}
		debug(x.statement.text, x.values, x.entry ? x.entry.oids : x.params || x.query.wire.built.oids);
	}

	function learned(entry: Entry, statement: Statement) {
		const shape = entry.oids.join() + ":" + entry.columns.map((x) => x.type).join();
		if (statement.shape !== shape) {
			if (statement.shape !== undefined) {
				statement.version++;
			}
			statement.shape = shape;
		}
		entry.version = statement.version;
		entry.binary = binary_columns(entry.columns);
	}

	/**
	 * @param columns - the columns of a prepared statement, as RowDescription describes them
	 * @returns for the queries that run the statement: the columns, with a decoder of the binary
	 *   format for each column that is read in binary, and the result format of each column for
	 *   Bind (1 for binary, 0 for text); or null, if no column is read in binary
	 */
	function binary_columns(columns: Column[]) {
		let binary: Column[] | null = null,
			formats: number[] | null = null;
		for (let i = 0; i < columns.length; i++) {
			// The parser that the column has as text, so that the decoder gives what it would
			const decode = events.binary(columns[i].type, columns[i].parser);
			if (decode) {
				binary = binary || columns.slice();
				formats = formats || columns.map(() => 0);
				binary[i] = { ...columns[i], decode };
				formats[i] = 1;
			}
		}
		return binary && { columns: binary, formats };
	}

	/**
	 * @param cache - the statement's entry, whose `serializers` are kept, or an object that is dropped
	 */
	function serialize(oids: number[], built: Built, cache: { serializers?: Serializer[] | null }) {
		const serializers = cache.serializers || (cache.serializers = oids.map(events.serializer)),
			values = built.values,
			serialized = new Array<Value>(values.length);

		for (let i = 0; i < values.length; i++) {
			serialized[i] = values[i] === null ? null : (serializers[i](values[i]) as Value);
			if (
				serialized[i] !== null &&
				serialized[i] !== undefined &&
				typeof serialized[i] !== "string" &&
				!(serialized[i] instanceof Uint8Array)
			) {
				// A serializer must return a string or bytes. For anything else, Buffer.byteLength
				// throws here, where the error is this query's, instead of the writer corrupting the
				// wire later
				Buffer.byteLength(serialized[i]);
			}
		}

		return serialized;
	}

	function transaction() {
		return !!connection.lease && connection.lease.kind === "transaction";
	}

	function described(x: Exchange) {
		x.describing = false;
		const { built } = x.query.wire,
			name = x.statement.name,
			params = x.params || [],
			columns = x.columns || [];

		try {
			if (x.verify) {
				const previous = x.previous;
				if (previous && same(previous, params, columns)) {
					if (x.original) {
						x.own = x.original;
						return sync(x);
					}
				} else if (previous) {
					stale(previous);
					x.statement.version++;
				}
				x.values = serialize(params, built, {});
				return run(x, "");
			}
			const entry = x.entry;
			if (entry) {
				entry.oids = params;
				entry.columns = columns;
				learned(entry, x.statement);
			}
			x.values = serialize(params, built, entry || {});
			run(x, name);
		} catch (error) {
			x.own = as_error(error);
			sync(x, !!connection.lease);
		}
	}

	function describe(statement: { text: string }, oids: number[]) {
		return new Promise<Description>((resolve, reject) => {
			const x = Exchange("describe", null, connection.lease, (item) => {
				p.parse(out, "", statement.text, oids);
				p.describe(out, "S", "");
				sync(item);
			});
			x.resolve = resolve;
			x.reject = reject;
			queue(x);
		});
	}

	function simple(query: Query, sql: string) {
		const x = Exchange("simple", query, connection.lease, (item) => {
			debug(sql, [], []);
			p.query(out, sql);
			item.synced = true;
		});
		x.text = sql;
		x.results = [];
		x.ends = ending.test(sql);
		x.streaming = x.open = query.streaming;
		if (options.scheduler) {
			cost(x);
		}
		queue(x);
	}

	function local(query: Query, error: Error) {
		queue(
			Exchange("query", query, connection.lease, () => {
				throw error;
			}),
		);
	}

	/**
	 * Sends a CancelRequest for exchange `x`, the head of `sent`, unless one is in
	 * flight already, and writes nothing more on this connection until the server
	 * has closed the cancel connection. PostgreSQL drops a cancel that reaches a backend waiting for its
	 * next command, so the cancel can't hit a query written after that.
	 *
	 * @returns a promise that settles as the CancelRequest does
	 */
	function stop(x: Exchange) {
		// A cancel request for anything else would hit whatever the backend runs next
		if (sent[0] !== x) {
			const i = sent.indexOf(x);
			const got = i === -1 ? "an exchange that is not in sent" : "sent[" + i + "]";
			throw new Error("Bug: stop() needs sent[0], but got " + got);
		}
		if (!x.stopping) {
			x.stopped = true;
			x.stopping = ready.cancel();
			// The server drops a cancel request that arrives between two messages of an
			// exchange, so a later call sends another. Before the hold, which may make
			// the connection write again
			const settled = () => {
				x.stopping = null;
			};
			x.stopping.then(settled, settled);
			hold(x.stopping);
		}
		return x.stopping;
	}

	/**
	 * Writes nothing more on this connection until `promise` settles, and the pool
	 * sends it no queries meanwhile. Then the connection writes what waits in
	 * `pending`, and tells the pool that it can take queries again.
	 *
	 * If `promise` rejects with CONNECT_TIMEOUT, the cancel request may still reach
	 * the server and cancel whatever the backend runs then, so the connection
	 * closes instead, and writes nothing more.
	 *
	 * @param promise settles once a cancel request has been handled, or has failed
	 */
	function hold(promise: Promise<unknown>) {
		const done = () => {
			cancelling--;
			if (cancelling === 0 && !closed) {
				release();
				notify_ready();
			}
		};
		cancelling++;
		promise.then(done, (error) => {
			if (error?.code === "CONNECT_TIMEOUT") {
				abandon(error);
			} else {
				done();
			}
		});
	}

	/**
	 * Stops the COPY of exchange `x`, the head of `sent`, as the protocol allows.
	 * COPY FROM and COPY BOTH stop with CopyFail and CopyDone, because the server
	 * holds back a cancel request while it waits for COPY data. COPY TO stops only
	 * with a cancel request. A COPY TO stream, or a stream still sending, fails with
	 * `Errors.canceled()` right away.
	 *
	 * @returns a promise that settles once the stop has been sent
	 */
	function cancel_copy(x: Exchange) {
		if (x.copy === "out") {
			// Also once the COPY data has ended, since statements after the COPY in the same
			// query may still run. Before the destroy, so that the hold also covers what resuming the socket finishes
			const stopped = stop(x);
			if (x.stream) {
				x.stream.destroy(Errors.canceled());
			}
			return stopped;
		}
		if (x.stream && !x.copied) {
			x.stream.destroy(Errors.canceled());
			return Promise.resolve();
		}
		return stop(x);
	}

	function cancel(query: Query) {
		if (running.has(query) || (sent[0] && sent[0].query === query && sent[0].awaiting)) {
			query.aborted = Errors.canceled();
			return Promise.resolve();
		}
		const i = pending.findIndex((x) => x.query === query);

		if (i !== -1) {
			const [x] = pending.splice(i, 1);
			if (x === fence) {
				fence = null;
			}
			settleError(x, Errors.canceled());
			release();
			return Promise.resolve();
		}

		const x = sent.find((item) => item.query === query);
		// A local exchange wrote nothing, and fails with its own error
		if (!x || x.kind === "local") {
			return Promise.resolve();
		}

		if (x !== sent[0]) {
			// Settled once `x` is the head and its cancel request has been handled, or once the
			// connection closes; every call gets the same promise. Until then nothing more is
			// written, since the cancel request could hit it.
			if (!x.cancel) {
				x.cancel = Promise.withResolvers<void>();
				hold(x.cancel.promise);
			}
			return x.cancel.promise;
		}
		return x.copy ? cancel_copy(x) : stop(x);
	}

	function close() {
		if (!closing) {
			closing = new Promise<void>((r) => {
				resolve_closing = r;
			});
			finish_closing();
		}
		return closing;
	}

	/**
	 * @returns whether no exchange waits to be written, waits for its ReadyForQuery, or waits for
	 *   settle_soon(). A cancel request in flight, and a cursor whose callback runs between two of
	 *   its steps, do not count.
	 */
	function idle() {
		return connection.inflight === 0;
	}

	/**
	 * If close() was called, and destroy() was not: sends Terminate once idle() is true, or, if
	 * the socket has closed already, resolves the promise that close() returned.
	 */
	function finish_closing() {
		if (closing && !destroyed && (closed || idle())) {
			terminate();
		}
	}

	/**
	 * Tells the pool that the connection may take queries again, after the end of an exchange or
	 * of a cancel request's hold; first calls finish_closing().
	 */
	function notify_ready() {
		finish_closing();
		events.onready(connection);
	}

	function terminate() {
		if (closed) {
			if (resolve_closing) {
				resolve_closing();
			}
			return;
		}
		if (terminated) {
			return;
		}

		flush();
		terminated = true;
		socket.end(p.Terminate());
	}

	function destroy() {
		destroyed = true;
		if (!closing) {
			closing = Promise.resolve();
		}
		socket.destroy();
	}

	/**
	 * Destroys the socket because of an error that came with no query to give it to.
	 *
	 * @param error - the error, which becomes the cause of `closed`
	 */
	function abandon(error: Failure) {
		connection_error = error;
		socket.destroy();
	}

	function onclose(error: Error | null) {
		if (closed) {
			return;
		}

		out.take();
		blocker = null;
		fence = null;
		const orderly = terminated && idle(),
			head = sent[0],
			fatal =
				connection_error || (head && head.error && head.error.severity === "FATAL" && head.error);
		closed = Errors.connection(
			destroyed ? "CONNECTION_DESTROYED" : "CONNECTION_CLOSED",
			options,
			ready.host,
			ready.port,
		);
		closed.cause = fatal || error || undefined;
		// A FATAL error that came with no query to give it to, such as from
		// idle_in_transaction_session_timeout, is what ended the lease (if any)
		let lease_error =
			connection_error && connection_error.severity === "FATAL" ? connection_error : null;
		sent.splice(0).forEach((x) => {
			// The query fails with `closed`, so there is nothing left to cancel
			if (x.cancel) {
				x.cancel.resolve();
			}
			if (x.stream) {
				x.stream.destroy(closed);
			}
			if (x.own) {
				settle(x);
				// The lease (if any) rejects with the FATAL error that answered its head, as below
				if (x === head && lease_error === null && x.error === fatal && !x.ends) {
					lease_error = x.error;
				}
				return;
			}
			// The head's own FATAL error is copied too, because it may be `closed.cause`, which every
			// copy of `closed` shares
			const reason = x === head && x.error && x.error.severity === "FATAL" ? x.error : closed,
				copied = copy_error(reason);
			// settleError adds x's query to `copied`
			settleError(x, copied);
			// Otherwise the lease rejects with the head's error, the head being the lease's own query.
			// Not with a FATAL error for a statement that ends a transaction (such as COMMIT), which
			// the server may have committed: then the lease rejects with `closed`, whose cause it is.
			if (
				x === head &&
				lease_error === null &&
				(reason === closed || (reason === fatal && !x.ends))
			) {
				lease_error = copied;
			}
		});
		pending.splice(0).forEach((x) => (x.own ? settle(x) : settleError(x, copy_error(closed))));
		running.forEach((query) => query.settled || query.reject(decorate(query, copy_error(closed))));
		running.clear();
		open.clear();
		if (resolve_closing) {
			resolve_closing();
		}
		events.onclose(connection, closed, lease_error, orderly);
	}

	function decorate(query: Query, error: unknown) {
		return queryError(error, query, options.debug);
	}

	function settleError(x: Exchange, error: Error) {
		if (x.kind === "describe") {
			x.reject(error);
		} else if (x.query && !x.query.settled) {
			x.query.reject(decorate(x.query, error));
		}
	}

	function debug(query_text: string, values: Value[] | null, oids: number[] | null) {
		if (typeof options.debug === "function") {
			options.debug(connection.id, query_text, values, oids);
		}
	}

	function wrote(x: Exchange) {
		const trace = x.trace;
		traced++;
		trace.query = x.text || x.statement.text;
		trace.statement = x.statement ? x.statement.name : "";
		trace.parameters = options.debug ? x.query.parameters : undefined;
		trace.connection = connection.id;
		trace.host = connection.host;
		trace.port = connection.port;
		trace.sent = now();
	}

	function first() {
		const x = sent[0];
		if (x && x.trace && x.trace.firstByte === null) {
			x.trace.firstByte = now();
		}
	}

	function frame(type: number, x: Buffer, start: number, end: number) {
		if (traced) {
			first();
		}
		try {
			switch (type) {
				case 68:
					DataRow(x, start);
					break;
				case 100:
					CopyData(x, start, end);
					break;
				case 90:
					ReadyForQuery(x, start);
					break;
				case 67:
					CommandComplete(x, start, end);
					break;
				case 50:
					BindComplete();
					break;
				case 49:
					ParseComplete();
					break;
				case 51:
					// CloseComplete: nothing to do
					break;
				case 116:
					ParameterDescription(x, start);
					break;
				case 84:
					RowDescription(x, start);
					break;
				case 110:
					NoData();
					break;
				case 69:
					ErrorResponse(x, start, end);
					break;
				case 115:
					PortalSuspended();
					break;
				case 73:
					EmptyQueryResponse();
					break;
				case 65:
					NotificationResponse(x, start);
					break;
				case 78:
					NoticeResponse(x, start, end);
					break;
				case 83:
					ParameterStatus(x, start);
					break;
				case 71:
					CopyInResponse();
					break;
				case 72:
					CopyOutResponse();
					break;
				case 87:
					CopyBothResponse();
					break;
				case 99:
					CopyDone();
					break;
				case 86:
					unsupported("FunctionCallResponse");
					break;
				case 118:
					unsupported("NegotiateProtocolVersion");
					break;
			}
		} catch (error) {
			const item = sent[0];
			if (item) {
				fail(item, as_error(error));
			} else {
				abandon(as_error(error));
			}
		}
		if (blocker && !holds(blocker)) {
			blocker = null;
			release();
		}
		if (out.length) {
			schedule();
		}
	}

	function fail(x: Exchange, error: Failure) {
		x.error = x.error || error;
		x.describing = false;
		x.open = false;
		sync(x);
	}

	function unsupported(x: string) {
		if (sent[0]) {
			fail(sent[0], Errors.notSupported(x));
		}
	}

	function ParseComplete() {
		const x = sent[0],
			name = x.parses.shift();

		if (
			name &&
			x.entry &&
			x.entry.name === name &&
			x.entry.owner === x &&
			x.entry.state === "parsing"
		) {
			x.entry.state = "ready";
		}
	}

	function BindComplete() {
		const x = sent[0];
		x.bound = true;
		if (!x.columns && x.entry) {
			x.columns = x.entry.columns;
			x.result.columns = x.columns;
		}
	}

	function ParameterDescription(x: Buffer, start: number) {
		sent[0].params = p.parameterDescription(x, start);
	}

	function RowDescription(x: Buffer, start: number) {
		received(sent[0], p.rowDescription(x, start, 0, column));
	}

	function NoData() {
		received(sent[0], []);
	}

	function received(x: Exchange, columns: Column[]) {
		if (x.kind === "simple" && x.result.command !== null) {
			x.results.push(x.result);
			x.result = new Result();
		}
		x.columns = columns;
		x.result.columns = columns;
		if (x.learn) {
			x.learn = false;
			if (x.entry && x.entry.owner === x) {
				x.entry.columns = columns;
				learned(x.entry, x.statement);
			}
		}
		if (x.describing) {
			described(x);
		}
	}

	function column(name: string, table: number, number: number, type: number): Column {
		const parser = events.parser(type);
		return {
			name: transform.column.from ? transform.column.from(name) : name,
			parser: parser.identity ? null : parser,
			decode: events.decoder(type, parser),
			table,
			number,
			type,
		};
	}

	function DataRow(x: Buffer, start: number) {
		const item = sent[0],
			{ query, columns } = item,
			raw = query.isRaw,
			from = raw !== true ? transform.value.from : null;
		if (item.shaped !== columns) {
			item.shaped = columns;
			item.reader = Rows(columns);
		}
		const shape = item.reader,
			fast = raw !== true && read(shape, !!raw, from),
			n = columns.length,
			result = item.result;

		// An object or an array of the user's values: any shape
		let row: any;
		if (fast) {
			row = fast(x, start + 7);
		} else {
			row = raw ? new Array(n) : {};
			let i = start + 7;
			for (let j = 0; j < n; j++) {
				const length = (x[i] << 24) | (x[i + 1] << 16) | (x[i + 2] << 8) | x[i + 3],
					col = columns[j];
				i += 4;
				let value = null;
				if (length !== -1) {
					value =
						raw === true
							? Buffer.from(x.subarray(i, i + length))
							: col.decode
								? col.decode(x, i, i + length)
								: col.parser
									? col.parser(text(x, i, i + length))
									: text(x, i, i + length);
					i += length;
				}
				if (from) {
					value = from(value, col);
				}
				if (raw) {
					row[j] = value;
				} else if (col.name === "__proto__") {
					own(row, col.name, value);
				} else {
					row[col.name] = value;
				}
			}
		}

		const transformed = transform.row.from ? transform.row.from(row) : row;
		if (query.forEachFn) {
			query.forEachFn(transformed, result);
		} else {
			result[result.length] = transformed;
		}
	}

	function CommandComplete(x: Buffer, start: number, end: number) {
		const item = sent[0],
			{ command, count } = p.commandComplete(x, start, end),
			result = item.result;

		result.command = command;
		result.count = count;
		result.state = connection.backend;
		result.statement = item;
		if (item.query) {
			item.query.source = item;
		}
		result.columns = result.columns || item.columns;

		if (item.final) {
			if (item.stream) {
				Object.assign(item.stream, { count, command });
			}
			item.final();
			item.final = null;
		}

		if (item.kind === "simple") {
			item.results.push(item.result);
			item.result = new Result();
			return;
		}

		if (item.rows) {
			item.finished = true;
			if (item.flushing) {
				sync(item);
			}
			if (result.count) {
				(item.last = new Promise((r) => r(item.query.cursorFn(result)))).catch(noop);
			}
		}
	}

	function unsafe(item: Exchange) {
		rolling = true;
		item.own = unsafe_transaction();
		for (const x of sent) {
			if (x.kind !== "local") {
				x.own = unsafe_transaction();
			}
		}
		pending.unshift(
			Exchange("internal", null, null, (x) => {
				p.query(out, "rollback");
				x.synced = true;
			}),
		);
	}

	function EmptyQueryResponse() {
		const item = sent[0];
		if (item.kind === "simple") {
			item.results.push(item.result);
			item.result = new Result();
		}
	}

	function PortalSuspended() {
		const item = sent[0];
		if (!item.flushing) {
			item.suspended = true;
			return;
		}
		void resume(item);
	}

	/**
	 * Gives the cursor's callback the rows of exchange `item`, the head of `sent`, and then, by
	 * what the callback returned, fetches the next rows or closes the portal. Async, so its errors
	 * cannot reach frame()'s catch: it fails `item` with them itself.
	 */
	async function resume(item: Exchange) {
		try {
			item.awaiting = true;
			const next = await item.query.cursorFn(item.result);
			item.awaiting = false;
			item.result = new Result();
			if (closed || item.synced || sent[0] !== item) {
				return;
			}
			if (item.query.aborted) {
				throw item.query.aborted;
			}
			if (next === CLOSE) {
				p.close(out, "P", "");
				sync(item);
			} else {
				p.execute(out, "", item.rows);
				p.flush(out);
				schedule();
			}
		} catch (error) {
			item.awaiting = false;
			if (closed || item.synced || sent[0] !== item) {
				return;
			}
			fail(item, as_error(error));
		}

		refresh();
	}

	function ErrorResponse(x: Buffer, start: number, end: number) {
		const item = sent[0],
			error = Errors.postgres(p.error(x, start, end));

		if (!item) {
			connection_error = error;
			return;
		}

		// First, so that the stream's destroy knows that the server has already failed the COPY
		fail(item, error);
		if (item.stream) {
			item.stream.destroy(error);
		}
		if (item.final) {
			item.final(error);
			item.final = null;
		}
	}

	function ReadyForQuery(x: Buffer, start: number) {
		status = p.readyForQuery(x, start);
		frames.own(false);
		const item = sent.shift();
		if (options.scheduler) {
			timed(item);
		}
		item.done = true;
		item.open = false;
		if (item.trace) {
			traced--;
		}
		if (item.kind === "internal") {
			rolling = false;
		}
		if (status !== "I" && !rolling && !item.lease && !connection.lease && options.max !== 1) {
			unsafe(item);
		}
		if (blocker === item) {
			blocker = null;
		}
		settle(item);
		// So that the cached statement no longer keeps the query that prepared it, with its values
		// and rows
		if (item.entry && item.entry.owner === item) {
			item.entry.owner = null;
		}
		while (sent.length && sent[0].kind === "local") {
			settle(sent.shift());
		}
		const next = sent[0];
		if (next && next.query) {
			next.query.active = true;
			if (next.cancel) {
				stop(next).then(() => next.cancel.resolve(), next.cancel.reject);
			}
		}
		release();

		notify_ready();
	}

	function settle(x: Exchange) {
		if (x.kind === "internal") {
			return;
		}

		if (x.kind === "describe") {
			if (x.error) {
				x.reject(x.error);
			} else {
				x.resolve({ params: x.params || [], columns: x.columns });
			}
			return;
		}

		const { query } = x,
			cursor = x.origin || (x.portal ? x : null);
		if (cursor && (x.own || x.error || !x.suspended)) {
			unfence(cursor);
		}

		if (x.own) {
			query.reject(decorate(query, x.own));
			return;
		}

		if (x.error) {
			failed(x);
			return;
		}

		if (x.suspended) {
			suspended(x);
			return;
		}

		if (x.last) {
			x.last.then(
				() => query.settled || finish(x),
				(error) => query.settled || query.reject(decorate(query, error)),
			);
		} else if (!query.settled) {
			finish(x);
		}
	}

	function unfence(cursor: Exchange) {
		if (!open.delete(cursor) || open.size || !fence) {
			return;
		}
		fence = null;
		release();
	}

	function failed(x: Exchange) {
		const entry = x.kind === "query" ? x.entry : null;
		const parsing = x.fresh || (entry && entry.owner === x && entry.state === "parsing");

		if (x.error.code === "42P05" && x.kind === "query" && x.statement.name && parsing) {
			if (entry) {
				drop(entry);
			}
			x.statement.name += "_";
			again_or_fail(x);
			return;
		}

		if (!entry) {
			settleError(x, x.error);
			return;
		}

		if (entry.owner === x && entry.state === "parsing") {
			drop(entry);
			settleError(x, x.error);
			return;
		}

		if (x.error.code === "26000") {
			drop(entry);
			again_or_fail(x);
			return;
		}

		if (x.bound) {
			settleError(x, x.error);
			return;
		}

		if (retryable(x)) {
			again(x, x.error);
			return;
		}

		stale(entry);
		settleError(x, x.error);
	}

	/** Runs `x` again if it can be run again (see `retryable`), and otherwise fails it with its error */
	function again_or_fail(x: Exchange) {
		if (retryable(x)) {
			again(x, null);
		} else {
			settleError(x, x.error);
		}
	}

	function stale(entry: Entry) {
		if (prepared.get(entry.name) === entry) {
			entry.state = "stale";
		}
	}

	function retryable(x: Exchange) {
		return (
			!x.retried &&
			!x.stopped &&
			!x.query.cancelled &&
			!x.query.cursorFn &&
			!x.streaming &&
			x.lease === connection.lease &&
			status === "I" &&
			!closing &&
			(sent.length === 0 || (!x.lease && options.max !== 1))
		);
	}

	function again(x: Exchange, original: Failure | null) {
		const retry = Exchange("query", x.query, x.lease, extended);
		retry.statement = x.statement;
		retry.ends = x.ends;
		retry.retried = true;
		retry.original = original;
		retry.previous = x.entry;
		retry.trace = x.trace;
		retry.cost = x.cost;

		if (sent.length) {
			queue(retry);
			return;
		}

		pending.unshift(retry);
		release();
	}

	function suspended(x: Exchange) {
		const cursor = x.origin || x,
			{ query } = x;

		running.add(query);

		new Promise((r) => r(query.cursorFn(x.result))).then(
			(next) => {
				running.delete(query);
				if (query.settled) {
					return unfence(cursor);
				}
				queue(step(cursor, next === CLOSE || !!query.aborted, query.aborted || null));
			},
			(error) => {
				running.delete(query);
				if (query.settled) {
					return unfence(cursor);
				}
				queue(step(cursor, true, error));
			},
		);
	}

	function step(cursor: Exchange, end: boolean, failure: Failure | null) {
		const x = Exchange("step", cursor.query, cursor.lease, stepped);
		x.origin = cursor;
		x.statement = cursor.statement;
		x.entry = cursor.entry;
		x.columns = cursor.columns;
		x.portal = cursor.portal;
		x.rows = cursor.rows;
		x.end = end;
		x.failure = failure;
		return x;
	}

	/**
	 * Writes a step of a cursor: an Execute of its portal, or a Close once the cursor ends.
	 * @returns `skip` (and writes nothing) when the cursor's transaction has ended and the step
	 *   only closes the cursor; otherwise null
	 * @throws the step's failure, or UNSAFE_TRANSACTION for a step that would read from a cursor
	 *   whose transaction has ended
	 */
	function stepped(x: Exchange) {
		const cursor = x.origin;

		if (connection.lease !== cursor.lease || cursor.epoch !== epoch) {
			if (x.failure) {
				throw x.failure;
			}
			if (!x.end) {
				throw outlived();
			}
			return skip;
		}

		x.own = x.failure;
		if (x.end) {
			p.close(out, "P", x.portal);
		} else {
			p.execute(out, x.portal, x.rows);
		}
		sync(x);
		return null;
	}

	function NotificationResponse(x: Buffer, start: number) {
		const { pid, channel, payload } = p.notification(x, start);
		if (events.onnotify) {
			guard(events.onnotify, channel, payload, pid);
		}
	}

	function NoticeResponse(x: Buffer, start: number, end: number) {
		const notice = p.error(x, start, end);
		if (listened(channels.notice)) {
			channels.notice.publish({
				notice,
				connection: connection.id,
				host: connection.host,
				port: connection.port,
				database: options.database,
			});
		}
		if (options.onnotice) {
			guard(options.onnotice, notice);
		} else if (options.onnotice !== false) {
			// oxlint-disable-next-line no-console -- the default onnotice prints to stdout, as documented
			console.log(notice);
		}
	}

	function ParameterStatus(x: Buffer, start: number) {
		const [k, v] = p.parameterStatus(x, start);
		connection.parameters[k] = v;
		if (events.onparameter) {
			guard(events.onparameter, k, v);
		}
	}

	/** Resumes reading the socket, if a COPY stream's back-pressure paused it. */
	function unpause() {
		if (!frames.paused) {
			return;
		}
		frames.resume();
		if (!frames.paused) {
			socket.resume();
		}
	}

	/**
	 * @returns whether the COPY of exchange `item` is still in progress: `item` is the
	 * head of `sent` (which is empty once the connection has closed), and its
	 * stream is still attached
	 */
	function in_progress(item: Exchange) {
		return !!item.stream && sent[0] === item;
	}

	/**
	 * @returns whether destroying the COPY TO stream of exchange `item` should also
	 * cancel the COPY. A cancel request aborts the transaction block that the COPY
	 * runs in, also one begun earlier in the same query, and it can hit a query
	 * written behind the COPY, so only a COPY in progress that is the first
	 * statement of its query, outside a transaction block, and alone on the wire.
	 */
	function cancellable(item: Exchange) {
		return (
			in_progress(item) &&
			status === "I" &&
			!item.error &&
			!(item.results && item.results.length) &&
			sent.length === 1
		);
	}

	/**
	 * Detaches a destroyed COPY stream from its exchange. If that COPY is still in
	 * progress, the connection then reads the socket again and drops any further
	 * COPY data, instead of waiting for the stream to ask for more.
	 *
	 * @param item the exchange whose COPY the stream belonged to
	 */
	function discard(item: Exchange) {
		const reading = in_progress(item);
		item.stream = null;
		if (reading) {
			frames.own(false);
			unpause();
		}
	}

	/**
	 * Ends the COPY FROM or COPY BOTH of exchange `item` before all of its data has
	 * been sent. A COPY FROM ends with CopyFail, which makes the server fail the COPY
	 * with `message`. A COPY BOTH ends with CopyDone, because walsender, the server
	 * of COPY BOTH, takes CopyFail as a FATAL error.
	 */
	function end_copy(item: Exchange, message: string) {
		if (item.copy === "both") {
			p.copyDone(out);
		} else {
			p.copyFail(out, message);
		}
		item.copied = true;
		item.open = false;
		schedule(true);
	}

	function writeData(chunk: Buffer | string, callback: () => void) {
		p.copyData(out, chunk);
		if (flush()) {
			callback();
		} else {
			drained = callback;
		}
	}

	function writable(item: Exchange): Stream.WritableOptions {
		return {
			autoDestroy: true,
			write(chunk, encoding, callback) {
				writeData(chunk, callback);
			},
			destroy(error, callback) {
				callback(error);
				discard(item);
				if (!item.copied && !closed && !item.error) {
					end_copy(item, (error || "The COPY stream was destroyed") + "");
					refresh();
				}
			},
			final(callback) {
				p.copyDone(out);
				item.copied = true;
				item.open = false;
				item.final = callback;
				schedule(true);
				refresh();
			},
		};
	}

	function CopyInResponse() {
		const item = sent[0];
		item.copy = "in";
		// The server holds back a cancel request while it waits for COPY data, so a
		// cancelled COPY FROM ends with CopyFail
		if (item.stopped) {
			return end_copy(item, "canceling statement due to user request");
		}
		item.stream = new Stream.Writable(writable(item));
		item.query.resolve(item.stream);
	}

	function readable(item: Exchange) {
		return () => {
			item.wanted = true;
			unpause();
		};
	}

	function CopyOutResponse() {
		const item = sent[0];
		item.copy = "out";
		item.stream = new Stream.Readable({
			read: readable(item),
			destroy(error, callback) {
				// Before the discard, so that the hold of the cancel also covers what resuming the
				// socket finishes: the end of this COPY, and the release of the next query
				if (cancellable(item)) {
					stop(item).catch(noop);
				}
				discard(item);
				callback(error);
			},
		});
		item.open = false;
		frames.own(true);
		item.query.resolve(item.stream);
	}

	function CopyBothResponse() {
		const item = sent[0];
		item.copy = "both";
		// The server holds back a cancel request while it waits for COPY data, so a
		// cancelled COPY BOTH ends with CopyDone, which fails nothing
		if (item.stopped) {
			item.error = item.error || Errors.canceled();
			return end_copy(item, "canceling statement due to user request");
		}
		item.stream = new Stream.Duplex({ ...writable(item), read: readable(item) });
		frames.own(true);
		item.query.resolve(item.stream);
	}

	function CopyData(x: Buffer, start: number, end: number) {
		const item = sent[0];

		if (!item.stream) {
			return;
		}

		item.wanted = false;
		if (
			!(item.stream as Stream.Readable).push(
				frames.owns(x) ? x.subarray(start + 5, end) : Buffer.from(x.subarray(start + 5, end)),
			) &&
			!item.wanted
		) {
			frames.pause();
			socket.pause();
		}
	}

	function CopyDone() {
		frames.own(false);
		const item = sent[0];
		if (item.stream) {
			(item.stream as Stream.Readable).push(null);
		}
		item.stream = null;
	}
}

/** @returns the error for a query that left a transaction open on a pooled connection */
function unsafe_transaction() {
	return Errors.generic("UNSAFE_TRANSACTION", "Only use sql.begin, sql.reserved or max: 1");
}

/**
 * @returns whether nothing may be written behind exchange `x` yet. A COPY holds
 * the connection until its ReadyForQuery, so that no query waits behind a slow
 * reader of its stream, and so that cancelling it can't hit another query.
 */
function holds(x: Exchange) {
	return (
		x.describing ||
		(x.error !== null && !x.done) ||
		(x.flushing && !x.synced) ||
		(x.streaming && !x.done) ||
		(x.alone && !x.done)
	);
}

function exclusive(x: Exchange) {
	return x.flushing || x.streaming || x.alone;
}

function cost(x: Exchange) {
	const { query } = x;
	if (query.cost && !query.cursorFn && !query.streaming) {
		x.cost = query.cost.est === undefined ? unknown : query.cost.est;
	}
}

function usable(entry: Entry, statement: Statement) {
	return (
		entry.oids !== null &&
		(entry.state === "parsing" || (entry.state === "ready" && entry.version === statement.version))
	);
}

function inferred(built: Built) {
	for (let i = 0; i < built.oids.length; i++) {
		if (!built.oids[i]) {
			return true;
		}
	}
	return false;
}

function same(entry: Entry, params: number[], columns: Column[]) {
	const a = entry.oids || [],
		b = entry.columns;

	return (
		!!b &&
		a.length === params.length &&
		params.every((x, i) => x === a[i]) &&
		b.length === columns.length &&
		columns.every((x, i) => x.type === b[i].type)
	);
}

function outlived() {
	return Errors.generic("UNSAFE_TRANSACTION", "The cursor outlived its transaction");
}

function finish(x: Exchange) {
	const { query } = x;

	if (x.kind === "simple") {
		if (x.result.command !== null) {
			x.results.push(x.result);
		}
		const results = x.results;
		query.resolve(results.length > 1 ? results : results[0] || x.result);
		return;
	}

	query.resolve(x.result);
}

function guard<A extends unknown[]>(fn: (...xs: A) => void, ...xs: A) {
	try {
		fn(...xs);
	} catch {
		// A handler that throws must not break the connection
	}
}

function key(name: string) {
	// oxlint-disable-next-line no-unnecessary-type-conversion -- a transform.column.from of the user's may give a non-string, which a property key makes a string of
	const x = JSON.stringify(String(name));
	return name === "__proto__" ? "[" + x + "]" : x;
}

export function own(row: object, name: string, value: unknown) {
	Object.defineProperty(row, name, { value, writable: true, enumerable: true, configurable: true });
}

/**
 * @returns a new exchange of `kind`, for `query` (null for the connection's own work), sent through
 *   `lease` (null for the pool's), whose messages `write` writes
 */
function Exchange(
	kind: Exchange["kind"],
	query: Query | null,
	lease: Lease | null,
	write: Exchange["write"],
): Exchange {
	return {
		kind,
		query,
		lease,
		write,
		trace: (query && query.trace) || null,
		statement: null,
		text: "",
		entry: null,
		fresh: null,
		previous: null,
		parses: [],
		values: null,
		params: null,
		columns: null,
		// The result format of each column for Bind, or null for text
		formats: null,
		shaped: null,
		reader: null,
		result: new Result(),
		results: null,
		origin: null,
		portal: "",
		rows: 0,
		end: false,
		failure: null,
		flushing: false,
		streaming: false,
		open: false,
		alone: query?.alone ?? false,
		describing: false,
		learn: false,
		verify: false,
		synced: false,
		bound: false,
		suspended: false,
		finished: false,
		done: false,
		ends: false,
		epoch: 0,
		retried: false,
		original: null,
		error: null,
		own: null,
		cancel: null,
		// Whether a cancel request has been sent for this exchange
		stopped: false,
		// The promise of this exchange's cancel request while that request is in flight; otherwise null
		stopping: null,
		stream: null,
		// "in", "out" or "both", once the server has started a COPY FROM, TO or BOTH
		copy: null,
		// Whether we have sent all of the COPY data, for COPY FROM and COPY BOTH
		copied: false,
		wanted: false,
		awaiting: false,
		last: null,
		final: null,
		resolve: null,
		reject: null,
		cost: undefined,
	};
}

/**
 * @param name - the name of the prepared statement on the connection
 * @param owner - the exchange that prepares the statement. ReadyForQuery sets it to null once that
 *   exchange has ended, so that the cache does not keep the exchange's query.
 * @param oids - the types of the parameters, or null until the server has described them
 * @returns the connection's cache entry for a prepared statement
 */
function Entry(name: string, owner: Exchange, oids: number[] | null): Entry {
	return {
		name,
		owner,
		oids,
		columns: null,
		// What binary_columns() gives for `columns`, once they are known
		binary: null,
		serializers: null,
		state: "parsing",
		version: -1,
	};
}

function Rows(columns: Column[]): Shape {
	let state = states.get(columns);
	if (state === undefined) {
		state = {
			columns,
			seen: 0,
			object: null,
			array: null,
			compilable: compiles && columns.length <= 512 && !columns.some((x) => x.name === "__proto__"),
		};
		states.set(columns, state);
	}
	return state;
}

function read(state: Shape, array: boolean, from: From) {
	const kind = array ? "array" : "object";

	if (state[kind] !== null) {
		return state[kind];
	}

	if (!state.compilable || ++state.seen < after) {
		return null;
	}

	try {
		return (state[kind] = compile(state.columns, array, from));
	} catch {
		compiles = state.compilable = false;
		return null;
	}
}

function compile(columns: Column[], array: boolean, from: From) {
	const locals: string[] = [],
		body = ["let l = 0"],
		at = "x, i, i + l";

	columns.forEach((c, j) => {
		if (c.decode) {
			locals.push("d" + j + " = c[" + j + "].decode");
		} else if (c.parser) {
			locals.push("p" + j + " = c[" + j + "].parser");
		}
		const value = c.decode
			? "d" + j + "(" + at + ")"
			: c.parser
				? "p" + j + "(text(" + at + "))"
				: "text(" + at + ")";
		body.push(
			"l = (x[i] << 24) | (x[i + 1] << 16) | (x[i + 2] << 8) | x[i + 3]",
			"i += 4",
			"let v" + j + " = null",
			"l !== -1 && (v" + j + " = " + value + ", i += l)",
			from ? "v" + j + " = from(v" + j + ", c[" + j + "])" : "",
		);
	});

	body.push(
		array
			? "return [" + columns.map((c, j) => "v" + j).join(",") + "]"
			: "return {" + columns.map((c, j) => key(c.name) + ":v" + j).join(",") + "}",
	);

	// oxlint-disable-next-line typescript/no-implied-eval -- compiles the reader of one row shape from the code above
	return new Function(
		"c",
		"text",
		"from",
		(locals.length ? "const " + locals.join(", ") + "\n" : "") +
			"return function row(x, i) {\n" +
			body.filter(Boolean).join("\n") +
			"\n}",
	)(columns, text, from);
}
