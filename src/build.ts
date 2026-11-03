import { Errors } from "./errors.ts";
import { Parameter, infer } from "./types.ts";
import type { Query } from "./query.ts";
import type { Options } from "./index.ts";

export const is_query = Symbol("query");

/** The state of one build(): what every part of the query text is made with */
type Context = {
	transform: Options["transform"];
	/** Whether a parameter's type is inferred from its value, or left to the server */
	infer: boolean;
	resolve: Options["resolve"];
	/** The values of the parameters so far */
	values: unknown[];
	/** The type oids of `values`; 0 leaves the type to the server */
	oids: number[];
	/** Whether the text depends on the values: a helper, an identifier or a fragment was in it */
	dynamic: boolean;
};

/** An object whose keys are column names, as the helpers take */
type Columns = Record<string, unknown>;

/** What a helper builds, by the clause before it */
type Kind = "values" | "in" | "select" | "update" | "insert" | "call";

/** Builds the text of a helper: `first` and `rest` are the arguments of `sql(first, ...rest)` */
type Helper = (first: unknown, rest: unknown[], o: Context) => string;

class NotTagged {
	// oxlint-disable-next-line unicorn/no-thenable -- awaiting a call of sql that is not a tagged template throws NOT_TAGGED_CALL
	then() {
		not_tagged();
	}
	catch() {
		not_tagged();
	}
	finally() {
		not_tagged();
	}
}

export class Identifier extends NotTagged {
	/** The identifier, escaped and quoted. */
	declare value: string;

	constructor(identifier: string) {
		super();
		this.value = escape_identifier(identifier);
	}
}

export class Join {
	declare separator: Query;
	declare items: unknown[];

	constructor(separator: Query, items: unknown[]) {
		this.separator = separator;
		this.items = items;
	}
}

export const join_strings = Object.assign(["", ""], { raw: ["", ""] });

export class Builder extends NotTagged {
	declare first: unknown;
	declare rest: unknown[];

	constructor(first: unknown, rest: unknown[]) {
		super();
		this.first = first;
		this.rest = rest;
	}
}

export function build(query: Query, options: Options) {
	const values: unknown[] = [],
		oids: number[] = [],
		o: Context = {
			transform: options.transform,
			infer: options.infer !== false,
			resolve: options.resolve,
			values,
			oids,
			dynamic: !query.tagged,
		};

	let text: string;
	if (query.tagged) {
		text = stringify(query, o);
	} else {
		query.args.forEach((x) => value(x, o));
		// oxlint-disable-next-line typescript/no-unnecessary-type-conversion -- unsafe() may be given a non-string, whose conversion fails the query with its own error
		text = "" + query.strings[0];
	}

	if (values.length >= 65534) {
		throw Errors.generic("MAX_PARAMETERS_EXCEEDED", "Max number of parameters (65534) exceeded");
	}

	const types = oids.join();
	return { strings: query.strings, dynamic: o.dynamic, types, text, values, oids };
}

/** What build() makes of a query: its text, with the values and types of its parameters */
export type Built = ReturnType<typeof build>;

function stringify(q: Query, o: Context) {
	let string = q.strings[0];

	for (let i = 1; i < q.strings.length; i++) {
		string += part(string, q.args[i - 1], o, q.strings[i]) + q.strings[i];
	}

	return string;
}

function part(before: string, x: unknown, o: Context, after = "") {
	if (
		x instanceof Builder ||
		x instanceof Identifier ||
		is_fragment(x) ||
		(Array.isArray(x) && is_fragment(x[0]))
	) {
		o.dynamic = true;
	}

	return is_fragment(x) && x.strings === join_strings
		? joined(x.args[0], o, before, after)
		: x instanceof Join
			? joined(x, o, "", "")
			: x instanceof Builder
				? helper(before, x, o)
				: is_fragment(x)
					? fragment(x, o)
					: x instanceof Identifier
						? x.value
						: Array.isArray(x) && is_fragment(x[0])
							? x.reduce((acc, f) => acc + " " + fragment(f, o), "")
							: value(x, o);
}

function joined(join: Join, o: Context, before: string, after: string) {
	let text = "";
	join.items.forEach((item, i) => {
		if (i > 0) {
			text = spaced(text, fragment(join.separator, o));
		}
		text = spaced(text, part("", item, o));
	});
	if (before && text && !/\s$/.test(before) && !/^\s/.test(text)) {
		text = " " + text;
	}
	if (after && text && !/^\s/.test(after) && !/\s$/.test(text)) {
		text = text + " ";
	}
	return text;
}

function spaced(a: string, b: string) {
	return a && b && !/\s$/.test(a) && !/^\s/.test(b) ? a + " " + b : a + b;
}

function is_fragment(x: unknown): x is Query {
	return !!x && (x as Query)[is_query] === true;
}

function fragment(q: Query, o: Context) {
	return q.tagged ? stringify(q, o) : q.strings[0];
}

export function value(x: unknown, o: Context) {
	let v = x instanceof Parameter ? x.value : x;
	if (v === undefined) {
		v = o.transform.undefined;
		if (v === undefined) {
			throw Errors.generic("UNDEFINED_VALUE", "Undefined values are not allowed");
		}
		if (!(x instanceof Parameter)) {
			x = v;
		}
	}
	o.values.push(v);
	o.oids.push(x instanceof Parameter ? o.resolve(x.type) : o.infer ? infer(x) : 0);
	return "$" + o.values.length;
}

const builders: Record<Kind, Helper> = {
	values: values_list,
	in: (first, rest, o) => {
		const x = values_list(first, rest, o);
		return x === "()" ? "(null)" : x;
	},
	select,
	update,
	insert,
	call,
};

function call(first: unknown, rest: unknown[], o: Context) {
	if (first === null || typeof first !== "object" || Array.isArray(first) || is_fragment(first)) {
		return select(first, rest, o);
	}

	const row = first as Columns;
	return columns(row, rest)
		.map((x) => escape_identifier(column(x, o)) + " => " + part("values", row[x], o))
		.join(",");
}

const clauses = new Map<string, Kind>([
		["in", "in"],
		["values", "values"],
		["select", "select"],
		["returning", "select"],
		["set", "update"],
		["distinct", "select"],
	]),
	stops = new Set([
		"from",
		"where",
		"on",
		"to",
		"join",
		"group",
		"order",
		"by",
		"having",
		"limit",
		"offset",
		"union",
		"intersect",
		"except",
		"using",
		"and",
		"or",
		"when",
		"then",
		"else",
		"with",
		"table",
		"grant",
		"revoke",
		"delete",
		"update",
		"case",
		"not",
		"like",
		"ilike",
		"between",
		"is",
		"exists",
		"conflict",
		"do",
		"nothing",
		"window",
		"over",
		"partition",
		"filter",
		"lateral",
		"cross",
		"inner",
		"left",
		"right",
		"full",
		"outer",
		"natural",
		"into",
	]);

function helper(before: string, x: Builder, o: Context) {
	const kind = context(before);
	return kind
		? builders[kind](x.first, x.rest, o)
		: identifiers(typeof x.first === "string" ? [x.first, ...x.rest] : x.first, o);
}

function context(sql: string): Kind | null {
	const words: string[] = [];

	let i = sql.length - 1,
		depth = 0;

	while (i >= 0) {
		const c = sql[i];
		if (c === ")") {
			depth++;
			i--;
		} else if (c === "(") {
			if (depth === 0) {
				const word = previous(sql, i - 1);
				if (words.length === 0) {
					return word === "in" || word === "values"
						? word
						: word && !clauses.has(word) && !stops.has(word)
							? "call"
							: "select";
				}
				return "select";
			}
			depth--;
			i--;
		} else if (c === "'" || c === '"') {
			const end = i;
			i--;
			while (i >= 0 && !(sql[i] === c && sql[i - 1] !== c)) {
				if (sql[i] === c) {
					i -= 2;
				} else {
					i--;
				}
			}
			i--;
			if (sql[i] === ".") {
				i--;
			} else if (depth === 0 && c === '"') {
				words.push(sql.slice(i + 1, end + 1));
			}
		} else if (/[a-z_0-9$]/i.test(c)) {
			const end = i + 1;
			while (i >= 0 && /[a-z_0-9$.]/i.test(sql[i])) {
				i--;
			}
			const word = depth === 0 && sql.slice(i + 1, end).toLowerCase();
			if (word && clauses.has(word)) {
				return clauses.get(word) ?? null;
			}
			if (word === "into") {
				return insert_into(words, sql, i) ? "insert" : null;
			}
			if (word && stops.has(word)) {
				return null;
			}
			if (word) {
				words.push(word);
			}
		} else {
			i--;
		}
	}
	return null;
}

function previous(sql: string, i: number) {
	while (i >= 0 && /\s/.test(sql[i])) {
		i--;
	}

	if (sql[i] === '"') {
		return '"';
	}

	const end = i + 1;
	while (i >= 0 && /[a-z_0-9$.]/i.test(sql[i])) {
		i--;
	}

	return sql.slice(i + 1, end).toLowerCase();
}

function insert_into(words: string[], sql: string, i: number) {
	const target = words.length === 1 || (words.length === 3 && words[1] === "as");
	return target && previous(sql, i) === "insert";
}

function values_builder(first: Columns[], picked: string[], o: Context) {
	return first
		.map((row) => "(" + picked.map((x) => part("values", row[x], o)).join(",") + ")")
		.join(",");
}

function values_list(first: unknown, rest: unknown[], o: Context) {
	const rows =
			Array.isArray(first) &&
			first.length > 0 &&
			first[0] !== null &&
			typeof first[0] === "object" &&
			!is_fragment(first[0]),
		picked = columns(rows ? first[0] : first, rest);

	return values_builder((rows ? first : [first]) as Columns[], picked, o);
}

function update(first: unknown, rest: unknown[], o: Context) {
	const row = first as Columns,
		picked = columns(row, rest);
	if (!picked.length) {
		empty("update");
	}

	return picked
		.map((x) => escape_identifier(column(x, o)) + "=" + part("values", row[x], o))
		.join(",");
}

function insert(first: unknown, rest: unknown[], o: Context) {
	if (Array.isArray(first) && first.every((x) => typeof x === "string")) {
		return "(" + escape_identifiers(first.concat(rest.flat() as string[]), o) + ")";
	}

	const picked = columns(Array.isArray(first) ? first[0] || {} : first, rest);
	if (!picked.length) {
		empty("insert");
	}

	return (
		"(" +
		escape_identifiers(picked, o) +
		")values" +
		values_builder((Array.isArray(first) ? first : [first]) as Columns[], picked, o)
	);
}

/** @returns the column names: `rest`, the names given after the object, flattened; else the object's keys */
function columns(first: unknown, rest: unknown[]) {
	return rest.length ? (rest.flat() as string[]) : Object.keys(first as object);
}

function empty(x: string) {
	throw Errors.generic("NO_COLUMNS", "The " + x + " helper got no columns");
}

function identifiers(first: unknown, o: Context) {
	return Array.isArray(first) ? first.map((x) => member(x, o)).join(",") : member(first, o);
}

function member(x: unknown, o: Context) {
	return is_fragment(x)
		? fragment(x, o)
		: x instanceof Identifier
			? x.value
			: escape_identifier(column(x as string, o));
}

function select(first: unknown, rest: unknown[], o: Context) {
	if (typeof first === "string") {
		first = [first, ...rest];
	}
	if (Array.isArray(first)) {
		return identifiers(first, o);
	}

	const row = first as Columns;
	return columns(row, rest)
		.map((x) => {
			const v = row[x];
			return (
				(is_fragment(v) ? fragment(v, o) : v instanceof Identifier ? v.value : value(v, o)) +
				" as " +
				escape_identifier(column(x, o))
			);
		})
		.join(",");
}

function column(x: string, o: Context) {
	return o.transform.column.to ? o.transform.column.to(x) : x;
}

function escape_identifiers(xs: string[], o: Context) {
	return xs.map((x) => escape_identifier(column(x, o))).join(",");
}

export function escape_identifier(x: string) {
	return '"' + x.replace(/"/g, '""').replace(/\./g, '"."') + '"';
}

export function not_tagged() {
	throw Errors.generic("NOT_TAGGED_CALL", "Query not called as a tagged template literal");
}
