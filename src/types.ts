import { Errors } from "./errors.ts";

/** How to parse and serialize a PostgreSQL type, as in `options.types` */
export type PostgresType = {
	/** The OID that values of this type are sent as, or the type's name (looked up when the pool starts) */
	to: number | string;
	/** The OIDs (or type names) whose values `parse` parses, and that `serialize` also serializes */
	from?: number | string | Array<number | string>;
	serialize?: (value: any) => unknown;
	parse?: (raw: any) => any;
};

const number = (x) => +x,
	bool = (x) => x === "t",
	json = (x) => JSON.parse(x),
	string = (x) =>
		x instanceof Date
			? serializeDate(x)
			: Array.isArray(x)
				? serializeArray(x, string)
				: literal(x)
					? JSON.stringify(x)
					: "" + x,
	literal = (x) =>
		x !== null &&
		typeof x === "object" &&
		(Object.getPrototypeOf(x) === Object.prototype || Object.getPrototypeOf(x) === null);

const arrays = {
	16: 1000,
	17: 1001,
	18: 1002,
	19: 1003,
	20: 1016,
	21: 1005,
	22: 1006,
	23: 1007,
	24: 1008,
	25: 1009,
	26: 1028,
	27: 1010,
	28: 1011,
	29: 1012,
	30: 1013,
	114: 199,
	142: 143,
	600: 1017,
	601: 1018,
	602: 1019,
	603: 1020,
	604: 1027,
	628: 629,
	650: 651,
	700: 1021,
	701: 1022,
	718: 719,
	774: 775,
	790: 791,
	829: 1040,
	869: 1041,
	1033: 1034,
	1042: 1014,
	1043: 1015,
	1082: 1182,
	1083: 1183,
	1114: 1115,
	1184: 1185,
	1186: 1187,
	1266: 1270,
	1560: 1561,
	1562: 1563,
	1700: 1231,
	1790: 2201,
	2202: 2207,
	2203: 2208,
	2204: 2209,
	2205: 2210,
	2206: 2211,
	2249: 2287,
	2275: 1263,
	2950: 2951,
	2970: 2949,
	3220: 3221,
	3614: 3643,
	3615: 3645,
	3734: 3735,
	3769: 3770,
	3802: 3807,
	3904: 3905,
	3906: 3907,
	3908: 3909,
	3910: 3911,
	3912: 3913,
	3926: 3927,
	4072: 4073,
	4089: 4090,
	4096: 4097,
	5038: 5039,
	5069: 271,
};

export const types = {
	string: { to: 25, from: null, serialize: string },
	number: { to: 0, from: [21, 23, 26, 700, 701], serialize: string, parse: number },
	json: { to: 114, from: [114, 3802], serialize: (x) => JSON.stringify(x), parse: json },
	boolean: { to: 16, from: [16], serialize: (x) => (x === true ? "t" : "f"), parse: bool },
	date: { to: 1184, from: [1082, 1114, 1184], serialize: serializeDate, parse: null },
	bytea: {
		to: 17,
		from: [17],
		serialize: (x) => "\\x" + Buffer.from(x).toString("hex"),
		parse: (x) => Buffer.from(x.slice(2), "hex"),
	},
};

const dates = { 1082: parseDate, 1114: parseTimestamp, 1184: parseTimestamptz };

function integer(x, i, end) {
	const negative = x[i] === 45;
	let n = 0;
	for (negative && i++; i < end; i++) {
		n = n * 10 + x[i] - 48;
	}
	return negative ? -n : n;
}

function boolean(x, i) {
	return x[i] === 116;
}

/**
 * @param x - the bytes
 * @param i - where the digits start in `x`
 * @param n - how many digits to read
 * @returns the number that the `n` ASCII digits at `x[i]` make, or -1 if one of them is no digit
 */
function digits(x, i, n) {
	let v = 0;
	for (const end = i + n; i < end; i++) {
		const d = x[i] - 48;
		if (!(d >= 0 && d <= 9)) {
			return -1;
		}
		v = v * 10 + d;
	}
	return v;
}

/**
 * Reads a date or a timestamp in the ISO format that PostgreSQL sends with DateStyle ISO, from
 * the year 1000 to 9999: `2024-12-31`, or `2024-12-31 23:59:59.123456` (with any number of
 * fractional digits, or none), which with `zoned` ends with an offset from UTC, `+01` or `-05:30`.
 *
 * @param x - the bytes
 * @param start - where the value starts in `x`
 * @param end - where the value ends in `x`
 * @param zoned - whether the value ends with an offset from UTC, as a timestamptz does; without
 *   one, the value is read as UTC
 * @returns the milliseconds since 1970-01-01 UTC, with the fraction of a millisecond cut off, as
 *   the text parsers do; or NaN for any other text (such as BC, infinity, a year before 1000 or
 *   after 9999, or an offset with seconds), which only the text parsers read
 */
function iso_time(x, start, end, zoned) {
	const year = digits(x, start, 4),
		month = digits(x, start + 5, 2),
		day = digits(x, start + 8, 2);
	if (end - start < 10 || year < 1000 || x[start + 4] !== 45 || x[start + 7] !== 45) {
		return NaN;
	}
	if (month < 1 || day < 1) {
		return NaN;
	}
	if (end - start === 10) {
		return zoned ? NaN : Date.UTC(year, month - 1, day);
	}

	if (end - start < 19 || x[start + 10] !== 32 || x[start + 13] !== 58 || x[start + 16] !== 58) {
		return NaN;
	}
	const hour = digits(x, start + 11, 2),
		minute = digits(x, start + 14, 2),
		second = digits(x, start + 17, 2);
	if (hour < 0 || minute < 0 || second < 0) {
		return NaN;
	}

	let i = start + 19,
		ms = 0;
	if (i < end && x[i] === 46) {
		i++;
		for (let scale = 100; i < end && x[i] >= 48 && x[i] <= 57; i++) {
			ms += (x[i] - 48) * scale;
			scale = Math.floor(scale / 10);
		}
	}

	let offset = 0;
	if (zoned) {
		const sign = x[i],
			rest = end - i,
			hours = rest === 3 || rest === 6 ? digits(x, i + 1, 2) : -1,
			minutes = rest === 6 && x[i + 3] === 58 ? digits(x, i + 4, 2) : rest === 3 ? 0 : -1;
		if ((sign !== 43 && sign !== 45) || hours < 0 || minutes < 0) {
			return NaN;
		}
		offset = (sign === 45 ? -1 : 1) * (hours * 60 + minutes);
		i = end;
	}

	return i === end
		? Date.UTC(year, month - 1, day, hour, minute, second, ms) - offset * 60_000
		: NaN;
}

/** Decodes a timestamptz from the bytes of its text, as parseTimestamptz parses the text */
function timestamptz(x, start, end) {
	const t = iso_time(x, start, end, true);
	return Number.isNaN(t) ? parseTimestamptz(x.toString("latin1", start, end)) : new Date(t);
}

/** Decodes a date, or a timestamp read as UTC, from the bytes of its text, as parseDate parses the text */
function utc_time(x, start, end) {
	const t = iso_time(x, start, end, false);
	return Number.isNaN(t) ? parseDate(x.toString("latin1", start, end)) : new Date(t);
}

/**
 * @param x - the bytes
 * @param i - where the integer starts in `x`
 * @returns the signed 32-bit big-endian integer at `x[i]`
 */
function int32(x, i) {
	return (x[i] << 24) | (x[i + 1] << 16) | (x[i + 2] << 8) | x[i + 3];
}

/**
 * @param read - `(x, i) => element` reads the element of the array at `x[i]` in the binary format
 * @returns a decoder `(x, start) => array` of an array in the binary format at `x[start]`, which
 *   gives what the text parser of the array gives: nested arrays for more dimensions than one,
 *   null for a NULL element, and nothing of the lower bounds
 */
function binary_array(read) {
	return (x, start) => {
		const dimensions = int32(x, start);
		if (dimensions === 0) {
			return [];
		}

		// After the number of dimensions come a flag that says whether there are NULLs and the
		// type of the elements, and then each dimension's size and lower bound
		const sizes = [];
		for (let d = 0; d < dimensions; d++) {
			sizes.push(int32(x, start + 12 + d * 8));
		}
		let at = start + 12 + dimensions * 8;
		return level(0);

		function level(d) {
			// oxlint-disable-next-line unicorn/no-new-array -- a length; filling it in place is faster than push()
			const xs = new Array(sizes[d]);
			for (let k = 0; k < xs.length; k++) {
				if (d < dimensions - 1) {
					xs[k] = level(d + 1);
					continue;
				}
				const length = int32(x, at);
				at += 4;
				if (length === -1) {
					xs[k] = null;
				} else {
					xs[k] = read(x, at);
					at += length;
				}
			}
			return xs;
		}
	};
}

/**
 * For each built-in array type that is read in binary: the type of its elements, and the decoder of
 * the array, which gives the elements as their built-in text parsers do. Not int8[]: its elements
 * are kept as text, and making that text from the binary takes longer than reading it
 * (tests/bench_decoders.ts).
 */
const binary_arrays = {
	1000: [16, binary_array((x, i) => x[i] === 1)],
	1005: [21, binary_array((x, i) => ((x[i] << 24) | (x[i + 1] << 16)) >> 16)],
	1007: [23, binary_array(int32)],
};

/** Decodes a bytea in the binary format, its bytes, by copying them out of the reused read buffer */
function binary_bytea(x, start, end) {
	return Buffer.from(x.subarray(start, end));
}

const shaped = (is, serialize) => (x) => (is(x) ? serialize(x) : string(x));

const shapedTypes = {
	...types,
	boolean: {
		...types.boolean,
		serialize: shaped((x) => typeof x === "boolean", types.boolean.serialize),
	},
	date: { ...types.date, serialize: shaped((x) => x instanceof Date, types.date.serialize) },
	bytea: {
		...types.bytea,
		serialize: shaped((x) => x instanceof Uint8Array, types.bytea.serialize),
	},
};

export function Types(options: Record<string, any> = {}) {
	const parsers = {},
		serializers = {},
		elements = {},
		undefinedValue = options.transform && options.transform.undefined;

	Object.entries(arrays).forEach(
		([oid, array]) => (elements[array] = [+oid, +oid === 603 ? ";" : ","]),
	);
	register(options.infer === false ? shapedTypes : types);
	Object.assign(parsers, dates);
	options.infer === false && (parsers[1114] = parseDate);
	const custom = Object.values<PostgresType>(options.types || {}),
		named = custom.filter((x) => [x.to].concat(x.from || []).some((y) => typeof y === "string")),
		oids = new Map<string, number>();

	register(custom.filter((x) => !named.includes(x)));

	/** The types that options.types names, whose values only their own parsers read */
	const own = new Set(custom.flatMap((x) => [x.to].concat(x.from || [])));

	const bases = {};

	return {
		parser,
		decoder,
		binary,
		serializer,
		load,
		infer,
		resolve,
		named: named.length > 0,
		parsers,
		serializers,
	};

	/**
	 * @param type - a type's OID, or a type's name (as given to `sql.typed()` or in `options.types`)
	 * @returns the OID; for a name, the OID that the pool loaded for it, or 0 (which leaves the type
	 * to the server) if the pool has not loaded one
	 */
	function resolve(type) {
		return typeof type === "string" ? (oids.get(type) ?? 0) : type;
	}

	/**
	 * @param oid - the type of a column
	 * @param parse - the parser that the column's values get, as text
	 * @returns a function `(x, start, end) => value` that gives what `parse` would, but straight
	 *   from the bytes of the text in `x`; or null, if only `parse` can read the values
	 */
	function decoder(oid, parse) {
		if (parse === number && (oid === 21 || oid === 23 || oid === 26)) {
			return integer;
		}
		if (parse === bool && oid === 16) {
			return boolean;
		}
		if (parse === parseTimestamptz && oid === 1184) {
			return timestamptz;
		}
		if (parse === parseDate && (oid === 1114 || oid === 1082)) {
			return utc_time;
		}
		return null;
	}

	/**
	 * @param oid - the type of a column
	 * @returns a decoder `(x, start, end) => value` of the column's values in the binary format,
	 *   which gives what the built-in text parser of the type gives; or null, if the column is read
	 *   as text: a type without such a decoder, or one that options.types parses itself, or whose
	 *   elements it parses itself
	 */
	function binary(oid) {
		const array = binary_arrays[oid];
		if (own.has(oid) || (array && own.has(array[0]))) {
			return null;
		}
		return oid === 17 ? binary_bytea : array ? array[1] : null;
	}

	function register(xs: Record<string, PostgresType> | PostgresType[]) {
		Object.values(xs).forEach((x) => {
			const from = [].concat(x.from || []);
			x.parse && from.forEach((oid) => (parsers[oid] = x.parse));
			if (x.serialize) {
				serializers[x.to] = x.serialize;
				from.forEach((oid) => (serializers[oid] = x.serialize));
			}
		});
	}

	function parser(oid) {
		if (oid in parsers) {
			return parsers[oid];
		}

		if (oid in bases) {
			return (parsers[oid] = parser(bases[oid]));
		}

		if (oid in elements) {
			const [element, delimiter] = elements[oid],
				parse = parser(element);
			return (parsers[oid] = (x) => parseArray(x, parse === identity ? null : parse, delimiter));
		}

		return identity;
	}

	function serializer(oid) {
		if (oid in serializers) {
			return serializers[oid];
		}

		if (oid in bases) {
			return (serializers[oid] = serializer(bases[oid]));
		}

		if (oid in elements) {
			const [element, delimiter] = elements[oid],
				serialize = serializer(element);
			return (serializers[oid] = (xs) =>
				Array.isArray(xs)
					? serializeArray(xs, serialize, delimiter, undefinedValue)
					: serialize(xs));
		}

		return string;
	}

	function load(run) {
		return Promise.all([fetched(run), named.length && names(run)]);
	}

	async function names(run) {
		const wanted = [
				...new Set(
					named.flatMap((x) => [x.to].concat(x.from || [])).filter((x) => typeof x === "string"),
				),
			],
			list = wanted.map((x) => "'" + x.split(".").pop().replace(/'/g, "''") + "'").join(","),
			rows = await run(
				"select t.oid::int, t.typarray::int as array, t.typdelim as delimiter, t.typname as name, n.nspname as schema, " +
					"pg_catalog.pg_type_is_visible(t.oid) as visible from pg_catalog.pg_type t " +
					"join pg_catalog.pg_namespace n on n.oid = t.typnamespace where t.typname in (" +
					list +
					")",
			),
			missing = [];
		wanted.forEach((x) => {
			const [schema, name] = x.includes(".") ? x.split(".") : [null, x],
				row = rows.find((r) => r.name === name && (schema ? r.schema === schema : r.visible));
			if (row) {
				oids.set(x, row.oid);
				if (row.array && !(row.array in elements)) {
					elements[row.array] = [row.oid, row.delimiter];
				}
			} else {
				missing.push(x);
			}
		});
		if (missing.length) {
			throw Errors.generic(
				"TYPE_NOT_FOUND",
				missing.length > 1
					? "The types " + missing.join(", ") + " do not exist"
					: "The type " + missing[0] + " does not exist",
			);
		}
		const resolved = named.map((x) => ({
			...x,
			to: resolve(x.to),
			from: [].concat(x.from || []).map(resolve),
		}));
		register(resolved);
		resolved.forEach((x) => [x.to].concat(x.from).forEach((oid) => own.add(oid)));
	}

	function fetched(run) {
		return run(
			"select oid::int, typelem::int as element, typdelim as delimiter, typbasetype::int as base, typtype as kind " +
				"from pg_catalog.pg_type where typtype = 'd' or (typcategory = 'A' and oid >= 16384)",
		).then((rows) =>
			rows.forEach(({ oid, element, delimiter, base, kind }) => {
				if (oid in parsers || oid in serializers) {
					return;
				}
				kind === "d"
					? (bases[oid] = base)
					: element && !(oid in elements) && (elements[oid] = [element, delimiter]);
			}),
		);
	}
}

const identity = (x) => x;
identity.identity = true;

export class Parameter {
	declare value: any;
	/** The type's OID, or its name until the name is resolved. */
	declare type: number | string;

	constructor(value, type) {
		this.value = value;
		this.type = type;
	}
}

export function infer(x) {
	return x instanceof Parameter
		? x.type
		: x instanceof Date
			? 1184
			: x instanceof Uint8Array
				? 17
				: x === true || x === false
					? 16
					: typeof x === "bigint"
						? 20
						: Array.isArray(x)
							? arrays[infer(x[0])] || 0
							: 0;
}

export function parseArray(x, parse, delimiter = ",") {
	let i = x[0] === "[" ? x.indexOf("=") + 1 : 0;
	return level();

	function level() {
		const xs = [];
		i++;
		while (i < x.length && x[i] !== "}") {
			if (x[i] === "{") {
				xs.push(level());
			} else if (x[i] === '"') {
				let s = "";
				for (i++; x[i] !== '"'; i++) {
					s += x[i] === "\\" ? x[++i] : x[i];
				}
				i++;
				xs.push(parse ? parse(s) : s);
			} else {
				const start = i;
				while (x[i] !== delimiter && x[i] !== "}") {
					i++;
				}
				const s = x.slice(start, i);
				xs.push(s === "NULL" ? null : parse ? parse(s) : s);
			}
			x[i] === delimiter && i++;
		}
		i++;
		return xs;
	}
}

export function serializeArray(xs, serialize = string, delimiter = ",", undefinedValue?) {
	return (
		"{" +
		xs
			.map((x) => {
				const typed = x instanceof Parameter;
				typed && (x = x.value);
				x === undefined && (x = undefinedValue);
				if (x === undefined) {
					throw Errors.generic("UNDEFINED_VALUE", "Undefined values are not allowed");
				}
				return Array.isArray(x) && !typed
					? serializeArray(x, serialize, delimiter, undefinedValue)
					: x === null
						? "NULL"
						: '"' + ("" + serialize(x)).replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
			})
			.join(delimiter) +
		"}"
	);
}

function serializeDate(x) {
	return x === Infinity
		? "infinity"
		: x === -Infinity
			? "-infinity"
			: (x instanceof Date ? x : new Date(x)).toISOString();
}

const timestamp =
	/^(\d{4,})-(\d\d)-(\d\d)(?: (\d\d):(\d\d):(\d\d)(?:\.(\d+))?)?(?:([+-])(\d\d)(?::(\d\d))?(?::(\d\d))?)?( BC)?$/;

function parts(x) {
	const m = x.match(timestamp);
	if (!m) {
		return null;
	}

	const year = m[12] ? 1 - m[1] : +m[1],
		ms = m[7] ? +(m[7] + "00").slice(0, 3) : 0,
		offset = m[8]
			? (m[8] === "-" ? -1 : 1) * ((m[9] * 60 + +(m[10] || 0)) * 60 + +(m[11] || 0)) * 1000
			: 0;

	return {
		year,
		month: m[2] - 1,
		day: +m[3],
		hour: +(m[4] || 0),
		minute: +(m[5] || 0),
		second: +(m[6] || 0),
		ms,
		offset,
	};
}

function infinite(x) {
	return x === "infinity" ? Infinity : x === "-infinity" ? -Infinity : null;
}

function utc(x) {
	const date = new Date(Date.UTC(2000, x.month, x.day, x.hour, x.minute, x.second, x.ms));
	date.setUTCFullYear(x.year);
	return date;
}

function plain(x) {
	const n = x.length;
	return (
		x.charCodeAt(0) !== 48 &&
		x.charCodeAt(n - 1) !== 67 &&
		!(x.charCodeAt(n - 3) === 58 && x.charCodeAt(n - 6) === 58) &&
		x.charCodeAt(0) !== 45 &&
		x.charCodeAt(0) !== 105
	);
}

function parseTimestamptz(x) {
	if (plain(x)) {
		return new Date(x);
	}

	const p = infinite(x) || parts(x);
	if (!p) {
		return new Date(x);
	}

	if (typeof p === "number") {
		return p;
	}

	const date = utc(p);
	date.setTime(date.getTime() - p.offset);
	return date;
}

function parseDate(x) {
	const p = infinite(x) || parts(x);
	return !p ? new Date(x) : typeof p === "number" ? p : utc(p);
}

function parseTimestamp(x) {
	const p = infinite(x) || parts(x);
	if (!p || typeof p === "number") {
		return p || new Date(x);
	}

	const date = new Date(2000, p.month, p.day, p.hour, p.minute, p.second, p.ms);
	date.setFullYear(p.year);
	return date;
}
