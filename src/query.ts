import util from "util";
import { build, isQuery, Join, joinStrings } from "./build.ts";
import { ours } from "./errors.ts";
import { channels, active, start, finish, now, userName } from "./diagnostics.ts";
import { statement } from "./result.ts";
import type postgres from "../types/index.js";
import type { Built } from "./build.ts";
import type { Exchange, Connection } from "./connection.ts";
import type { Options } from "./index.ts";
import type { Cost, Statement } from "./pool.ts";
import type { Backend } from "./protocol.ts";
import type { Failure } from "./errors.ts";

const origins = new WeakMap<TemplateStringsArray | string[], string>();

/**
 * Runs a Query when it is first awaited: the pool's, or a lease's. It carries the pool's `options`
 * and `debug`, and `cancel`, which cancels a Query.
 */
export type Handler = ((q: Query) => void) & {
	debug?: Options["debug"];
	options: Options;
	cancel?: (q: Query) => Promise<unknown>;
};

/** The options of one Query, which its methods set */
export type QueryOptions = { simple?: boolean; prepare?: boolean };

/** The callback of a cursor: called with each batch of rows; may return CLOSE to stop */
export type CursorFn = (rows: any) => unknown;

export const CLOSE = {};

export class Query extends Promise<any> {
	/** Settles this Query's promise; `resolve` and `reject` wrap these. */
	declare fulfil: (x: any) => void;
	declare fail: (error: any) => void;
	/** Whether `strings` came from a tagged template (and has `.raw`). */
	declare tagged: boolean;
	declare strings: TemplateStringsArray | string[];
	declare args: any[];
	/** Called with this Query when it runs; it may carry `debug`, `options`, and `cancel`. */
	declare handler: Handler;
	declare options: QueryOptions;
	/** The `{ pid, secret }` of the backend process whose connection ran this Query. */
	declare state: Backend | null;
	/** The connection's pipeline item that ran this Query. */
	declare source: Exchange | null;
	declare active: boolean;
	declare executed: boolean;
	declare settled: boolean;
	/** What `build()` returned, cached. */
	declare built: Built | null;
	/** The diagnostics_channel context, while tracing this Query. */
	declare trace: postgres.QueryTrace | null;
	/** Removes the abort listener that `signal()` added. */
	declare aborts: (() => void) | null;
	declare originError: Error | null;
	declare streaming: boolean;
	declare cursorRows: number;
	declare cursorFn: CursorFn | null;
	declare onlyDescribe: boolean;
	declare forEachFn: (row: any, result: any) => unknown;
	/** `true` for `.raw()`, `"values"` for `.values()`. */
	declare isRaw: boolean | "values";
	/** Whether the query must have its connection to itself: its statement opens a transaction block */
	declare alone: boolean | undefined;
	/** Called once the query has been written on its lease's connection; the lease's send() sets it */
	declare onwrite: (() => void) | undefined;
	/** The statement and the built text; the pool's query() sets it for a query of the extended protocol */
	declare wire: { statement: Statement; built: Built };
	/** The scheduler's cost of the query's text, if the scheduler is on */
	declare cost: Cost | null | undefined;
	/** The connection that the query was placed on */
	declare connection: Connection | null | undefined;
	/** Whether cancel() came before the query reached a connection: the pool refuses it then */
	declare cancelled: boolean | undefined;
	/** The error that a cancel() of a cursor between two of its steps fails the cursor with */
	declare aborted: Failure | null | undefined;
	/** Marks a Query, which build.ts's isFragment() tests for */
	declare [isQuery]: true;

	constructor(
		strings: TemplateStringsArray | string[],
		args: any[],
		handler: Handler,
		options: QueryOptions = {},
	) {
		// The executor runs before super() returns
		let resolve!: (x: any) => void, reject!: (error: any) => void;

		super((a, b) => {
			resolve = a;
			reject = b;
		});

		this.fulfil = resolve;
		this.fail = reject;

		this[isQuery] = true;
		this.tagged = Array.isArray((strings as TemplateStringsArray).raw);
		this.strings = strings;
		this.args = args;
		this.handler = handler;
		this.options = options;

		this.state = null;
		this.source = null;
		this.active = false;
		this.executed = false;
		this.settled = false;
		this.built = null;
		this.trace = null;
		this.aborts = null;
		this.streaming = false;
		this.cursorFn = null;
		this.cursorRows = 0;

		this.originError = handler.debug ? new Error() : null;
		if (this.tagged && !handler.debug && !origins.has(strings)) {
			origins.set(strings, located());
		}
	}

	static get [Symbol.species]() {
		return Promise;
	}

	join(items: Iterable<unknown>) {
		const kept = [...items].filter((x) => x !== false && x !== null && x !== undefined),
			joined = new Query(joinStrings, [new Join(this, kept)], this.handler);

		void Object.defineProperty(joined, "length", { value: kept.length });
		return joined;
	}

	resolve(x: unknown) {
		if (this.aborts) {
			this.aborts();
		}
		this.active = false;
		this.settled = true;
		traced(this, null, x);
		this.fulfil(x);
	}

	reject(x: unknown) {
		if (this.aborts) {
			this.aborts();
		}
		this.active = false;
		this.settled = true;
		traced(this, x);
		this.fail(x);
	}

	get origin() {
		return this.originError
			? this.originError.stack
			: (this.tagged && origins.get(this.strings)) || "";
	}

	get statement() {
		return this.source && statement(this.source);
	}

	build() {
		return this.built || (this.built = build(this, this.handler.options));
	}

	get text() {
		return this.build().text;
	}

	get parameters() {
		return this.build().values;
	}

	[util.inspect.custom](
		depth: number,
		options: util.InspectOptionsStylized,
		inspect: typeof util.inspect,
	) {
		if (!this.handler.debug) {
			return "Query {}";
		}

		let x;
		try {
			x = this.build();
		} catch (error) {
			return "Query { " + (error instanceof Error ? error.message : util.inspect(error)) + " }";
		}
		return "Query " + inspect({ text: x.text, parameters: x.values }, options);
	}

	/**
	 * Cancels this Query: removes it from the queue if it has not been sent, and otherwise sends a
	 * cancel request.
	 *
	 * @returns A promise that rejects if the cancel request cannot be sent (say, because the
	 *   network is down). A cancel request is only a best effort, so leaving the rejection
	 *   unhandled does not crash the process; the query then runs until it finishes on its own.
	 */
	cancel() {
		const cancelled = this.handler.cancel ? this.handler.cancel(this) : Promise.resolve();
		cancelled.catch(() => {});
		return cancelled;
	}

	/**
	 * Cancels this Query (see `cancel()`) when `signal` aborts, or right away if it has aborted.
	 *
	 * @param signal An AbortSignal; if null or undefined, this does nothing.
	 * @returns This Query.
	 */
	signal(signal: AbortSignal | null | undefined) {
		if (!signal || this.settled) {
			return this;
		}

		// Returns nothing, because Node's EventTarget rethrows the rejection of a promise that a
		// listener returns, as an uncaught exception
		const abort = () => {
			void this.cancel();
		};
		if (signal.aborted) {
			abort();
			return this;
		}

		signal.addEventListener("abort", abort, { once: true });
		this.aborts = () => {
			this.aborts = null;
			signal.removeEventListener("abort", abort);
		};
		return this;
	}

	simple() {
		this.options.simple = true;
		this.options.prepare = false;
		return this;
	}

	async readable() {
		void this.simple();
		this.streaming = true;
		return this;
	}

	async writable() {
		void this.simple();
		this.streaming = true;
		return this;
	}

	cursor(rows: number | CursorFn = 1, fn?: CursorFn) {
		this.options.simple = false;
		if (typeof rows === "function") {
			fn = rows;
			rows = 1;
		}

		this.cursorRows = rows;

		if (typeof fn === "function") {
			this.cursorFn = fn;
			return this;
		}

		let prev: ((value?: unknown) => void) | undefined;
		return {
			[Symbol.asyncIterator]: () => ({
				next: () => {
					if (this.executed && !this.active) {
						return { done: true };
					}

					if (prev) {
						prev();
					}
					const promise = new Promise((resolve, reject) => {
						this.cursorFn = (value) => {
							resolve({ value, done: false });
							return new Promise((r) => (prev = r));
						};
						this.resolve = (x) => {
							this.active = false;
							this.settled = true;
							traced(this, null, x);
							resolve({ done: true });
						};
						this.reject = (x) => {
							this.active = false;
							this.settled = true;
							traced(this, x);
							reject(x);
						};
					});
					void this.execute();
					return promise;
				},
				return() {
					if (prev) {
						prev(CLOSE);
					}
					return { done: true };
				},
			}),
		};
	}

	describe() {
		this.options.simple = false;
		this.onlyDescribe = this.options.prepare = true;
		return this;
	}

	stream() {
		throw new Error(".stream has been renamed to .forEach");
	}

	forEach(fn: (row: any, result: any) => unknown) {
		this.forEachFn = fn;
		this.handle();
		return this;
	}

	raw() {
		this.isRaw = true;
		return this;
	}

	values() {
		this.isRaw = "values";
		return this;
	}

	handle() {
		if (this.executed) {
			return;
		}

		this.executed = true;
		queueMicrotask(() => this.run());
	}

	run() {
		const t = channels.query;
		if (t && active(t)) {
			start(t, (this.trace = context(this)), () => this.handler(this));
		} else {
			this.handler(this);
		}
	}

	execute() {
		this.handle();
		return this;
	}

	// oxlint-disable-next-line unicorn/no-thenable -- a Query runs when it is first awaited: then() starts it
	then<TResult1 = any, TResult2 = never>(
		fulfilled?: ((value: any) => TResult1 | PromiseLike<TResult1>) | null,
		rejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | null,
	): Promise<TResult1 | TResult2> {
		this.handle();
		return super.then(fulfilled, rejected);
	}

	catch<TResult = never>(
		rejected?: ((reason: any) => TResult | PromiseLike<TResult>) | null,
	): Promise<any> {
		this.handle();
		return super.catch(rejected);
	}

	finally(fn?: (() => void) | null): Promise<any> {
		this.handle();
		return super.finally(fn);
	}
}

function context(q: Query): postgres.QueryTrace {
	const options = q.handler.options;
	let text = null;
	if (q.strings.length) {
		try {
			text = q.text;
		} catch {
			text = null;
		}
	}
	return {
		query: text,
		parameters: undefined,
		database: options.database,
		user: userName(options),
		host: null,
		port: null,
		connection: null,
		statement: null,
		command: null,
		count: null,
		queued: now(),
		sent: null,
		firstByte: null,
		complete: null,
	};
}

/** Ends the trace of `q`, if it has one, with `error` (null for success) and `result` */
function traced(q: Query, error: unknown, result?: unknown) {
	const x = q.trace,
		t = channels.query;
	if (x === null || t === null) {
		return;
	}
	q.trace = null;
	x.complete = now();
	if (result && typeof result === "object" && "command" in result) {
		// A Result, or a COPY stream once it has finished
		const done = result as { command: string | null; count: number | null };
		x.command = done.command;
		x.count = done.count;
	}
	finish(t, x, error, result);
}

function located() {
	const limit = Error.stackTraceLimit;
	Error.stackTraceLimit = 8;
	try {
		return trim(new Error().stack || "");
	} catch {
		return "";
	} finally {
		Error.stackTraceLimit = limit;
	}
}

function trim(stack: string) {
	const lines = stack.split("\n"),
		i = lines.findIndex((line, j) => j > 0 && !ours(line));

	return i === -1 ? stack : lines.slice(0, i + 1).join("\n");
}
