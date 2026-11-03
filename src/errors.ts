import util from "util";
import type { Options } from "./index.ts";
import type { Query } from "./query.ts";

/** An error with the `code` that the library's errors and PostgreSQL's have, and a PostgreSQL error's `severity` */
export type Failure = Error & { code?: string; severity?: string };

export class PostgresError extends Error {
	// The fields of the ErrorResponse that PostgreSQL sent, then `query`, `parameters`,
	// and `types`, which this library adds to some errors.
	declare severity_local: string;
	declare severity: string;
	declare code: string;
	declare position?: string;
	declare file: string;
	declare line: string;
	declare routine: string;
	declare detail?: string;
	declare hint?: string;
	declare internal_position?: string;
	declare internal_query?: string;
	declare where?: string;
	declare schema_name?: string;
	declare table_name?: string;
	declare column_name?: string;
	declare data_type_name?: string;
	declare constraint_name?: string;
	declare query?: string;
	declare parameters?: any[];
	declare types?: number[];

	constructor(x: string | ({ message?: string } & Record<string, unknown>)) {
		super(typeof x === "string" ? x : x && x.message);
		this.name = this.constructor.name;
		if (x && typeof x === "object") {
			Object.assign(this, x);
		}
	}

	toJSON() {
		// oxlint-disable-next-line typescript/no-misused-spread -- a plain object of the error's own fields is the point
		return { ...this, message: this.message };
	}
}

export const Errors = {
	connection,
	postgres,
	generic,
	canceled,
	notSupported,
};

function connection(code: string, options: Options, host: string | null, port: number) {
	const address = options.path || host,
		error = Object.assign(
			new Error("write " + code + " " + (options.path || host + ":" + port)),
			{ code, errno: code, address },
			options.path ? {} : { port },
		);

	Error.captureStackTrace(error, connection);
	return error;
}

function postgres(x: Record<string, string>) {
	const error = new PostgresError(x);
	Error.captureStackTrace(error, postgres);
	return error;
}

function generic(code: string, message: string) {
	const error = Object.assign(new Error(code + ": " + message), { code });
	Error.captureStackTrace(error, generic);
	return error;
}

/**
 * @returns the error of a query or COPY stream that the client cancelled itself,
 * with the code and message of the server's error for a cancelled statement
 */
function canceled() {
	const error = generic("57014", "canceling statement due to user request");
	Error.captureStackTrace(error, canceled);
	return error;
}

function notSupported(x: string) {
	const error = Object.assign(new Error(x + " (B) is not supported"), {
		code: "MESSAGE_NOT_SUPPORTED",
		name: x,
	});
	Error.captureStackTrace(error, notSupported);
	return error;
}

const places = locations();

export const ours = (line: string) =>
	places.some(
		(here) =>
			line.includes(here) &&
			!line
				.slice(line.indexOf(here) + here.length)
				.split(":")[0]
				.includes("/"),
	);

function locations() {
	try {
		const url = new URL(".", import.meta.url);
		return url.protocol === "file:" ? [url.href, decodeURIComponent(url.pathname)] : [url.href];
	} catch {
		return [];
	}
}

export function withOrigin(error: Error, origin: string | null | undefined) {
	if (origin) {
		Object.defineProperty(error, "stack", {
			value: [
				(error.stack ?? String(error)).split("\n")[0],
				...origin
					.split("\n")
					.slice(1)
					.filter((x) => !ours(x)),
			].join("\n"),
			writable: true,
			configurable: true,
			enumerable: false,
		});
	}
	return error;
}

/**
 * Copies an error, so that each of several queries that fail for one reason can get its own error
 * from `queryError`, which adds properties to the error that it is given.
 * @param error - the error to copy
 * @returns `error` itself if it is not an object. Otherwise, a new object with the prototype, the
 *   own properties and the `stack` of `error`, except the properties that `queryError` adds (if
 *   `error` has them). If `error` is an `Error`, the copy is a native `Error` too, so that
 *   `Error.isError` and `structuredClone` treat it as one.
 */
export function copy_error<T>(error: T): T {
	if (!error || typeof error !== "object") {
		return error;
	}

	const x = Object.setPrototypeOf(
		error instanceof Error ? new Error() : {},
		Object.getPrototypeOf(error),
	);
	Object.defineProperties(x, Object.getOwnPropertyDescriptors(error));
	Object.defineProperty(x, "stack", {
		value: (error as unknown as Error).stack,
		writable: true,
		configurable: true,
	});
	for (const k of ["query", "parameters", "args", "types"]) {
		delete x[k];
	}
	return x;
}

/**
 * @param thrown - what a callback or a promise threw: an error, or anything else
 * @returns `thrown` if it is an object, else an Error whose message is `thrown` (a string) or its
 *   util.inspect()
 */
export function as_error(thrown: unknown): Failure {
	return thrown !== null && typeof thrown === "object"
		? (thrown as Failure)
		: new Error(typeof thrown === "string" ? thrown : util.inspect(thrown));
}

/**
 * @param thrown - what failed the query: an error, or whatever a callback threw
 * @param q - the query, or null for no query
 * @param debug - the `debug` option: whether the query's text and values are enumerable on the error
 * @returns the error, an Error made of `thrown` if it was not an object, with the query's text,
 *   values, args and types as (non-enumerable, unless `debug`) properties, and its origin in the stack
 */
export function queryError(thrown: unknown, q: Query | null, debug: unknown) {
	const error = as_error(thrown);
	if (!q || "query" in error) {
		return error;
	}

	const built = q.built;
	Object.defineProperties(error, {
		query: {
			value: built ? built.text : q.strings[0],
			enumerable: !!debug,
			configurable: true,
			writable: true,
		},
		parameters: {
			value: built ? built.values : [],
			enumerable: !!debug,
			configurable: true,
			writable: true,
		},
		args: { value: q.args, enumerable: !!debug, configurable: true, writable: true },
		types: {
			value: built ? built.oids : [],
			enumerable: !!debug,
			configurable: true,
			writable: true,
		},
	});
	return withOrigin(error, q.origin);
}

/** The casing transforms that v3 had as properties of `postgres`, and that v4 removed */
const casing_transforms = [
	"camel",
	"toCamel",
	"fromCamel",
	"pascal",
	"toPascal",
	"fromPascal",
	"kebab",
	"toKebab",
	"fromKebab",
];

/**
 * Defines a getter on `target` for each removed casing transform (such as `camel`), which throws
 * CASING_TRANSFORM_REMOVED. Without this, `transform: postgres.camel` would be `transform:
 * undefined`, which transforms nothing, without an error. The getters are not enumerable, so that
 * `Object.assign` (which reads only enumerable properties) does not throw when it copies `target`.
 * @param target - the default export of the package's entry point (for example, `postgres`)
 */
export function throw_on_casing_transforms(target: object) {
	for (const name of casing_transforms) {
		Object.defineProperty(target, name, {
			configurable: true,
			enumerable: false,
			get() {
				throw Errors.generic(
					"CASING_TRANSFORM_REMOVED",
					"postgres." +
						name +
						" is removed in v4: pass your own functions as transform.column.to and transform.column.from instead, and as transform.value.from for the keys inside json and jsonb values",
				);
			},
		});
	}
}
