import net from "net";
import { expect, test, vi } from "vitest";
import {
	postgres,
	sql,
	options,
	login_md5,
	rel,
	idle_timeout,
	delay,
	port_of,
	pg_port,
	thrown,
	terminate,
} from "./setup.ts";

test("Undefined values throws", async () => {
	let error;

	await sql`
    select ${undefined} as x
  `.catch((x) => (error = x.code));

	expect(error).toBe("UNDEFINED_VALUE");
});

test("Throw syntax error", async () => {
	expect((await sql`wat 1`.catch((x) => x)).code).toBe("42601");
});

test("Proper handling of non object Errors", async () => {
	const sql = postgres({
		socket: () => {
			throw "wat";
		},
	});

	expect(await sql`select 1 as x`.catch((e) => e.message)).toBe("wat");
});

test("Proper handling of null Errors", async () => {
	const sql = postgres({
		socket: () => {
			throw null;
		},
	});

	expect(await sql`select 1 as x`.catch((e) => e.message)).toBe("null");
});

test("sql file throws", async () => {
	expect(await sql.file(rel("selectomondo.sql")).catch((x) => x.code)).toBe("ENOENT");
});

test("Throws if more than 65534 parameters", async () => {
	await sql`create table test (x int)`;
	expect(
		await sql`insert into test ${sql([...Array(65535).keys()].map((x) => ({ x })))}`.catch(
			(e) => e.code,
		),
	).toBe("MAX_PARAMETERS_EXCEEDED");
	await sql`drop table test`;
});

test("await sql() throws not tagged error", async () => {
	let error;
	try {
		await sql("select 1");
	} catch (e) {
		error = e.code;
	}
	expect(error).toBe("NOT_TAGGED_CALL");
});

test("sql().then throws not tagged error", async () => {
	expect(thrown(() => sql("select 1").then(() => {})).code).toBe("NOT_TAGGED_CALL");
});

test("sql().catch throws not tagged error", async () => {
	expect(thrown(() => sql("select 1").catch(() => {})).code).toBe("NOT_TAGGED_CALL");
});

test("sql().finally throws not tagged error", async () => {
	expect(thrown(() => sql("select 1").finally(() => {})).code).toBe("NOT_TAGGED_CALL");
});

test("little bobby tables", async () => {
	const name = "Robert'); DROP TABLE students;--";

	await sql`create table students (name text, age int)`;
	await sql`insert into students (name) values (${name})`;

	try {
		expect((await sql`select name from students`)[0].name).toBe(name);
	} finally {
		await sql`drop table students`;
	}
});

test("throws correct error when authentication fails", async () => {
	const sql = postgres({
		...options,
		...login_md5,
		pass: "wrong",
	});
	expect(await sql`select 1`.catch((e) => e.code)).toBe("28P01");
});

test("notice", async () => {
	let notice;
	const log = console.log;
	console.log = function (x) {
		notice = x;
	};

	const sql = postgres(options);

	await sql`create table if not exists users()`;
	await sql`create table if not exists users()`;

	console.log = log;

	expect(notice.severity).toBe("NOTICE");
});

test("notice hook", async () => {
	let notice;
	const sql = postgres({
		...options,
		onnotice: (x) => (notice = x),
	});

	await sql`create table if not exists users()`;
	await sql`create table if not exists users()`;

	expect(notice.severity).toBe("NOTICE");
});

test("Debug", async () => {
	let result;
	const sql = postgres({
		...options,
		debug: (connection_id, str) => (result = str),
	});

	await sql`select 1`;

	expect(result).toBe("select 1");
});

test("Async stack trace", async () => {
	const sql = postgres({ ...options, debug: false });
	// The query must be on the line right after the line with `new Error()`
	const line = parseInt(new Error().stack.split("\n")[1].match(":([0-9]+):")[1]);
	const error = await sql`error`.catch((x) => x);
	const expected = line + 1;
	expect(parseInt(error.stack.split("\n").pop().match(":([0-9]+):")[1])).toBe(expected);
});

test("Debug has long async stack trace", async () => {
	const sql = postgres({ ...options, debug: true });

	const error = await yo().catch((x) => x);
	const frames = [...error.stack.matchAll(/^\s+at (wat|yo) /gm)].map((m) => m[1]);
	expect(frames).toEqual(["wat", "yo"]);

	function yo() {
		return wat();
	}

	function wat() {
		return sql`error`;
	}
});

test("Error contains query string", async () => {
	expect(await sql`selec 1`.catch((err) => err.query)).toBe("selec 1");
});

test("Error contains query serialized parameters", async () => {
	expect(await sql`selec ${1}`.catch((err) => err.parameters[0])).toBe(1);
});

test("Error contains query raw parameters", async () => {
	expect(await sql`selec ${1}`.catch((err) => err.args[0])).toBe(1);
});

/**
 * Starts a query for each of `xs` on `sql`, each with its element as its only parameter.
 * @returns the promises of the errors that the queries reject with, in the order of `xs`
 */
function failures(sql, xs) {
	return xs.map((x) => sql`select pg_sleep(1), ${x}::text as x`.catch((e) => e));
}

// The tests below compare `args`, not `parameters`, because a query that fails before it is built
// has empty `parameters`.

test("Pipelined queries that a connection close rejects each get their own error", async () => {
	const sql = postgres({ ...options, max: 1 });
	const [{ pid }] = await sql`select pg_backend_pid() as pid`;
	const errors = failures(sql, ["a", "b", "c"]);
	await delay(50);
	await terminate(pid);
	// The `cause` of b's and c's errors is a's FATAL error, which must not have a's `args`
	expect((await Promise.all(errors)).map((e) => [e.args, e.cause?.args])).toEqual([
		[["a"], undefined],
		[["b"], undefined],
		[["c"], undefined],
	]);
	await sql.end();
});

test("Queries on a reserved connection that has closed each get their own error", async () => {
	const sql = postgres({ ...options, max: 1 }),
		reserved = await sql.reserve();
	const [{ pid }] = await reserved`select pg_backend_pid() as pid`;
	await terminate(pid);
	const errors = [];
	for (const x of ["a", "b", "c"]) {
		errors.push(await failures(reserved, [x])[0]);
	}
	expect(errors.map((e) => e.args)).toEqual([["a"], ["b"], ["c"]]);
	await sql.end();
});

test("Queries waiting for a connection when end() destroys the pool each get their own error", async () => {
	const sql = postgres({ ...options, max: 1 }),
		reserved = await sql.reserve();
	const errors = failures(sql, ["a", "b"]);
	await sql.end({ timeout: 0 });
	expect((await Promise.all(errors)).map((e) => e.args)).toEqual([["a"], ["b"]]);
	reserved.release();
});

test("Queries waiting for a connection when end() gives up connecting each get their own error", async () => {
	let attempts = 0;
	// A clean close, which the pool treats as a transient failure (and so keeps the queries waiting)
	const server = net.createServer((socket) => {
		attempts++;
		socket.end();
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	// A long backoff, so that the pool does not try again before end()
	const sql = postgres({
		...options,
		host: "127.0.0.1",
		port: port_of(server),
		max: 1,
		backoff: 60,
	});
	const errors = failures(sql, ["a", "b"]);
	await vi.waitUntil(() => attempts === 1 && sql.stats.opening === 0);
	await sql.end();
	server.close();
	expect((await Promise.all(errors)).map((e) => [e.code, e.args])).toEqual([
		["CONNECTION_ENDED", ["a"]],
		["CONNECTION_ENDED", ["b"]],
	]);
});

test("A transaction whose backend is terminated mid-query rejects with that query's error", async () => {
	const sql = postgres({ ...options, max: 1 });
	const error = await sql
		.begin(async (sql) => {
			const [{ pid }] = await sql`select pg_backend_pid() as pid`;
			const query = failures(sql, ["a"])[0];
			await delay(50);
			await terminate(pid);
			await query;
		})
		.catch((e) => e);
	await sql.end();
	expect([error.code, error.severity, error.args]).toEqual(["57P01", "FATAL", ["a"]]);
});

test("A transaction whose connection drops mid-query rejects with that query's error", async () => {
	const sockets = [];
	// A proxy to the server, so that the test can drop the connection without a FATAL error
	const proxy = net.createServer((client) => {
		const server = net.connect(pg_port, "localhost");
		client.pipe(server).pipe(client);
		for (const socket of [client, server]) {
			socket.on("error", () => {});
			sockets.push(socket);
		}
	});
	await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", r));
	const sql = postgres({ ...options, host: "127.0.0.1", port: port_of(proxy), max: 1 });
	const error = await sql
		.begin(async (sql) => {
			const query = failures(sql, ["a"])[0];
			await delay(50);
			for (const socket of sockets) {
				socket.destroy();
			}
			await query;
		})
		.catch((e) => e);
	proxy.close();
	await sql.end();
	expect([error.code, error.args]).toEqual(["CONNECTION_CLOSED", ["a"]]);
});

test("Cursors whose callbacks are running when the connection closes each get their own error", async () => {
	const sql = postgres({ ...options, max: 1 });
	let resume,
		pid,
		cursors,
		started = 0,
		settled = 0;
	const paused = new Promise((r) => (resume = r));
	const done = sql
		.begin(async (tx) => {
			pid = (await tx`select pg_backend_pid() as pid`)[0].pid;
			cursors = ["a", "b"].map((x) =>
				tx`select ${x}::text as x from generate_series(1, 3)`
					.cursor(1, () => {
						started++;
						return paused;
					})
					.catch((e) => e)
					.finally(() => {
						settled++;
					}),
			);
			await Promise.all(cursors);
		})
		.catch(() => {});
	try {
		await vi.waitUntil(() => started === 2);
		await terminate(pid);
		// The close must reject the cursors while their callbacks are still running
		await vi.waitUntil(() => settled === 2);
	} finally {
		resume();
		await done;
		await sql.end();
	}
	expect((await Promise.all(cursors)).map((e) => [e.code, e.args])).toEqual([
		["CONNECTION_CLOSED", ["a"]],
		["CONNECTION_CLOSED", ["b"]],
	]);
});

test("Queries that a reserved connection gets just as it closes each get their own error", async () => {
	let raw;
	const sql = postgres({
		...options,
		max: 1,
		socket: () => (raw = net.connect(pg_port, "localhost")),
	});
	const reserved = await sql.reserve();
	await reserved`select 1`;
	// Two queries that execute and two that only describe, so that the check in place() for a
	// closed connection would show if two queries of either kind got the same error
	const errors = [
		reserved`select ${"a"}::text as x`.execute(),
		reserved`select ${"b"}::text as x`.execute(),
		reserved`select ${"c"}::text as x`.describe(),
		reserved`select ${"d"}::text as x`.describe(),
	].map((q) => q.catch((e) => e));
	// Each query is sent to the lease in one microtask, and goes to the connection in a later
	// microtask. The connection closes in a microtask between those two, as it can with a socket
	// that reports its close in a microtask (as on Cloudflare).
	queueMicrotask(() => raw.emit("error", new Error("closed between microtasks")));
	try {
		expect((await Promise.all(errors)).map((e) => [e.code, e.args])).toEqual([
			["CONNECTION_CLOSED", ["a"]],
			["CONNECTION_CLOSED", ["b"]],
			["CONNECTION_CLOSED", ["c"]],
			["CONNECTION_CLOSED", ["d"]],
		]);
	} finally {
		reserved.release();
		await sql.end();
	}
});

test("Query and parameters on an error are not enumerable if debug is not set", async () => {
	const sql = postgres({ ...options, debug: false });

	expect(
		await sql`selec ${1}`.catch((err) => [
			err.query,
			err.parameters,
			err.propertyIsEnumerable("query"),
			err.propertyIsEnumerable("parameters"),
		]),
	).toEqual(["selec $1", [1], false, false]);
});

test("Query and parameters on an error are enumerable if debug is set", async () => {
	const sql = postgres({ ...options, debug: true });

	expect(
		await sql`selec ${1}`.catch((err) => [
			err.query,
			err.parameters,
			err.propertyIsEnumerable("query"),
			err.propertyIsEnumerable("parameters"),
		]),
	).toEqual(["selec $1", [1], true, true]);
});

test("Postgres errors are of type PostgresError", async () => {
	expect((await sql`bad keyword`.catch((e) => e)) instanceof sql.PostgresError).toBe(true);
});

test("Catches query format errors", async () => {
	expect(
		await sql
			.unsafe({
				toString: () => {
					throw new Error("wat");
				},
			})
			.catch((e) => e.message),
	).toBe("wat");
});

test("A query that fails to encode leaves the connection usable", async () => {
	const sql = postgres({ ...options, max: 1 });
	const error = await sql
		.unsafe({
			toString: () => {
				throw new Error("wat");
			},
		})
		.catch((e) => e.message);
	const huge = await sql`select ${{
		toJSON() {
			throw new Error("json");
		},
	}}::json`.catch((e) => e.message);
	const [{ x }] = await sql`select 1 as x`;
	expect([error, huge, x]).toEqual(["wat", "json", 1]);
	await sql.end();
});

test("Catches type serialize errors", async () => {
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

	expect(await sql`select ${"wat"}`.catch((e) => e.message)).toBe("watSerialize");
});

test("Catches type parse errors", async () => {
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

	expect(await sql`select 'wat'`.catch((e) => e.message)).toBe("watParse");
});

test("Insert array with undefined throws", async () => {
	await sql`create table test (x int[])`;
	expect(await sql`insert into test ${sql({ x: [1, undefined, 3] })}`.catch((e) => e.code)).toBe(
		"UNDEFINED_VALUE",
	);
	await sql`drop table test`;
});

test("A PostgresError has its fields and its message in JSON (#767)", async () => {
	await sql`create table test (x int check (x > 0))`;
	const error = await sql`insert into test values (-1)`.catch((e) => e);
	const json = JSON.parse(JSON.stringify(error));
	expect([
		json.name,
		json.code,
		json.constraint_name,
		json.table_name,
		json.message.includes("check constraint"),
	]).toEqual(["PostgresError", "23514", "test_x_check", "test", true]);
	await sql`drop table test`;
});

test("The cached origin of a query does not keep the closure that made it alive (#1274)", async ({
	skip,
}) => {
	const v8 = await import("v8"),
		vm = await import("vm");
	let gc;
	try {
		v8.setFlagsFromString("--expose-gc");
		gc = vm.runInNewContext("gc");
	} catch {
		skip("this runtime cannot expose gc()");
	}

	const refs = [];
	await holding(refs);

	for (let i = 0; i < 5; i++) {
		await delay(10);
		gc();
	}

	expect(refs[0].deref() === undefined).toBe(true);
});

function holding(refs) {
	const big = { data: Buffer.alloc(1e6) };
	refs.push(new WeakRef(big));
	return (function inner() {
		return sql`select ${big.data.length} as n`;
	})();
}
