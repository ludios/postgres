import { Pipe } from "./net.ts";
import type { Clock, Random, End } from "./net.ts";

/** A prepared statement of a session */
type Prepared = { text: string; ast: Ast; stale: boolean; shape: string };

/** A portal of a session: its statement, parameter values, and how many rows it has given */
type Portal = {
	p: Prepared;
	values: (string | null)[];
	row: number;
	ordered?: boolean;
	slept?: boolean;
};

/** What parse() makes of a query text: a transaction control command, or a select of the test's grammar */
type Ast =
	| { control: string; params: number; select: false }
	| {
			control?: undefined;
			select: true;
			params: number;
			id: string;
			scope: string;
			rows: string | null;
			fail: string | null;
			sleep: string | null;
	  };

const select =
		/^select (\S+) as id, (\S+) as scope(?: from rows\((\S+)\))?(?: fail\((\S+)\))?(?: sleep\((\S+)\))?$/i,
	control =
		/^(begin|commit|end|rollback|savepoint \w+|release savepoint \w+|rollback to savepoint \w+)\b/i;

export function Server({
	clock,
	random,
	delay,
	split,
	hosts = 1,
	log = null,
}: {
	clock: ReturnType<typeof Clock>;
	random: ReturnType<typeof Random>;
	delay: number;
	split: number;
	hosts?: number;
	log?: ((line: string) => void) | null;
}) {
	const { setTimeout } = clock.timers,
		sessions = new Set<ReturnType<typeof Session>>(),
		violations: string[] = [],
		// When each connection attempt that the startup mode refused came, on the clock
		attempts: number[] = [],
		// The session that each scope's queries reached
		scopes = new Map<number, number>(),
		// Whether each scope's transaction committed or rolled back
		outcomes = new Map<number, string>(),
		// The stale plans by query id: the session's status when the plan went stale, and the retries
		stale = new Map<number, { status: string; retries: number }>(),
		// The latest query id of each scope
		latest = new Map<number, number>(),
		startup = [...Array(hosts)].map(() => "ready");
	let pids = 1000,
		peak = 0;

	return {
		sessions,
		violations,
		attempts,
		outcomes,
		startup,
		get peak() {
			return peak;
		},
		socket,
		kill: (x: Session) => x.fatal("57P01", "terminating connection due to administrator command"),
		close: (x: Session, reset: boolean) => (reset ? x.end.destroy() : x.end.end()),
		stale: (x: Session) => x.prepared.forEach((p) => (p.stale = true)),
		deallocate: (x: Session) => {
			x.prepared.forEach((p, name) => x.wiped.add(name));
			x.prepared.clear();
		},
		retype: (x: Session) => (x.shape = x.shape === "a" ? "b" : "a"),
		commitRollback: (x: Session) => (x.commitRollback = true),
	};

	function socket(host = 0) {
		const { client, server } = Pipe({ clock, random, delay, split });
		Session(server, host);
		return client;
	}

	function violation(x: string) {
		violations.push(x);
	}

	/** A session, on the server end of a Pipe: a connection as the server sees it */
	type Session = ReturnType<typeof Session>;

	function Session(end: End, host: number) {
		const prepared = new Map<string, Prepared>(),
			portals = new Map<string, Portal>(),
			queue: Buffer[] = [];
		let incoming = Buffer.alloc(0),
			started = false,
			busy = false,
			discard = false,
			status = "I",
			txScope = 0,
			txScopes = new Set<number>(),
			// The statement that sleeps, with how to cancel it
			sleeping: { cancel: (cancelled?: boolean) => void } | null = null,
			gone = false;

		const x = {
			id: ++pids,
			secret: random.int(1, 1e9),
			end,
			prepared,
			wiped: new Set(),
			shape: "a",
			commitRollback: false,
			get status() {
				return status;
			},
			fatal,
			cancel: () => sleeping && sleeping.cancel(true),
		};

		end.on("data", (data: Buffer) => {
			incoming = Buffer.concat([incoming, data]);
			while (incoming.length >= (started ? 5 : 4)) {
				const length = started ? incoming.readInt32BE(1) + 1 : incoming.readInt32BE(0);
				if (incoming.length < length) {
					break;
				}

				const message = incoming.subarray(0, length);
				incoming = incoming.subarray(length);
				if (started) {
					queue.push(message);
					pump();
				} else {
					first(message);
				}
			}
		});
		end.on("close", () => {
			gone = true;
			if (status !== "I") {
				txScopes.forEach((s) => outcomes.set(s, "rollback"));
			}
			sessions.delete(x);
			if (sleeping) {
				sleeping.cancel();
			}
		});
		end.on("error", () => {});

		return x;

		function first(message: Buffer) {
			const code = message.readInt32BE(4);
			if (code === 80877103) {
				end.write("N");
				return;
			}

			if (code === 80877102) {
				const pid = message.readInt32BE(8),
					secret = message.readInt32BE(12);
				for (const s of sessions) {
					if (s.id === pid && s.secret === secret && s.cancel) {
						s.cancel();
					}
				}
				end.end();
				return;
			}
			started = true;
			const mode = startup[host];
			if (mode !== "ready") {
				attempts.push(clock.now);
			}
			if (mode === "close") {
				end.end();
				return;
			}

			if (mode === "error") {
				end.end(error("FATAL", "53300", "sorry, too many clients already"));
				return;
			}

			if (mode === "hang") {
				return;
			}

			sessions.add(x);
			peak = Math.max(peak, [...sessions].filter((s) => s.end.writable).length);
			end.write(
				Buffer.concat([
					msg("R", i32(0)),
					...Object.entries({
						server_version: "16.0",
						client_encoding: "UTF8",
						DateStyle: "ISO, MDY",
						TimeZone: "UTC",
						integer_datetimes: "on",
						standard_conforming_strings: "on",
					}).map(([k, v]) => msg("S", str(k), str(v))),
					msg("K", i32(x.id), i32(x.secret)),
					ready(),
				]),
			);
		}

		function fatal(code: string, message: string) {
			if (!gone) {
				end.end(error("FATAL", code, message));
			}
		}

		function pump() {
			while (true) {
				if (busy || gone || !queue.length) {
					break;
				}
				handle(queue.shift()!);
			}
		}

		function handle(m: Buffer) {
			const type = String.fromCharCode(m[0]),
				r = reader(m, 5);

			if (log) {
				log(
					x.id +
						" " +
						status +
						(discard ? " discard " : " ") +
						type +
						" " +
						m
							.subarray(5)
							.toString()
							.replace(/[^ -~]+/g, ".")
							.slice(0, 90),
				);
			}
			if (discard && type !== "S") {
				return;
			}

			if (type === "P") {
				const name = r.str(),
					text = r.str();
				const ast = parse(text);
				if (!ast) {
					return fail("42601", 'syntax error at or near "' + text.slice(0, 10) + '"');
				}

				if (status === "E" && !ast.control) {
					return fail(
						"25P02",
						"current transaction is aborted, commands ignored until end of transaction block",
					);
				}

				if (name && prepared.has(name)) {
					violation('parse of statement "' + name + '" that already exists in session ' + x.id);
					return fail("42P05", 'prepared statement "' + name + '" already exists');
				}
				prepared.set(name, { text, ast, stale: false, shape: x.shape });
				x.wiped.delete(name);
				reply(msg("1"));
			} else if (type === "B") {
				const portal = r.str(),
					name = r.str();
				// The parameter formats, which this server ignores
				r.i16s();
				const n = r.i16(),
					values = [...Array(n)].map(() => r.bytes());
				const p = prepared.get(name);
				if (!p) {
					if (name && !x.wiped.has(name)) {
						violation('bind of statement "' + name + '" that session ' + x.id + " never had");
					}
					return fail("26000", 'prepared statement "' + name + '" does not exist');
				}
				portals.set(portal, {
					p,
					values: values.map((v) => (v === null ? null : v.toString())),
					row: 0,
				});
				reply(msg("2"));
			} else if (type === "D") {
				const kind = r.byte(),
					name = r.str();
				const p = kind === "S" ? prepared.get(name) : portals.get(name)?.p;
				if (!p) {
					if (kind === "S" && name && !x.wiped.has(name)) {
						violation('describe of statement "' + name + '" that session ' + x.id + " never had");
					}
					return fail(kind === "S" ? "26000" : "34000", "does not exist");
				}
				if (p.ast.select && p.shape !== x.shape) {
					return fail("0A000", "cached plan must not change result type");
				}

				if (kind === "S") {
					reply(msg("t", i16(p.ast.params), ...[...Array(p.ast.params)].map(() => i32(23))));
				}
				reply(p.ast.select ? columns(x.shape) : msg("n"));
			} else if (type === "E") {
				const name = r.str(),
					limit = r.i32();
				const portal = portals.get(name);
				if (!portal) {
					violation('execute of portal "' + name + '" that does not exist in session ' + x.id);
					return fail("34000", 'portal "' + name + '" does not exist');
				}
				execute(portal, limit, false);
			} else if (type === "Q") {
				const text = r.str();
				const ast = parse(text);
				if (!ast) {
					fail("42601", "syntax error");
					discard = false;
					return reply(ready());
				}
				execute({ p: { text, ast, stale: false, shape: x.shape }, values: [], row: 0 }, 0, true);
			} else if (type === "S") {
				discard = false;
				if (status === "I") {
					portals.clear();
				}
				reply(ready());
			} else if (type === "C") {
				if (r.byte() === "S") {
					prepared.delete(r.str());
				} else {
					portals.delete(r.str());
				}
				reply(msg("3"));
			} else if (type === "X") {
				end.end();
			} else if (type !== "H") {
				fail("08P01", "unsupported message " + type);
			}
		}

		function execute(portal: Portal, limit: number, simple: boolean) {
			const { ast } = portal.p,
				value = (v: string) => (v[0] === "$" ? Number(portal.values[+v.slice(1) - 1]) : +v),
				done = () => {
					if (simple) {
						discard = false;
						reply(ready());
					}
				};

			if (!ast.select) {
				transaction(ast.control);
				return done();
			}

			const id = value(ast.id),
				scope = value(ast.scope),
				rows = ast.rows ? value(ast.rows) : 1,
				at = ast.fail === null ? -1 : value(ast.fail),
				ms = ast.sleep === null ? 0 : value(ast.sleep);

			bind(scope);
			check(id, scope);
			if (!portal.ordered) {
				order(id, scope);
			}
			portal.ordered = true;

			if (portal.p.stale || (ast.select && portal.p.shape !== x.shape)) {
				if (!stale.has(id)) {
					stale.set(id, { status, retries: 0 });
				}
				fail("0A000", "cached plan must not change result type");
				return done();
			}

			if (status === "E") {
				fail(
					"25P02",
					"current transaction is aborted, commands ignored until end of transaction block",
				);
				return done();
			}

			if (ms && !portal.slept) {
				busy = true;
				let timer: ReturnType<typeof setTimeout> | null = null;
				sleeping = {
					cancel: (cancelled?: boolean) => {
						clock.timers.clearTimeout(timer);
						sleeping = null;
						busy = false;
						if (cancelled) {
							fail("57014", "canceling statement due to user request");
							done();
							pump();
						}
					},
				};
				timer = setTimeout(() => {
					sleeping = null;
					busy = false;
					portal.slept = true;
					execute(portal, limit, simple);
					pump();
				}, ms);
				return;
			}

			if (simple) {
				reply(columns(x.shape));
			}
			const out: Buffer[] = [];
			while (portal.row < rows) {
				if (portal.row === at) {
					reply(Buffer.concat(out));
					fail("22012", "division by zero");
					return done();
				}
				if (limit && out.length === limit) {
					reply(Buffer.concat([...out, msg("s")]));
					return;
				}
				out.push(msg("D", i16(3), ...cell(id), ...cell(scope), ...cell(x.shape === "a" ? 1 : "b")));
				portal.row++;
			}
			reply(Buffer.concat([...out, msg("C", str("SELECT " + out.length))]));
			done();
		}

		function check(id: number, scope: number) {
			const retry = stale.get(id);
			if (retry && ++retry.retries) {
				if (retry.status !== "I") {
					violation(
						"stale plan for query " + id + " retried while the session was " + retry.status,
					);
				}
				if (retry.retries > 1) {
					violation("stale plan for query " + id + " retried " + retry.retries + " times");
				}
			}

			if (scope && scopes.has(scope) && scopes.get(scope) !== x.id) {
				violation(
					"scope " + scope + " reached session " + x.id + " after session " + scopes.get(scope),
				);
			}
			if (scope) {
				scopes.set(scope, x.id);
			}

			if (status !== "I" && scope !== txScope) {
				violation(
					"query " +
						id +
						" of scope " +
						scope +
						" reached session " +
						x.id +
						" inside the transaction of scope " +
						txScope,
				);
			}
		}

		function order(id: number, scope: number) {
			if (!scope) {
				return;
			}

			const latest_id = latest.get(scope);
			if (latest_id !== undefined && latest_id > id) {
				violation(
					"query " +
						id +
						" of scope " +
						scope +
						" reached the server after query " +
						latest.get(scope),
				);
			}
			latest.set(scope, Math.max(id, latest.get(scope) || 0));
		}

		function transaction(command: string) {
			const c = command.toLowerCase();
			if (c === "begin") {
				if (status === "I") {
					txScope = -1;
					txScopes = new Set();
				}
				status = status === "I" ? "T" : status;
				reply(msg("C", str("BEGIN")));
			} else if (c === "commit" || c === "end") {
				const rolled = status === "E" || x.commitRollback;
				x.commitRollback = false;
				txScopes.forEach((s) => outcomes.set(s, rolled ? "rollback" : "commit"));
				status = "I";
				txScope = 0;
				portals.clear();
				reply(msg("C", str(rolled ? "ROLLBACK" : "COMMIT")));
			} else if (c === "rollback") {
				txScopes.forEach((s) => outcomes.set(s, "rollback"));
				status = "I";
				txScope = 0;
				portals.clear();
				reply(msg("C", str("ROLLBACK")));
			} else if (c.startsWith("rollback to")) {
				if (status === "I") {
					fail("25P01", "no transaction");
				} else {
					status = "T";
					reply(msg("C", str("ROLLBACK")));
				}
			} else {
				if (status === "I") {
					fail("25P01", "SAVEPOINT can only be used in transaction blocks");
				} else if (status === "E") {
					fail("25P02", "current transaction is aborted");
				} else {
					reply(msg("C", str(c.startsWith("release") ? "RELEASE" : "SAVEPOINT")));
				}
			}
		}

		function bind(scope: number) {
			if (txScope === -1 && scope) {
				txScope = scope;
				txScopes.add(scope);
			}
		}

		function fail(code: string, message: string) {
			if (status === "T") {
				status = "E";
			}
			discard = true;
			reply(error("ERROR", code, message));
		}

		function reply(bytes: Buffer) {
			if (!gone) {
				end.write(bytes);
			}
		}

		function ready() {
			return msg("Z", Buffer.from(status));
		}

		function parse(text: string): Ast | null {
			const c = text.trim().match(control);
			if (c) {
				return { control: c[1], params: 0, select: false };
			}

			const m = text.trim().match(select);
			if (!m) {
				return null;
			}

			const [, id, scope, rows = null, failure = null, sleep = null] = m.map(
				(group: string | undefined) => group && group.replace(/::int$/, ""),
			);
			const params = Math.max(
				0,
				...[id, scope, rows, failure, sleep]
					.filter((v): v is string => !!v && v[0] === "$")
					.map((v) => +v.slice(1)),
			);
			return { select: true, params, id: id!, scope: scope!, rows, fail: failure, sleep };
		}
	}
}

function columns(shape: string) {
	const column = (name: string, type: number) =>
		Buffer.concat([str(name), i32(0), i16(0), i32(type), i16(4), i32(-1), i16(0)]);
	return msg(
		"T",
		i16(3),
		column("id", 23),
		column("scope", 23),
		column("shape", shape === "a" ? 23 : 25),
	);
}

function cell(x: string | number | null | undefined) {
	if (x === null || x === undefined) {
		return [i32(-1)];
	}

	const b = Buffer.from(String(x));
	return [i32(b.length), b];
}

function error(severity: string, code: string, message: string) {
	return msg(
		"E",
		Buffer.from("S" + severity + "\0V" + severity + "\0C" + code + "\0M" + message + "\0\0"),
	);
}

function reader(b: Buffer, i: number) {
	return {
		byte: () => String.fromCharCode(b[i++]),
		i16: () => {
			i += 2;
			return b.readInt16BE(i - 2);
		},
		i32: () => {
			i += 4;
			return b.readInt32BE(i - 4);
		},
		i16s() {
			return [...Array(this.i16())].map(() => this.i16());
		},
		str: () => {
			const end = b.indexOf(0, i);
			const x = b.toString("utf8", i, end);
			i = end + 1;
			return x;
		},
		bytes() {
			const n = this.i32();
			if (n === -1) {
				return null;
			}
			i += n;
			return b.subarray(i - n, i);
		},
	};
}

function str(x: string) {
	return Buffer.from(x + "\0");
}
function i16(x: number) {
	const b = Buffer.alloc(2);
	b.writeInt16BE(x);
	return b;
}
function i32(x: number) {
	const b = Buffer.alloc(4);
	b.writeInt32BE(x);
	return b;
}
function msg(type: string, ...parts: Buffer[]) {
	const body = Buffer.concat(parts);
	return Buffer.concat([Buffer.from(type), i32(body.length + 4), body]);
}
