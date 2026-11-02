import { expect, test } from "vitest";
import * as fc from "fast-check";
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

const pad = (n, width) => String(n).padStart(width, "0");

/**
 * @param t - an instant, in milliseconds since 1970-01-01 UTC
 * @param micros - the microseconds that the instant has after its millisecond, 0 to 999
 * @param offset - the offset from UTC in seconds, for a timestamptz; or null, for a timestamp
 * @returns the text that PostgreSQL sends for the timestamp with DateStyle ISO, in a time zone
 *   with the offset `offset`
 */
function iso(t, micros, offset) {
	const d = new Date(t + (offset ?? 0) * 1000),
		year = d.getUTCFullYear(),
		fraction = (pad(d.getUTCMilliseconds(), 3) + pad(micros, 3)).replace(/0+$/, "");
	let text =
		pad(year > 0 ? year : 1 - year, 4) +
		"-" +
		pad(d.getUTCMonth() + 1, 2) +
		"-" +
		pad(d.getUTCDate(), 2) +
		" " +
		pad(d.getUTCHours(), 2) +
		":" +
		pad(d.getUTCMinutes(), 2) +
		":" +
		pad(d.getUTCSeconds(), 2) +
		(fraction ? "." + fraction : "");
	if (offset !== null) {
		const abs = Math.abs(offset),
			minutes = Math.floor(abs / 60) % 60,
			seconds = abs % 60;
		text +=
			(offset < 0 ? "-" : "+") +
			pad(Math.floor(abs / 3600), 2) +
			(minutes || seconds ? ":" + pad(minutes, 2) : "") +
			(seconds ? ":" + pad(seconds, 2) : "");
	}
	return year > 0 ? text : text + " BC";
}

/**
 * @param text - the text of a value
 * @returns the bytes of `text` between digits of other values, where a decoder that reads past the
 *   value would find them, and where `text` starts and ends in those bytes
 */
function embedded(text) {
	return { x: Buffer.from("12345" + text + "67890", "latin1"), start: 5, end: 5 + text.length };
}

/** The types of a pool with the default `infer: false`, which reads a timestamp as UTC */
const utc_types = Types({ infer: false });

/**
 * @param oid - the type of the value
 * @param text - the text of the value
 * @returns the value that the decoder of `utc_types` for `oid` gives for the bytes of `text`
 */
function decoded(oid, text) {
	const { x, start, end } = embedded(text);
	return utc_types.decoder(oid, utc_types.parser(oid))(x, start, end);
}

const instants = fc.date({
		min: new Date(Date.UTC(-500, 0, 1)),
		max: new Date(Date.UTC(12000, 0, 1)),
		noInvalidDate: true,
	}),
	offsets = fc.oneof(
		fc.integer({ min: -15, max: 15 }).map((h) => h * 3600),
		fc.integer({ min: -15 * 60, max: 15 * 60 }).map((m) => m * 60),
		fc.integer({ min: -15 * 3600, max: 15 * 3600 }),
	),
	micros = fc.integer({ min: 0, max: 999 });

test("Decode timestamptz, timestamp and date from the bytes as their text parsers do", async () => {
	fc.assert(
		fc.property(instants, micros, offsets, (t, us, offset) => {
			const zoned = iso(t.getTime(), us, offset),
				plain = iso(t.getTime(), us, null),
				day = plain.replace(/ \d\d:\d\d:\d\d(\.\d+)?/, "");
			expect([decoded(1184, zoned), decoded(1114, plain), decoded(1082, day)]).toEqual([
				utc_types.parser(1184)(zoned),
				utc_types.parser(1114)(plain),
				utc_types.parser(1082)(day),
			]);
		}),
		{ numRuns: 5000 },
	);
});

test("Decode the timestamps of the years 1000 to 9999 without their text", async () => {
	fc.assert(
		fc.property(
			fc.date({
				min: new Date(Date.UTC(1000, 0, 2)),
				max: new Date(Date.UTC(9999, 11, 30)),
				noInvalidDate: true,
			}),
			micros,
			offsets.filter((x) => x % 60 === 0),
			(t, us, offset) => {
				const zoned = embedded(iso(t.getTime(), us, offset)),
					plain = embedded(iso(t.getTime(), us, null));
				// The decoders read these without the text, so that turning them into text throws
				for (const { x } of [zoned, plain]) {
					x.toString = () => {
						throw new Error("read as text");
					};
				}
				expect([
					utc_types.decoder(1184, utc_types.parser(1184))(zoned.x, zoned.start, zoned.end),
					utc_types.decoder(1114, utc_types.parser(1114))(plain.x, plain.start, plain.end),
				]).toEqual([t, t]);
			},
		),
		{ numRuns: 2000 },
	);
});

test("Decode infinity, BC, years past 9999 and offsets in seconds through the text parsers", async () => {
	// 44 BC is the year -43, as there is no year 0
	const bc = new Date(Date.UTC(2000, 2, 15, 12));
	bc.setUTCFullYear(-43);
	expect([
		decoded(1184, "infinity"),
		decoded(1114, "-infinity"),
		decoded(1082, "infinity"),
		decoded(1184, "0044-03-15 12:00:00+00 BC"),
		decoded(1082, "10000-01-01"),
		decoded(1184, "1900-01-01 00:00:00+00:19:32"),
		decoded(1184, "0999-12-31 23:59:59.5+00"),
	]).toEqual([
		Infinity,
		-Infinity,
		Infinity,
		bc,
		new Date(Date.UTC(10000, 0, 1)),
		new Date(Date.UTC(1900, 0, 1) - (19 * 60 + 32) * 1000),
		new Date(Date.UTC(999, 11, 31, 23, 59, 59, 500)),
	]);
});

test("Read a timestamp as local time with its text parser, which has no decoder", async () => {
	expect([Types({ infer: true }).decoder(1114, Types({ infer: true }).parser(1114))]).toEqual([
		null,
	]);
});

/**
 * @param n - an integer
 * @returns `n` as a signed 32-bit big-endian integer
 */
function int32_bytes(n) {
	const x = Buffer.alloc(4);
	x.writeInt32BE(n);
	return x;
}

/**
 * @param xs - an array, nested for each dimension after the first, with as many elements at each
 *   depth; or empty
 * @param write - `(element) => Buffer` gives the binary format of an element
 * @returns the array in PostgreSQL's binary format, with lower bounds of 1
 */
function binary_array_bytes(xs, write) {
	const sizes = [];
	for (let a = xs; Array.isArray(a) && a.length > 0; a = a[0]) {
		sizes.push(a.length);
	}
	const flat = xs.flat(Math.max(sizes.length - 1, 0));
	return Buffer.concat([
		int32_bytes(sizes.length),
		int32_bytes(flat.includes(null) ? 1 : 0),
		// The type of the elements, which the decoders don't read
		int32_bytes(0),
		...sizes.flatMap((n) => [int32_bytes(n), int32_bytes(1)]),
		...flat.map((x) =>
			x === null ? int32_bytes(-1) : Buffer.concat([int32_bytes(write(x).length), write(x)]),
		),
	]);
}

/**
 * @param xs - an array, nested for each dimension after the first
 * @param show - `(element) => string` gives the text of an element
 * @returns the text that PostgreSQL sends for the array
 */
function array_text(xs, show) {
	return Array.isArray(xs)
		? "{" + xs.map((x) => array_text(x, show)).join(",") + "}"
		: xs === null
			? "NULL"
			: show(xs);
}

/**
 * @param element - an arbitrary of the elements
 * @returns an arbitrary of arrays of `element` and NULLs, with one dimension (and maybe no
 *   elements) or two
 */
function arrays_of(element) {
	const item = fc.option(element, { nil: null });
	return fc.oneof(
		fc.array(item, { maxLength: 8 }),
		fc
			.integer({ min: 1, max: 4 })
			.chain((n) =>
				fc.array(fc.array(item, { minLength: n, maxLength: n }), { minLength: 1, maxLength: 4 }),
			),
	);
}

/** For each array type that is read in binary: its elements, their binary format, and their text */
const binary_cases = [
	{
		oid: 1000,
		element: fc.boolean(),
		write: (x) => Buffer.from([x ? 1 : 0]),
		show: (x) => (x ? "t" : "f"),
	},
	{
		oid: 1005,
		element: fc.integer({ min: -32768, max: 32767 }),
		write: (x) => {
			const b = Buffer.alloc(2);
			b.writeInt16BE(x);
			return b;
		},
		show: String,
	},
	{ oid: 1007, element: fc.integer(), write: int32_bytes, show: String },
];

test("Decode int2, int4 and bool arrays in binary as their text parsers parse the text", async () => {
	for (const { oid, element, write, show } of binary_cases) {
		fc.assert(
			fc.property(arrays_of(element), (xs) => {
				const bytes = binary_array_bytes(xs, write),
					x = Buffer.concat([Buffer.from("12345"), bytes, Buffer.from("67890")]);
				expect(binary_decoder(utc_types, oid)(x, 5, 5 + bytes.length)).toEqual(
					utc_types.parser(oid)(array_text(xs, show)),
				);
			}),
			{ numRuns: 500 },
		);
	}
});

test("Decode bytea in binary as its text parser parses the hex text", async () => {
	fc.assert(
		fc.property(fc.uint8Array({ maxLength: 64 }), (bytes) => {
			const x = Buffer.concat([Buffer.from("12345"), bytes, Buffer.from("67890")]),
				value = binary_decoder(utc_types, 17)(x, 5, 5 + bytes.length);
			// A copy, as the read buffer is reused
			x.fill(0);
			expect(value).toEqual(utc_types.parser(17)("\\x" + Buffer.from(bytes).toString("hex")));
		}),
		{ numRuns: 500 },
	);
});

test("Decode arrays with a lower bound other than 1 without the bounds, as their text parser does", async () => {
	const bytes = Buffer.concat(
		[int32_bytes(1), int32_bytes(0), int32_bytes(23), int32_bytes(2), int32_bytes(0)].concat(
			[5, 6].flatMap((n) => [int32_bytes(4), int32_bytes(n)]),
		),
	);
	expect([
		binary_decoder(utc_types, 1007)(bytes, 0, bytes.length),
		utc_types.parser(1007)("[0:1]={5,6}"),
	]).toEqual([
		[5, 6],
		[5, 6],
	]);
});

/**
 * @param oid - a type
 * @returns the types of a pool whose options.types parses `oid` itself
 */
function custom_types(oid) {
	return Types({ types: { x: { to: oid, from: [oid], serialize: String, parse: String } } });
}

/**
 * @param pool_types - what Types() returned
 * @param oid - the type of a column
 * @returns the decoder of the binary format that a column of type `oid` gets, or null
 */
function binary_decoder(pool_types, oid) {
	return pool_types.binary(oid, pool_types.parser(oid));
}

test("Read as text the types without a binary decoder, and those whose parser or elements' parser is not the built-in one", async () => {
	const named = Types({
			types: { x: { to: "ints", from: ["ints"], serialize: String, parse: String } },
		}),
		row = { oid: 1007, array: 0, delimiter: ",", name: "ints", schema: "public", visible: true },
		// As `sql.options.parsers[17] = String` does, before any query reads a bytea
		replaced = Types({ infer: false }),
		serialize_only = Types({ types: { x: { to: 1007, serialize: String } } });
	// Answers only the query that looks up the named types
	await named.load(async (text) => (text.includes("t.typname in") ? [row] : []));
	replaced.parsers[17] = String;
	replaced.parsers[23] = String;
	expect([
		binary_decoder(utc_types, 25),
		binary_decoder(utc_types, 23),
		binary_decoder(utc_types, 1009),
		binary_decoder(utc_types, 1016),
		binary_decoder(custom_types(1007), 1007),
		binary_decoder(custom_types(23), 1007),
		binary_decoder(custom_types(17), 17),
		binary_decoder(named, 1007),
		binary_decoder(replaced, 17),
		binary_decoder(replaced, 1007),
		typeof binary_decoder(replaced, 1005),
		typeof binary_decoder(custom_types(23), 1005),
		typeof binary_decoder(serialize_only, 1007),
	]).toEqual([
		null,
		null,
		null,
		null,
		null,
		null,
		null,
		null,
		null,
		null,
		"function",
		"function",
		"function",
	]);
});
