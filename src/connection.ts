import Stream from "stream";
import * as p from "./protocol.ts";
import { Errors, as_error, copy_error, query_error } from "./errors.ts";
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
 * connection's own work, and what the connection learns while they are in flight. A union by
 * `kind`: "query", a query of the extended protocol; "simple", one of the simple protocol; "step",
 * the next rows of a cursor; "describe", a Describe of a statement; "internal", the connection's
 * own, such as the rollback of an unsafe transaction; "local", a query that failed before it was
 * written.
 */
export type Exchange =
	| QueryExchange
	| SimpleExchange
	| StepExchange
	| DescribeExchange
	| InternalExchange
	| LocalExchange;

/** What every exchange has */
type Base = {
	/** The lease that the exchange is sent through, or null for the pool's own work */
	lease: Lease | null;
	/** The rows and the command tag of the statement that the server is answering */
	result: Result;
	/** Whether the exchange's Sync, or its Query message (which syncs too), has been written */
	synced: boolean;
	/** Whether the exchange's ReadyForQuery has come */
	done: boolean;
	/** `epoch` as of the exchange's write */
	epoch: number;
	/** Whether the statement ends a transaction */
	ends: boolean;
	/** Whether the query must have the connection to itself */
	alone: boolean;
	/** Whether the query is a COPY stream (readable() or writable()) */
	streaming: boolean;
	/** Whether a COPY still takes data from its stream: no query may be queued meanwhile */
	open: boolean;
	/** The error that the server answered with, or that reading an answer threw */
	error: Failure | null;
	/** An error of the exchange's own, before any answer of the server, such as a refused build */
	own: Failure | null;
	/** The scheduler's estimate of the exchange's time, in ms, or undefined without an estimate */
	cost: number | undefined;
};

/** What the exchanges of a user's query have */
type UserBase = Base & {
	query: Query;
	trace: postgres.QueryTrace | null;
	/** Settled once the exchange's cancel request has been handled: see cancel() */
	cancel: PromiseWithResolvers<void> | null;
	/** Whether a cancel request has been sent for this exchange */
	stopped: boolean;
	/** The promise of this exchange's cancel request while that request is in flight; otherwise null */
	stopping: Promise<unknown> | null;
};

/** The reader of the rows that an exchange gets */
type Reading = {
	/** The columns of the rows, once the server has described them (or the cache knows them) */
	columns: Column[] | null;
	/** The readers of `columns`, once a DataRow has come */
	reader: Shape | null;
};

/** The state of the COPY that a query may turn out to be */
type Copying = {
	/** The stream of a COPY, from the Copy*Response until the COPY's data has ended */
	stream: Stream.Readable | Stream.Writable | null;
	/** "in", "out" or "both", once the server has started a COPY FROM, TO or BOTH */
	copy: "in" | "out" | "both" | null;
	/** Whether we have sent all of the COPY data, for COPY FROM and COPY BOTH */
	copied: boolean;
	/** Whether the reader of a COPY TO stream wants more data */
	wanted: boolean;
	/** The final callback of a COPY FROM stream, until CommandComplete calls it */
	final: ((error?: Error | null) => void) | null;
};

/** The cursor of a query made with .cursor(), whose callback (see cursor_callback()) gets each batch of rows */
type Cursor = {
	/** The rows per Execute; 0 for all */
	rows: number;
	/** The portal's name, given as the exchange is written: "" (the unnamed portal) outside a transaction */
	portal: string;
};

/** A query of the extended protocol */
export type QueryExchange = UserBase &
	Reading &
	Copying & {
		kind: "query";
		/** The statement, from the pool's cache */
		statement: Statement;
		cursor: Cursor | null;
		/** The connection's entry for the prepared statement, once the exchange uses one */
		entry: Entry | null;
		/** The entry made for a statement that this exchange prepares */
		fresh: Entry | null;
		/** For a retry: the entry of the exchange that is retried */
		previous: Entry | null;
		/** The names of the statements whose ParseComplete has not come yet */
		parses: string[];
		/** The types of the parameters, from ParameterDescription */
		params: number[] | null;
		/** The result format of each column for Bind, or null for text */
		formats: number[] | null;
		/** Whether the exchange waits for the server's description before it binds */
		describing: boolean;
		/** Whether the exchange learns the description for its entry */
		learn: boolean;
		/** For a retry: whether the description must be compared with the previous entry's */
		verify: boolean;
		bound: boolean;
		/** Whether the cursor waits for its callback, after a PortalSuspended (a named portal) */
		suspended: boolean;
		/** Whether the cursor's callback is running, for the rows of a step that PortalSuspended ended */
		awaiting: boolean;
		/** The promise of the cursor callback's last call, which the query settles after */
		last: Promise<unknown> | null;
		retried: boolean;
		/** For a retry: the error of the exchange that is retried */
		original: Failure | null;
	};

/** A query exchange with a cursor */
export type CursorExchange = QueryExchange & { cursor: Cursor };

/** A query of the simple protocol */
export type SimpleExchange = UserBase &
	Reading &
	Copying & {
		kind: "simple";
		text: string;
		/** The results, one per statement of the text */
		results: Result[];
	};

/** The next rows of a cursor's named portal: an Execute, or a Close once the cursor ends */
export type StepExchange = UserBase &
	Reading & {
		kind: "step";
		/** The cursor's exchange */
		origin: CursorExchange;
		/** Whether the step closes the cursor */
		end: boolean;
		/** What the cursor's callback threw, which the step fails its query with */
		failure: Failure | null;
		/** Whether the cursor waits for its callback, after a PortalSuspended */
		suspended: boolean;
		/** The promise of the cursor callback's last call, which the query settles after */
		last: Promise<unknown> | null;
	};

/** A Describe of a statement, for the pool: resolves with the statement's parameter types and columns */
export type DescribeExchange = Base & {
	kind: "describe";
	query: null;
	text: string;
	/** The types of the parameters that the caller knows; 0 for one to describe */
	oids: number[];
	/** The types of the parameters, from ParameterDescription */
	params: number[] | null;
	columns: Column[] | null;
	resolve: (description: Description) => void;
	reject: (error: unknown) => void;
};

/** The connection's own work: the rollback of an unsafe transaction */
export type InternalExchange = Base & {
	kind: "internal";
	query: null;
};

/** A query that failed before it was written, or a step that wrote nothing: settles without the server */
export type LocalExchange = UserBase & {
	kind: "local";
	/** For a step: the cursor's exchange, which the step closes */
	origin: CursorExchange | null;
};

/** The exchanges that the server answers, of a user's query */
type UserExchange = QueryExchange | SimpleExchange | StepExchange;

/** The exchanges that may turn out to be a COPY */
type CopyExchange = QueryExchange | SimpleExchange;

/** The connection's cache entry for a prepared statement */
type Entry = {
	/** The name of the prepared statement on the connection */
	name: string;
	/**
	 * The exchange that prepares the statement. ReadyForQuery sets it to null once that exchange has
	 * ended, so that the cache does not keep the exchange's query.
	 */
	owner: QueryExchange | null;
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
		head_since = 0;

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
			settle_error(x, copy_error(closed));
			return;
		}

		if (blocker && blocker.streaming && blocker.open) {
			settle_error(x, Errors.generic("COPY_IN_PROGRESS", "You cannot execute queries during copy"));
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
		for (let x = pending[0]; !blocker && x !== undefined && x !== fence; x = pending[0]) {
			// Before each write, because write() runs user code (a debug callback, a custom type's
			// serializer) that may cancel a query, and a cancel starts a hold
			if (cancelling) {
				break;
			}
			pending.shift();
			write(x);
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
		let result: unknown;
		try {
			result = messages(x);
		} catch (error) {
			x.own = as_error(error);
			result = skip;
		}
		if (result === skip) {
			out.truncate(mark);
			const refusal = skipped(x);
			if (refusal === null) {
				return;
			}
			x = refusal;
		}
		if (x.kind === "query" && x.fresh) {
			register(x, x.fresh);
		}
		if (is_cursor(x) && x.cursor.portal) {
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
			head_since = timers.now();
		}
		sent.push(x);
		if (holds(x)) {
			blocker = x;
		}
		if (user(x) && x.kind !== "local" && x.trace) {
			wrote(x, x.trace);
		}
	}

	/**
	 * Writes the messages of exchange `x`, by its kind.
	 * @returns `skip` if nothing was written: for a local exchange, and for a step that only closes
	 *   a cursor whose transaction has ended
	 */
	function messages(x: Exchange) {
		switch (x.kind) {
			case "query":
				return extended(x);
			case "simple":
				debug(x.text, [], []);
				p.query(out, x.text);
				x.synced = true;
				return;
			case "step":
				return stepped(x);
			case "describe":
				p.parse(out, "", x.text, x.oids);
				p.describe(out, "S", "");
				sync(x);
				return;
			case "internal":
				p.query(out, "rollback");
				x.synced = true;
				return;
			case "local":
				return skip;
		}
	}

	/**
	 * Takes over for exchange `x`, which wrote nothing, or whose messages were dropped because
	 * writing them threw (which `x.own` then holds).
	 * @returns null, once `x` has been dealt with: a local exchange settles with `x.own` (if any)
	 *   without an answer of the server, once nothing is in flight ahead of it. Or, for a query with
	 *   a lease and an error of its own, a simple exchange of a query that the server refuses, to be
	 *   written in `x`'s place, so that the lease's transaction fails too.
	 */
	function skipped(x: Exchange): SimpleExchange | null {
		if (x.kind === "describe" || x.kind === "internal") {
			// The connection's own messages are always written: this is a bug of this file
			abandon(x.own || new Error("Bug: an exchange of the connection's own wrote nothing"));
			return null;
		}
		if (!x.own || x.kind === "step" || !connection.lease) {
			const settling_locally =
				x.kind === "local"
					? x
					: LocalExchange(x.query, x.lease, x.own, x.kind === "step" ? x.origin : null);
			if (sent.length === 0) {
				settle_soon(settling_locally);
			} else {
				sent.push(settling_locally);
			}
			return null;
		}
		const refusal = SimpleExchange(x.query, x.lease, refused);
		refusal.own = x.own;
		refusal.ends = x.ends;
		refusal.cost = x.cost;
		// Not a COPY that takes data, whatever the query was to be
		refusal.open = false;
		sync(refusal, true);
		return refusal;
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

	/**
	 * Puts `entry`, the statement that exchange `x` prepares, in the cache, as the newest entry; and
	 * closes the oldest statement whose ParseComplete has come, once the cache holds more than `limit`.
	 */
	function register(x: QueryExchange, entry: Entry) {
		const current = prepared.get(entry.name);
		if (current) {
			prepared.delete(entry.name);
		}
		prepared.set(entry.name, entry);
		x.entry = entry;
		x.fresh = null;
		if (prepared.size <= limit) {
			return;
		}

		for (const [name, cached] of prepared) {
			if (cached.state !== "parsing") {
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
			x = QueryExchange(query, connection.lease, statement);

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

		if (x.cost !== undefined && x.query && x.query.cost) {
			const sample = t - head_since,
				c = x.query.cost;
			c.est = c.est === undefined || sample > c.est ? sample : c.est + (sample - c.est) * 0.1;
			if (events.ontimed) {
				events.ontimed(sample, t);
			}
		}

		head_since = t;
	}

	function backlog(t: number) {
		let w = 0;
		for (let i = 0; i < sent.length; i++) {
			const e = sent[i].cost || 0;
			if (i === 0) {
				const elapsed = t - head_since;
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
		for (const x of sent) {
			if (x.cost !== undefined && x.cost >= ms) {
				return true;
			}
		}

		for (const x of pending) {
			if (x.cost !== undefined && x.cost >= ms) {
				return true;
			}
		}

		return false;
	}

	function extended(x: QueryExchange) {
		const { query, statement } = x,
			{ built } = query.wire,
			name = statement.name,
			current = name ? prepared.get(name) : null;

		if (x.cursor) {
			x.cursor.portal = transaction() ? "c" + portals++ : "";
		}

		if (current && current.state === "parsing" && current.oids === null) {
			throw Errors.generic(
				"STATEMENT_PENDING",
				"A statement was used before its description arrived",
			);
		}

		if (current && current !== x.previous && usable(current, statement)) {
			// raw() gets the bytes of the text
			const binary = query.is_raw === true ? null : current.binary;
			x.entry = current;
			x.columns = binary ? binary.columns : current.columns;
			x.formats = binary ? binary.formats : null;
			return run(x, name, serialize(current.oids, built, current));
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
		run(x, name, serialize(built.oids, built, x.fresh || {}));
	}

	function parse(x: QueryExchange, name: string, query_text: string, oids: number[]) {
		p.parse(out, name, query_text, oids);
		x.parses.push(name);
	}

	/**
	 * Writes the Bind, Execute and Sync (or Flush, for an unnamed cursor) of query exchange `x`.
	 * @param name - the statement's name; "" for the unnamed statement
	 * @param values - the parameters, serialized
	 */
	function run(x: QueryExchange, name: string, values: Value[]) {
		const mark = out.length,
			{ cursor } = x,
			// The unnamed portal of a cursor gets a Flush, so that its rows can be read, and a Sync later
			flushes = cursor !== null && cursor.portal === "";
		try {
			p.run(
				out,
				cursor ? cursor.portal : "",
				name,
				values,
				cursor ? cursor.rows : 0,
				flushes,
				x.formats,
			);
		} catch (error) {
			out.truncate(mark);
			throw error;
		}
		if (!flushes) {
			x.synced = true;
		}
		debug(x.statement.text, values, x.entry?.oids ?? x.params ?? x.query.wire.built.oids);
	}

	/**
	 * Gives `entry` the server's description of its statement, and `statement` the shape that it
	 * describes.
	 * @param oids - the types of the parameters
	 * @param columns - the columns of the rows
	 */
	function learned(entry: Entry, statement: Statement, oids: number[], columns: Column[]) {
		const shape = oids.join() + ":" + columns.map((x) => x.type).join();
		entry.oids = oids;
		entry.columns = columns;
		if (statement.shape !== shape) {
			if (statement.shape !== undefined) {
				statement.version++;
			}
			statement.shape = shape;
		}
		entry.version = statement.version;
		entry.binary = binary_columns(columns);
	}

	/**
	 * @param columns - the columns of a prepared statement, as RowDescription describes them
	 * @returns for the queries that run the statement: the columns, with a decoder of the binary
	 *   format for each column that is read in binary, and the result format of each column for
	 *   Bind (1 for binary, 0 for text); or null, if no column is read in binary
	 */
	function binary_columns(columns: Column[]) {
		let binary: Entry["binary"] = null;
		for (let i = 0; i < columns.length; i++) {
			// The parser that the column has as text, so that the decoder gives what it would
			const decode = events.binary(columns[i].type, columns[i].parser);
			if (decode) {
				binary = binary || { columns: columns.slice(), formats: columns.map(() => 0) };
				binary.columns[i] = { ...columns[i], decode };
				binary.formats[i] = 1;
			}
		}
		return binary;
	}

	/**
	 * @param cache - the statement's entry, whose `serializers` are kept, or an object that is dropped
	 */
	function serialize(oids: number[], built: Built, cache: { serializers?: Serializer[] | null }) {
		const serializers = cache.serializers || (cache.serializers = oids.map(events.serializer)),
			values = built.values,
			serialized = new Array<Value>(values.length);

		for (let i = 0; i < values.length; i++) {
			const value = values[i] === null ? null : (serializers[i](values[i]) as Value);
			if (
				value !== null &&
				value !== undefined &&
				typeof value !== "string" &&
				!(value instanceof Uint8Array)
			) {
				// A serializer must return a string or bytes. For anything else, Buffer.byteLength
				// throws here, where the error is this query's, instead of the writer corrupting the
				// wire later
				Buffer.byteLength(value);
			}
			serialized[i] = value;
		}

		return serialized;
	}

	function transaction() {
		return !!connection.lease && connection.lease.kind === "transaction";
	}

	function described(x: QueryExchange) {
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
				return run(x, "", serialize(params, built, {}));
			}
			const entry = x.entry;
			if (entry) {
				learned(entry, x.statement, params, columns);
			}
			run(x, name, serialize(params, built, entry || {}));
		} catch (error) {
			x.own = as_error(error);
			sync(x, !!connection.lease);
		}
	}

	function describe(statement_text: string, oids: number[]) {
		return new Promise<Description>((resolve, reject) => {
			queue(DescribeExchange(connection.lease, statement_text, oids, resolve, reject));
		});
	}

	function simple(query: Query, sql: string) {
		const x = SimpleExchange(query, connection.lease, sql);
		x.ends = ending.test(sql);
		if (options.scheduler) {
			cost(x);
		}
		queue(x);
	}

	function local(query: Query, error: Error) {
		queue(LocalExchange(query, connection.lease, error, null));
	}

	/**
	 * Sends a CancelRequest for exchange `x`, the head of `sent`, unless one is in
	 * flight already, and writes nothing more on this connection until the server
	 * has closed the cancel connection. PostgreSQL drops a cancel that reaches a backend waiting for its
	 * next command, so the cancel can't hit a query written after that.
	 *
	 * @returns a promise that settles as the CancelRequest does
	 */
	function stop(x: UserExchange) {
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
	function cancel_copy(x: CopyExchange) {
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
		const in_flight = sent[0];
		if (
			running.has(query) ||
			(in_flight && in_flight.kind === "query" && in_flight.query === query && in_flight.awaiting)
		) {
			query.aborted = Errors.canceled();
			return Promise.resolve();
		}
		const i = pending.findIndex((x) => x.query === query);

		if (i !== -1) {
			const [x] = pending.splice(i, 1);
			if (x === fence) {
				fence = null;
			}
			settle_error(x, Errors.canceled());
			release();
			return Promise.resolve();
		}

		const x = sent.find((item): item is UserExchange | LocalExchange => item.query === query);
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
		return x.kind !== "step" && x.copy ? cancel_copy(x) : stop(x);
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
		const ended = Errors.connection(
			destroyed ? "CONNECTION_DESTROYED" : "CONNECTION_CLOSED",
			options,
			ready.host,
			ready.port,
		);
		closed = ended;
		ended.cause = fatal || error || undefined;
		// A FATAL error that came with no query to give it to, such as from
		// idle_in_transaction_session_timeout, is what ended the lease (if any)
		let lease_error =
			connection_error && connection_error.severity === "FATAL" ? connection_error : null;
		sent.splice(0).forEach((x) => {
			if (user(x)) {
				// The query fails with `closed`, so there is nothing left to cancel
				if (x.cancel) {
					x.cancel.resolve();
				}
				if (x.kind !== "step" && x.kind !== "local" && x.stream) {
					x.stream.destroy(ended);
				}
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
			const reason = x === head && x.error && x.error.severity === "FATAL" ? x.error : ended,
				copied = copy_error(reason);
			// settle_error adds x's query to `copied`
			settle_error(x, copied);
			// Otherwise the lease rejects with the head's error, the head being the lease's own query.
			// Not with a FATAL error for a statement that ends a transaction (such as COMMIT), which
			// the server may have committed: then the lease rejects with `closed`, whose cause it is.
			if (
				x === head &&
				lease_error === null &&
				(reason === ended || (reason === fatal && !x.ends))
			) {
				lease_error = copied;
			}
		});
		pending.splice(0).forEach((x) => (x.own ? settle(x) : settle_error(x, copy_error(ended))));
		running.forEach((query) => query.settled || query.reject(decorate(query, copy_error(ended))));
		running.clear();
		open.clear();
		if (resolve_closing) {
			resolve_closing();
		}
		events.onclose(connection, ended, lease_error, orderly);
	}

	function decorate(query: Query, error: unknown) {
		return query_error(error, query, options.debug);
	}

	function settle_error(x: Exchange, error: Error) {
		if (x.kind === "describe") {
			x.reject(error);
		} else if (x.query && !x.query.settled) {
			x.query.reject(decorate(x.query, error));
		}
	}

	function debug(query_text: string, values: Value[], oids: number[]) {
		if (typeof options.debug === "function") {
			options.debug(connection.id, query_text, values, oids);
		}
	}

	/** Fills in `trace`, the trace of exchange `x`, as `x` is written */
	function wrote(x: UserExchange, trace: postgres.QueryTrace) {
		traced++;
		if (x.kind === "simple") {
			trace.query = x.text;
			trace.statement = "";
		} else {
			const { statement } = x.kind === "step" ? x.origin : x;
			trace.query = statement.text;
			trace.statement = statement.name;
		}
		trace.parameters = options.debug ? x.query.parameters : undefined;
		trace.connection = connection.id;
		trace.host = connection.host;
		trace.port = connection.port;
		trace.sent = now();
	}

	function first() {
		const x = sent[0];
		if (x && user(x) && x.trace && x.trace.firstByte === null) {
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
		if (x.kind === "query") {
			x.describing = false;
		}
		x.open = false;
		sync(x);
	}

	function unsupported(x: string) {
		if (sent[0]) {
			fail(sent[0], Errors.not_supported(x));
		}
	}

	/**
	 * @param message - the message's name, for the error
	 * @param kinds - the kinds of exchange that the server answers with the message
	 * @returns the head of `sent`, which the server's `message` answers
	 * @throws UNEXPECTED_MESSAGE if nothing is in flight, or the head is of another kind: the server
	 *   broke the protocol, or this file has a bug
	 */
	function answered<K extends Exchange["kind"]>(message: string, ...kinds: K[]) {
		const x = sent[0];
		if (x === undefined) {
			throw Errors.generic(
				"UNEXPECTED_MESSAGE",
				"A " + message + " came while nothing was in flight",
			);
		}
		if (!(kinds as string[]).includes(x.kind)) {
			throw Errors.generic(
				"UNEXPECTED_MESSAGE",
				"A " + message + " came for a " + x.kind + " exchange",
			);
		}
		return x as Extract<Exchange, { kind: K }>;
	}

	function ParseComplete() {
		const x = answered("ParseComplete", "query", "describe");
		if (x.kind === "describe") {
			return;
		}
		const name = x.parses.shift();
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
		const x = answered("BindComplete", "query");
		x.bound = true;
		if (!x.columns && x.entry) {
			x.columns = x.entry.columns;
			x.result.columns = x.columns;
		}
	}

	function ParameterDescription(x: Buffer, start: number) {
		answered("ParameterDescription", "query", "describe").params = p.parameter_description(
			x,
			start,
		);
	}

	function RowDescription(x: Buffer, start: number) {
		received(
			answered("RowDescription", "query", "simple", "describe"),
			p.row_description(x, start, 0, column),
		);
	}

	function NoData() {
		received(answered("NoData", "query", "describe"), []);
	}

	function received(x: QueryExchange | SimpleExchange | DescribeExchange, columns: Column[]) {
		if (x.kind === "simple" && x.result.command !== null) {
			x.results.push(x.result);
			x.result = new Result();
		}
		x.columns = columns;
		x.result.columns = columns;
		if (x.kind !== "query") {
			return;
		}
		if (x.learn) {
			x.learn = false;
			if (x.entry && x.entry.owner === x) {
				// A query whose types were all given: the entry was made with them
				learned(x.entry, x.statement, x.query.wire.built.oids, columns);
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
		const item = answered("DataRow", "query", "simple", "step"),
			{ query, columns } = item,
			raw = query.is_raw,
			from = raw !== true ? transform.value.from : null;
		if (columns === null) {
			throw Errors.generic("UNEXPECTED_MESSAGE", "A DataRow came before the RowDescription");
		}
		if (item.reader === null || item.reader.columns !== columns) {
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
		if (query.for_each_fn) {
			query.for_each_fn(transformed, result);
		} else {
			result[result.length] = transformed;
		}
	}

	function CommandComplete(x: Buffer, start: number, end: number) {
		const item = answered("CommandComplete", "query", "simple", "step", "internal"),
			{ command, count } = p.command_complete(x, start, end),
			result = item.result;

		result.command = command;
		result.count = count;
		result.state = connection.backend;
		result.statement = item;
		if (item.kind === "internal") {
			return;
		}
		item.query.source = item;
		result.columns = result.columns || item.columns;

		if (item.kind === "simple") {
			finalize_copy(item, command, count);
			item.results.push(item.result);
			item.result = new Result();
			return;
		}

		if (item.kind === "query") {
			finalize_copy(item, command, count);
		}
		const cursor = item.kind === "query" ? item.cursor : item.origin.cursor;
		if (cursor) {
			if (unnamed_cursor(item)) {
				sync(item);
			}
			if (result.count) {
				(item.last = new Promise((r) => r(cursor_callback(item.query)(result)))).catch(noop);
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
		pending.unshift(InternalExchange());
	}

	function EmptyQueryResponse() {
		const item = answered("EmptyQueryResponse", "query", "simple");
		if (item.kind === "simple") {
			item.results.push(item.result);
			item.result = new Result();
		}
	}

	function PortalSuspended() {
		const item = answered("PortalSuspended", "query", "step");
		if (unnamed_cursor(item)) {
			void resume(item);
		} else {
			item.suspended = true;
		}
	}

	/**
	 * Gives the cursor's callback the rows of exchange `item`, the head of `sent`, and then, by
	 * what the callback returned, fetches the next rows or closes the portal. Async, so its errors
	 * cannot reach frame()'s catch: it fails `item` with them itself.
	 */
	async function resume(item: CursorExchange) {
		try {
			item.awaiting = true;
			const next = await cursor_callback(item.query)(item.result);
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
				p.execute(out, "", item.cursor.rows);
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
		if (item.kind === "query" || item.kind === "simple") {
			if (item.stream) {
				item.stream.destroy(error);
			}
			if (item.final) {
				item.final(error);
				item.final = null;
			}
		}
	}

	function ReadyForQuery(x: Buffer, start: number) {
		status = p.ready_for_query(x, start);
		frames.own(false);
		const item = sent.shift();
		if (item === undefined) {
			throw Errors.generic(
				"UNEXPECTED_MESSAGE",
				"A ReadyForQuery came while nothing was in flight",
			);
		}
		if (options.scheduler) {
			timed(item);
		}
		item.done = true;
		item.open = false;
		if (user(item) && item.trace) {
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
		if (item.kind === "query" && item.entry && item.entry.owner === item) {
			item.entry.owner = null;
		}
		for (let settled = sent[0]; settled && settled.kind === "local"; settled = sent[0]) {
			sent.shift();
			settle(settled);
		}
		const next = sent[0];
		if (next && user(next)) {
			next.query.active = true;
			const { cancel: requested } = next;
			if (requested && next.kind !== "local") {
				stop(next).then(() => requested.resolve(), requested.reject);
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
			origin = cursor_of(x),
			waiting = (x.kind === "query" || x.kind === "step") && x.suspended;
		if (origin && (x.own || x.error || !waiting)) {
			unfence(origin);
		}

		if (x.own) {
			query.reject(decorate(query, x.own));
			return;
		}

		if (x.error) {
			failed(x, x.error);
			return;
		}

		if ((x.kind === "query" || x.kind === "step") && x.suspended) {
			suspended(x);
			return;
		}

		const last = x.kind === "query" || x.kind === "step" ? x.last : null;
		if (last) {
			last.then(
				() => query.settled || finish(x),
				(error) => query.settled || query.reject(decorate(query, error)),
			);
		} else if (!query.settled) {
			finish(x);
		}
	}

	function unfence(cursor: CursorExchange) {
		if (!open.delete(cursor) || open.size || !fence) {
			return;
		}
		fence = null;
		release();
	}

	/** Fails exchange `x` with `error`, the server's; or runs a query again, for an error that a stale cache entry caused */
	function failed(x: UserExchange | LocalExchange, error: Failure) {
		if (x.kind !== "query") {
			settle_error(x, error);
			return;
		}
		const { entry } = x,
			parsing =
				x.fresh !== null || (entry !== null && entry.owner === x && entry.state === "parsing");

		if (error.code === "42P05" && x.statement.name && parsing) {
			if (entry) {
				drop(entry);
			}
			x.statement.name += "_";
			again_or_fail(x, error);
			return;
		}

		if (!entry) {
			settle_error(x, error);
			return;
		}

		if (entry.owner === x && entry.state === "parsing") {
			drop(entry);
			settle_error(x, error);
			return;
		}

		if (error.code === "26000") {
			drop(entry);
			again_or_fail(x, error);
			return;
		}

		if (x.bound) {
			settle_error(x, error);
			return;
		}

		if (retryable(x)) {
			again(x, error);
			return;
		}

		stale(entry);
		settle_error(x, error);
	}

	/** Runs `x` again if it can be run again (see `retryable`), and otherwise fails it with `error` */
	function again_or_fail(x: QueryExchange, error: Failure) {
		if (retryable(x)) {
			again(x, null);
		} else {
			settle_error(x, error);
		}
	}

	function stale(entry: Entry) {
		if (prepared.get(entry.name) === entry) {
			entry.state = "stale";
		}
	}

	function retryable(x: QueryExchange) {
		return (
			!x.retried &&
			!x.stopped &&
			!x.query.cancelled &&
			x.cursor === null &&
			!x.streaming &&
			x.lease === connection.lease &&
			status === "I" &&
			!closing &&
			(sent.length === 0 || (!x.lease && options.max !== 1))
		);
	}

	function again(x: QueryExchange, original: Failure | null) {
		const retry = QueryExchange(x.query, x.lease, x.statement);
		retry.ends = x.ends;
		retry.retried = true;
		retry.original = original;
		retry.previous = x.entry;
		retry.cost = x.cost;

		if (sent.length) {
			queue(retry);
			return;
		}

		pending.unshift(retry);
		release();
	}

	/**
	 * Gives the cursor's callback the rows of exchange `x` (the cursor's, or a step's), whose named
	 * portal PortalSuspended has suspended; then queues the next step: an Execute, or the Close that
	 * what the callback returned or threw asks for.
	 */
	function suspended(x: QueryExchange | StepExchange) {
		const origin = x.kind === "step" ? x.origin : is_cursor(x) ? x : null,
			{ query } = x;
		if (origin === null) {
			throw new Error("Bug: a PortalSuspended came for a query without a cursor");
		}

		running.add(query);

		new Promise((r) => r(cursor_callback(query)(x.result))).then(
			(next) => {
				running.delete(query);
				if (query.settled) {
					return unfence(origin);
				}
				queue(StepExchange(origin, next === CLOSE || !!query.aborted, query.aborted || null));
			},
			(error) => {
				running.delete(query);
				if (query.settled) {
					return unfence(origin);
				}
				queue(StepExchange(origin, true, as_error(error)));
			},
		);
	}

	/**
	 * Writes a step of a cursor: an Execute of its portal, or a Close once the cursor ends.
	 * @returns `skip` (and writes nothing) when the cursor's transaction has ended and the step
	 *   only closes the cursor; otherwise null
	 * @throws the step's failure, or UNSAFE_TRANSACTION for a step that would read from a cursor
	 *   whose transaction has ended
	 */
	function stepped(x: StepExchange) {
		const { origin } = x;

		if (connection.lease !== origin.lease || origin.epoch !== epoch) {
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
			p.close(out, "P", origin.cursor.portal);
		} else {
			p.execute(out, origin.cursor.portal, origin.cursor.rows);
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
		const notice = p.error(x, start, end),
			channel = channels.notice;
		if (channel && listened(channel)) {
			channel.publish({
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
		const [k, v] = p.parameter_status(x, start);
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
	function in_progress(item: CopyExchange) {
		return !!item.stream && sent[0] === item;
	}

	/**
	 * @returns whether destroying the COPY TO stream of exchange `item` should also
	 * cancel the COPY. A cancel request aborts the transaction block that the COPY
	 * runs in, also one begun earlier in the same query, and it can hit a query
	 * written behind the COPY, so only a COPY in progress that is the first
	 * statement of its query, outside a transaction block, and alone on the wire.
	 */
	function cancellable(item: CopyExchange) {
		return (
			in_progress(item) &&
			status === "I" &&
			!item.error &&
			!(item.kind === "simple" && item.results.length) &&
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
	function discard(item: CopyExchange) {
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
	function end_copy(item: CopyExchange, message: string) {
		if (item.copy === "both") {
			p.copy_done(out);
		} else {
			p.copy_fail(out, message);
		}
		item.copied = true;
		item.open = false;
		schedule(true);
	}

	function write_data(chunk: Buffer | string, callback: () => void) {
		p.copy_data(out, chunk);
		if (flush()) {
			callback();
		} else {
			drained = callback;
		}
	}

	function writable(item: CopyExchange): Stream.WritableOptions {
		return {
			autoDestroy: true,
			write(chunk, encoding, callback) {
				write_data(chunk, callback);
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
				p.copy_done(out);
				item.copied = true;
				item.open = false;
				item.final = callback;
				schedule(true);
				refresh();
			},
		};
	}

	function CopyInResponse() {
		const item = answered("CopyInResponse", "query", "simple");
		item.copy = "in";
		// The server holds back a cancel request while it waits for COPY data, so a
		// cancelled COPY FROM ends with CopyFail
		if (item.stopped) {
			return end_copy(item, "canceling statement due to user request");
		}
		item.stream = new Stream.Writable(writable(item));
		item.query.resolve(item.stream);
	}

	function readable(item: CopyExchange) {
		return () => {
			item.wanted = true;
			unpause();
		};
	}

	function CopyOutResponse() {
		const item = answered("CopyOutResponse", "query", "simple");
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
		const item = answered("CopyBothResponse", "query", "simple");
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
		const item = answered("CopyData", "query", "simple");

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
		const item = answered("CopyDone", "query", "simple");
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

/** @returns the exchange of the cursor (with a named portal) that `x` is, steps, or closes; else null */
function cursor_of(x: UserExchange | LocalExchange) {
	if (x.kind === "step" || x.kind === "local") {
		return x.origin;
	}
	return is_cursor(x) && x.cursor.portal ? x : null;
}

/**
 * Calls the final callback of the COPY FROM stream of `item`, if one waits, once the server has
 * answered the COPY with its command tag, `command` and `count`, which the stream gets too.
 */
function finalize_copy(item: CopyExchange, command: string, count: number | null) {
	if (item.final) {
		if (item.stream) {
			Object.assign(item.stream, { count, command });
		}
		item.final();
		item.final = null;
	}
}

/**
 * @returns whether nothing may be written behind exchange `x` yet. A COPY holds
 * the connection until its ReadyForQuery, so that no query waits behind a slow
 * reader of its stream, and so that cancelling it can't hit another query.
 */
function holds(x: Exchange) {
	return (
		(x.kind === "query" && (x.describing || (unnamed_cursor(x) && !x.synced))) ||
		(x.error !== null && !x.done) ||
		(x.streaming && !x.done) ||
		(x.alone && !x.done)
	);
}

function exclusive(x: Exchange) {
	return unnamed_cursor(x) || x.streaming || x.alone;
}

/** @returns whether `x` is an exchange of a user's query, which the connection's own work is not */
function user(x: Exchange): x is UserExchange | LocalExchange {
	return x.kind !== "describe" && x.kind !== "internal";
}

/**
 * @returns the callback of the cursor of `query`, read when a batch of rows is ready, because the
 *   async iterator of .cursor() gives the query a new callback for each batch
 */
function cursor_callback(query: Query) {
	const { cursor_fn } = query;
	if (cursor_fn === null) {
		throw new Error("Bug: the query of a cursor has no callback");
	}
	return cursor_fn;
}

/** @returns whether `x` is a query made with .cursor() */
function is_cursor(x: Exchange): x is CursorExchange {
	return x.kind === "query" && x.cursor !== null;
}

/** @returns whether `x` is a cursor of the unnamed portal, whose Execute a Flush follows, not a Sync */
function unnamed_cursor(x: Exchange): x is CursorExchange {
	return is_cursor(x) && x.cursor.portal === "";
}

function cost(x: QueryExchange | SimpleExchange) {
	const { query } = x;
	if (query.cost && !is_cursor(x) && !x.streaming) {
		x.cost = query.cost.est === undefined ? unknown : query.cost.est;
	}
}

/** @returns whether the cached `entry` can run `statement` as it is: described, and of the statement's shape */
function usable(entry: Entry, statement: Statement): entry is Entry & { oids: number[] } {
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

function finish(x: UserExchange | LocalExchange) {
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
 * @param lease - the lease that the exchange is sent through, or null for the pool's own work
 * @param query - the query, or null for the connection's own work
 * @returns what every exchange starts with
 */
function base(lease: Lease | null, query: Query | null): Base {
	return {
		lease,
		result: new Result(),
		synced: false,
		done: false,
		epoch: 0,
		ends: false,
		alone: query?.alone ?? false,
		streaming: query?.streaming ?? false,
		open: query?.streaming ?? false,
		error: null,
		own: null,
		cost: undefined,
	};
}

/** @returns what every exchange of `query`, sent through `lease`, starts with */
function user_base(query: Query, lease: Lease | null): UserBase {
	return {
		...base(lease, query),
		query,
		trace: query.trace,
		cancel: null,
		stopped: false,
		stopping: null,
	};
}

/** @returns what every exchange that may turn out to be a COPY starts with */
function copying(): Copying {
	return { stream: null, copy: null, copied: false, wanted: false, final: null };
}

/** @returns a new exchange of the extended protocol, for `query`, of `statement`, sent through `lease` */
function QueryExchange(query: Query, lease: Lease | null, statement: Statement): QueryExchange {
	return {
		...user_base(query, lease),
		...copying(),
		kind: "query",
		statement,
		cursor: query.cursor_fn ? { rows: query.cursor_rows, portal: "" } : null,
		columns: null,
		reader: null,
		entry: null,
		fresh: null,
		previous: null,
		parses: [],
		params: null,
		formats: null,
		describing: false,
		learn: false,
		verify: false,
		bound: false,
		suspended: false,
		awaiting: false,
		last: null,
		retried: false,
		original: null,
	};
}

/** @returns a new exchange of the simple protocol, for `query`, of `query_text`, sent through `lease` */
function SimpleExchange(query: Query, lease: Lease | null, query_text: string): SimpleExchange {
	return {
		...user_base(query, lease),
		...copying(),
		kind: "simple",
		text: query_text,
		results: [],
		columns: null,
		reader: null,
	};
}

/**
 * @param origin - the cursor's exchange
 * @param end - whether the step closes the cursor
 * @param failure - what the cursor's callback threw, which the step fails its query with
 * @returns a new step of the cursor
 */
function StepExchange(origin: CursorExchange, end: boolean, failure: Failure | null): StepExchange {
	return {
		...user_base(origin.query, origin.lease),
		kind: "step",
		origin,
		end,
		failure,
		columns: origin.columns,
		reader: null,
		suspended: false,
		last: null,
	};
}

/**
 * @param lease - the lease that the describe is sent through, or null for the pool's own
 * @param statement_text - the statement's text
 * @param oids - the types of the parameters that the caller knows; 0 for one to describe
 * @param resolve - gets the statement's description
 * @param reject - gets the error that the server answered with
 * @returns a new Describe of the statement
 */
function DescribeExchange(
	lease: Lease | null,
	statement_text: string,
	oids: number[],
	resolve: (description: Description) => void,
	reject: (error: unknown) => void,
): DescribeExchange {
	return {
		...base(lease, null),
		kind: "describe",
		query: null,
		text: statement_text,
		oids,
		params: null,
		columns: null,
		resolve,
		reject,
	};
}

/** @returns a new exchange of the connection's own: the rollback of an unsafe transaction */
function InternalExchange(): InternalExchange {
	return { ...base(null, null), kind: "internal", query: null };
}

/**
 * @param error - the error that the query failed with before it was written, or null for a step that
 *   only closes a cursor
 * @param origin - for a step: the cursor's exchange
 * @returns a new local exchange for `query`, sent through `lease`: see LocalExchange
 */
function LocalExchange(
	query: Query,
	lease: Lease | null,
	error: Failure | null,
	origin: CursorExchange | null,
): LocalExchange {
	return { ...user_base(query, lease), kind: "local", origin, own: error };
}

/**
 * @param name - the name of the prepared statement on the connection
 * @param owner - the exchange that prepares the statement. ReadyForQuery sets it to null once that
 *   exchange has ended, so that the cache does not keep the exchange's query.
 * @param oids - the types of the parameters, or null until the server has described them
 * @returns the connection's cache entry for a prepared statement
 */
function Entry(name: string, owner: QueryExchange, oids: number[] | null): Entry {
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

/**
 * @param columns - the columns of a row
 * @param array - whether the reader gives the row as an array of its values, else as an object
 * @param from - the transform of each value, if any
 * @returns a reader of a row of `columns`, from the first column's length in a DataRow; it reads
 *   each value as DataRow() does without it
 */
export function compile(columns: Column[], array: boolean, from: From) {
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
