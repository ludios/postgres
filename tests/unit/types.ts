// Model-output: Claude Opus 5.5
import { expect, test } from "vitest";
import { Types } from "../../src/types.ts";

const types = Types({}),
	parse = (oid, x) => types.parser(oid)(x),
	serialize = (oid, x) => types.serializer(oid)(x);

const show = (x) =>
	Array.isArray(x)
		? "[" + x.map(show) + "]"
		: x === null
			? "null"
			: x instanceof Date
				? "date:" + (isNaN(x.getTime()) ? "invalid" : x.toISOString())
				: Buffer.isBuffer(x)
					? "buffer:" + x.toString("hex")
					: typeof x === "object"
						? "object:" + JSON.stringify(x)
						: typeof x + ":" + x;

/** Like `new Date(year, month, ...)` (in local time), but without mapping the years 0 to 99 to 1900 to 1999 */
const local = (year, month, day = 1, h = 0, m = 0, s = 0, ms = 0) => {
	const x = new Date(2000, month, day, h, m, s, ms);
	x.setFullYear(year);
	return x;
};

test("Parse scalars as v3 does", async () => {
	expect(
		[
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
		]
			.map(show)
			.join(),
	).toBe(
		"number:1,number:-2,number:3,number:1.5,number:2.25,string:9007199254740993,string:1.10,boolean:true,boolean:false,string:x",
	);
});

test("Parse json and jsonb", async () => {
	expect(show(parse(114, '{"a":[1,null]}')) + "|" + show(parse(3802, '{"b":true}'))).toBe(
		'object:{"a":[1,null]}|object:{"b":true}',
	);
});

test("Parse bytea hex", async () => {
	expect(show(parse(17, "\\x00ff10"))).toBe("buffer:00ff10");
});

test("Parse timestamptz with offsets", async () => {
	const expected = [
		"date:2024-01-02T03:04:05.678Z",
		"date:2024-01-02T01:04:05.000Z",
		"date:2024-01-02T08:34:05.000Z",
		"date:2024-01-02T03:04:05.123Z",
	].join();
	expect(
		[
			"2024-01-02 03:04:05.678+00",
			"2024-01-02 03:04:05+02",
			"2024-01-02 03:04:05-05:30",
			"2024-01-02 03:04:05.123456+00",
		]
			.map((x) => show(parse(1184, x)))
			.join(),
	).toBe(expected);
});

test("Parse timestamptz with an offset in seconds", async () => {
	expect(show(parse(1184, "1850-06-15 13:20:20+00:50:20"))).toBe("date:1850-06-15T12:30:00.000Z");
});

test("Parse timestamptz before year 100 (#1185)", async () => {
	expect(
		["0050-06-15 12:30:00+00", "0050-06-15 13:20:20+00:50:20", "0001-01-01 00:00:00+00"]
			.map((x) => show(parse(1184, x)))
			.join("|"),
	).toBe(
		"date:0050-06-15T12:30:00.000Z|date:0050-06-15T12:30:00.000Z|date:0001-01-01T00:00:00.000Z",
	);
});

test("Parse timestamp without time zone as local time, like v3", async () => {
	const expected =
		local(2024, 0, 2, 3, 4, 5, 678).getTime() + "," + local(50, 5, 15, 12, 30).getTime();
	expect(
		parse(1114, "2024-01-02 03:04:05.678").getTime() +
			"," +
			parse(1114, "0050-06-15 12:30:00").getTime(),
	).toBe(expected);
});

test("Parse date as UTC midnight, like v3", async () => {
	expect(show(parse(1082, "2024-01-02")) + "|" + show(parse(1082, "0050-06-15"))).toBe(
		"date:2024-01-02T00:00:00.000Z|date:0050-06-15T00:00:00.000Z",
	);
});

test("Parse infinity for every date type (#728)", async () => {
	const expected = "number:Infinity,number:-Infinity,".repeat(3).slice(0, -1);
	expect(
		[1082, 1114, 1184]
			.flatMap((oid) => [parse(oid, "infinity"), parse(oid, "-infinity")])
			.map(show)
			.join(),
	).toBe(expected);
});

test("Serialize infinity for every date type (#728)", async () => {
	const expected = "infinity,-infinity,".repeat(3).slice(0, -1);
	expect(
		[1082, 1114, 1184]
			.flatMap((oid) => [serialize(oid, Infinity), serialize(oid, -Infinity)])
			.join(),
	).toBe(expected);
});

test("Serialize dates as ISO, including before year 100", async () => {
	const old = new Date(Date.UTC(2000, 5, 15, 12, 30));
	old.setUTCFullYear(50);
	expect([new Date(0), old, 1000].map((x) => serialize(1184, x)).join()).toBe(
		"1970-01-01T00:00:00.000Z,0050-06-15T12:30:00.000Z,1970-01-01T00:00:01.000Z",
	);
});

test("Serialize booleans, json and bytea", async () => {
	expect(
		[
			serialize(16, true),
			serialize(16, false),
			serialize(114, { a: 1 }),
			serialize(17, Buffer.from([0, 255])),
		].join("|"),
	).toBe('t|f|{"a":1}|\\x00ff');
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
		]
			.map(types.infer)
			.join(),
	).toBe("1184,17,17,16,16,20,0,0,0,0,1185,0");
});

test("Parse built-in arrays without a fetch", async () => {
	const expected = [
		"[number:1,number:2]",
		"[string:a,string:b c]",
		"[boolean:true,boolean:false]",
		"[string:1,string:2]",
		"[date:1970-01-01T00:00:00.000Z]",
		'[object:{"a":1}]',
		"[buffer:01]",
	].join("|");
	expect(
		[
			parse(1007, "{1,2}"),
			parse(1009, '{a,"b c"}'),
			parse(1000, "{t,f}"),
			parse(1016, "{1,2}"),
			parse(1185, '{"1970-01-01 00:00:00+00"}'),
			parse(199, '{"{\\"a\\":1}"}'),
			parse(1001, '{"\\\\x01"}'),
		]
			.map(show)
			.join("|"),
	).toBe(expected);
});

test("Parse infinity in timestamp arrays", async () => {
	expect(show(parse(1185, "{infinity,-infinity,NULL}"))).toBe(
		"[number:Infinity,number:-Infinity,null]",
	);
});

test("Array NULL is null", async () => {
	expect(show(parse(1007, "{1,NULL,3}")) + "|" + show(parse(1009, "{NULL,a,NULL}"))).toBe(
		"[number:1,null,number:3]|[null,string:a,null]",
	);
});

test('Array quoted "NULL" stays a string', async () => {
	expect(show(parse(1009, '{"NULL",NULL,"a b",NULL,"NULL"}'))).toBe(
		"[string:NULL,null,string:a b,null,string:NULL]",
	);
});

test("Array NULL in nested arrays", async () => {
	expect(show(parse(1007, "{{1,NULL},{NULL,4}}"))).toBe("[[number:1,null],[null,number:4]]");
});

test("Array NULL with the box ; delimiter", async () => {
	expect(show(parse(1020, "{(1,2),(3,4);NULL}"))).toBe("[string:(1,2),(3,4),null]");
});

test("Array parser is not called for NULL", async () => {
	const parsed = [],
		types = Types({
			types: { text: { to: 25, from: [25], serialize: (x) => x, parse: (x) => parsed.push(x) } },
		});
	types.parser(1009)('{a,NULL,"NULL"}');
	expect(parsed.join()).toBe("a,NULL");
});

test("Array of only NULL, empty arrays and empty strings", async () => {
	expect(
		show(parse(1009, "{NULL,NULL}")) +
			"|" +
			show(parse(1009, "{}")) +
			"|" +
			show(parse(1009, '{"",a}')),
	).toBe("[null,null]|[]|[string:,string:a]");
});

test("Array escapes", async () => {
	expect(show(parse(1009, '{"Hello \\"you\\"","c:\\\\windows","{x}","a,b"}'))).toBe(
		'[string:Hello "you",string:c:\\windows,string:{x},string:a,b]',
	);
});

test("Array with explicit bounds", async () => {
	expect(show(parse(1007, "[0:1]={1,2}"))).toBe("[number:1,number:2]");
});

test("Serialize arrays", async () => {
	expect(
		[
			serialize(1007, [1, null, 3]),
			serialize(1009, [["a"], ["b"]]),
			serialize(1009, ["NULL"]),
			serialize(1009, ['Hello "you"', "c:\\windows"]),
			serialize(1009, []),
			serialize(1020, ["(1,2),(3,4)", "(5,6),(7,8)"]),
		].join("|"),
	).toBe(
		'{"1",NULL,"3"}|{{"a"},{"b"}}|{"NULL"}|{"Hello \\"you\\"","c:\\\\windows"}|{}|{"(1,2),(3,4)";"(5,6),(7,8)"}',
	);
});

test("Serialize arrays with the element serializer", async () => {
	expect(serialize(1000, [true, false, null])).toBe('{"t","f",NULL}');
});

test('Array round trip keeps NULL and "NULL" apart', async () => {
	expect(show(parse(1009, serialize(1009, ["NULL", null, "a"])))).toBe(
		"[string:NULL,null,string:a]",
	);
});

test("Parse timestamptz in a DateStyle other than ISO as Date does", async () => {
	expect(show(parse(1184, "Mon Oct 19 12:00:00 2026 UTC"))).toBe("date:2026-10-19T12:00:00.000Z");
});
