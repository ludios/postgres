import { expect, test } from "vitest";
import { postgres, sql, options, login_md5, rel, idle_timeout, delay } from "./setup.ts";

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
	let error;
	try {
		sql("select 1").then(() => {});
	} catch (e) {
		error = e.code;
	}
	expect(error).toBe("NOT_TAGGED_CALL");
});

test("sql().catch throws not tagged error", async () => {
	let error;
	try {
		sql("select 1").catch(() => {});
	} catch (e) {
		error = e.code;
	}
	expect(error).toBe("NOT_TAGGED_CALL");
});

test("sql().finally throws not tagged error", async () => {
	let error;
	try {
		sql("select 1").finally(() => {});
	} catch (e) {
		error = e.code;
	}
	expect(error).toBe("NOT_TAGGED_CALL");
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

	const inlines = "Bun" in globalThis;
	const expected = inlines ? "true" : "watyo";
	expect(
		await yo().catch((x) =>
			inlines ? String(x.stack.includes("errors.ts")) : x.stack.match(/wat|yo/g).join(""),
		),
	).toBe(expected);

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

test("Query and parameters on errorare not enumerable if debug is not set", async () => {
	const sql = postgres({ ...options, debug: false });

	expect(
		await sql`selec ${1}`.catch(
			(err) => err.propertyIsEnumerable("parameters") || err.propertyIsEnumerable("query"),
		),
	).toBe(false);
});

test("Query and parameters are enumerable if debug is set", async () => {
	const sql = postgres({ ...options, debug: true });

	expect(
		await sql`selec ${1}`.catch(
			(err) => err.propertyIsEnumerable("parameters") && err.propertyIsEnumerable("query"),
		),
	).toBe(true);
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
	expect([error, huge, x].join()).toBe("wat,json,1");
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
	expect(
		[
			json.name,
			json.code,
			json.constraint_name,
			json.table_name,
			json.message.includes("check constraint"),
		].join(" "),
	).toBe("PostgresError 23514 test_x_check test true");
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
