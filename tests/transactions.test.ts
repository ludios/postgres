import type net from "net";
import { expect, onTestFinished, test } from "vitest";
import {
	postgres,
	sql,
	options,
	defer,
	delay,
	idle_timeout,
	server_major,
	terminate,
	until_sleeping,
	proxy_to_server,
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
			.begin(async (tx) => {
				await tx`insert into test values(1)`;
				await tx`insert into test values('hej')`;
			})
			.catch((x) => x.code),
	).toBe("22P02");
});

test("Transaction rolls back", async () => {
	await sql`create table test (a int)`;
	await sql
		.begin(async (tx) => {
			await tx`insert into test values(1)`;
			await tx`insert into test values('hej')`;
		})
		.catch(() => {});
	expect((await sql`select a from test`).count).toBe(0);
});

test("Transaction throws on uncaught savepoint", async () => {
	await sql`create table test (a int)`;

	expect(
		await sql
			.begin(async (tx) => {
				await tx`insert into test values(1)`;
				await tx.savepoint(async (sp) => {
					await sp`insert into test values(2)`;
					throw new Error("fail");
				});
			})
			.catch((err) => err.message),
	).toBe("fail");
});

test("Transaction throws on uncaught named savepoint", async () => {
	await sql`create table test (a int)`;

	expect(
		await sql
			.begin(async (tx) => {
				await tx`insert into test values(1)`;
				await tx.savepoint("watpoint", async (sp) => {
					await sp`insert into test values(2)`;
					throw new Error("fail");
				});
			})
			.catch((err) => err.message),
	).toBe("fail");
});

test("Transaction succeeds on caught savepoint", async () => {
	await sql`create table test (a int)`;
	await sql.begin(async (tx) => {
		await tx`insert into test values(1)`;
		await tx
			.savepoint(async (sp) => {
				await sp`insert into test values(2)`;
				throw new Error("please rollback");
			})
			.catch(() => {});
		await tx`insert into test values(3)`;
	});

	expect((await sql`select count(1) from test`)[0].count).toBe("2");
});

test("Savepoint returns Result", async () => {
	let result;
	await sql.begin(async (tx) => {
		result = await tx.savepoint((sp) => sp`select 1 as x`);
	});

	expect(result[0].x).toBe(1);
});

test("Prepared transaction", async () => {
	await sql`create table test (a int)`;

	await sql.begin(async (tx) => {
		await tx`insert into test values(1)`;
		await tx.prepare("tx1");
	});

	await sql`commit prepared 'tx1'`;

	expect((await sql`select count(1) from test`)[0].count).toBe("1");
});

test("Transaction requests are executed implicitly", async () => {
	const sql = postgres({ debug: true, idle_timeout: 1, fetch_types: false });
	expect(
		(
			await sql.begin((tx) => [
				tx`select set_config('postgres_js.test', 'testing', true)`,
				tx`select current_setting('postgres_js.test') as x`,
			])
		)[1][0].x,
	).toBe("testing");
});

test("Uncaught transaction request errors bubbles to transaction", async () => {
	expect(
		await sql
			.begin((tx) => [
				tx`select wat`,
				tx`select current_setting('postgres_js.test') as x, ${1} as a`,
			])
			.catch((e) => e.code),
	).toBe("42703");
});

test("Fragments in transactions", async () => {
	expect((await sql.begin((tx) => tx`select true as x where ${tx`1=1`}`))[0].x).toBe(true);
});

test("Transaction rejects with rethrown error", async () => {
	expect(
		await sql
			.begin(async (tx) => {
				try {
					await tx`select exception`;
				} catch {
					throw new Error("WAT");
				}
			})
			.catch((e) => e.message),
	).toBe("WAT");
});

test("Parallel transactions", async () => {
	await sql`create table test (a int)`;
	expect(
		(await Promise.all([sql.begin((tx) => tx`select 1`), sql.begin((tx) => tx`select 1`)])).map(
			(x) => x.count,
		),
	).toEqual([1, 1]);
});

test("Many transactions at beginning of connection", async () => {
	const sql = postgres(options);
	const xs = await Promise.all(Array.from({ length: 100 }, () => sql.begin((tx) => tx`select 1`)));
	expect(xs.length).toBe(100);
});

test("Transactions array", async () => {
	await sql`create table test (a int)`;

	expect(
		(await sql.begin((tx) => [tx`select 1`.then((x) => x), tx`select 1`])).map((x) => x.count),
	).toEqual([1, 1]);
});

test("Transaction waits", async () => {
	await sql`create table test (a int)`;
	await sql.begin(async (tx) => {
		await tx`insert into test values(1)`;
		await tx
			.savepoint(async (sp) => {
				await sp`insert into test values(2)`;
				throw new Error("please rollback");
			})
			.catch(() => {});
		await tx`insert into test values(3)`;
	});

	expect(
		(await Promise.all([sql.begin((tx) => tx`select 1`), sql.begin((tx) => tx`select 1`)])).map(
			(x) => x.count,
		),
	).toEqual([1, 1]);
});

test("Helpers in Transaction", async () => {
	expect((await sql.begin(async (tx) => await tx`select ${tx({ x: 1 })}`))[0].x).toBe("1");
});

test("Connection errors are caught using begin()", async () => {
	await using sql = postgres({ host: "localhost", port: 1 });
	const code = await sql
		.begin(async (tx) => {
			await tx`insert into test (label, value) values (${1}, ${2})`;
		})
		.then(
			() => "ran",
			(e) => e.code,
		);
	expect(code).toBe("ECONNREFUSED");
}, 2000);

test("Throws correct error when retrying in transactions", async () => {
	await sql`create table test(x int)`;
	const error = await sql
		.begin((tx) => tx`insert into test (x) values (${tx.typed(false, 16)})`)
		.catch((e) => e);
	expect(error.code).toBe("42804");
});

test("Properly throws routine error on not prepared statements in transaction", async () => {
	const { routine } = await sql
		.begin((tx) => [tx`create table x (x text[])`, tx`insert into x(x) values (('a', 'b'))`])
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

	expect(await sql.begin((tx) => tx`select ${"wat"}`).catch((e) => e.message)).toBe("watSerialize");
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

	expect(await sql.begin((tx) => tx`select 'wat'`).catch((e) => e.message)).toBe("watParse");
});

test("Prevent premature end of connection in transaction", async () => {
	const sql = postgres({ max_lifetime: 0.01, idle_timeout });
	const result = await sql.begin(async (tx) => {
		await tx`select 1`;
		await delay(20);
		await tx`select 1`;
		return "yay";
	});

	expect(result).toBe("yay");
});

test("Ensure reconnect after max_lifetime with transactions", async () => {
	const sql = postgres({
		max_lifetime: 0.01,
		idle_timeout,
		max: 1,
	});

	const xs = [];
	for (let i = 0; i < 10; i++) {
		const [{ x }] = await sql.begin((tx) => tx`select 1 as x`);
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
		.catch((e) => e);
	expect(x.code).toBe("CONNECTION_CLOSED");
});

test("Does not try rollback when commit errors", async () => {
	let notice = null;
	const sql = postgres({ ...options, onnotice: (x) => (notice = x) });
	await sql`create table test(x int constraint test_constraint unique deferrable initially deferred)`;

	await sql
		.begin("isolation level serializable", async (tx) => {
			await tx`insert into test values(1)`;
			await tx`insert into test values(1)`;
		})
		.catch((e) => e);

	expect(notice).toBe(null);
});

test("Transaction rejects when the server rolls back the commit", async () => {
	await using sql = postgres({ ...options, max: 1 });
	let xid;
	const result = await sql
		.begin(async (tx) => {
			[{ xid }] = await tx`select pg_current_xact_id()::text as xid`;
			await tx`savepoint parent_marker`;
			await tx
				.savepoint(async (sp) => {
					await sp`rollback to savepoint parent_marker`;
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
	expect([result, status]).toEqual(["rejected", "aborted"]);
});

test("Caught error inside a transaction still rejects it", async () => {
	await sql`create table test (x int)`;
	const result = await sql
		.begin(async (tx) => {
			await tx`insert into test values (1)`;
			await tx`select 1/0`.catch(() => {});
			return "committed";
		})
		.then(
			(x) => x,
			() => "rejected",
		);
	const [{ count }] = await sql`select count(*)::int from test`;
	expect([result, count]).toEqual(["rejected", 0]);
});

test("Notify inside a transaction with max 1", async () => {
	await using sql = postgres({ ...options, max: 1 });
	expect(await sql.begin((tx) => tx.notify("test", "x")).then(() => "ok")).toBe("ok");
});

test("Transaction at pipeline boundary is reserved", async () => {
	await using sql = postgres({ ...options, max: 2, max_pipeline: 1, fetch_types: false });
	await Promise.all([sql`select 1`, sql`select 1`]);
	const inflight = [sql`select pg_sleep(0.1)`.execute(), sql`select pg_sleep(0.1)`.execute()];
	const x = await sql
		.begin((tx) => tx`select 1 as x`)
		.then(
			(rows) => rows[0].x,
			(e) => e.code,
		);
	await Promise.all(inflight);
	expect(x).toBe(1);
});

test("Transaction is reserved with pipelining disabled", async () => {
	await using sql = postgres({ ...options, max: 2, max_pipeline: 0, fetch_types: false });
	const x = await sql
		.begin((tx) => tx`select 1 as x`)
		.then(
			(rows) => rows[0].x,
			(e) => e.code,
		);
	expect(x).toBe(1);
});

test("Query issued while BEGIN is in flight does not join the transaction", async () => {
	await using sql = postgres({ ...options, max: 1, fetch_types: false });
	await sql`create table test (a int)`;
	const transaction = sql
		.begin(async (tx) => {
			await tx`select 1`;
			throw new Error("rollback");
		})
		.catch(() => {});
	const insert = sql`insert into test values (1)`;
	await Promise.all([transaction, insert]);
	expect((await sql`select count(*)::int as n from test`)[0].n).toBe(1);
});

test("Transaction with sequential queries works with max_pipeline 0", async () => {
	await using sql = postgres({ ...options, max: 4, max_pipeline: 0 });
	expect(
		await sql.begin(async (tx) => {
			await tx`select set_config('postgres_js.test', 'testing', true)`;
			return (await tx`select current_setting('postgres_js.test') as x`)[0].x;
		}),
	).toBe("testing");
});

test("Transaction with concurrent queries works with max_pipeline 0", async () => {
	await using sql = postgres({ ...options, max: 4, max_pipeline: 0 });
	expect(
		(
			await sql.begin((tx) => [
				tx`select set_config('postgres_js.test', 'testing', true)`,
				tx`select current_setting('postgres_js.test') as x`,
			])
		)[1][0].x,
	).toBe("testing");
});

test("Undefined value in a transaction returning an array of queries rejects", async () => {
	await using sql = postgres(options);
	await sql`create table test (x int)`;
	const error = await sql
		.begin((tx) => [tx`insert into test values (1)`, tx`select ${undefined} as x`])
		.catch((e) => e.code);
	const count = (await sql`select count(*)::int from test`)[0].count;
	expect([error, count]).toEqual(["UNDEFINED_VALUE", 0]);
});

test("Undefined value aborts a pipelined transaction on a reserved connection", async () => {
	await using sql = postgres(options);
	await sql`create table test (x int)`;
	using reserved = await sql.reserve();
	const results = await Promise.all(
		[
			reserved`begin`,
			reserved`insert into test values (1)`,
			reserved`select ${undefined} as x`,
			reserved`insert into test values (2)`,
			reserved`commit`,
		].map((x) =>
			x.then(
				(result) => result.command,
				(e) => e.code,
			),
		),
	);
	reserved.release();
	const count = (await sql`select count(*)::int from test`)[0].count;
	expect([...results, count]).toEqual([
		"BEGIN",
		"INSERT",
		"UNDEFINED_VALUE",
		"25P02",
		"ROLLBACK",
		0,
	]);
});

test("Parameter failing to serialize aborts a pipelined transaction on a reserved connection", async () => {
	await using sql = postgres(options);
	await sql`create table test (x int)`;
	using reserved = await sql.reserve();
	const results = await Promise.all(
		[
			reserved`begin`,
			reserved`insert into test values (1)`,
			reserved`select ${new Date(NaN)}::timestamptz as x`,
			reserved`insert into test values (2)`,
			reserved`commit`,
		].map((x) =>
			x.then(
				(result) => result.command,
				(e) => e.code || e.name,
			),
		),
	);
	reserved.release();
	const count = (await sql`select count(*)::int from test`)[0].count;
	expect([...results, count]).toEqual(["BEGIN", "INSERT", "RangeError", "25P02", "ROLLBACK", 0]);
});

test("Does not reject leftover begin onclose after commit", async () => {
	const sql = postgres({ ...options, max: 1 });
	const rejections = [];
	const on_unhandled = (reason) => rejections.push(reason);
	process.on("unhandledRejection", on_unhandled);
	onTestFinished(() => {
		process.off("unhandledRejection", on_unhandled);
	});
	await sql.begin((tx) => tx`select 1`);
	await sql.end({ timeout: 0 });
	await delay(50);
	expect(rejections.length).toBe(0);
});

test("idle_in_transaction_session_timeout rejects the transaction", async () => {
	await using sql = postgres(options);
	const error = await sql
		.begin(async (tx) => {
			await tx`set local idle_in_transaction_session_timeout = '1s'`;
			await delay(1500);
			await tx`select 1`;
		})
		.catch((e) => e);
	expect(error.code).toBe("25P03");
});

test("Transaction queries fail after its connection is gone even if the callback continues", async () => {
	await using sql = postgres({ ...options, max: 1 });
	setTimeout(() => sql`select 1`.catch(() => {}), 1200);
	let code;
	await sql
		.begin(async (tx) => {
			await tx`set local idle_in_transaction_session_timeout = '1s'`;
			await delay(1500);
			code = await tx`select 'should fail'`.then(
				() => "ran",
				(e) => e.code,
			);
		})
		.catch(() => {});
	await delay(1000);
	expect(code).toBe("CONNECTION_CLOSED");
});

test("Disconnect rejects queued transaction queries and allows reconnect", async () => {
	await using sql = postgres({ ...options, max_pipeline: 1, fetch_types: false });
	let queries;

	const error = await sql
		.begin((tx) => {
			queries = [
				tx`select pg_terminate_backend(pg_backend_pid())`.execute(),
				tx`select 1`.execute(),
				tx`select 2`.execute(),
			];
			return Promise.allSettled(queries);
		})
		.catch((x) => x);

	const results = await Promise.allSettled(queries);
	const [{ x }] = await sql`select 1 as x`;
	expect([error.code, ...results.map((r) => r.status), x]).toEqual([
		"57P01",
		"rejected",
		"rejected",
		"rejected",
		1,
	]);
});

test("Disconnected transaction cannot query a reused connection", async () => {
	const code = await with_disconnected_transaction(({ sql, disconnected }) =>
		sql.begin(async (tx) => {
			await tx`select set_config('postgres_js.test', 'replacement', true)`;
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
	return with_disconnected_transaction(({ sql, finish }) =>
		sql.begin(async (tx) => {
			const [{ x: before }] = await tx`select txid_current()::text as x`;
			finish(error);
			await new Promise((resolve) => setImmediate(resolve));
			const [{ x: after }] = await tx`select txid_current()::text as x`;
			return [before, after];
		}),
	);
}

/**
 * Begins a transaction on a new pool, and terminates the transaction's backend while its callback
 * waits; then runs `fn`.
 * @param fn - a function that gets `sql`, the pool; `disconnected`, the `sql` of the transaction,
 *   whose connection is gone; and `finish`, which lets the transaction's callback return, or throw
 *   the error given to `finish`
 * @returns what `fn` returns, awaited
 */
async function with_disconnected_transaction(fn) {
	await using pool = postgres({ ...options, fetch_types: false });
	let finish, ready;
	const gate = new Promise<void>(
		(resolve, reject) => (finish = (error) => (error ? reject(error) : resolve())),
	);
	// Lets the transaction's callback return (if `fn` did not let it) before the pool ends
	await using _finish = defer(async () => {
		finish();
		await new Promise((resolve) => setImmediate(resolve));
	});
	const connected = new Promise((resolve) => (ready = resolve));
	const failed = pool
		.begin(async (tx) => {
			const [{ pid }] = await tx`select pg_backend_pid() as pid`;
			ready({ disconnected: tx, pid });
			await gate;
		})
		.catch((x) => x);

	const { disconnected, pid } = await Promise.race([
		connected,
		failed.then((error) => {
			throw error;
		}),
	]);
	await terminate(pid);
	await failed;
	return await fn({ sql: pool, disconnected, finish });
}

test("Savepoint names are quoted", async () => {
	await sql`create table test (a int)`;
	await sql.begin(async (tx) => {
		await tx.savepoint("with space", (sp) => sp`insert into test values (1)`);
		await tx.savepoint(
			'a";create table test_injected (a int);--',
			(sp) => sp`insert into test values (2)`,
		);
	});
	const [{ injected }] = await sql`select to_regclass('test_injected') is not null as injected`;
	expect([(await sql`select count(*)::int as n from test`)[0].n, injected]).toEqual([2, false]);
});

test("A prepared transaction name cannot close its quote", async () => {
	const name = "tx'; create table test_injected (a int); --";
	await sql.begin((tx) => {
		tx.prepare(name);
		return tx`select 1`;
	});
	const [{ gid }] = await sql`select gid from pg_prepared_xacts where gid like 'tx%'`;
	await sql.unsafe("rollback prepared '" + gid.replace(/'/g, "''") + "'");
	const [{ injected }] = await sql`select to_regclass('test_injected') is not null as injected`;
	expect(injected).toBe(false);
});

test("An unsafe begin is rejected and rolled back, and the queries behind it get their own answers", async () => {
	await using sql = postgres({ ...options, max: 2 });
	await sql`create table test (a int)`;
	const results = await Promise.all([
		sql`begin`.then(
			(x) => x.command,
			(e) => e.code,
		),
		sql`insert into test values (1) returning a`.then(
			(x) => [x.command, x[0].a],
			(e) => e.code,
		),
		sql`select 'third' as x`.then(
			(x) => [x.command, x[0].x],
			(e) => e.code,
		),
	]);
	const [{ n }] = await sql`select count(*)::int as n from test`;
	expect([results, n]).toEqual([["UNSAFE_TRANSACTION", ["INSERT", 1], ["SELECT", "third"]], 1]);
});

test("A begin hidden behind a comment runs alone, rolls back and leaves the queries pipelined behind it alone", async () => {
	await using sql = postgres({ ...options, max: 2 });
	await sql`create table test (a int)`;
	using reserved = await sql.reserve();
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
		x.map((r) => r[0].x),
	);
	expect([results, n, after]).toEqual([["UNSAFE_TRANSACTION", "INSERT", "SELECT"], 1, [1, 2]]);
});

test("A begin used again runs alone again, whether tagged, unsafe, prepared or not", async () => {
	await using sql = postgres({ ...options, max: 2 });
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
				await Promise.all([
					begin().then(
						(result) => result.command,
						(e) => e.code,
					),
					sql`insert into test values (1) returning a`.then(
						(result) => result.command,
						(e) => e.code,
					),
				]),
			);
		}
	}
	const [{ n }] = await sql`select count(*)::int as n from test`;
	expect([results, n]).toEqual([
		Array.from({ length: 8 }, () => ["UNSAFE_TRANSACTION", "INSERT"]),
		8,
	]);
});

test("A script with its own BEGIN and COMMIT in one simple query runs on the pool", async () => {
	await using sql = postgres({ ...options, max: 2 });
	await sql`create table test (a int)`;
	const commands = await sql
		.unsafe("begin; insert into test values (1); commit;")
		.then((x) => x.map((r) => r.command));
	const after = await sql
		.unsafe("select 1; begin; insert into test values (2); commit")
		.then((x) => x.map((r) => r.command));
	const [{ n }] = await sql`select count(*)::int as n from test`;
	expect([commands, after, n]).toEqual([
		["BEGIN", "INSERT", "COMMIT"],
		["SELECT", "BEGIN", "INSERT", "COMMIT"],
		2,
	]);
});

test("A query that leaves a transaction open on the pool is rejected and rolled back", async () => {
	await using sql = postgres({ ...options, max: 2 });
	await sql`create table test (a int)`;
	const opened = await sql.unsafe("select 1; start transaction").then(
		() => "ok",
		(e) => e.code,
	);
	for (let i = 0; i < 4; i++) {
		await sql`insert into test values (${i})`;
	}
	await sql.end();
	await using check = postgres(options);
	const [{ n }] = await check`select count(*)::int as n from test`;
	expect([opened, n]).toEqual(["UNSAFE_TRANSACTION", 4]);
});

test("A query issued before sql.begin runs before the transaction with max: 1", async () => {
	await using sql = postgres({ ...options, max: 1 });
	await sql`create table test (a int)`;
	const first = sql`select count(*)::int as n from test`.execute();
	const transaction = sql.begin((tx) => tx`insert into test values (1)`);
	const [{ n }] = await first;
	await transaction;
	expect(n).toBe(0);
});

test("A caught query that cannot be built aborts a transaction opened by hand on a reserved connection", async () => {
	await using sql = postgres(options);
	await sql`create table test (a int)`;
	using reserved = await sql.reserve();
	await reserved`begin`;
	await reserved`insert into test values (1)`;
	const bad = await reserved`select ${undefined} as x`.catch((e) => e.code);
	const commit = await reserved`commit`;
	reserved.release();
	const [{ n }] = await sql`select count(*)::int as n from test`;
	expect([bad, commit.command, n]).toEqual(["UNDEFINED_VALUE", "ROLLBACK", 0]);
});

test("A query that cannot be built on a reserved connection outside a transaction leaves the connection usable", async () => {
	await using sql = postgres(options);
	using reserved = await sql.reserve();
	const bad = await reserved`select ${undefined} as x`.catch((e) => e.code);
	const [{ x }] = await reserved`select 1 as x`;
	expect([bad, x]).toEqual(["UNDEFINED_VALUE", 1]);
});

test("sql.begin inside a transaction runs in a savepoint", async () => {
	await sql`create table test (x int)`;
	const result = await sql.begin(async (tx) => {
		await tx`insert into test values (1)`;
		await tx.begin((sp) => sp`insert into test values (2)`);
		await tx
			.begin(async (sp) => {
				await sp`insert into test values (3)`;
				throw new Error("undo 3");
			})
			.catch(() => {});
		return tx`select array_agg(x order by x)::text as xs from test`;
	});
	expect(result[0].xs).toBe("{1,2}");
});

test("A nested sql.begin with a different mode throws, the same mode is allowed", async () => {
	const codes = await sql.begin("read write", async (tx) => [
		await tx
			.begin("read only", (sp) => sp`select 1`)
			.then(
				() => "ran",
				(e) => e.code,
			),
		await tx
			.begin("READ  write", (sp) => sp`select 1`)
			.then(
				() => "ran",
				(e) => e.code,
			),
	]);
	expect(codes).toEqual(["NESTED_TRANSACTION_MODE", "ran"]);
});

test("A nested sql.begin can not be prepared", async () => {
	const code = await sql.begin(async (tx) =>
		tx
			.begin(async (sp) => sp.prepare("x"))
			.then(
				() => "ran",
				(e) => e.code,
			),
	);
	expect(code).toBe("NESTED_TRANSACTION_MODE");
});

test("A tagged savepoint runs its query in a savepoint", async () => {
	const [x] = await sql.begin((tx) => tx.savepoint`select 1 as x`);
	expect(x.x).toBe(1);
});

test("Queries in a Promise.all inside a transaction are pipelined in the order they were made (#951)", async () => {
	/**
	 * A hook for proxy_to_server() that delays what each side sends by 50 ms, so that a round trip
	 * takes a measurable time.
	 * @param socket - the proxy's socket to the side that `x` is for
	 * @param x - a chunk that the other side sent
	 * @returns true, so that the proxy itself leaves `x` alone
	 */
	const later = (socket: net.Socket, x: Buffer) => {
		setTimeout(() => {
			if (socket.writable) {
				socket.write(x);
			}
		}, 50);
		return true;
	};
	await using proxy = await proxy_to_server({
		from_client: (x, c) => later(c.server, x),
		from_server: (x, c) => later(c.client, x),
	});
	await using sql = postgres({
		...options,
		host: proxy.host,
		port: proxy.port,
		max: 1,
		fetch_types: false,
	});
	const result = await sql.begin(async (tx) => {
		await tx`create table test (x int)`;
		let start = Date.now();
		for (let i = 0; i < 5; i++) {
			await tx`select ${i}::int`;
		}
		const sequential = Date.now() - start;
		start = Date.now();
		const [, counted, , summed] = await Promise.all([
			tx`insert into test values (1)`,
			tx`select count(*)::int as n from test`,
			tx`insert into test values (2)`,
			tx`select sum(x)::int as n from test`,
			tx`select 1`,
		]);
		return [Date.now() - start < sequential / 2, counted[0].n, summed[0].n];
	});
	expect(result).toEqual([true, 1, 3]);
});

test("sql.rollback() rolls back without throwing, and begin resolves with the result (#500)", async () => {
	await sql`create table test (x int)`;
	const result = await sql.begin(async (tx) => {
		await tx`insert into test values (1)`;
		await tx.rollback();
		return "value";
	});
	const [{ n }] = await sql`select count(*)::int as n from test`;
	expect([result, n]).toEqual(["value", 0]);
});

test("sql.rollback() in a savepoint or nested begin rolls back only that, and the outer transaction commits", async () => {
	await sql`create table test (x int)`;
	await sql.begin(async (tx) => {
		await tx`insert into test values (1)`;
		await tx.savepoint(async (sp) => {
			await sp`insert into test values (2)`;
			return sp.rollback();
		});
		await tx.begin(async (sp) => {
			await sp`insert into test values (3)`;
			return sp.rollback();
		});
		await tx`insert into test values (4)`;
	});
	const [{ xs }] = await sql`select string_agg(x::text, ',' order by x) as xs from test`;
	expect(xs).toBe("1,4");
});

test("Queries, savepoints and nested begins after sql.rollback() are not sent and reject with TRANSACTION_ROLLED_BACK", async () => {
	await sql`create table test (x int)`;
	const codes = [];
	const outcome = await sql
		.begin(async (tx) => {
			await tx.rollback();
			codes.push(await tx`insert into test values (1)`.catch((e) => e.code));
			codes.push(await tx.savepoint((sp) => sp`select 1`).catch((e) => e.code));
			codes.push(await tx.begin((sp) => sp`select 1`).catch((e) => e.code));
		})
		.catch((e) => e.code);
	const [{ n }] = await sql`select count(*)::int as n from test`;
	expect([codes, outcome, n]).toEqual([
		Array(3).fill("TRANSACTION_ROLLED_BACK"),
		"TRANSACTION_ROLLED_BACK",
		0,
	]);
});

test("sql.rollback() comes after the queries already made, and the connection is left idle", async () => {
	await using sql = postgres({ ...options, max: 1 });
	await sql`create table test (x int)`;
	let same;
	await sql.begin(async (tx) => {
		const insert = tx`insert into test values (1)`.execute();
		// One microtask, by which Query.handle() has sent the insert
		await Promise.resolve();
		const a = tx.rollback();
		same = a === tx.rollback();
		await insert;
		return a;
	});
	const [{ n }] = await sql`select count(*)::int as n from test`,
		[{ status }] =
			await sql`select state as status from pg_stat_activity where pid = pg_backend_pid()`;
	expect([same, n, status]).toEqual([true, 0, "active"]);
});

test("A transaction ended by transaction_timeout rejects with the FATAL error instead of CONNECTION_CLOSED (#1283)", async ({
	skip,
}) => {
	const major = await server_major();
	skip(major < 17, "transaction_timeout needs PostgreSQL 17 or later");

	await using timed = postgres({ ...options, max: 1 });
	const error = await timed
		.begin(async (tx) => {
			await tx`select set_config('transaction_timeout', '200', true)`;
			await tx`select pg_sleep(2)`;
		})
		.catch((e) => e);
	expect([error.code, error.severity]).toEqual(["25P04", "FATAL"]);
});

test("A transaction whose backend is terminated mid-query rejects with the FATAL error (#1283)", async () => {
	await using sql = postgres({ ...options, max: 1 });
	const error = await sql
		.begin(async (tx) => {
			const [{ pid }] = await tx`select pg_backend_pid() as pid`;
			const query = tx`select pg_sleep(2)`.execute();
			await until_sleeping(pid);
			await terminate(pid);
			await query;
		})
		.catch((e) => e);
	expect([error.code, error.severity]).toEqual(["57P01", "FATAL"]);
});

test("A transaction terminated between statements rejects with the FATAL error, and its next query has it as cause (#1283)", async () => {
	await using sql = postgres({ ...options, max: 1 });
	let settled;
	const next = new Promise<any>((r) => (settled = r));
	const error = await sql
		.begin(async (tx) => {
			const [{ pid }] = await tx`select pg_backend_pid() as pid`;
			await terminate(pid);
			await delay(100);
			settled(await tx`select 1`.catch((e) => e));
		})
		.catch((e) => e);
	const later = await next;
	expect([error.code, error.severity, later.code, later.cause && later.cause.code]).toEqual([
		"57P01",
		"FATAL",
		"CONNECTION_CLOSED",
		"57P01",
	]);
});

test("A FATAL in answer to COMMIT rejects with CONNECTION_CLOSED, with the FATAL as cause", async () => {
	await using pool = postgres({ ...options, max: 1 });
	await pool`create table test (id int)`;
	// A trigger deferred to COMMIT, which terminates the backend that runs it
	await pool`
		create or replace function test_kill() returns trigger language plpgsql
		as $$ begin perform pg_terminate_backend(pg_backend_pid()); return null; end $$
	`;
	await pool`create constraint trigger test_kill after insert on test deferrable initially deferred for each row execute function test_kill()`;
	const error = await pool.begin((tx) => tx`insert into test values (1)`).catch((e) => e);
	const [{ n }] = await pool`select count(*)::int as n from test`;
	expect([error.code, error.cause && error.cause.code, n]).toEqual([
		"CONNECTION_CLOSED",
		"57P01",
		0,
	]);
});

test("A savepoint or nested begin rejects when the connection is lost while its callback runs (#1281)", async () => {
	const outcomes = [];
	for (const method of ["savepoint", "begin"]) {
		await using sql = postgres({ ...options, max: 1 });
		let started, release, settled;
		const pid = new Promise<number>((r) => (started = r)),
			gate = new Promise((r) => (release = r)),
			child = new Promise((r) => (settled = r));
		const root = sql
			.begin((tx) =>
				tx[method](async (sp) => {
					const [x] = await sp`select pg_backend_pid() as pid`;
					started(x.pid);
					await gate;
					return "child";
				})
					.then(
						() => "fulfilled",
						(e) => e.code,
					)
					.then((x) => {
						settled(x);
						return x;
					}),
			)
			.catch((e) => e.code);
		const backend = await pid;
		await terminate(backend);
		const outer = await root;
		release();
		outcomes.push([outer, await child]);
	}
	expect(outcomes).toEqual([
		["57P01", "57P01"],
		["57P01", "57P01"],
	]);
});
