// Model-output: Claude Opus 5.5
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

	constructor(x) {
		super(typeof x === "string" ? x : x && x.message);
		this.name = this.constructor.name;
		x && typeof x === "object" && Object.assign(this, x);
	}

	toJSON() {
		return { ...this, message: this.message };
	}
}

export const Errors = {
	connection,
	postgres,
	generic,
	notSupported,
};

function connection(code, options, host, port) {
	const address = options.path || host,
		error = Object.assign(
			new Error("write " + code + " " + (options.path || host + ":" + port)),
			{ code, errno: code, address },
			options.path ? {} : { port },
		);

	Error.captureStackTrace(error, connection);
	return error;
}

function postgres(x) {
	const error = new PostgresError(x);
	Error.captureStackTrace(error, postgres);
	return error;
}

function generic(code, message) {
	const error = Object.assign(new Error(code + ": " + message), { code });
	Error.captureStackTrace(error, generic);
	return error;
}

function notSupported(x) {
	const error = Object.assign(new Error(x + " (B) is not supported"), {
		code: "MESSAGE_NOT_SUPPORTED",
		name: x,
	});
	Error.captureStackTrace(error, notSupported);
	return error;
}

const places = locations();

export const ours = (line) =>
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
	} catch (error) {
		return [];
	}
}

export function withOrigin(error, origin) {
	origin &&
		Object.defineProperty(error, "stack", {
			value: [
				error.stack.split("\n")[0],
				...origin
					.split("\n")
					.slice(1)
					.filter((x) => !ours(x)),
			].join("\n"),
			writable: true,
			configurable: true,
			enumerable: false,
		});
	return error;
}

export function queryError(error, q, debug) {
	if (!error || typeof error !== "object") error = new Error(error);

	if (!q || "query" in error) return error;

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
export function throw_on_casing_transforms(target) {
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
