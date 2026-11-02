import { expect, test } from "vitest";
import {
	postgres,
	sql,
	options,
	delay,
	idle_timeout,
	pg_port,
	port_of,
	server_major,
} from "./setup.ts";

test("Throws on illegal transactions", async () => {
	const sql = postgres({ ...options, max: 2, fetch_types: false });
	const error = await sql`begin`.catch((e) => e);
	expect(error.code).toBe("UNSAFE_TRANSACTION");
});

test("Transaction throws", async () => {
	await sql`create table test (a int)`;
	expect(
		await sql
			.begin(async (sql) => {
				await sql`insert into test values(1)`;
				await sql`insert into test values('hej')`;
			})
			.catch((x) => x.code),
	).toBe("22P02");
	await sql`drop table test`;
});

test("Transaction rolls back", async () => {
	await sql`create table test (a int)`;
	await sql
		.begin(async (sql) => {
			await sql`insert into test values(1)`;
			await sql`insert into test values('hej')`;
		})
		.catch(() => {});
	expect((await sql`select a from test`).count).toBe(0);
	await sql`drop table test`;
});

test("Transaction throws on uncaught savepoint", async () => {
	await sql`create table test (a int)`;

	expect(
		await sql
			.begin(async (sql) => {
				await sql`insert into test values(1)`;
				await sql.savepoint(async (sql) => {
					await sql`insert into test values(2)`;
					throw new Error("fail");
				});
			})
			.catch((err) => err.message),
	).toBe("fail");
	await sql`drop table test`;
});

test("Transaction throws on uncaught named savepoint", async () => {
	await sql`create table test (a int)`;

	expect(
		await sql
			.begin(async (sql) => {
				await sql`insert into test values(1)`;
				await sql.savepoit("watpoint", async (sql) => {
					await sql`insert into test values(2)`;
					throw new Error("fail");
				});
			})
			.catch(() => "fail"),
	).toBe("fail");
	await sql`drop table test`;
});

test("Transaction succeeds on caught savepoint", async () => {
	await sql`create table test (a int)`;
	await sql.begin(async (sql) => {
		await sql`insert into test values(1)`;
		await sql
			.savepoint(async (sql) => {
				await sql`insert into test values(2)`;
				throw new Error("please rollback");
			})
			.catch(() => {});
		await sql`insert into test values(3)`;
	});

	expect((await sql`select count(1) from test`)[0].count).toBe("2");
	await sql`drop table test`;
});

test("Savepoint returns Result", async () => {
	let result;
	await sql.begin(async (sql) => {
		result = await sql.savepoint((sql) => sql`select 1 as x`);
	});

	expect(result[0].x).toBe(1);
});

test("Prepared transaction", async () => {
	await sql`create table test (a int)`;

	await sql.begin(async (sql) => {
		await sql`insert into test values(1)`;
		await sql.prepare("tx1");
	});

	await sql`commit prepared 'tx1'`;

	expect((await sql`select count(1) from test`)[0].count).toBe("1");
	await sql`drop table test`;
});

test("Transaction requests are executed implicitly", async () => {
	const sql = postgres({ debug: true, idle_timeout: 1, fetch_types: false });
	expect(
		(
			await sql.begin((sql) => [
				sql`select set_config('postgres_js.test', 'testing', true)`,
				sql`select current_setting('postgres_js.test') as x`,
			])
		)[1][0].x,
	).toBe("testing");
});

test("Uncaught transaction request errors bubbles to transaction", async () => {
	expect(
		await sql
			.begin((sql) => [
				sql`select wat`,
				sql`select current_setting('postgres_js.test') as x, ${1} as a`,
			])
			.catch((e) => e.code),
	).toBe("42703");
});

test("Fragments in transactions", async () => {
	expect((await sql.begin((sql) => sql`select true as x where ${sql`1=1`}`))[0].x).toBe(true);
});

test("Transaction rejects with rethrown error", async () => {
	expect(
		await sql
			.begin(async (sql) => {
				try {
					await sql`select exception`;
				} catch (ex) {
					throw new Error("WAT");
				}
			})
			.catch((e) => e.message),
	).toBe("WAT");
});

test("Parallel transactions", async () => {
	await sql`create table test (a int)`;
	expect(
		(await Promise.all([sql.begin((sql) => sql`select 1`), sql.begin((sql) => sql`select 1`)]))
			.map((x) => x.count)
			.join(""),
	).toBe("11");
	await sql`drop table test`;
});

test("Many transactions at beginning of connection", async () => {
	const sql = postgres(options);
	const xs = await Promise.all(
		Array.from({ length: 100 }, () => sql.begin((sql) => sql`select 1`)),
	);
	expect(xs.length).toBe(100);
});

test("Transactions array", async () => {
	await sql`create table test (a int)`;

	expect(
		(await sql.begin((sql) => [sql`select 1`.then((x) => x), sql`select 1`]))
			.map((x) => x.count)
			.join(""),
	).toBe("11");
	await sql`drop table test`;
});

test("Transaction waits", async () => {
	await sql`create table test (a int)`;
	await sql.begin(async (sql) => {
		await sql`insert into test values(1)`;
		await sql
			.savepoint(async (sql) => {
				await sql`insert into test values(2)`;
				throw new Error("please rollback");
			})
			.catch(() => {});
		await sql`insert into test values(3)`;
	});

	expect(
		(await Promise.all([sql.begin((sql) => sql`select 1`), sql.begin((sql) => sql`select 1`)]))
			.map((x) => x.count)
			.join(""),
	).toBe("11");
	await sql`drop table test`;
});

test("Helpers in Transaction", async () => {
	expect((await sql.begin(async (sql) => await sql`select ${sql({ x: 1 })}`))[0].x).toBe("1");
});

test(
	"Connection errors are caught using begin()",
	{
		timeout: 2000,
	},
	async () => {
		let error;
		try {
			const sql = postgres({ host: "localhost", port: 1 });

			await sql.begin(async (sql) => {
				await sql`insert into test (label, value) values (${1}, ${2})`;
			});
		} catch (err) {
			error = err;
		}

		expect(
			error.code === "ECONNREFUSED" || error.message === "Connection refused (os error 61)",
		).toBe(true);
	},
);

test("Throws correct error when retrying in transactions", async () => {
	await sql`create table test(x int)`;
	const error = await sql
		.begin((sql) => sql`insert into test (x) values (${sql.typed(false, 16)})`)
		.catch((e) => e);
	expect(error.code).toBe("42804");
	await sql`drop table test`;
});

test("Properly throws routine error on not prepared statements in transaction", async () => {
	const { routine } = await sql
		.begin((sql) => [sql`create table x (x text[])`, sql`insert into x(x) values (('a', 'b'))`])
		.catch((e) => e);

	expect(routine).toBe("transformAssignedExpr");
});

test("Catches type serialize errors in transactions", async () => {
	const sql = postgres({
		idle_timeout,
		types: {
			text: {
				from: 25,
				to: 25,
				parse: (x) => x,
				serialize: () => {
					throw new Error("watSerialize");
				},
			},
		},
	});

	expect(await sql.begin((sql) => sql`select ${"wat"}`).catch((e) => e.message)).toBe(
		"watSerialize",
	);
});

test("Catches type parse errors in transactions", async () => {
	const sql = postgres({
		idle_timeout,
		types: {
			text: {
				from: 25,
				to: 25,
				parse: () => {
					throw new Error("watParse");
				},
				serialize: (x) => x,
			},
		},
	});

	expect(await sql.begin((sql) => sql`select 'wat'`).catch((e) => e.message)).toBe("watParse");
});

test("Prevent premature end of connection in transaction", async () => {
	const sql = postgres({ max_lifetime: 0.01, idle_timeout });
	const result = await sql.begin(async (sql) => {
		await sql`select 1`;
		await delay(20);
		await sql`select 1`;
		return "yay";
	});

	expect(result).toBe("yay");
});

test("Ensure reconnect after max_lifetime with transactions", { timeout: 5000 }, async () => {
	const sql = postgres({
		max_lifetime: 0.01,
		idle_timeout,
		max: 1,
	});

	const xs = [];
	for (let i = 0; i < 10; i++) {
		const [{ x }] = await sql.begin((sql) => sql`select 1 as x`);
		xs.push(x);
	}

	expect(xs).toEqual(Array(10).fill(1));
});

test("Ensure transactions throw if connection is closed dwhile there is no query", async () => {
	const sql = postgres(options);
	const x = await sql
		.begin(async () => {
			setTimeout(() => sql.end({ timeout: 0 }), 10);
			await new Promise((r) => setTimeout(r, 200));
			return sql`select 1`;
		})
		.catch((x) => x);
	expect(x.code).toBe("CONNECTION_CLOSED");
});

test("Does not try rollback when commit errors", async () => {
	let notice = null;
	const sql = postgres({ ...options, onnotice: (x) => (notice = x) });
	await sql`create table test(x int constraint test_constraint unique deferrable initially deferred)`;

	await sql
		.begin("isolation level serializable", async (sql) => {
			await sql`insert into test values(1)`;
			await sql`insert into test values(1)`;
		})
		.catch((e) => e);

	expect(notice).toBe(null);
	await sql`drop table test`;
});

test("Transaction rejects when the server rolls back the commit", async () => {
	const sql = postgres({ ...options, max: 1 });
	let xid;
	const result = await sql
		.begin(async (sql) => {
			[{ xid }] = await sql`select pg_current_xact_id()::text as xid`;
			await sql`savepoint parent_marker`;
			await sql
				.savepoint(async (sql) => {
					await sql`rollback to savepoint parent_marker`;
					throw new Error("force");
				})
				.catch(() => {});
			return "committed";
		})
		.then(
			(x) => x,
			() => "rejected",
		);
	const [{ status }] = await sql`select pg_xact_status(${xid}::xid8) as status`;
	expect(result + "," + status).toBe("rejected,aborted");
	await sql.end();
});

test("Caught error inside a transaction still rejects it", async () => {
	await sql`create table test (x int)`;
	const result = await sql
		.begin(async (sql) => {
			await sql`insert into test values (1)`;
			await sql`select 1/0`.catch(() => {});
			return "committed";
		})
		.then(
			(x) => x,
			() => "rejected",
		);
	const [{ count }] = await sql`select count(*)::int from test`;
	expect(result + "," + count).toBe("rejected,0");
	await sql`drop table test`;
});

test("Notify inside a transaction with max 1", async () => {
	const sql = postgres({ ...options, max: 1 });
	expect(await sql.begin((sql) => sql.notify("test", "x")).then(() => "ok")).toBe("ok");
	await sql.end();
});

test("Transaction at pipeline boundary is reserved", async () => {
	const sql = postgres({ ...options, max: 2, max_pipeline: 1, fetch_types: false });
	await Promise.all([sql`select 1`, sql`select 1`]);
	const inflight = [sql`select pg_sleep(0.1)`.execute(), sql`select pg_sleep(0.1)`.execute()];
	const x = await sql
		.begin((sql) => sql`select 1 as x`)
		.then(
			(x) => x[0].x,
			(x) => x.code,
		);
	await Promise.all(inflight);
	expect(x).toBe(1);
	await sql.end();
});

test("Transaction is reserved with pipelining disabled", async () => {
	const sql = postgres({ ...options, max: 2, max_pipeline: 0, fetch_types: false });
	const x = await sql
		.begin((sql) => sql`select 1 as x`)
		.then(
			(x) => x[0].x,
			(x) => x.code,
		);
	expect(x).toBe(1);
	await sql.end();
});

test("Query issued while BEGIN is in flight does not join the transaction", async () => {
	const sql = postgres({ ...options, max: 1, fetch_types: false });
	await sql`create table test (a int)`;
	const tx = sql
		.begin(async (sql) => {
			await sql`select 1`;
			throw new Error("rollback");
		})
		.catch(() => {});
	const insert = sql`insert into test values (1)`;
	await Promise.all([tx, insert]);
	expect((await sql`select count(*)::int as n from test`)[0].n).toBe(1);
	await sql`drop table test`;
	await sql.end();
});

test("Transaction with sequential queries works with max_pipeline 0", async () => {
	const sql = postgres({ ...options, max: 4, max_pipeline: 0 });
	expect(
		await sql.begin(async (sql) => {
			await sql`select set_config('postgres_js.test', 'testing', true)`;
			return (await sql`select current_setting('postgres_js.test') as x`)[0].x;
		}),
	).toBe("testing");
	await sql.end();
});

test("Transaction with concurrent queries works with max_pipeline 0", async () => {
	const sql = postgres({ ...options, max: 4, max_pipeline: 0 });
	expect(
		(
			await sql.begin((sql) => [
				sql`select set_config('postgres_js.test', 'testing', true)`,
				sql`select current_setting('postgres_js.test') as x`,
			])
		)[1][0].x,
	).toBe("testing");
	await sql.end();
});

test("Undefined value in a transaction returning an array of queries rejects", async () => {
	const sql = postgres(options);
	await sql`create table test (x int)`;
	const error = await sql
		.begin((sql) => [sql`insert into test values (1)`, sql`select ${undefined} as x`])
		.catch((e) => e.code);
	const count = (await sql`select count(*)::int from test`)[0].count;
	await sql`drop table test`;
	await sql.end();
	expect([error, count].join()).toBe("UNDEFINED_VALUE,0");
});

test("Undefined value aborts a pipelined transaction on a reserved connection", async () => {
	const sql = postgres(options);
	await sql`create table test (x int)`;
	const reserved = await sql.reserve();
	const results = await Promise.all(
		[
			reserved`begin`,
			reserved`insert into test values (1)`,
			reserved`select ${undefined} as x`,
			reserved`insert into test values (2)`,
			reserved`commit`,
		].map((x) =>
			x.then(
				(x) => x.command,
				(e) => e.code,
			),
		),
	);
	reserved.release();
	const count = (await sql`select count(*)::int from test`)[0].count;
	await sql`drop table test`;
	await sql.end();
	expect([...results, count].join()).toBe("BEGIN,INSERT,UNDEFINED_VALUE,25P02,ROLLBACK,0");
});

test("Parameter failing to serialize aborts a pipelined transaction on a reserved connection", async () => {
	const sql = postgres(options);
	await sql`create table test (x int)`;
	const reserved = await sql.reserve();
	const results = await Promise.all(
		[
			reserved`begin`,
			reserved`insert into test values (1)`,
			reserved`select ${new Date(NaN)}::timestamptz as x`,
			reserved`insert into test values (2)`,
			reserved`commit`,
		].map((x) =>
			x.then(
				(x) => x.command,
				(e) => e.code || e.name,
			),
		),
	);
	reserved.release();
	const count = (await sql`select count(*)::int from test`)[0].count;
	await sql`drop table test`;
	await sql.end();
	expect([...results, count].join()).toBe("BEGIN,INSERT,RangeError,25P02,ROLLBACK,0");
});

test("Does not reject leftover begin onclose after commit", async () => {
	const sql = postgres({ ...options, max: 1 });
	const rejections = [];
	const onUnhandled = (reason) => rejections.push(reason);
	process.on("unhandledRejection", onUnhandled);
	try {
		await sql.begin((sql) => sql`select 1`);
		await sql.end({ timeout: 0 });
		await delay(50);
	} finally {
		process.off("unhandledRejection", onUnhandled);
	}
	expect(rejections.length).toBe(0);
});

test("idle_in_transaction_session_timeout rejects the transaction", { timeout: 5000 }, async () => {
	const sql = postgres(options);
	const error = await sql
		.begin(async (sql) => {
			await sql`set local idle_in_transaction_session_timeout = '1s'`;
			await delay(1500);
			await sql`select 1`;
		})
		.catch((e) => e);
	await sql.end();
	expect(error.code).toBe("25P03");
});

test(
	"Transaction queries fail after its connection is gone even if the callback continues",
	{ timeout: 5000 },
	async () => {
		const sql = postgres({ ...options, max: 1 });
		setTimeout(() => sql`select 1`.catch(() => {}), 1200);
		let code;
		await sql
			.begin(async (sql) => {
				await sql`set local idle_in_transaction_session_timeout = '1s'`;
				await delay(1500);
				code = await sql`select 'should fail'`.then(
					() => "ran",
					(e) => e.code,
				);
			})
			.catch(() => {});
		await delay(1000);
		await sql.end();
		expect(code).toBe("CONNECTION_CLOSED");
	},
);

test("Disconnect rejects queued transaction queries and allows reconnect", async () => {
	const sql = postgres({ ...options, max_pipeline: 1, fetch_types: false });
	let queries;

	try {
		const error = await sql
			.begin((sql) => {
				queries = [
					sql`select pg_terminate_backend(pg_backend_pid())`.execute(),
					sql`select 1`.execute(),
					sql`select 2`.execute(),
				];
				return Promise.allSettled(queries);
			})
			.catch((x) => x);

		const results = await Promise.allSettled(queries);
		const [{ x }] = await sql`select 1 as x`;
		expect([error.code, ...results.map((x) => x.status), x].join(",")).toBe(
			"57P01,rejected,rejected,rejected,1",
		);
	} finally {
		await sql.end({ timeout: 0 });
	}
});

test("Disconnected transaction cannot query a reused connection", async () => {
	const code = await withDisconnectedTransaction(({ sql, disconnected }) =>
		sql.begin(async (sql) => {
			await sql`select set_config('postgres_js.test', 'replacement', true)`;
			const result = await disconnected`select current_setting('postgres_js.test') as x`.catch(
				(x) => x,
			);
			return result.code;
		}),
	);
	expect(code).toBe("CONNECTION_CLOSED");
});

test("Disconnected transaction cannot commit a reused connection", async () => {
	const [before, after] = await finishDisconnectedTransaction();
	expect(after).toBe(before);
});

test("Disconnected transaction cannot roll back a reused connection", async () => {
	const [before, after] = await finishDisconnectedTransaction(
		new Error("original callback failed"),
	);
	expect(after).toBe(before);
});

function finishDisconnectedTransaction(error?) {
	return withDisconnectedTransaction(({ sql, finish }) =>
		sql.begin(async (sql) => {
			const [{ x: before }] = await sql`select txid_current()::text as x`;
			finish(error);
			await new Promise((resolve) => setImmediate(resolve));
			const [{ x: after }] = await sql`select txid_current()::text as x`;
			return [before, after];
		}),
	);
}

async function withDisconnectedTransaction(fn) {
	const pool = postgres({ ...options, fetch_types: false });
	let finish, ready;
	const gate = new Promise<void>(
		(resolve, reject) => (finish = (error) => (error ? reject(error) : resolve())),
	);
	const connected = new Promise((resolve) => (ready = resolve));
	const failed = pool
		.begin(async (sql) => {
			const [{ pid }] = await sql`select pg_backend_pid() as pid`;
			ready({ disconnected: sql, pid });
			await gate;
		})
		.catch((x) => x);

	try {
		const { disconnected, pid } = await Promise.race([
			connected,
			failed.then((error) => {
				throw error;
			}),
		]);
		await sql`select pg_terminate_backend(${pid}::int)`;
		await failed;
		return await fn({ sql: pool, disconnected, finish });
	} finally {
		finish();
		await new Promise((resolve) => setImmediate(resolve));
		await pool.end({ timeout: 0 });
	}
}

test("Savepoint names are quoted", async () => {
	await sql`create table test (a int)`;
	await sql.begin(async (sql) => {
		await sql.savepoint("with space", (sql) => sql`insert into test values (1)`);
		await sql.savepoint(
			'a";create table test_injected (a int);--',
			(sql) => sql`insert into test values (2)`,
		);
	});
	const [{ injected }] = await sql`select to_regclass('test_injected') is not null as injected`;
	expect((await sql`select count(*)::int as n from test`)[0].n + " " + injected).toBe("2 false");
	await sql`drop table test`;
});

test("A prepared transaction name cannot close its quote", async () => {
	const name = "tx'; create table test_injected (a int); --";
	await sql.begin((sql) => (sql.prepare(name), sql`select 1`));
	const [{ gid }] = await sql`select gid from pg_prepared_xacts where gid like 'tx%'`;
	await sql.unsafe("rollback prepared '" + gid.replace(/'/g, "''") + "'");
	const [{ injected }] = await sql`select to_regclass('test_injected') is not null as injected`;
	expect(String(injected)).toBe("false");
});

test("An unsafe begin is rejected and rolled back, and the queries behind it get their own answers", async () => {
	const sql = postgres({ ...options, max: 2 });
	await sql`create table test (a int)`;
	const results = await Promise.all([
		sql`begin`.then(
			(x) => x.command,
			(e) => e.code,
		),
		sql`insert into test values (1) returning a`.then(
			(x) => x.command + ":" + x[0].a,
			(e) => e.code,
		),
		sql`select 'third' as x`.then(
			(x) => x.command + ":" + x[0].x,
			(e) => e.code,
		),
	]);
	const [{ n }] = await sql`select count(*)::int as n from test`;
	expect(results.join() + " " + n).toBe("UNSAFE_TRANSACTION,INSERT:1,SELECT:third 1");
	await sql`drop table test`;
	await sql.end();
});

test("A begin hidden behind a comment runs alone, rolls back and leaves the queries pipelined behind it alone", async () => {
	const sql = postgres({ ...options, max: 2 });
	await sql`create table test (a int)`;
	const reserved = await sql.reserve();
	const results = await Promise.all([
		sql`/* hidden */ begin`.then(
			(x) => x.command,
			(e) => e.code,
		),
		sql`insert into test values (1) returning a`.then(
			(x) => x.command,
			(e) => e.code,
		),
		sql`select 'third' as x`.then(
			(x) => x.command,
			(e) => e.code,
		),
	]);
	reserved.release();
	const [{ n }] = await sql`select count(*)::int as n from test`;
	const after = await Promise.all([sql`select 1 as x`, sql`select 2 as x`]).then((x) =>
		x.map((r) => r[0].x).join(),
	);
	expect(results.join() + " " + n + " " + after).toBe("UNSAFE_TRANSACTION,INSERT,SELECT 1 1,2");
	await sql`drop table test`;
	await sql.end();
});

test("A begin used again runs alone again, whether tagged, unsafe, prepared or not", async () => {
	const sql = postgres({ ...options, max: 2 });
	await sql`create table test (a int)`;
	const begins = [
		() => sql`begin`,
		() => sql.unsafe("begin"),
		() => sql.unsafe("begin", [], { simple: false }),
		() => sql.unsafe("begin", [], { simple: false, prepare: true }),
	];
	const results = [];
	for (let i = 0; i < 2; i++) {
		for (const begin of begins) {
			results.push(
				(
					await Promise.all([
						begin().then(
							(x) => x.command,
							(e) => e.code,
						),
						sql`insert into test values (1) returning a`.then(
							(x) => x.command,
							(e) => e.code,
						),
					])
				).join(":"),
			);
		}
	}
	const [{ n }] = await sql`select count(*)::int as n from test`;
	const expected = Array(8).fill("UNSAFE_TRANSACTION:INSERT").join() + " 8";
	expect(results.join() + " " + n).toBe(expected);
	await sql`drop table test`;
	await sql.end();
});

test("A script with its own BEGIN and COMMIT in one simple query runs on the pool", async () => {
	const sql = postgres({ ...options, max: 2 });
	await sql`create table test (a int)`;
	const commands = await sql
		.unsafe("begin; insert into test values (1); commit;")
		.then((x) => x.map((r) => r.command).join());
	const after = await sql
		.unsafe("select 1; begin; insert into test values (2); commit")
		.then((x) => x.map((r) => r.command).join());
	const [{ n }] = await sql`select count(*)::int as n from test`;
	expect(commands + " " + after + " " + n).toBe("BEGIN,INSERT,COMMIT SELECT,BEGIN,INSERT,COMMIT 2");
	await sql`drop table test`;
	await sql.end();
});

test("A query that leaves a transaction open on the pool is rejected and rolled back", async () => {
	const sql = postgres({ ...options, max: 2 });
	await sql`create table test (a int)`;
	const opened = await sql.unsafe("select 1; start transaction").then(
		() => "ok",
		(e) => e.code,
	);
	for (let i = 0; i < 4; i++) await sql`insert into test values (${i})`;
	await sql.end();
	const check = postgres(options);
	const [{ n }] = await check`select count(*)::int as n from test`;
	try {
		expect(opened + " " + n).toBe("UNSAFE_TRANSACTION 4");
	} finally {
		await check`drop table test`;
		await check.end();
	}
});

test("A query issued before sql.begin runs before the transaction with max: 1", async () => {
	const sql = postgres({ ...options, max: 1 });
	await sql`create table test (a int)`;
	const first = sql`select count(*)::int as n from test`.execute();
	const tx = sql.begin((sql) => sql`insert into test values (1)`);
	const [{ n }] = await first;
	await tx;
	expect(n).toBe(0);
	await sql`drop table test`;
	await sql.end();
});

test("A caught query that cannot be built aborts a transaction opened by hand on a reserved connection", async () => {
	const sql = postgres(options);
	await sql`create table test (a int)`;
	const reserved = await sql.reserve();
	await reserved`begin`;
	await reserved`insert into test values (1)`;
	const bad = await reserved`select ${undefined} as x`.catch((e) => e.code);
	const commit = await reserved`commit`;
	reserved.release();
	const [{ n }] = await sql`select count(*)::int as n from test`;
	expect(bad + " " + commit.command + " " + n).toBe("UNDEFINED_VALUE ROLLBACK 0");
	await sql`drop table test`;
	await sql.end();
});

test("A query that cannot be built on a reserved connection outside a transaction leaves the connection usable", async () => {
	const sql = postgres(options);
	const reserved = await sql.reserve();
	const bad = await reserved`select ${undefined} as x`.catch((e) => e.code);
	const [{ x }] = await reserved`select 1 as x`;
	reserved.release();
	expect(bad + " " + x).toBe("UNDEFINED_VALUE 1");
	await sql.end();
});

test("sql.begin inside a transaction runs in a savepoint", async () => {
	await sql`create table test (x int)`;
	const result = await sql.begin(async (sql) => {
		await sql`insert into test values (1)`;
		await sql.begin((sql) => sql`insert into test values (2)`);
		await sql
			.begin(async (sql) => {
				await sql`insert into test values (3)`;
				throw new Error("undo 3");
			})
			.catch(() => {});
		return sql`select array_agg(x order by x)::text as xs from test`;
	});
	expect(result[0].xs).toBe("{1,2}");
	await sql`drop table test`;
});

test("A nested sql.begin with a different mode throws, the same mode is allowed", async () => {
	const codes = await sql.begin("read write", async (sql) => [
		await sql
			.begin("read only", (sql) => sql`select 1`)
			.then(
				() => "ran",
				(e) => e.code,
			),
		await sql
			.begin("READ  write", (sql) => sql`select 1`)
			.then(
				() => "ran",
				(e) => e.code,
			),
	]);
	expect(codes.join()).toBe("NESTED_TRANSACTION_MODE,ran");
});

test("A nested sql.begin can not be prepared", async () => {
	const code = await sql.begin(async (sql) =>
		sql
			.begin(async (sql) => sql.prepare("x"))
			.then(
				() => "ran",
				(e) => e.code,
			),
	);
	expect(code).toBe("NESTED_TRANSACTION_MODE");
});

test("A tagged savepoint runs its query in a savepoint", async () => {
	const [x] = await sql.begin((sql) => sql.savepoint`select 1 as x`);
	expect(x.x).toBe(1);
});

test(
	"Queries in a Promise.all inside a transaction are pipelined in the order they were made (#951)",
	{ timeout: 10_000 },
	async () => {
		const net = await import("net"),
			proxy = net.createServer((client) => {
				const server = net.connect(pg_port, "127.0.0.1");
				client.on("data", (x) => setTimeout(() => server.write(x), 50));
				server.on("data", (x) => setTimeout(() => client.write(x), 50));
				client.on("close", () => server.destroy());
				server.on("close", () => client.destroy());
				client.on("error", () => {});
				server.on("error", () => {});
			});
		await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", r));
		const sql = postgres({
			...options,
			host: "127.0.0.1",
			port: port_of(proxy),
			max: 1,
			fetch_types: false,
		});
		const result = await sql.begin(async (sql) => {
			await sql`create table test (x int)`;
			let start = Date.now();
			for (let i = 0; i < 5; i++) await sql`select ${i}::int`;
			const sequential = Date.now() - start;
			start = Date.now();
			const [, counted, , summed] = await Promise.all([
				sql`insert into test values (1)`,
				sql`select count(*)::int as n from test`,
				sql`insert into test values (2)`,
				sql`select sum(x)::int as n from test`,
				sql`select 1`,
			]);
			return [Date.now() - start < sequential / 2, counted[0].n, summed[0].n].join(" ");
		});
		await sql.end();
		proxy.close();
		expect(result).toBe("true 1 3");
	},
);

test("sql.rollback() rolls back without throwing, and begin resolves with the result (#500)", async () => {
	await sql`create table test (x int)`;
	const result = await sql.begin(async (sql) => {
		await sql`insert into test values (1)`;
		await sql.rollback();
		return "value";
	});
	const [{ n }] = await sql`select count(*)::int as n from test`;
	expect(result + " " + n).toBe("value 0");
	await sql`drop table test`;
});

test("sql.rollback() in a savepoint or nested begin rolls back only that, and the outer transaction commits", async () => {
	await sql`create table test (x int)`;
	await sql.begin(async (sql) => {
		await sql`insert into test values (1)`;
		await sql.savepoint(async (sql) => (await sql`insert into test values (2)`, sql.rollback()));
		await sql.begin(async (sql) => (await sql`insert into test values (3)`, sql.rollback()));
		await sql`insert into test values (4)`;
	});
	const [{ xs }] = await sql`select string_agg(x::text, ',' order by x) as xs from test`;
	expect(xs).toBe("1,4");
	await sql`drop table test`;
});

test("Queries, savepoints and nested begins after sql.rollback() are not sent and reject with TRANSACTION_ROLLED_BACK", async () => {
	await sql`create table test (x int)`;
	const codes = [];
	const outcome = await sql
		.begin(async (sql) => {
			await sql.rollback();
			codes.push(await sql`insert into test values (1)`.catch((e) => e.code));
			codes.push(await sql.savepoint((sql) => sql`select 1`).catch((e) => e.code));
			codes.push(await sql.begin((sql) => sql`select 1`).catch((e) => e.code));
		})
		.catch((e) => e.code);
	const [{ n }] = await sql`select count(*)::int as n from test`;
	expect(codes.join() + " " + outcome + " " + n).toBe(
		"TRANSACTION_ROLLED_BACK,TRANSACTION_ROLLED_BACK,TRANSACTION_ROLLED_BACK TRANSACTION_ROLLED_BACK 0",
	);
	await sql`drop table test`;
});

test("sql.rollback() comes after the queries already made, and the connection is left idle", async () => {
	const sql = postgres({ ...options, max: 1 });
	await sql`create table test (x int)`;
	let same;
	await sql.begin((sql) => {
		sql`insert into test values (1)`;
		const a = sql.rollback();
		same = a === sql.rollback();
		return a;
	});
	const [{ n }] = await sql`select count(*)::int as n from test`,
		[{ status }] =
			await sql`select state as status from pg_stat_activity where pid = pg_backend_pid()`;
	expect(same + " " + n + " " + status).toBe("true 0 active");
	await sql`drop table test`;
	await sql.end();
});

test("A transaction ended by transaction_timeout rejects with the FATAL error instead of CONNECTION_CLOSED (#1283)", async ({
	skip,
}) => {
	skip((await server_major()) < 17, "transaction_timeout needs PostgreSQL 17 or later");

	const timed = postgres({ ...options, max: 1 });
	const error = await timed
		.begin(async (sql) => {
			await sql`select set_config('transaction_timeout', '200', true)`;
			await sql`select pg_sleep(2)`;
		})
		.catch((e) => e);
	expect(error.code + " " + error.severity).toBe("25P04 FATAL");
	await timed.end();
});

test("A transaction whose backend is terminated mid-query rejects with the FATAL error (#1283)", async () => {
	const sql = postgres({ ...options, max: 1 }),
		killer = postgres({ ...options, max: 1 });
	const error = await sql
		.begin(async (sql) => {
			const [{ pid }] = await sql`select pg_backend_pid() as pid`;
			const query = sql`select pg_sleep(2)`.execute();
			while (
				!(
					await killer`select wait_event = 'PgSleep' as sleeping from pg_stat_activity where pid = ${pid}`
				)[0].sleeping
			)
				await delay(1);
			await killer`select pg_terminate_backend(${pid})`;
			await query;
		})
		.catch((e) => e);
	expect(error.code + " " + error.severity).toBe("57P01 FATAL");
	await killer.end();
	await sql.end();
});

test("A transaction terminated between statements rejects with the FATAL error, and its next query has it as cause (#1283)", async () => {
	const sql = postgres({ ...options, max: 1 }),
		killer = postgres({ ...options, max: 1 });
	let settled;
	const next = new Promise<any>((r) => (settled = r));
	const error = await sql
		.begin(async (sql) => {
			const [{ pid }] = await sql`select pg_backend_pid() as pid`;
			await killer`select pg_terminate_backend(${pid})`;
			await delay(100);
			settled(await sql`select 1`.catch((e) => e));
		})
		.catch((e) => e);
	const later = await next;
	expect([error.code, error.severity, later.code, later.cause && later.cause.code].join(" ")).toBe(
		"57P01 FATAL CONNECTION_CLOSED 57P01",
	);
	await killer.end();
	await sql.end();
});

test(
	"A savepoint or nested begin rejects when the connection is lost while its callback runs (#1281)",
	{ timeout: 10_000 },
	async () => {
		const outcomes = [];
		for (const method of ["savepoint", "begin"]) {
			const sql = postgres({ ...options, max: 1 }),
				killer = postgres({ ...options, max: 1 });
			let started, release, settled;
			const pid = new Promise((r) => (started = r)),
				gate = new Promise((r) => (release = r)),
				child = new Promise((r) => (settled = r));
			const root = sql
				.begin((sql) =>
					sql[method](async (sql) => {
						const [x] = await sql`select pg_backend_pid() as pid`;
						started(x.pid);
						await gate;
						return "child";
					})
						.then(
							() => "fulfilled",
							(e) => e.code,
						)
						.then((x) => (settled(x), x)),
				)
				.catch((e) => e.code);
			await killer`select pg_terminate_backend(${await pid})`;
			const outer = await root;
			release();
			outcomes.push(outer + " " + (await child));
			await killer.end();
			await sql.end();
		}
		expect(outcomes.join()).toBe("57P01 57P01,57P01 57P01");
	},
);
