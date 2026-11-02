import fs from "fs";
import crypto from "crypto";
import { expect, test } from "vitest";
import net from "net";
import {
	postgres,
	sql,
	options,
	thrown,
	delay,
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
	await sql`drop table test`;
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
		sql`select 1`.execute();
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
	const tx = sql.begin((sql) => (query.cancel(), sql`select pg_sleep(0.5) as hej, 'hejsa'`));
	const error = await query.catch((x) => x);
	await tx;
	expect(error.code).toBe("57014");
});

test("Result becomes array", async () => {
	expect((await sql`select 1`).slice() instanceof Array).toBe(true);
});

test("Include table oid and column number in column details", async () => {
	await sql`create table tester (name text, age int)`;
	const r = await sql`select name, age from tester where name like $1 and age > $2`.describe();
	const [{ oid }] = await sql`select oid from pg_class where relname = 'tester'`;

	try {
		expect(r.columns.map((c) => [c.table, c.number])).toEqual([
			[oid, 1],
			[oid, 2],
		]);
	} finally {
		await sql`drop table tester`;
	}
});

test("Large object", async () => {
	const file = new URL(import.meta.url);
	const md5 = crypto.createHash("md5").update(fs.readFileSync(file)).digest("hex");

	const lo = await sql.largeObject();
	await new Promise(async (r) =>
		fs
			.createReadStream(file)
			.pipe(await lo.writable())
			.on("finish", r),
	);
	await lo.seek(0);

	const out = crypto.createHash("md5");
	await new Promise((r) =>
		lo.readable().then((x) => x.on("data", (x) => out.update(x)).on("end", r)),
	);

	expect(out.digest("hex")).toBe(md5);
	await lo.close();
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
	await lo.write(Buffer.from("0123456789"));
	const [tell] = await lo.tell(),
		[size] = await lo.size();
	await lo.seek(0);
	const range = await read({ start: 2, end: 6 }),
		rest = await read({ highWaterMark: 4 }),
		writable = await lo.writable({ start: 3 });
	await new Promise((r) => writable.end("abc", r));
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
	await lo.close();
});

test("Multiple statements give one result each", async () => {
	await sql`create table test (x int)`;
	const xs = await sql.unsafe("update test set x = 1; delete from test; select 1 as a");
	expect(xs.map((x) => x.command)).toEqual(["UPDATE", "DELETE", "SELECT"]);
	await sql`drop table test`;
});

test("Error mid-result does not offset rows of next query", async () => {
	const sql = postgres({ ...options, max: 1 });
	await sql`select 1 / (g - 3) from generate_series(1, 5) g`.catch((x) => x);
	const result = await sql`select 1 as x`;
	await sql.end();
	expect(result.length).toBe(1);
});

test("Result is not sparse after a query errors mid row-stream", async () => {
	const sql = postgres({ ...options, max: 1 });
	await sql`select n, 1 / (3 - n) as boom from generate_series(1, 5) n`.catch(() => {});
	const result = await sql`select x from generate_series(1, 3) x`;
	await sql.end();
	expect(result.map((r) => r.x)).toEqual([1, 2, 3]);
});

test("Undefined value in a pipelined query rejects only that query", async () => {
	const sql = postgres(options);
	await sql`select 1`;
	const results = await Promise.all(
		[sql`select pg_sleep(0.1), 1 as x`, sql`select ${undefined} as x`, sql`select 3 as x`].map(
			(x) =>
				x.then(
					([x]) => x.x,
					(e) => e.code,
				),
		),
	);
	const after = (await sql`select 4 as x`)[0].x;
	await sql.end();
	expect([...results, after]).toEqual([1, "UNDEFINED_VALUE", 3, 4]);
});

test("Undefined value in a pipelined cursor rejects only that query", async () => {
	const sql = postgres(options);
	await sql`select 1`;
	const results = await Promise.all(
		[
			sql`select pg_sleep(0.1), 1 as x`,
			sql`select ${undefined} as x`.cursor(() => {}),
			sql`select 3 as x`,
		].map((x) =>
			x.then(
				(x) => (x.length ? x[0].x : x.command),
				(e) => e.code,
			),
		),
	);
	const after = (await sql`select 4 as x`)[0].x;
	await sql.end();
	expect([...results, after]).toEqual([1, "UNDEFINED_VALUE", 3, 4]);
});

test("Too many parameters in a pipelined query rejects only that query", async () => {
	const sql = postgres(options);
	await sql`select 1`;
	const results = await Promise.all(
		[
			sql`select pg_sleep(0.1), 1 as x`,
			sql.unsafe("select 2 as x", [...Array(65535).keys()]),
			sql`select 3 as x`,
			sql`select 4 as x`,
		].map((x) =>
			x.then(
				([x]) => x.x,
				(e) => e.code,
			),
		),
	);
	const after = (await sql`select 5 as x`)[0].x;
	await sql.end();
	expect([...results, after]).toEqual([1, "MAX_PARAMETERS_EXCEEDED", 3, 4, 5]);
});

test("Parameter failing to serialize in a pipelined cursor rejects only that query", async () => {
	const sql = postgres(options);
	await sql`select 1`;
	const results = await Promise.all(
		[
			sql`select pg_sleep(0.1), 1 as x`,
			sql`select ${new Date(NaN)}::timestamptz as x`.cursor(() => {}),
			sql`select 3 as x`,
		].map((x) =>
			x.then(
				(x) => (x.length ? x[0].x : x.command),
				(e) => e.name,
			),
		),
	);
	const after = (await sql`select 4 as x`)[0].x;
	await sql.end();
	expect([...results, after]).toEqual([1, "RangeError", 3, 4]);
});

test("Cancel piped query with a query piped behind it", async () => {
	await sql`select 1`;
	const last = sql`select pg_sleep(0.5)`.execute();
	const query = sql`select pg_sleep(2) as dig`;
	setTimeout(() => query.cancel(), 100);
	const [error, [{ x }]] = await Promise.all([query.catch((x) => x), sql`select 1 as x`]);
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
	const sql = postgres({ ...options, max: 1, idle_timeout: null });
	try {
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
	} finally {
		await sql.end();
	}
});

test("A cancel of a query pipelined behind another does not cancel a query sent after it", async () => {
	const sql = postgres({ ...options, max: 1, idle_timeout: null });
	try {
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
	} finally {
		await sql.end({ timeout: 0 });
	}
});

test("A cancel request that never completes holds its connection only for connect_timeout", async () => {
	let sockets = 0;
	const sql = postgres({
		...options,
		max: 1,
		idle_timeout: null,
		connect_timeout: 1,
		// The second socket is the cancel request's, which never connects
		socket: () => (++sockets === 1 ? net.connect(pg_port, "localhost") : new Promise(() => {})),
	});
	try {
		const [{ pid }] = await sql`select pg_backend_pid() as pid`,
			sleeping = sql`select pg_sleep(0.1)`.execute();
		await until_sleeping(pid);
		sleeping.cancel();
		await sleeping;
		const [{ x }] = await sql`select 1 as x`;
		expect([x, sockets]).toEqual([1, 2]);
	} finally {
		await sql.end({ timeout: 0 });
	}
});

test("Every cancel() of a query pipelined behind another settles when the connection closes", async () => {
	const sql = postgres({ ...options, max: 1 });
	try {
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
	} finally {
		await sql.end({ timeout: 0 });
	}
});

test("result.statement and query.statement have the documented name, string, types and columns", async () => {
	const q = sql`select ${1}::int as a`;
	const r = await q;
	const s = await sql.unsafe("select 1 as b");
	expect([
		r.statement.string,
		r.statement.types,
		r.statement.columns.map((x) => x.name),
		q.statement.string === r.statement.string,
		s.statement.name,
		s.statement.string,
		s.statement.columns.map((x) => x.name),
	]).toEqual(["select $1::int as a", [23], ["a"], true, "", "select 1 as b", ["b"]]);
});

test("debug gets the values as sent and the parameter types, also on first use", async () => {
	const calls = [];
	const sql = postgres({
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
	await sql.end();
});

test("Inspecting a query with debug shows why it can not be built", async () => {
	const util = await import("util"),
		sql = postgres({ ...options, debug: true });
	expect(util.inspect(sql`select ${undefined}`)).toBe(
		"Query { UNDEFINED_VALUE: Undefined values are not allowed }",
	);
	await sql.end();
});

test(".stream() says it is now .forEach()", async () => {
	expect(thrown(() => sql`select 1`.stream()).message).toBe(".stream has been renamed to .forEach");
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
	await sql`drop table test`;
});
