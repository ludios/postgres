import path from "path";
import util from "util";
import { Clock, Random } from "./sim/net.ts";
import { Server } from "./sim/server.ts";
import type { End } from "./sim/net.ts";
import { replace_pg_vars } from "./pg_env.ts";

// The pools read no PG* variable of the shell, such as a PGSSLMODE, with which every connection
// would ask the simulated server for TLS
replace_pg_vars({});

const single = process.env.SEED !== undefined,
	first = single ? Number(process.env.SEED) : 1,
	runs = single ? 1 : Number(process.env.RUNS) || 2000,
	modulePath = process.env.MODULE || "../src/index.ts",
	globals = !!process.env.GLOBALS;

const postgres = (
	await import(
		modulePath.startsWith(".")
			? new URL(modulePath, import.meta.url).href
			: path.resolve(modulePath)
	)
).default;

const scenarios: Record<string, { faults: string[]; kinds?: string[] }> = {
	split: { faults: [] },
	errors: { faults: [], kinds: ["query", "rows", "fail", "syntax", "begin", "cursor", "unsafe"] },
	close: { faults: ["close", "reset"] },
	terminate: { faults: ["kill"] },
	stale: { faults: ["stale", "deallocate"] },
	shapes: { faults: ["retype"] },
	commit: { faults: ["commitRollback"], kinds: ["begin", "query"] },
	startup: { faults: ["outage"] },
	mixed: {
		faults: ["kill", "close", "reset", "stale", "deallocate", "retype", "commitRollback", "outage"],
	},
};

let failed = 0;
for (let seed = first; seed < first + runs; seed++) {
	const result = await simulate(seed);
	if (result.violations.length) {
		failed++;
		console.log(
			"\n⛔️ SEED=" + seed + " (" + result.scenario + ")\n  " + result.violations.join("\n  "),
		);
		if (single) {
			console.log("\n" + result.trace.join("\n"));
		}
		if (failed >= (Number(process.env.MAXFAIL) || 10) && !single) {
			break;
		}
	} else if (single) {
		console.log(result.trace.join("\n"));
	}
	if (!single && seed % 100 === 0) {
		process.stdout.write(".");
	}
}

console.log(
	failed
		? "\n⚠️ " + failed + " failing seed" + (failed === 1 ? "" : "s")
		: "\n🎉 " + runs + " seeds",
);
process.exitCode = failed ? 1 : 0;

async function simulate(seed: number) {
	const name = process.env.SCENARIO || Object.keys(scenarios)[seed % Object.keys(scenarios).length],
		scenario = scenarios[name],
		violations: string[] = [],
		trace: string[] = [],
		log = (x: string) => trace.push(String(clock.now).padStart(6) + " " + x),
		random = Random(seed),
		clock = Clock((e) => violations.push("uncaught in a timer: " + ((e && e.stack) || e))),
		clients: End[] = [],
		config = {
			max: random.pick([1, 2, 3, 5]),
			prepare: random.chance(0.8),
			delay: random.pick([0, 1, 5, 20]),
			split: random.pick([0, 0.2, 0.8]),
			scenario: name,
			faults: scenario.faults.length ? random.pick([2, 6, 15]) : 0,
			ops: random.int(5, 60),
			max_pipeline: random.pick([0, 1, 2, 100]),
		},
		wire = single && process.env.WIRE ? (x: string) => log("wire " + x) : undefined,
		server = Server({ clock, random, delay: config.delay, split: config.split, log: wire }),
		stray = (x: any) => violations.push("unhandled: " + ((x && x.stack) || x)),
		restore = globals && fakeGlobals(clock);

	log("config " + JSON.stringify(config));
	process.on("unhandledRejection", stray);
	process.on("uncaughtException", stray);

	const sql = postgres({
		host: "sim",
		port: 5432,
		user: "sim",
		database: "sim",
		max: config.max,
		max_pipeline: config.max_pipeline,
		prepare: config.prepare,
		fetch_types: false,
		connect_timeout: 2,
		idle_timeout: random.pick([0, 1]),
		backoff: (n: number) => (0.5 + random.next() / 2) * Math.min(3 ** n / 100, 20),
		max_lifetime: random.pick([0, 2, 60 * 30]),
		onnotice: () => {},
		timers: clock.timers,
		socket: () => {
			const x = server.socket();
			clients.push(x);
			return x;
		},
	});

	const settled: Settled[] = [];
	let next = 1;

	const kinds = scenario.kinds || [
		"query",
		"query",
		"rows",
		"fail",
		"syntax",
		"sleep",
		"unsafe",
		"begin",
		"reserve",
		"cursor",
	];
	for (let i = 0; i < config.ops; i++) {
		clock.timers.setTimeout(() => settled.push(operation(random.pick(kinds))), random.int(0, 3000));
	}

	for (let i = 0; i < config.faults; i++) {
		clock.timers.setTimeout(fault, random.int(0, 3000));
	}

	let ended = false;
	try {
		await clock.run(10000);
		// Without faults, nothing delays an operation for long; end() would reject a stuck one
		const stuck = settled.filter((x) => !x.done).length;
		if (!config.faults && stuck) {
			violations.push(stuck + " of " + settled.length + " operations still open after 10 s");
		}
		sql.end({ timeout: 1 }).then(
			() => (ended = true),
			(e: Error) => violations.push("end() rejected: " + e.message),
		);
		await clock.run(70000);
	} catch (error) {
		process.off("unhandledRejection", stray);
		process.off("uncaughtException", stray);
		if (restore) {
			restore();
		}
		violations.push(error instanceof Error ? error.message : util.inspect(error));
		return { violations, trace, scenario: name };
	}

	const open = settled.filter((x) => !x.done).length;
	if (open) {
		violations.push(open + " of " + settled.length + " operations never settled");
	}
	if (!ended) {
		violations.push("end() did not resolve");
	}

	violations.push(...server.violations);

	if (server.peak > config.max) {
		violations.push("peak of " + server.peak + " sessions with max " + config.max);
	}
	const burst = Math.max(
		0,
		...server.attempts.map((t) => server.attempts.filter((x) => x >= t && x < t + 1000).length),
	);
	if (burst > 2 * config.max + 4) {
		violations.push(burst + " failed connection attempts within one second");
	}

	if (clock.pending) {
		violations.push(
			clock.pending +
				" timers left after end(), due at " +
				clock
					.pendingTimers()
					.map((x) => Math.round(x.at) + "ms")
					.join(", "),
		);
	}
	const sockets = clients.filter((x) => !x.destroyed).length;
	if (sockets) {
		violations.push(sockets + " sockets left open after end()");
	}

	process.off("unhandledRejection", stray);
	process.off("uncaughtException", stray);
	if (restore) {
		restore();
	}

	return { violations, trace, scenario: name };

	/** @returns a check of the rows of query `id` of `scope`: that they are its, and `rows` many */
	function expect(kind: string, id: number, scope: number, rows?: number) {
		return (xs: Row[]) => {
			if (rows !== undefined && xs.length !== rows) {
				violations.push(kind + " " + id + " got " + xs.length + " rows, expected " + rows);
			}
			xs.forEach(
				(x) =>
					(x.id !== id || x.scope !== scope) &&
					violations.push(
						kind +
							" " +
							id +
							" of scope " +
							scope +
							" got the answer of query " +
							x.id +
							" of scope " +
							x.scope,
					),
			);
			xs.forEach(
				(x) =>
					x.shape !== 1 &&
					x.shape !== "b" &&
					violations.push(
						kind +
							" " +
							id +
							" read its row by another description: shape " +
							JSON.stringify(x.shape),
					),
			);
			return xs;
		};
	}

	/** @returns the promise of operation `id`, which logs how it settles, with `done` set once it has */
	function settle(kind: string, id: number, promise: unknown) {
		log("start " + kind + " " + id);
		const x: Settled = Promise.resolve(promise)
			.then(
				() => log("done " + kind + " " + id),
				(e: any) => {
					log("fail " + kind + " " + id + " " + (e && (e.code || e.message)));
					if (
						!e ||
						!e.code ||
						e instanceof TypeError ||
						e instanceof RangeError ||
						e.code === "STATEMENT_PENDING"
					) {
						violations.push(
							kind + " " + id + " failed inside the client: " + ((e && e.stack) || e),
						);
					}
				},
			)
			.then(() => (x.done = true));
		return x;
	}

	function query(sql: any, kind: string, scope: number): Promise<unknown> {
		const id = next++;
		const k = random.int(1, 5);
		if (kind === "rows") {
			return sql`select ${id}::int as id, ${scope}::int as scope from rows(${k}::int)`.then(
				expect(kind, id, scope, k),
			);
		}

		if (kind === "fail") {
			const at = random.int(0, k - 1);
			return sql`select ${id}::int as id, ${scope}::int as scope from rows(${k}::int) fail(${at}::int)`.then(
				() => violations.push("query " + id + " should have failed"),
				(e: any) => {
					if (e.code !== "22012") {
						throw e;
					}
				},
			);
		}
		if (kind === "syntax") {
			return sql`selec ${id}::int as id, ${scope}::int as scope`.then(
				() => violations.push("query " + id + " should have failed to parse"),
				(e: any) => {
					if (e.code !== "42601") {
						throw e;
					}
				},
			);
		}

		if (kind === "sleep") {
			const q = sql`select ${id}::int as id, ${scope}::int as scope sleep(${random.int(1, 500)}::int)`;
			if (random.chance(0.3)) {
				clock.timers.setTimeout(
					() => Promise.resolve(q.cancel()).catch(() => {}),
					random.int(0, 300),
				);
			}
			return q.then(expect(kind, id, scope, 1));
		}
		if (kind === "unsafe") {
			return sql
				.unsafe("select " + id + " as id, " + scope + " as scope")
				.then(expect(kind, id, scope, 1));
		}

		if (kind === "cursor") {
			const check = expect(kind, id, scope);
			let n = 0;
			return sql`select ${id}::int as id, ${scope}::int as scope from rows(${k}::int)`
				.cursor(random.int(1, 3), (rows: Row[]) => {
					n += rows.length;
					check(rows);
					return (
						random.chance(0.5) && new Promise((r) => clock.timers.setTimeout(r, random.int(0, 50)))
					);
				})
				.then(
					() =>
						n !== k &&
						violations.push(
							"cursor " + id + " of scope " + scope + " got " + n + " rows, expected " + k,
						),
				);
		}
		return sql`select ${id}::int as id, ${scope}::int as scope`.then(expect(kind, id, scope, 1));
	}

	function scoped(sql: any, scope: number) {
		const chosen = [...Array(random.int(1, 4))].map(() =>
			random.pick(["query", "rows", "fail", "syntax", "sleep", "unsafe", "cursor"]),
		);
		return random.chance(0.5)
			? Promise.all(chosen.map((k) => query(sql, k, scope)))
			: chosen.reduce<Promise<unknown>>(
					(p, k) => p.then(() => query(sql, k, scope)),
					Promise.resolve(),
				);
	}

	function operation(kind: string) {
		const scope = kind === "begin" ? 1000 + next++ : kind === "reserve" ? 2000 + next++ : 0;
		if (kind === "begin") {
			const ok = random.chance(0.8);
			const transaction = sql.begin(async (tx: any) => {
				await query(tx, "query", scope);
				await scoped(tx, scope);
				if (!ok) {
					throw Object.assign(new Error("rollback"), { code: "SIM_ROLLBACK" });
				}
			});
			return settle(
				"begin",
				scope,
				transaction.then(
					() =>
						clock.timers.setTimeout(
							() =>
								server.outcomes.get(scope) !== "commit" &&
								violations.push(
									"transaction " +
										scope +
										" resolved but the server did " +
										(server.outcomes.get(scope) || "nothing"),
								),
							0,
						),
					(e: any) => {
						const lost = /^(CONNECTION_|ECONNRESET)/.test(e.code);
						if (!lost && server.outcomes.get(scope) === "commit") {
							violations.push(
								"transaction " +
									scope +
									" rejected (" +
									e.message +
									") but the server committed it",
							);
						}
						throw e;
					},
				),
			);
		}
		if (kind === "reserve") {
			return settle(
				"reserve",
				scope,
				sql.reserve().then(async (reserved: any) => {
					try {
						await query(reserved, "query", scope);
						await scoped(reserved, scope);
					} finally {
						reserved.release();
					}
				}),
			);
		}

		if (kind === "cursor") {
			const id = next++,
				k = random.int(1, 9),
				check = expect("cursor", id, 0);
			let n = 0;
			return settle(
				"cursor",
				id,
				sql`select ${id}::int as id, ${0}::int as scope from rows(${k}::int)`
					.cursor(random.int(1, 3), (rows: Row[]) => {
						n += rows.length;
						return check(rows);
					})
					.then(
						() => n !== k && violations.push("cursor " + id + " got " + n + " rows, expected " + k),
					),
			);
		}
		const id = next;
		return settle(kind, id, query(sql, kind, 0));
	}

	function fault() {
		const sessions = [...server.sessions],
			x = sessions.length && random.pick(sessions),
			kind = random.pick(scenario.faults);
		if (kind === "outage") {
			const mode = random.pick(["close", "error", "hang"]),
				ms = random.int(10, 3000);
			log("fault outage " + mode + " " + ms + "ms");
			server.startup[0] = mode;
			clock.timers.setTimeout(() => (server.startup[0] = "ready"), ms);
			return;
		}
		if (!x) {
			return;
		}

		log("fault " + kind + " session " + x.id);
		if (kind === "kill") {
			server.kill(x);
		} else if (kind === "close") {
			server.close(x, false);
		} else if (kind === "reset") {
			server.close(x, true);
		} else {
			server[kind as "stale" | "deallocate" | "retype" | "commitRollback"](x);
		}
	}
}

/** A row of the simulated server: the query's id and scope, and the shape it was read by */
type Row = { id: number; scope: number; shape: number | string };

/** The promise of an operation, with `done` once it has settled */
type Settled = Promise<unknown> & { done?: boolean };

/** Replaces the global timers with the clock's; @returns a function that puts them back */
function fakeGlobals(clock: ReturnType<typeof Clock>) {
	const real = globalThis as unknown as Record<string, unknown>,
		faked = clock.timers as unknown as Record<string, unknown>,
		saved = ["setTimeout", "clearTimeout", "setImmediate", "clearImmediate"].map(
			(k) => [k, real[k]] as const,
		);
	// oxlint-disable-next-line typescript/unbound-method -- saved only to be put back
	const now = performance.now;
	saved.forEach(([k]) => (real[k] = faked[k]));
	performance.now = clock.timers.now;
	return () => {
		saved.forEach(([k, v]) => (real[k] = v));
		performance.now = now;
	};
}
