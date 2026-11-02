import { expect, test } from "vitest";
import { Types } from "../../src/types.ts";

const types = Types({}),
	parse = (oid, x) => types.parser(oid)(x),
	serialize = (oid, x) => types.serializer(oid)(x);

/** Like `new Date(year, month, ...)` (in local time), but without mapping the years 0 to 99 to 1900 to 1999 */
const local = (year, month, day = 1, h = 0, m = 0, s = 0, ms = 0) => {
	const x = new Date(2000, month, day, h, m, s, ms);
	x.setFullYear(year);
	return x;
};

test("Parse scalars as v3 does", async () => {
	expect([
		parse(21, "1"),
		parse(23, "-2"),
		parse(26, "3"),
		parse(700, "1.5"),
		parse(701, "2.25"),
		parse(20, "9007199254740993"),
		parse(1700, "1.10"),
		parse(16, "t"),
		parse(16, "f"),
		parse(25, "x"),
	]).toStrictEqual([1, -2, 3, 1.5, 2.25, "9007199254740993", "1.10", true, false, "x"]);
});

test("Parse json and jsonb", async () => {
	expect([parse(114, '{"a":[1,null]}'), parse(3802, '{"b":true}')]).toStrictEqual([
		{ a: [1, null] },
		{ b: true },
	]);
});

test("Parse bytea hex", async () => {
	expect(parse(17, "\\x00ff10")).toStrictEqual(Buffer.from("00ff10", "hex"));
});

test("Parse timestamptz with offsets", async () => {
	expect(
		[
			"2024-01-02 03:04:05.678+00",
			"2024-01-02 03:04:05+02",
			"2024-01-02 03:04:05-05:30",
			"2024-01-02 03:04:05.123456+00",
		].map((x) => parse(1184, x)),
	).toStrictEqual([
		new Date("2024-01-02T03:04:05.678Z"),
		new Date("2024-01-02T01:04:05.000Z"),
		new Date("2024-01-02T08:34:05.000Z"),
		new Date("2024-01-02T03:04:05.123Z"),
	]);
});

test("Parse timestamptz with an offset in seconds", async () => {
	expect(parse(1184, "1850-06-15 13:20:20+00:50:20")).toStrictEqual(
		new Date("1850-06-15T12:30:00.000Z"),
	);
});

test("Parse timestamptz before year 100 (#1185)", async () => {
	expect(
		["0050-06-15 12:30:00+00", "0050-06-15 13:20:20+00:50:20", "0001-01-01 00:00:00+00"].map((x) =>
			parse(1184, x),
		),
	).toStrictEqual([
		new Date("0050-06-15T12:30:00.000Z"),
		new Date("0050-06-15T12:30:00.000Z"),
		new Date("0001-01-01T00:00:00.000Z"),
	]);
});

test("Parse timestamp without time zone as local time, like v3", async () => {
	expect([parse(1114, "2024-01-02 03:04:05.678"), parse(1114, "0050-06-15 12:30:00")]).toEqual([
		local(2024, 0, 2, 3, 4, 5, 678),
		local(50, 5, 15, 12, 30),
	]);
});

test("Parse date as UTC midnight, like v3", async () => {
	expect([parse(1082, "2024-01-02"), parse(1082, "0050-06-15")]).toStrictEqual([
		new Date("2024-01-02T00:00:00.000Z"),
		new Date("0050-06-15T00:00:00.000Z"),
	]);
});

test("Parse infinity for every date type (#728)", async () => {
	expect(
		[1082, 1114, 1184].map((oid) => [parse(oid, "infinity"), parse(oid, "-infinity")]),
	).toStrictEqual(Array.from({ length: 3 }, () => [Infinity, -Infinity]));
});

test("Serialize infinity for every date type (#728)", async () => {
	expect(
		[1082, 1114, 1184].map((oid) => [serialize(oid, Infinity), serialize(oid, -Infinity)]),
	).toEqual(Array.from({ length: 3 }, () => ["infinity", "-infinity"]));
});

test("Serialize dates as ISO, including before year 100", async () => {
	const old = new Date(Date.UTC(2000, 5, 15, 12, 30));
	old.setUTCFullYear(50);
	expect([new Date(0), old, 1000].map((x) => serialize(1184, x))).toEqual([
		"1970-01-01T00:00:00.000Z",
		"0050-06-15T12:30:00.000Z",
		"1970-01-01T00:00:01.000Z",
	]);
});

test("Serialize booleans, json and bytea", async () => {
	expect([
		serialize(16, true),
		serialize(16, false),
		serialize(114, { a: 1 }),
		serialize(17, Buffer.from([0, 255])),
	]).toEqual(["t", "f", '{"a":1}', "\\x00ff"]);
});

test("Infer types with the v3 rules, and arrays as their array type", async () => {
	expect(
		[
			new Date(),
			Buffer.from([]),
			new Uint8Array(1),
			true,
			false,
			1n,
			1,
			"a",
			null,
			{},
			[new Date()],
			[],
		].map(types.infer),
	).toEqual([1184, 17, 17, 16, 16, 20, 0, 0, 0, 0, 1185, 0]);
});

test("Parse built-in arrays without a fetch", async () => {
	expect([
		parse(1007, "{1,2}"),
		parse(1009, '{a,"b c"}'),
		parse(1000, "{t,f}"),
		parse(1016, "{1,2}"),
		parse(1185, '{"1970-01-01 00:00:00+00"}'),
		parse(199, '{"{\\"a\\":1}"}'),
		parse(1001, '{"\\\\x01"}'),
	]).toStrictEqual([
		[1, 2],
		["a", "b c"],
		[true, false],
		["1", "2"],
		[new Date(0)],
		[{ a: 1 }],
		[Buffer.from([1])],
	]);
});

test("Parse infinity in timestamp arrays", async () => {
	expect(parse(1185, "{infinity,-infinity,NULL}")).toStrictEqual([Infinity, -Infinity, null]);
});

test("Array NULL is null", async () => {
	expect([parse(1007, "{1,NULL,3}"), parse(1009, "{NULL,a,NULL}")]).toStrictEqual([
		[1, null, 3],
		[null, "a", null],
	]);
});

test('Array quoted "NULL" stays a string', async () => {
	expect(parse(1009, '{"NULL",NULL,"a b",NULL,"NULL"}')).toStrictEqual([
		"NULL",
		null,
		"a b",
		null,
		"NULL",
	]);
});

test("Array NULL in nested arrays", async () => {
	expect(parse(1007, "{{1,NULL},{NULL,4}}")).toStrictEqual([
		[1, null],
		[null, 4],
	]);
});

test("Array NULL with the box ; delimiter", async () => {
	expect(parse(1020, "{(1,2),(3,4);NULL}")).toStrictEqual(["(1,2),(3,4)", null]);
});

test("Array parser is not called for NULL", async () => {
	const parsed = [],
		types = Types({
			types: { text: { to: 25, from: [25], serialize: (x) => x, parse: (x) => parsed.push(x) } },
		});
	types.parser(1009)('{a,NULL,"NULL"}');
	expect(parsed).toEqual(["a", "NULL"]);
});

test("Array of only NULL, empty arrays and empty strings", async () => {
	expect([parse(1009, "{NULL,NULL}"), parse(1009, "{}"), parse(1009, '{"",a}')]).toStrictEqual([
		[null, null],
		[],
		["", "a"],
	]);
});

test("Array escapes", async () => {
	expect(parse(1009, '{"Hello \\"you\\"","c:\\\\windows","{x}","a,b"}')).toStrictEqual([
		'Hello "you"',
		"c:\\windows",
		"{x}",
		"a,b",
	]);
});

test("Array with explicit bounds", async () => {
	expect(parse(1007, "[0:1]={1,2}")).toStrictEqual([1, 2]);
});

test("Serialize arrays", async () => {
	expect([
		serialize(1007, [1, null, 3]),
		serialize(1009, [["a"], ["b"]]),
		serialize(1009, ["NULL"]),
		serialize(1009, ['Hello "you"', "c:\\windows"]),
		serialize(1009, []),
		serialize(1020, ["(1,2),(3,4)", "(5,6),(7,8)"]),
	]).toEqual([
		'{"1",NULL,"3"}',
		'{{"a"},{"b"}}',
		'{"NULL"}',
		'{"Hello \\"you\\"","c:\\\\windows"}',
		"{}",
		'{"(1,2),(3,4)";"(5,6),(7,8)"}',
	]);
});

test("Serialize arrays with the element serializer", async () => {
	expect(serialize(1000, [true, false, null])).toBe('{"t","f",NULL}');
});

test('Array round trip keeps NULL and "NULL" apart', async () => {
	expect(parse(1009, serialize(1009, ["NULL", null, "a"]))).toStrictEqual(["NULL", null, "a"]);
});

test("Parse timestamptz in a DateStyle other than ISO as Date does", async () => {
	expect(parse(1184, "Mon Oct 19 12:00:00 2026 UTC")).toStrictEqual(
		new Date("2026-10-19T12:00:00.000Z"),
	);
});

test("Type names like constructor and __proto__ are not looked up on Object.prototype", async () => {
	expect([types.resolve("constructor"), types.resolve("__proto__")]).toEqual([0, 0]);
});

test("A custom type named __proto__ resolves to its OID", async () => {
	const custom = Types({
		types: {
			p: { to: "__proto__", from: ["__proto__"], serialize: String, parse: (x) => "p:" + x },
		},
	});
	const row = {
		oid: 99999,
		array: 0,
		delimiter: ",",
		name: "__proto__",
		schema: "public",
		visible: true,
	};
	// Answers only the query that looks up the named types
	const run = async (text) => (text.includes("t.typname in") ? [row] : []);
	await custom.load(run);
	expect([custom.resolve("__proto__"), custom.parser(99999)("x")]).toEqual([99999, "p:x"]);
});
