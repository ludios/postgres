import { expect, test } from "vitest";
import type { Sql, Row } from "../types/index.js";
import { postgres, sql, options, delay, thrown, defer, proxy_to_server } from "./setup.ts";

test("null", async () => {
	expect((await sql`select ${null} as x`)[0].x).toBe(null);
});

test("Integer", async () => {
	expect((await sql`select ${1} as x`)[0].x).toBe("1");
});

test("String", async () => {
	expect((await sql`select ${"hello"} as x`)[0].x).toBe("hello");
});

test("Boolean false", async () => {
	expect((await sql`select ${false}::bool as x`)[0].x).toBe(false);
});

test("Boolean true", async () => {
	expect((await sql`select ${true}::bool as x`)[0].x).toBe(true);
});

test("Date", async () => {
	const now = new Date();
	expect(+now - (await sql`select ${now}::timestamptz as x`)[0].x).toBe(0);
});

test("infer: true types booleans, dates and arrays of them without a cast, as v3 did", async () => {
	await using sql = postgres({ ...options, infer: true });
	const now = new Date();
	const [x] =
		await sql`select ${true} as a, ${false} as b, ${now} as c, ${[now, now]} as d, ${[true, false]} as e`;
	expect(x).toEqual({ a: true, b: false, c: now, d: [now, now], e: [true, false] });
});

test("infer: false leaves untyped parameters to the server, so they come back as text without a cast", async () => {
	await using sql = postgres({ ...options, infer: false });
	const [x] = await sql`select ${true} as a, ${new Date(0)} as b`;
	expect([typeof x.a, typeof x.b]).toEqual(["string", "string"]);
});

test("Json", async () => {
	const x = (await sql`select ${sql.json({ a: "hello", b: 42 })} as x`)[0].x;
	expect([x.a, x.b]).toEqual(["hello", 42]);
});

test("implicit json", async () => {
	const x = (await sql`select ${{ a: "hello", b: 42 } as any}::json as x`)[0].x;
	expect([x.a, x.b]).toEqual(["hello", 42]);
});

test("implicit jsonb", async () => {
	const x = (await sql`select ${{ a: "hello", b: 42 } as any}::jsonb as x`)[0].x;
	expect([x.a, x.b]).toEqual(["hello", 42]);
});

test("Empty array", async () => {
	expect(Array.isArray((await sql`select ${[]}::text[] as x`)[0].x)).toBe(true);
});

test("String array", async () => {
	expect((await sql`select ${"{1,2,3}"}::int[] as x`)[0].x).toEqual([1, 2, 3]);
});

test("Array of Integer", async () => {
	expect((await sql`select ${[1, 2, 3]}::int[] as x`)[0].x[2]).toBe(3);
});

test("Array of String", async () => {
	expect((await sql`select ${["a", "b", "c"]}::text[] as x`)[0].x[2]).toBe("c");
});

test("Array of Date", async () => {
	const now = new Date();
	const expected = now.getTime();
	expect((await sql`select ${[now, now, now]}::timestamptz[] as x`)[0].x[2].getTime()).toBe(
		expected,
	);
});

test("Array of Box", async () => {
	expect((await sql`select ${"{(1,2),(3,4);(4,5),(6,7)}"}::box[] as x`)[0].x).toEqual([
		"(3,4),(1,2)",
		"(6,7),(4,5)",
	]);
});

test("Nested array n2", async () => {
	expect(
		(
			await sql`select ${[
				[1, 2],
				[3, 4],
			]}::int[] as x`
		)[0].x[1][1],
	).toBe(4);
});

test("Nested array n3", async () => {
	expect((await sql`select ${[[[1, 2]], [[3, 4]], [[5, 6]]]}::int[] as x`)[0].x[2][0][1]).toBe(6);
});

test("Escape in arrays", async () => {
	expect((await sql`select ${['Hello "you"', "c:\\windows"]}::text[] as x`)[0].x).toEqual([
		'Hello "you"',
		"c:\\windows",
	]);
});

test("null for int", async () => {
	await sql`create table test (x int)`;
	expect((await sql`insert into test values(${null})`).count).toBe(1);
});

test("Null sets to null", async () => {
	expect((await sql`select ${null} as x`)[0].x).toBe(null);
});

test("Point type", async () => {
	const sql = postgres({
		...options,
		types: {
			point: {
				to: 600,
				from: [600],
				serialize: ([x, y]: number[]) => "(" + x + "," + y + ")",
				parse: (x: string) =>
					x
						.slice(1, -1)
						.split(",")
						.map((s) => +s),
			},
		},
	});

	await sql`create table test (x point)`;
	await sql`insert into test (x) values (${sql.types.point([10, 20])})`;
	expect((await sql`select x from test`)[0].x[1]).toBe(20);
});

test("Point type array", async () => {
	const sql = postgres({
		...options,
		types: {
			point: {
				to: 600,
				from: [600],
				serialize: ([x, y]: number[]) => "(" + x + "," + y + ")",
				parse: (x: string) =>
					x
						.slice(1, -1)
						.split(",")
						.map((s) => +s),
			},
		},
	});

	await sql`create table test (x point[])`;
	await sql`insert into test (x) values (${[sql.types.point([10, 20]), sql.types.point([20, 30])]})`;
	expect((await sql`select x from test`)[0].x[1][1]).toBe(30);
});

test("bytea serializes and parses", async () => {
	const buf = Buffer.from("wat");

	await sql`create table test (x bytea)`;
	await sql`insert into test values (${buf})`;

	expect((await sql`select x from test`)[0].x).toEqual(buf);
});

test("bigint is returned as String", async () => {
	expect(typeof (await sql`select 9223372036854777 as x`)[0].x).toBe("string");
});

test("int is returned as Number", async () => {
	expect(typeof (await sql`select 123 as x`)[0].x).toBe("number");
});

test("numeric is returned as string", async () => {
	expect(typeof (await sql`select 1.2 as x`)[0].x).toBe("string");
});

test("Null in text array", async () => {
	const [{ x }] = await sql`select array['a', null, 'b']::text[] as x`;
	expect(x).toStrictEqual(["a", null, "b"]);
});

test("Null in arrays of other types", async () => {
	const x = (
		await sql`
    select
      array[1, null]::int2[] as int2,
      array[null, 2]::int4[] as int4,
      array[1, null]::bigint[] as bigint,
      array[1.5, null]::numeric[] as numeric,
      array[true, null, false]::bool[] as bool,
      array['1970-01-01 00:00:00+00'::timestamptz, null] as timestamptz
  `
	)[0];

	expect([x.int2, x.int4, x.bigint, x.numeric, x.bool, x.timestamptz]).toStrictEqual([
		[1, null],
		[null, 2],
		["1", null],
		["1.5", null],
		[true, null, false],
		[new Date(0), null],
	]);
});

test("Null in json array", async () => {
	const [{ x }] = await sql`select array['{"a":1}'::json, null] as x`;
	expect(x).toStrictEqual([{ a: 1 }, null]);
});

test("Null in array_agg", async () => {
	const [{ x }] = await sql`select array_agg(y) as x from (values ('a'), (null), ('b')) as v(y)`;
	expect(x).toStrictEqual(["a", null, "b"]);
});

test("Null in nested arrays", async () => {
	const x = (
		await sql`
    select
      array[[1, null], [null, 4]]::int[] as ints,
      array[[['a', null]], [[null, 'd e']]]::text[] as strings
  `
	)[0];

	expect([x.ints, x.strings]).toStrictEqual([
		[
			[1, null],
			[null, 4],
		],
		[[["a", null]], [[null, "d e"]]],
	]);
});

test("Null in array of only nulls", async () => {
	expect((await sql`select array[null, null]::text[] as x`)[0].x).toStrictEqual([null, null]);
});

test("String NULL in array is not null", async () => {
	const [{ x }] = await sql`select array['NULL', null, 'null', 'Null']::text[] as x`;
	expect(x).toStrictEqual(["NULL", null, "null", "Null"]);
});

test("String NULL in nested array is not null", async () => {
	const [{ x }] = await sql`select array[['NULL', null], [null, 'NULL']]::text[] as x`;
	expect(x).toStrictEqual([
		["NULL", null],
		[null, "NULL"],
	]);
});

test("String NULL in array round trips", async () => {
	const [{ x }] = await sql`select ${["NULL", null, "a"]}::text[] as x`;
	expect(x).toStrictEqual(["NULL", null, "a"]);
});

test("Null in array does not reach custom type parser", async () => {
	const parsed: string[] = [];
	await using sql = postgres({
		...options,
		types: {
			text: {
				to: 25,
				from: [25],
				serialize: (x: unknown) => x,
				parse: (x: string) => {
					parsed.push(x);
					return x.toUpperCase();
				},
			},
		},
	});

	const x = (await sql`select array['a', null, 'NULL']::text[] as x`)[0].x;
	expect([x, parsed]).toStrictEqual([
		["A", null, "NULL"],
		["a", "NULL"],
	]);
});

test("Infinity timestamp parses to Infinity", async () => {
	expect((await sql`select 'infinity'::timestamptz as x`)[0].x).toBe(Infinity);
});

test("-Infinity timestamp parses to -Infinity", async () => {
	expect((await sql`select '-infinity'::timestamptz as x`)[0].x).toBe(-Infinity);
});

test("Infinity timestamp round-trips", async () => {
	expect((await sql`select ${sql.typed(Infinity, 1184)} as x`)[0].x).toBe(Infinity);
});

test("-Infinity timestamp round-trips", async () => {
	expect((await sql`select ${sql.typed(-Infinity, 1184)} as x`)[0].x).toBe(-Infinity);
});

test("Date before year 100", async () => {
	await using sql = postgres({ ...options, connection: { TimeZone: "UTC" } });
	const [{ x }] = await sql`select '0050-06-15 12:30:00+00'::timestamptz as x`;
	expect(x.toISOString()).toBe("0050-06-15T12:30:00.000Z");
});

test("Date with an offset in seconds", async () => {
	await using sql = postgres({ ...options, connection: { TimeZone: "Europe/Copenhagen" } });
	const [{ x, y }] = await sql`
    select '1850-06-15 12:30:00+00'::timestamptz as x, '0050-06-15 12:30:00+00'::timestamptz as y
  `;
	expect([x.toISOString(), y.toISOString()]).toEqual([
		"1850-06-15T12:30:00.000Z",
		"0050-06-15T12:30:00.000Z",
	]);
});

test("Domain type wrapping an array resolves to the base type serializer, for a domain made before the pool starts", async () => {
	await sql`drop domain if exists pg_test_domain_array cascade`;
	await sql`create domain pg_test_domain_array as text[]`;
	await sql`create table test (x pg_test_domain_array)`;
	await using _drop = defer(() => sql.unsafe("drop table test; drop domain pg_test_domain_array"));
	await using fresh = postgres(options);
	expect((await fresh`insert into test values (${["a", "b"]}) returning x`)[0].x).toEqual([
		"a",
		"b",
	]);
});

test("Nested domain types resolve through to their base type serializer, for a domain made before the pool starts", async () => {
	await sql`drop domain if exists pg_test_domain_nested_child cascade`;
	await sql`drop domain if exists pg_test_domain_nested_parent cascade`;
	await sql`create domain pg_test_domain_nested_parent as text[]`;
	await sql`create domain pg_test_domain_nested_child as pg_test_domain_nested_parent`;
	await sql`create table test (x pg_test_domain_nested_child)`;
	await using _drop = defer(() =>
		sql.unsafe(
			"drop table test; drop domain pg_test_domain_nested_child; drop domain pg_test_domain_nested_parent",
		),
	);
	await using fresh = postgres(options);
	expect((await fresh`insert into test values (${["a", "b"]}) returning x`)[0].x).toEqual([
		"a",
		"b",
	]);
});

test("Built-in array types without fetch_types", async () => {
	await using sql = postgres({ ...options, fetch_types: false });
	const [{ x, y }] = await sql`select array['a', 'b']::text[] as x, array[1, 2]::int4[] as y`;
	const [{ z }] = await sql`select ${["c", "d"]}::text[] as z`;
	expect([x[1], y[1], z[1]]).toEqual(["b", 2, "d"]);
});

test("Object with a type key in a jsonb array", async () => {
	await sql`create table test (nodes jsonb[])`;
	await sql`insert into test ${sql({ nodes: [{ type: "a", v: 1 }] })}`;
	const [{ nodes }] = await sql`select nodes from test`;
	expect([nodes[0].type, nodes[0].v]).toEqual(["a", 1]);
});

test("infer: false sends a boolean to a jsonb parameter", async () => {
	await using sql = postgres({ ...options, infer: false });
	expect((await sql`select ${true}::jsonb as x`)[0].x).toBe(true);
});

test("infer: false sends a boolean array", async () => {
	await using sql = postgres({ ...options, infer: false });
	expect((await sql`select ${[true, false]}::bool[] as x`)[0].x).toEqual([true, false]);
});

test("infer: false sends strings to boolean, bytea and date parameters as text", async () => {
	await using sql = postgres({ ...options, infer: false, max: 1 });
	await sql`create temp table shapes (a boolean, b bytea, c timestamptz, d boolean[])`;
	await sql`insert into shapes values (${"yes"}, ${"\\x4142"}, ${"2026-10-17T12:00:00Z"}, ${["t", false]})`;
	const [x] = await sql`select a, encode(b, 'escape') as b, c, d from shapes`;
	expect(x).toEqual({ a: true, b: "AB", c: new Date("2026-10-17T12:00:00Z"), d: [true, false] });
});

test("infer: false writes a Date to a timestamp column as the instant it is, not in the session time zone", async () => {
	await using sql = postgres({
		...options,
		infer: false,
		max: 1,
		connection: { TimeZone: "America/New_York" },
	});
	await sql`create temp table stamps (at timestamp)`;
	await sql`insert into stamps values (${new Date("2026-10-17T12:00:00Z")})`;
	const [{ at }] = await sql`select at::text from stamps`;
	expect(at).toBe("2026-10-17 12:00:00");
});

test("infer: false reads a timestamp column back as the instant that was written", async () => {
	await using sql = postgres({
		...options,
		infer: false,
		max: 1,
		connection: { TimeZone: "America/New_York" },
	});
	await sql`create table test (at timestamp, ats timestamp[])`;
	const date = new Date("2026-06-01T12:00:00.123Z");
	await sql`insert into test values (${date}, ${[date]})`;
	const [{ at, ats }] = await sql`select at, ats from test`;
	expect([at, ats]).toEqual([date, [date]]);
});

test("Custom type serializes values the server says are of a type in its from (#1129)", async () => {
	await using sql = postgres({
		...options,
		max: 1,
		types: {
			point: {
				to: 600,
				from: [600],
				serialize: ([x, y]: number[]) => "(" + x + "," + y + ")",
				parse: (x: string) => x.slice(1, -1).split(",").map(Number),
			},
		},
	});
	await sql`create temp table points (p point)`;
	await sql`insert into points values (${[1, 2]})`;
	const [{ p }] = await sql`select p from points`;
	expect(p).toEqual([1, 2]);
});

/**
 * Creates the table `name`, whose column `m` has the new enum type `<name>_mood` ('a', 'b'), after
 * dropping any table and type of those names that an earlier run left.
 * @param name - the name of the table
 * @param rows - the rows to insert, as the SQL after `values` (e.g. "('a'), ('b')"), if any
 * @returns a disposer that drops the table and the type
 */
async function enum_table(name: string, rows?: string) {
	await sql.unsafe(
		[
			"drop table if exists " + name,
			"drop type if exists " + name + "_mood",
			"create type " + name + "_mood as enum ('a', 'b')",
			"create table " + name + " (m " + name + "_mood)",
			...(rows ? ["insert into " + name + " values " + rows] : []),
		].join(";"),
	);
	return defer(() => sql.unsafe("drop table " + name + "; drop type " + name + "_mood"));
}

test("A column of a type Postgres.js does not know returns its rows as text, empty or not", async () => {
	await using _drop = await enum_table("test_enum_rows");
	await using fresh = postgres(options);
	const empty = await fresh`select m from test_enum_rows`;
	await sql`insert into test_enum_rows values ('a'), ('b')`;
	const tagged = await fresh`select m from test_enum_rows order by m`,
		simple = await fresh.unsafe("select m from test_enum_rows order by m"),
		many = await fresh.unsafe("select m from test_enum_rows order by m; select 1 as n");
	expect([
		empty.length,
		tagged.map((x) => x.m),
		simple.map((x) => x.m),
		many[0].map((x: Row) => x.m),
		many[1][0].n,
	]).toEqual([0, ["a", "b"], ["a", "b"], ["a", "b"], 1]);
});

test("forEach and cursors get every row of a column of a type Postgres.js does not know", async () => {
	await using _drop = await enum_table("test_enum_each", "('a'), ('b'), ('a')");
	await using fresh = postgres(options);
	const seen: unknown[] = [],
		batches: number[] = [];
	await fresh`select m from test_enum_each`.forEach((row) => seen.push(row.m));
	await fresh`select m from test_enum_each`.cursor(2, (rows) => {
		batches.push(rows.length);
	});
	expect([seen.length, batches]).toEqual([3, [2, 1]]);
});

test("A parameter of a type Postgres.js does not know keeps its place among the queries after it", async () => {
	await using _drop = await enum_table("test_enum_order");
	await using fresh = postgres({ ...options, max: 1 });
	await fresh`select 1`;
	const [, select] = await fresh.begin((tx) => [
		tx`insert into test_enum_order values (${"a"})`,
		tx`select count(*)::int as n from test_enum_order`,
	]);
	const commands = await Promise.all([
		fresh`begin`,
		fresh`insert into test_enum_order values (${"b"})`,
		fresh`rollback`,
	]).then((results) => results.map((r) => r.command));
	const [{ n }] = await fresh`select count(*)::int as n from test_enum_order`;
	expect([select[0].n, commands, n]).toEqual([1, ["BEGIN", "INSERT", "ROLLBACK"], 1]);
});

test("infer: false writes a Date for a text parameter as an ISO timestamp", async () => {
	await using sql = postgres({ ...options, infer: false, max: 1 });
	const [{ x }] = await sql`select ${new Date("2026-06-01T12:00:00.123Z")}::text as x`;
	expect(x).toBe("2026-06-01T12:00:00.123Z");
});

test("An array in a values list is written as an array for a cast (#741)", async () => {
	const [{ r }] =
		await sql`select (v.r)::real[] as r from (values ${sql([[1, [1.25, 3.5]]])}) as v(id, r)`;
	expect(r).toEqual([1.25, 3.5]);
});

test("An object in a values list is written as json for a cast (#872, #765)", async () => {
	const [{ j }] =
		await sql`select (v.j)::jsonb as j from (values ${sql([[1, { a: 1, b: [true, null] }]] as any)}) as v(id, j)`;
	expect(j).toEqual({ a: 1, b: [true, null] });
});

test("infer: false writes a boolean array to a jsonb parameter and a bigint to numeric (#931, #874)", async () => {
	await using sql = postgres({ ...options, infer: false });
	const [{ j, n }] =
		await sql`select ${[true, false]}::jsonb as j, ${1n << 255n}::numeric(78,0)::text as n`;
	expect([j, n]).toEqual([[true, false], String(1n << 255n)]);
});

test("A bigint array is written to an int8[] column (#837)", async () => {
	const [{ x }] = await sql`select ${[9007199254740994n, 1n]}::int8[]::text as x`;
	expect(x).toBe("{9007199254740994,1}");
});

test("A custom type given by name is looked up, with its array type (#1115)", async () => {
	await sql`drop type if exists pair_t cascade`;
	await sql`create type pair_t as (a int, b int)`;
	await using _drop_type = defer(() => sql`drop type pair_t`);
	await using sql2 = postgres({
		...options,
		types: {
			pair: {
				to: "pair_t",
				from: ["pair_t"],
				serialize: (x: number[]) => "(" + x.join(",") + ")",
				parse: (x: string) => x.slice(1, -1).split(",").map(Number),
			},
		},
	});
	const [{ x, xs, sum }] = await sql2`
    select
      ${sql2.typed.pair([1, 2])}::pair_t as x,
      array[${sql2.typed.pair([3, 4])}::pair_t] as xs,
      (${sql2.typed.pair([5, 6])}::pair_t).a as sum
  `;
	expect([x, xs, sum]).toEqual([[1, 2], [[3, 4]], 5]);
});

test("Several custom type names that do not exist are named in one TYPE_NOT_FOUND", async () => {
	await using sql2 = postgres({
		...options,
		types: {
			a: { to: "no_such_a", serialize: String },
			b: { to: "no_such_b", serialize: String },
		} as any,
	});
	const message = await sql2`select 1`.then(
		() => "ran",
		(e) => [e.code, e.message],
	);
	expect(message).toEqual([
		"TYPE_NOT_FOUND",
		"TYPE_NOT_FOUND: The types no_such_a, no_such_b do not exist",
	]);
});

test("A custom type name that does not exist rejects with TYPE_NOT_FOUND", async () => {
	await using sql2 = postgres({
		...options,
		types: {
			nope: { to: "no_such_type", from: ["no_such_type"], serialize: String, parse: String },
		},
	});
	const codes = [
		await sql2`select 1`.then(
			() => "ran",
			(e) => e.code,
		),
		await sql2
			.begin((tx) => tx`select 1`)
			.then(
				() => "ran",
				(e) => e.code,
			),
	];
	expect(codes).toEqual(["TYPE_NOT_FOUND", "TYPE_NOT_FOUND"]);
});

test("sql.end() resolves after the types fail to load for a waiting query", async () => {
	// No idle timeout: the connection must not close by itself, or end() resolves through that
	const sql2 = postgres({
		...options,
		max: 1,
		idle_timeout: 0,
		types: { nope: { to: "no_such_type", serialize: String } } as any,
	});
	const code = sql2`select 1`.then(
		() => "ran",
		(e) => e.code,
	);
	// The query reaches the pool in a microtask; end() must find it waiting for a connection
	await Promise.resolve();
	const ended = await Promise.race([
		sql2.end().then(() => "ended"),
		delay(2000).then(() => "still ending"),
	]);
	expect([await code, ended]).toEqual(["TYPE_NOT_FOUND", "ended"]);
});

test("A custom type created after a failed lookup is found on a later query", async () => {
	await sql`drop type if exists later_t cascade`;
	// Declared before sql2, so that sql2 ends before the type is dropped
	await using _drop_type = defer(() => sql`drop type if exists later_t`);
	await using sql2 = postgres({
		...options,
		types: {
			later: {
				to: "later_t",
				from: ["later_t"],
				serialize: String,
				parse: (x: string) => "parsed " + x,
			},
		},
	});
	const first = await sql2`select 1`.then(
		() => "ran",
		(e) => e.code,
	);
	await sql`create type later_t as enum ('a')`;
	await delay(1100);
	const [{ x }] = await sql2`select 'a'::later_t as x`;
	expect([first, x]).toEqual(["TYPE_NOT_FOUND", "parsed a"]);
});

test("Custom types by name need fetch_types", async () => {
	expect(
		thrown(() =>
			postgres({
				...options,
				fetch_types: false,
				types: { x: { to: "x", from: ["x"], serialize: String, parse: String } },
			}),
		).code,
	).toBe("TYPE_NOT_FOUND");
});

/**
 * @param pool - the `sql` of a pool
 * @returns the rows of a query of a bytea and of arrays of each type that is read in binary (and
 *   of int8, which is not), with NULLs, two dimensions, no elements, and lower bounds other than 1
 */
function binaries(pool: Sql) {
	return pool`select ${1}::int as k, '\\x00ff10'::bytea as b,
		array[1, -2, null, 2147483647, -2147483648]::int4[] as i4,
		array[[1, 2], [3, -32768]]::int2[] as i2,
		array['9223372036854775807', '-9223372036854775808', null]::int8[] as i8,
		array[true, false, null]::bool[] as bo,
		'{}'::int[] as e, '[0:1]={5,6}'::int[] as lb, null::int[] as n`;
}

/**
 * @param bytes - what a client sent on a connection without TLS, from its startup message on
 * @returns the result formats of each Bind message in `bytes`, in order
 */
function bind_result_formats(bytes: Buffer) {
	const formats = [];
	// The startup message has no type byte
	for (let i = bytes.readInt32BE(0); i < bytes.length; i += 1 + bytes.readInt32BE(i + 1)) {
		if (bytes[i] !== 66) {
			continue;
		}
		// After the length: the portal's name, the statement's name, the parameter formats, and the
		// parameters, each with its length (-1 for NULL)
		let at = bytes.indexOf(0, bytes.indexOf(0, i + 5) + 1) + 1;
		at += 2 + bytes.readInt16BE(at) * 2;
		const values = bytes.readInt16BE(at);
		at += 2;
		for (let v = 0; v < values; v++) {
			at += 4 + Math.max(bytes.readInt32BE(at), 0);
		}
		const n = bytes.readInt16BE(at);
		formats.push(Array.from({ length: n }, (_, k) => bytes.readInt16BE(at + 2 + 2 * k)));
	}
	return formats;
}

test("bytea and int2, int4 and bool arrays are read in binary once their statement is prepared, with the same values", async () => {
	const sent: Buffer[] = [];
	await using proxy = await proxy_to_server({
		from_client: (chunk) => {
			sent.push(chunk);
			return false;
		},
	});
	await using pool = postgres({ ...options, host: proxy.host, port: proxy.port, ssl: false });
	const results = [await binaries(pool), await binaries(pool), await binaries(pool)].map((x) =>
			Array.from(x),
		),
		row: Record<string, unknown> = {
			k: 1,
			b: Buffer.from("00ff10", "hex"),
			i4: [1, -2, null, 2147483647, -2147483648],
			i2: [
				[1, 2],
				[3, -32768],
			],
			i8: ["9223372036854775807", "-9223372036854775808", null],
			bo: [true, false, null],
			e: [],
			lb: [5, 6],
			n: null,
		},
		binary = [0, 1, 1, 1, 0, 1, 1, 1, 1];

	expect(results).toEqual([[row], [row], [row]]);
	expect(bind_result_formats(Buffer.concat(sent))).toEqual(
		options.prepare === false ? [[], [], []] : [[], binary, binary],
	);
});

test("A custom parser for an int4 array still gets the text once its statement is prepared", async () => {
	await using pool = postgres({
		...options,
		types: {
			ints: {
				to: 1007,
				from: [1007],
				serialize: (x: unknown) => x,
				parse: (x: string) => "text " + x,
			},
		},
	});
	const query = async () => (await pool`select array[1, 2]::int4[] as x, ${1}::int as k`)[0].x;
	expect([await query(), await query()]).toEqual(["text {1,2}", "text {1,2}"]);
});

test("A parser set in sql.options.parsers still gets the text of a bytea and of an int4 array once their statement is prepared", async () => {
	await using pool = postgres(options);
	pool.options.parsers[17] = (x) => "bytes " + x;
	pool.options.parsers[1007] = (x) => "ints " + x;
	const query = async () => {
		const [{ b, a }] =
			await pool`select '\\x01'::bytea as b, array[1]::int4[] as a, ${1}::int as k`;
		return [b, a];
	};
	expect([await query(), await query()]).toEqual([
		["bytes \\x01", "ints {1}"],
		["bytes \\x01", "ints {1}"],
	]);
});

test("A custom parser for int4 still gets the text of an int4 array's elements once its statement is prepared", async () => {
	await using pool = postgres({
		...options,
		types: {
			int: { to: 23, from: [23], serialize: (x: number) => "" + x, parse: (x: string) => "n" + x },
		},
	});
	const query = async () => (await pool`select array[1, 2]::int4[] as x, ${1}::int8 as k`)[0].x;
	expect([await query(), await query()]).toEqual([
		["n1", "n2"],
		["n1", "n2"],
	]);
});

test("raw() gets the text of a bytea and of an array once their statement is prepared", async () => {
	await using pool = postgres(options);
	const query = async () =>
		(await pool`select '\\x01'::bytea as b, array[1]::int[] as a, ${1}::int as k`.raw())[0].map(
			String,
		);
	expect([await query(), await query()]).toEqual([
		["\\x01", "{1}", "1"],
		["\\x01", "{1}", "1"],
	]);
});
