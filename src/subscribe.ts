import { own } from "./connection.ts";
import { log_at, log, reason, target } from "./log.ts";
import type { LogLevel } from "@logtape/logtape";
import type postgres from "../types/index.js";
import type { Duplex } from "stream";
import type { Options, Timer, Timers } from "./index.ts";
import type { Failure } from "./errors.ts";

/** A subscriber of an event: `fn` gets each change; `onsubscribe` is called once the stream is up */
type Subscriber = {
	fn: (row: postgres.Row | null, info: postgres.ReplicationEvent, event: string) => unknown;
	onsubscribe: () => void;
	onerror?: (error: Error) => void;
};

/** A Begin message, as parse() reports it */
type Begin = { lsn: bigint; time: Date; xid: number };

/** A Commit message, as parse() reports it */
type Commit = { lsn: bigint; end: bigint };

/**
 * A change of a row, as parse() reports it: a public ReplicationEvent, before change() adds the
 * transaction's `lsn`, `time` and `xid`
 */
type Change = {
	command: "insert" | "update" | "delete" | "truncate";
	relation: postgres.RelationInfo;
	key?: boolean;
	old?: postgres.Row | null;
	cascade?: boolean;
	restartIdentity?: boolean;
} & Partial<postgres.TransactionInfo>;

/** Gets each message that parse() reads: a Begin, a Commit, or a change of a row */
type Message = {
	begin(x: Begin): void;
	commit(x: Commit): void;
	change(row: postgres.Row | null, info: Change): void;
};

const noop = (..._: any[]) => {},
	status_interval = 10000,
	epoch = BigInt(Date.UTC(2000, 0, 1)) * 1000n;

const lsn_to_string = (x: bigint) =>
	(x >> 32n).toString(16).toUpperCase() + "/" + (x & 0xffffffffn).toString(16).toUpperCase();

/** @returns whether `x` is a thenable: a promise of any realm or implementation, as a handler may return */
function thenable(x: unknown): x is PromiseLike<unknown> {
	return x !== null && x !== undefined && typeof (x as { then?: unknown }).then === "function";
}

export default function Subscribe(
	postgres: (options: Record<string, any>) => any,
	options: Options,
) {
	const subscribers = new Map<string, Set<Subscriber>>(),
		persistent = !!options.slot,
		slot = options.slot || "postgresjs_" + Math.random().toString(36).slice(2),
		// The pid and secret key of the backend that streams the replication. `subscribe`
		// returns this object to its caller.
		state: { pid?: number; secret?: number } = {},
		timers = options.timers,
		// The pool's target, as the log lines name it
		where = target(options);

	let connection: Promise<unknown> | null,
		current: ReturnType<typeof Stream> | null = null,
		ended = false,
		retries = 0,
		// How many times in a row the stream restarted to deliver again a transaction that a subscriber
		// failed (see fail()); the backoff of the restarts counts these too, so that a subscriber that
		// fails the same transaction every time does not restart the stream at once, forever
		replays = 0,
		// The LSN of the latest transaction that a subscriber failed, until it is handled; the replays
		// end then, not when an earlier transaction, delivered again before it, is handled
		poison: bigint | null = null;

	const sql = (subscribe.sql = postgres({
		...options,
		transform: { column: {}, value: {}, row: {} },
		max: 1,
		idle_timeout: null,
		max_lifetime: null,
		connection: {
			...options.connection,
			replication: "database",
		},
		onclose: () => {
			if (current) {
				current.stop();
			}
			current = null;
			state.pid = state.secret = undefined;
			if (!ended) {
				restart();
			}
		},
		no_subscribe: true,
		role: "replication",
	}));

	const end = sql.end,
		close = sql.close;

	sql.end = async () => {
		ended = true;
		if (current) {
			await current.finish();
		}
		return end();
	};

	sql.close = async () => {
		if (current) {
			await current.finish();
		}
		return close();
	};

	return subscribe;

	async function subscribe(
		event: string,
		fn: Subscriber["fn"],
		onsubscribe: () => void = noop,
		onerror?: Subscriber["onerror"],
	) {
		event = parse_event(event);

		if (!connection) {
			connection = init();
		}

		const subscriber = { fn, onsubscribe, onerror },
			fns = subscribers.get(event) ?? new Set<Subscriber>();
		fns.add(subscriber);
		subscribers.set(event, fns);

		const unsubscribe = () => {
			fns.delete(subscriber);
			if (fns.size === 0) {
				subscribers.delete(event);
			}
		};

		return connection.then(
			() => {
				onsubscribe();
				return { unsubscribe, state, sql };
			},
			(error: Error) => {
				unsubscribe();
				connection = null;
				throw error;
			},
		);
	}

	function restart() {
		// At once the first time; then, after a failed restart or for a replay, with an exponential
		// backoff of at most 10 s
		const delay =
			retries === 0 && replays === 0 ? 0 : Math.min(100 * 2 ** (retries + replays), 10000);
		retries++;
		log.subscribe.warn(
			"restarting replication from slot {slot} on {target} in {delay} ms (attempt {retries}" +
				(replays ? ", replay {replays} of a transaction that a subscriber failed)" : ")") +
				(persistent
					? ""
					: "; the temporary slot was dropped with its connection, so changes committed before the new one exists are not delivered"),
			{ slot, target: where, delay, retries, replays },
		);
		connection = new Promise<void>((r) => timers.setTimeout(r, delay))
			.then(() => (ended ? null : init()))
			.then(
				(x) => {
					retries = 0;
					if (!ended) {
						subscribers.forEach((event) => event.forEach(({ onsubscribe }) => onsubscribe()));
					}
					return x;
				},
				(error: Error) => {
					report(error, "replication from slot {slot} on {target} failed", "", "warning", {
						slot,
						target: where,
					});
					if (!ended) {
						restart();
					}
				},
			);
		connection.catch(noop);
	}

	async function init() {
		if (!options.publications) {
			throw new Error("Missing publication names");
		}

		await sql
			.unsafe(
				`CREATE_REPLICATION_SLOT ${slot}${persistent ? "" : " TEMPORARY"} LOGICAL pgoutput NOEXPORT_SNAPSHOT`,
			)
			.then(
				() => {
					log_at(
						log.subscribe,
						persistent ? "info" : "debug",
						persistent
							? "created replication slot {slot} on {target}"
							: "created temporary replication slot {slot} on {target}",
						{ slot, target: where },
					);
				},
				(error: Failure) => {
					if (!persistent || error.code !== "42710") {
						throw error;
					}
					log.subscribe.debug("using existing replication slot {slot} on {target}", {
						slot,
						target: where,
					});
				},
			);

		const query = sql.unsafe(
			`START_REPLICATION SLOT ${slot} LOGICAL 0/0 (proto_version '1', publication_names '${options.publications}')`,
		);
		query.catch(noop);
		const stream = await query.writable();
		current = Stream(stream);
		state.pid = query.state && query.state.pid;
		state.secret = query.state && query.state.secret;
		log.subscribe.info(
			"replication stream started from slot {slot} on {target} for publications {publications} (backend pid {pid})",
			{ slot, target: where, publications: options.publications, pid: state.pid },
		);
		return current;
	}

	function Stream(stream: Duplex) {
		const relations: Record<number, postgres.RelationInfo> = {};
		let acked = 0n,
			received = 0n,
			transaction: Transaction | null = null,
			// The promise of the subscribers' handling of the changes so far, while one is pending
			queue: Promise<unknown> | null = null,
			failed = false,
			stopped = false,
			timer: Timer | null = timers.setTimeout(tick, status_interval),
			soon: ReturnType<Timers["setImmediate"]> | null = null;

		stream.on("data", data);
		stream.on("error", (error: Error) => {
			if (!failed) {
				report(error, "replication from slot {slot} on {target} failed", "", "warning", {
					slot,
					target: where,
				});
			}
		});
		stream.on("close", () => {
			const unexpected = !stopped;
			stop();
			if (unexpected) {
				close();
			}
		});

		return { stop, finish };

		function data(x: Buffer) {
			if (x[0] === 0x77) {
				received = max(received, x.readBigUInt64BE(9));
				parse(
					x.subarray(25),
					relations,
					sql.options.parsers,
					{ begin, commit, change },
					options.transform,
				);
			} else if (x[0] === 0x6b) {
				received = max(received, x.readBigUInt64BE(1));
				if (idle()) {
					acked = max(acked, received);
				}
				if (x[17]) {
					status();
				}
			}
		}

		function begin(x: Begin) {
			transaction = { lsn: x.lsn, time: x.time, xid: x.xid };
		}

		function commit(x: Commit) {
			if (began("a Commit")) {
				transaction = null;
				run(() => {
					if (poison === null || x.lsn >= poison) {
						replays = 0;
						poison = null;
					}
					confirm(x.end);
				});
			}
		}

		function change(row: postgres.Row | null, info: Change) {
			const open = began("a change");
			if (open) {
				info.lsn = lsn_to_string(open.lsn);
				info.time = open.time;
				info.xid = open.xid;
				run(() => handle(row, info));
			}
		}

		/**
		 * @param what - the message that came, for the error
		 * @returns the transaction that the stream is in; or null, having failed the stream, as the
		 *   message came outside one
		 */
		function began(what: string) {
			if (transaction === null) {
				stream.destroy(new Error("The replication stream sent " + what + " before a Begin"));
			}
			return transaction;
		}

		function run(fn: () => unknown) {
			if (failed || stopped) {
				return;
			}

			if (queue) {
				queue = queue.then(() => (failed || stopped ? null : fn()));
				return;
			}

			const result = fn();
			if (result instanceof Promise) {
				queue = result;
				stream.pause();
				drain(result);
			}
		}

		/** Resumes the stream once `at` (the `queue`), and what queued behind it, have settled */
		function drain(at: Promise<unknown>) {
			at.then(() => {
				if (queue !== at) {
					if (queue) {
						drain(queue);
					}
					return;
				}

				queue = null;
				if (!stopped && !failed) {
					stream.resume();
				}
			}, noop);
		}

		/** Confirms the transaction whose changes the subscribers have handled, up to `lsn`, the LSN of its end */
		function confirm(lsn: bigint) {
			acked = max(acked, lsn);
			if (persistent && !soon) {
				soon = timers.setImmediate(() => {
					soon = null;
					status();
				});
			}
		}

		function handle(row: postgres.Row | null, info: Change) {
			const path = info.relation.schema + "." + info.relation.table,
				key =
					row && info.relation.keys.length ? "=" + info.relation.keys.map((x) => row[x.name]) : "",
				pending: Promise<unknown>[] = [];

			call(pending, "*", row, info);
			call(pending, "*:" + path, row, info);
			if (key) {
				call(pending, "*:" + path + key, row, info);
			}
			call(pending, info.command, row, info);
			call(pending, info.command + ":" + path, row, info);
			if (key) {
				call(pending, info.command + ":" + path + key, row, info);
			}
			return pending.length ? Promise.all(pending) : null;
		}

		function call(
			pending: Promise<unknown>[],
			event: string,
			row: postgres.Row | null,
			info: Change,
		) {
			const fns = subscribers.get(event);
			if (fns) {
				fns.forEach((subscriber) => {
					let result: unknown;
					try {
						// The change has the transaction's fields by now: it is a ReplicationEvent
						result = subscriber.fn(row, info as postgres.ReplicationEvent, event);
					} catch (error) {
						return fail(error, subscriber, event);
					}
					if (thenable(result)) {
						pending.push(Promise.resolve(result).catch((error) => fail(error, subscriber, event)));
					}
				});
			}
		}

		/**
		 * Reports that `subscriber` (of `event`) threw or rejected, and, with a persistent slot, ends
		 * the stream so that the transaction is delivered again, once the stream has restarted.
		 */
		function fail(error: unknown, subscriber: Subscriber, event: string) {
			const retrying = persistent && !failed;
			report(
				error,
				"subscriber of {event} on {target} failed",
				retrying
					? "; restarting replication from slot {slot} to deliver the transaction again"
					: persistent
						? ""
						: "; the callback is not retried",
				persistent ? "warning" : "error",
				{ event, target: where, slot },
				subscriber,
			);
			if (!retrying) {
				return;
			}

			failed = true;
			replays++;
			if (transaction !== null && (poison === null || transaction.lsn > poison)) {
				poison = transaction.lsn;
			}
			queue = null;
			stop();
			stream.destroy(new Error("A subscriber failed, so the transaction is delivered again"));
			close();
		}

		function idle() {
			return !transaction && !queue;
		}

		function tick() {
			timer = null;
			if (stopped) {
				return;
			}

			status();
			timer = timers.setTimeout(tick, status_interval);
		}

		function status() {
			if (stopped || stream.destroyed || !stream.writable) {
				return;
			}

			const x = Buffer.alloc(34);
			x[0] = 0x72;
			x.writeBigUInt64BE(acked, 1);
			x.writeBigUInt64BE(acked, 9);
			x.writeBigUInt64BE(acked, 17);
			x.writeBigInt64BE(BigInt(Date.now()) * 1000n - epoch, 25);
			stream.write(x);
		}

		async function finish() {
			if (queue) {
				await queue.catch(noop);
			}
			if (!failed) {
				if (idle()) {
					acked = max(acked, received);
				}
				status();
			}
			stop();
			if (!stream.destroyed) {
				await new Promise((r) => {
					stream.once("close", r);
					stream.end();
				});
			}
			log.subscribe.debug("replication from slot {slot} on {target} stopped", {
				slot,
				target: where,
			});
		}

		function stop() {
			if (stopped) {
				return;
			}

			stopped = true;
			if (timer) {
				timers.clearTimeout(timer);
			}
			if (soon) {
				timers.clearImmediate(soon);
			}
			timer = soon = null;
		}
	}

	/**
	 * Gives `error` to the onerror handlers (`subscriber`'s, or every subscriber's for an error of
	 * the stream), and logs it: at `level`, or at error if no handler got it, as this line is then
	 * the only report.
	 * @param what - what failed, with `{name}` placeholders of `properties`
	 * @param then - what follows, such as `; restarting ...`; "" for nothing
	 */
	function report(
		error: unknown,
		what: string,
		then: string,
		level: LogLevel,
		properties: Record<string, unknown>,
		subscriber?: Subscriber,
	) {
		const handlers = subscriber
			? [subscriber.onerror]
			: [...subscribers.values()].flatMap((subs) => [...subs].map((s) => s.onerror));

		const listeners = handlers.filter(
			(fn): fn is (error: Error) => void => typeof fn === "function",
		);
		listeners.forEach((fn) => fn(error as Error));
		log_at(
			log.subscribe,
			listeners.length ? level : "error",
			what + (listeners.length ? "" : " (no onerror handler)") + then + ": {reason}",
			{ ...properties, reason: reason(error), error },
		);
	}
}

/** The transaction that the replication messages are part of, from its Begin to its Commit */
type Transaction = {
	lsn: bigint;
	/** When it committed */
	time: Date;
	xid: number;
};

function max(a: bigint, b: bigint) {
	return a > b ? a : b;
}

function Time(x: bigint) {
	return new Date(Date.UTC(2000, 0, 1) + Number(x / 1000n));
}

function parse(
	x: Buffer,
	relations: Record<number, postgres.RelationInfo>,
	parsers: Options["parsers"],
	message: Message,
	transform: Options["transform"],
) {
	const type = x[0];
	if (type === 82) {
		let i = 1;
		const r: postgres.RelationInfo = (relations[x.readUInt32BE(i)] = {
			schema: x.toString("utf8", (i += 4), (i = x.indexOf(0, i))) || "pg_catalog",
			table: x.toString("utf8", i + 1, (i = x.indexOf(0, i + 1))),
			columns: Array(x.readUInt16BE((i += 2))),
			keys: [],
		});
		i += 2;

		let column_index = 0,
			column: postgres.ColumnInfo;

		while (i < x.length) {
			column = r.columns[column_index++] = {
				key: x[i++],
				name: transform.column.from
					? transform.column.from(x.toString("utf8", i, (i = x.indexOf(0, i))))
					: x.toString("utf8", i, (i = x.indexOf(0, i))),
				type: x.readUInt32BE((i += 1)),
				parser: parsers[x.readUInt32BE(i)],
				atttypmod: x.readUInt32BE((i += 4)),
			};

			if (column.key) {
				r.keys.push(column);
			}
			i += 4;
		}
	} else if (type === 66) {
		message.begin({
			lsn: x.readBigUInt64BE(1),
			time: Time(x.readBigInt64BE(9)),
			xid: x.readUInt32BE(17),
		});
	} else if (type === 67) {
		message.commit({ lsn: x.readBigUInt64BE(2), end: x.readBigUInt64BE(10) });
	} else if (type === 73) {
		const relation = relations[x.readUInt32BE(1)];
		message.change(tuples(x, relation.columns, 8, transform).row, {
			command: "insert",
			relation,
		});
	} else if (type === 68) {
		let i = 1;
		const relation = relations[x.readUInt32BE(i)];
		i += 4;
		const key = x[i] === 75;
		message.change(
			key || x[i] === 79 ? tuples(x, relation.columns, (i += 3), transform).row : null,
			{ command: "delete", relation, key },
		);
	} else if (type === 85) {
		let i = 1;
		const relation = relations[x.readUInt32BE(i)];
		i += 4;
		const key = x[i] === 75;
		const xs = key || x[i] === 79 ? tuples(x, relation.columns, (i += 3), transform) : null;

		if (xs) {
			i = xs.i;
		}

		const { row } = tuples(x, relation.columns, i + 3, transform);
		message.change(row, { command: "update", relation, key, old: xs && xs.row });
	} else if (type === 84) {
		const count = x.readUInt32BE(1),
			flags = x[5];
		for (let i = 0; i < count; i++) {
			message.change(null, {
				command: "truncate",
				relation: relations[x.readUInt32BE(6 + i * 4)],
				cascade: (flags & 1) === 1,
				restartIdentity: (flags & 2) === 2,
			});
		}
	}
}

function tuples(
	x: Buffer,
	columns: postgres.ColumnInfo[],
	xi: number,
	transform: Options["transform"],
) {
	let type: number, column: postgres.ColumnInfo, value: unknown;

	const row: Record<string, unknown> = {};
	for (let i = 0; i < columns.length; i++) {
		type = x[xi++];
		column = columns[i];
		value =
			type === 110
				? null
				: type === 117
					? undefined
					: column.parser(x.toString("utf8", xi + 4, (xi += 4 + x.readUInt32BE(xi))));

		// The transform gets the replication's column record, not a query's Column, which it is declared for
		value = transform.value.from
			? transform.value.from(value, column as unknown as postgres.Column<string>)
			: value;
		if (column.name === "__proto__") {
			own(row, column.name, value);
		} else {
			row[column.name] = value;
		}
	}

	return { i: xi, row: transform.row.from ? transform.row.from(row) : row };
}

function parse_event(x: string) {
	// Every part is optional, so any string matches
	const [, command, path, key] =
		x.match(/^(\*|insert|update|delete|truncate)?:?([^.]+?\.?[^=]+)?=?(.+)?/i) ?? [];

	return (
		(command || "*") +
		(path ? ":" + (path.indexOf(".") === -1 ? "public." + path : path) : "") +
		(key ? "=" + key : "")
	);
}
