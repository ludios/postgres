import fs from "fs";
import crypto from "crypto";
import { pipeline } from "stream/promises";
import { expect, test } from "vitest";
import net from "net";
import {
	postgres,
	sql,
	options,
	thrown,
	delay,
	defer,
	terminate,
	until_sleeping,
	pg_port,
} from "./setup.ts";

test("Result is array", async () => {
	expect(Array.isArray(await sql`select 1`)).toBe(true);
});

test("Result has count", async () => {
	expect((await sql`select 1`).count).toBe(1);
});

test("Result has command", async () => {
	expect((await sql`select 1`).command).toBe("SELECT");
});

test("Create table", async () => {
	expect((await sql`create table test(int int)`).command).toBe("CREATE TABLE");
});

test("Drop table", async () => {
	await sql`create table test(int int)`;
	expect((await sql`drop table test`).command).toBe("DROP TABLE");
});

test("Big result", async () => {
	expect((await sql`select * from generate_series(1, 100000)`).count).toBe(100000);
});

test("Result has columns spec", async () => {
	expect((await sql`select 1 as x`).columns[0].name).toBe("x");
});

test("Result as arrays", async () => {
	const sql = postgres({
		...options,
		transform: {
			row: (x) => Object.values(x),
		},
	});

	expect((await sql`select 1 as a, 2 as b`)[0]).toEqual([1, 2]);
});

test("Raw method returns rows as arrays", async () => {
	const [x] = await sql`select 1`.raw();
	expect(Array.isArray(x)).toBe(true);
});

test("Array returns rows as arrays of columns", async () => {
	expect((await sql`select 1`.values())[0][0]).toBe(1);
});

test("Execute", async () => {
	const result = await new Promise((resolve) => {
		const sql = postgres({ ...options, fetch_types: false, debug: (id, query) => resolve(query) });
		void sql`select 1`.execute();
	});

	expect(result).toBe("select 1");
});

test("Cancel running query", async () => {
	const query = sql`select pg_sleep(2)`;
	setTimeout(() => query.cancel(), 500);
	const error = await query.catch((x) => x);
	expect(error.code).toBe("57014");
});

test("Cancel piped query", async () => {
	await sql`select 1`;
	const last = sql`select pg_sleep(1)`.execute();
	const query = sql`select pg_sleep(2) as dig`;
	setTimeout(() => query.cancel(), 500);
	const error = await query.catch((x) => x);
	await last;
	expect(error.code).toBe("57014");
});

test("Cancel queued query", async () => {
	const query = sql`select pg_sleep(2) as nej`;
	const transaction = sql.begin((tx) => {
		void query.cancel();
		return tx`select pg_sleep(0.5) as hej, 'hejsa'`;
	});
	const error = await query.catch((x) => x);
	await transaction;
	expect(error.code).toBe("57014");
});

test("Result becomes array", async () => {
	expect(Object.getPrototypeOf((await sql`select 1`).slice())).toBe(Array.prototype);
});

test("Include table oid and column number in column details", async () => {
	await sql`create table tester (name text, age int)`;
	await using _drop = defer(() => sql`drop table tester`);
	const r = await sql`select name, age from tester where name like $1 and age > $2`.describe();
	const [{ oid }] = await sql`select oid from pg_class where relname = 'tester'`;

	expect(r.columns.map((c) => [c.table, c.number])).toEqual([
		[oid, 1],
		[oid, 2],
	]);
});

test("A large object's close() rejects after a failed operation aborted its transaction", async () => {
	await using sql = postgres({ ...options, max: 1 });
	const lo = await sql.largeObject();
	const failed = await lo.seek(0, 99).catch((e) => e.code);
	const closed = await lo.close().catch((e) => e.code);
	// close() rejects with the error that aborted the transaction, which every later query of the
	// transaction gets
	expect([failed, closed]).toEqual(["22023", "22023"]);
	// The pool has its only connection back: the transaction rolled back and the lease ended
	expect((await sql`select 1 as x`)[0].x).toBe(1);
});

test("Large object", async () => {
	const file = new URL(import.meta.url);
	const md5 = crypto.createHash("md5").update(fs.readFileSync(file)).digest("hex");

	const lo = await sql.largeObject();
	await using _close = defer(() => lo.close());
	await pipeline(fs.createReadStream(file), await lo.writable());
	await lo.seek(0);

	const out = crypto.createHash("md5");
	await new Promise((r) =>
		lo.readable().then((stream) => stream.on("data", (chunk) => out.update(chunk)).on("end", r)),
	);

	expect(out.digest("hex")).toBe(md5);
});

test("Large object tell, size, truncate, and ranges for readable and writable", async () => {
	const lo = await sql.largeObject(),
		read = async (o?) => {
			let s = "";
			for await (const x of await lo.readable(o)) {
				s += x;
			}
			return s;
		};
	await using _close = defer(() => lo.close());
	await lo.write(Buffer.from("0123456789"));
	const [tell] = (await lo.tell()) as any,
		[size] = await lo.size();
	await lo.seek(0);
	const range = await read({ start: 2, end: 6 }),
		rest = await read({ highWaterMark: 4 }),
		writable = await lo.writable({ start: 3 });
	await new Promise<void>((r) => writable.end("abc", () => r()));
	await lo.seek(0);
	const all = await read();
	await lo.truncate(4);
	const [truncated] = await lo.size();
	expect([tell.lo_tell64, size.position, size.size, range, rest, all, truncated.size]).toEqual([
		"10",
		"10",
		"10",
		"2345",
		"6789",
		"012abc6789",
		"4",
	]);
});

test("Multiple statements give one result each", async () => {
	await sql`create table test (x int)`;
	const xs = await sql.unsafe("update test set x = 1; delete from test; select 1 as a");
	expect(xs.map((x) => x.command)).toEqual(["UPDATE", "DELETE", "SELECT"]);
});

test("Error mid-result does not offset rows of next query", async () => {
	await using sql = postgres({ ...options, max: 1 });
	await sql`select 1 / (g - 3) from generate_series(1, 5) g`.catch((x) => x);
	const result = await sql`select 1 as x`;
	expect(result.length).toBe(1);
});

test("Result is not sparse after a query errors mid row-stream", async () => {
	await using sql = postgres({ ...options, max: 1 });
	await sql`select n, 1 / (3 - n) as boom from generate_series(1, 5) n`.catch(() => {});
	const result = await sql`select x from generate_series(1, 3) x`;
	expect(result.map((r) => r.x)).toEqual([1, 2, 3]);
});

test("Undefined value in a pipelined query rejects only that query", async () => {
	await using sql = postgres(options);
	await sql`select 1`;
	const results = await Promise.all(
		[sql`select pg_sleep(0.1), 1 as x`, sql`select ${undefined} as x`, sql`select 3 as x`].map(
			(x) =>
				x.then(
					([row]) => row.x,
					(e) => e.code,
				),
		),
	);
	const after = (await sql`select 4 as x`)[0].x;
	expect([...results, after]).toEqual([1, "UNDEFINED_VALUE", 3, 4]);
});

test("Undefined value in a pipelined cursor rejects only that query", async () => {
	await using sql = postgres(options);
	await sql`select 1`;
	const results = await Promise.all(
		[
			sql`select pg_sleep(0.1), 1 as x`,
			sql`select ${undefined} as x`.cursor(() => {}),
			sql`select 3 as x`,
		].map((x) =>
			x.then(
				(result) => (result.length ? result[0].x : result.command),
				(e) => e.code,
			),
		),
	);
	const after = (await sql`select 4 as x`)[0].x;
	expect([...results, after]).toEqual([1, "UNDEFINED_VALUE", 3, 4]);
});

test("Too many parameters in a pipelined query rejects only that query", async () => {
	await using sql = postgres(options);
	await sql`select 1`;
	const results = await Promise.all(
		[
			sql`select pg_sleep(0.1), 1 as x`,
			sql.unsafe("select 2 as x", [...Array(65535).keys()]),
			sql`select 3 as x`,
			sql`select 4 as x`,
		].map((x) =>
			x.then(
				(rows) => rows[0].x,
				(e) => e.code,
			),
		),
	);
	const after = (await sql`select 5 as x`)[0].x;
	expect([...results, after]).toEqual([1, "MAX_PARAMETERS_EXCEEDED", 3, 4, 5]);
});

test("Parameter failing to serialize in a pipelined cursor rejects only that query", async () => {
	await using sql = postgres(options);
	await sql`select 1`;
	const results = await Promise.all(
		[
			sql`select pg_sleep(0.1), 1 as x`,
			sql`select ${new Date(NaN)}::timestamptz as x`.cursor(() => {}),
			sql`select 3 as x`,
		].map((x) =>
			x.then(
				(result) => (result.length ? result[0].x : result.command),
				(e) => e.name,
			),
		),
	);
	const after = (await sql`select 4 as x`)[0].x;
	expect([...results, after]).toEqual([1, "RangeError", 3, 4]);
});

test("Cancel piped query with a query piped behind it", async () => {
	await sql`select 1`;
	const last = sql`select pg_sleep(0.5)`.execute();
	const query = sql`select pg_sleep(2) as dig`;
	setTimeout(() => query.cancel(), 100);
	const [error, [{ x }]] = await Promise.all([query.catch((e) => e), sql`select 1 as x`]);
	await last;
	expect([error.code, x]).toEqual(["57014", 1]);
});

test("Cancel returns a promise", async () => {
	const query = sql`select pg_sleep(1)`.execute();
	const cancelled = query.cancel();
	const error = await query.catch((x) => x);
	expect([cancelled instanceof Promise, error.code]).toEqual([true, "57014"]);
});

test("A cancel that reaches the server after its query has finished does not cancel the next query", async () => {
	// Without an idle timeout, the next query has to run on the same connection
	await using sql = postgres({ ...options, max: 1, idle_timeout: null });
	const [{ pid }] = await sql`select pg_backend_pid() as pid`;
	const fast = sql`select 1`.execute();
	fast.catch(() => {});
	// Let the query go out, then block, so that the server finishes it while its reply stays unread
	await new Promise((resolve) => process.nextTick(resolve));
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
	const cancelled = fast.cancel(),
		[{ x, after }] = await sql`select pg_sleep(0.3), 1 as x, pg_backend_pid() as after`;
	await cancelled;
	expect([x, after]).toEqual([1, pid]);
});

test("A cancel of a query pipelined behind another does not cancel a query sent after it", async () => {
	await using sql = postgres({ ...options, max: 1, idle_timeout: null });
	const [{ pid }] = await sql`select pg_backend_pid() as pid`,
		head = sql`select pg_sleep(0.2)`.execute(),
		fast = sql`select 1`.execute();
	fast.catch(() => {});
	await until_sleeping(pid);
	// `fast` finishes long before its cancel request, sent once it is the head, arrives
	const cancelled = fast.cancel(),
		[{ x }] = await sql`select pg_sleep(0.3), 1 as x`;
	await Promise.all([cancelled, head]);
	expect(x).toBe(1);
});

test("A cancel request that times out closes its connection, so that it can't cancel a later query", async () => {
	let sockets = 0;
	await using sql = postgres({
		...options,
		max: 1,
		idle_timeout: null,
		connect_timeout: 1,
		// The second socket is the cancel request's, which never connects
		socket: () => (++sockets === 2 ? new Promise(() => {}) : net.connect(pg_port, "localhost")),
	});
	const [{ pid }] = await sql`select pg_backend_pid() as pid`,
		sleeping = sql`select pg_sleep(0.1)`.execute();
	await until_sleeping(pid);
	const cancelled = sleeping.cancel().then(
		() => "resolved",
		(error) => error.code,
	);
	await sleeping;
	const [{ other }] = await sql`select pg_backend_pid() as other`,
		outcome = await Promise.race([cancelled, delay(3000).then(() => "pending")]);
	expect([outcome, other === pid, sockets]).toEqual(["CONNECT_TIMEOUT", false, 3]);
});

test("A cancel of a pipelined query holds its connection for as long as the query ahead of it runs", async () => {
	await using sql = postgres({ ...options, max: 1, idle_timeout: null, connect_timeout: 1 });
	const [{ pid }] = await sql`select pg_backend_pid() as pid`,
		first = sql`select pg_sleep(1.5)`.execute(),
		second = sql`select 1`.execute();
	second.catch(() => {});
	await until_sleeping(pid);
	const cancelled = second.cancel();
	// Sent after connect_timeout, while the first query still runs; written before the cancel
	// request, it would get it
	await delay(1200);
	const third = sql`select pg_sleep(0.3)`.execute();
	await Promise.all([first, cancelled]);
	await expect(third).resolves.toBeDefined();
});

test("Canceling a pipelined query whose parameters failed to serialize does not hold its connection", async () => {
	await using sql = postgres({ ...options, max: 1, idle_timeout: null, connect_timeout: null });
	const [{ pid }] = await sql`select pg_backend_pid() as pid`,
		circular: any = {};
	circular.self = circular;
	const sleeping = sql`select pg_sleep(0.1)`.execute(),
		failed = sql`select ${sql.json(circular)} as x`.execute();
	failed.catch(() => {});
	await until_sleeping(pid);
	const cancelled = failed.cancel();
	await sleeping;
	await expect(failed).rejects.toThrow(TypeError);
	const settled = await Promise.race([
		Promise.all([cancelled, sql`select 1 as x`]).then(([, [{ x }]]) => x),
		delay(3000).then(() => "pending"),
	]);
	expect(settled).toBe(1);
});

test("sql.close() resolves when a query that waited behind a cancel request fails to serialize", async () => {
	await using sql = postgres({ ...options, max: 1, idle_timeout: null, connect_timeout: null });
	const reserved = await sql.reserve(),
		fast = reserved`select 1`.execute();
	fast.catch(() => {});
	// Let the query go out, then block, so that its ReadyForQuery comes before the cancel request
	// ends
	await new Promise((resolve) => process.nextTick(resolve));
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
	const cancelled = fast.cancel(),
		failed = reserved`select ${sql.json({ x: 1n })} as x`.execute();
	failed.catch(() => {});
	// Let the lease place the query, which waits behind the cancel request. Once the lease is
	// released, the query fails as one without a lease does, and is never sent.
	await new Promise((resolve) => process.nextTick(resolve));
	reserved.release();
	const closed = await Promise.race([
		sql.close().then(() => "closed"),
		delay(3000).then(() => "pending"),
	]);
	await cancelled;
	await expect(failed).rejects.toThrow(TypeError);
	expect(closed).toBe("closed");
});

test("Every cancel() of a query pipelined behind another settles when the connection closes", async () => {
	await using sql = postgres({ ...options, max: 1 });
	const [{ pid }] = await sql`select pg_backend_pid() as pid`,
		first = sql`select pg_sleep(10)`.execute(),
		second = sql`select 1`.execute();
	first.catch(() => {});
	second.catch(() => {});
	await until_sleeping(pid);
	const cancels = [second.cancel(), second.cancel()];
	await terminate(pid);
	const settled = await Promise.race([
		Promise.allSettled(cancels).then(() => "settled"),
		delay(3000).then(() => "pending"),
	]);
	expect(settled).toBe("settled");
});

test("result.statement and query.statement have the documented name, string, types and columns", async () => {
	const q = sql`select ${1}::int as a`;
	const r = await q;
	const s = await sql.unsafe("select 1 as b");
	expect([
		r.statement.string,
		r.statement.types,
		r.statement.columns.map((x) => x.name),
		(q as any).statement.string === r.statement.string,
		s.statement.name,
		s.statement.string,
		s.statement.columns.map((x) => x.name),
	]).toEqual(["select $1::int as a", [23], ["a"], true, "", "select 1 as b", ["b"]]);
});

test("debug gets the values as sent and the parameter types, also on first use", async () => {
	const calls = [];
	await using sql = postgres({
		...options,
		max: 1,
		debug: (id, query, values, types) => calls.push([values, types]),
	});
	await sql`select ${1}::int as x`;
	await sql`select ${1}::int as x`;
	expect(calls.slice(-2)).toEqual([
		[["1"], [23]],
		[["1"], [23]],
	]);
});

test("Inspecting a query with debug shows why it can not be built", async () => {
	const util = await import("util");
	await using sql = postgres({ ...options, debug: true });
	expect(util.inspect(sql`select ${undefined}`)).toBe(
		"Query { UNDEFINED_VALUE: Undefined values are not allowed }",
	);
});

test(".stream() says it is now .forEach()", async () => {
	expect(thrown(() => (sql`select 1` as any).stream()).message).toBe(
		".stream has been renamed to .forEach",
	);
});

test(".finally() runs the query", async () => {
	let ran = false;
	const [x] = await sql`select 1 as x`.finally(() => (ran = true));
	expect([x.x, ran]).toEqual([1, true]);
});

test("A deferred constraint failing at the end of an implicit transaction rejects the query (#1117, #1090)", async () => {
	await sql`create table test (x int constraint test_unique unique deferrable initially deferred)`;
	await sql`insert into test values (1)`;
	const codes = [
		await sql`insert into test ${sql({ x: 1 })}`.then(
			() => "ran",
			(e) => e.code,
		),
		await sql.unsafe("insert into test values (1)").then(
			() => "ran",
			(e) => e.code,
		),
		await sql`select count(*)::int as n from test`.then(([x]) => x.n),
	];
	expect(codes).toEqual(["23505", "23505", 1]);
});
