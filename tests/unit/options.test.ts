import { expect, test, vi } from "vitest";
import postgres from "../../src/index.ts";
import { thrown, with_env } from "../helpers.ts";

/**
 * @param url - the url to give postgres(), if any
 * @param o - options to give postgres(), besides max: 1
 * @returns the hosts, ports, user, pass, database and socket path (null if none) of the options that
 * postgres() made
 */
const parsed = (url, o?) => {
	const x = postgres(url, { max: 1, ...o }).options;
	return [x.host, x.port, x.user, x.pass, x.database, x.path || null];
};

test("A bracketed IPv6 host in a url (#1232)", async () => {
	expect(parsed("postgres://u:p@[::1]:5433/db")).toEqual([["::1"], [5433], "u", "p", "db", null]);
});

test("Several bracketed IPv6 hosts with ports in a url (#1232)", async () => {
	expect(parsed("postgres://u:p@[::1]:1,[2001:db8::1]/db")).toEqual([
		["::1", "2001:db8::1"],
		[1, 5432],
		"u",
		"p",
		"db",
		null,
	]);
});

test("A percent-encoded socket directory as the host of a url (#1057)", async () => {
	expect(parsed("postgres://u@%2Fvar%2Frun%2Fpostgresql:5433/db")).toEqual([
		["/var/run/postgresql"],
		[5433],
		"u",
		"",
		"db",
		"/var/run/postgresql/.s.PGSQL.5433",
	]);
});

test("A host in the query of a url, as libpq reads it (#984)", async () => {
	expect(parsed("postgres://u@localhost/db?host=/run/postgresql")).toEqual([
		["/run/postgresql"],
		[5432],
		"u",
		"",
		"db",
		"/run/postgresql/.s.PGSQL.5432",
	]);
});

test("A url with no host and a host in its query (#984)", async () => {
	expect(parsed("postgres:///db?host=/run/postgresql", { user: "u" })).toEqual([
		["/run/postgresql"],
		[5432],
		"u",
		"",
		"db",
		"/run/postgresql/.s.PGSQL.5432",
	]);
});

test("A password with characters that are not percent-encoded is used as written (#735, #890)", async () => {
	expect(parsed("postgres://u:p@ss#w%rd\\x@h/db")).toEqual([
		["h"],
		[5432],
		"u",
		"p@ss#w%rd\\x",
		"db",
		null,
	]);
});

test("A percent-encoded password is decoded (#735)", async () => {
	expect(parsed("postgres://u:p%25ss%23w%40rd@h/db")).toEqual([
		["h"],
		[5432],
		"u",
		"p%ss#w@rd",
		"db",
		null,
	]);
});

test("Hosts with ports in the host option, as in v3", async () => {
	expect(parsed(undefined, { host: "a:1,b:2", user: "u", database: "db" })).toEqual([
		["a", "b"],
		[1, 2],
		"u",
		"",
		"db",
		null,
	]);
});

test("A port option applies to every host", async () => {
	expect(parsed("postgres://u@a:1,b:2/db", { port: 7 })).toEqual([
		["a", "b"],
		[7, 7],
		"u",
		"",
		"db",
		null,
	]);
});

test("disable and false in the query of a url turn an option off", async () => {
	const x = postgres("postgres://u@h/db?prepare=false&ssl=disable&fetch_types=false", {
		max: 1,
	}).options;
	expect([x.prepare, x.ssl, x.fetch_types]).toEqual([false, false, false]);
});

test("disable and false in a PG environment variable turn an option off, as in a url", async () => {
	const x = with_env(
		{ PGPREPARE: "false", PGIDLE_TIMEOUT: "disable" },
		() => postgres({ max: 1 }).options,
	);
	expect([x.prepare, x.idle_timeout]).toEqual([false, false]);
});

test("target_session_attrs from options, the url and PGTARGETSESSIONATTRS, as libpq reads it, where any is null", async () => {
	const read = with_env({ PGTARGETSESSIONATTRS: "standby" }, () => [
		postgres({ max: 1 }).options.target_session_attrs,
		postgres("postgres://u@h/db?target_session_attrs=primary", { max: 1 }).options
			.target_session_attrs,
		postgres({ max: 1, target_session_attrs: null }).options.target_session_attrs,
		postgres({ max: 1, target_session_attrs: "any" }).options.target_session_attrs,
		postgres("postgres://u@h/db?target_session_attrs=any", { max: 1 }).options.target_session_attrs,
	]);
	const unset = with_env(
		{ PGTARGETSESSIONATTRS: undefined },
		() => postgres({ max: 1 }).options.target_session_attrs,
	);
	const any = with_env(
		{ PGTARGETSESSIONATTRS: "any" },
		() => postgres({ max: 1 }).options.target_session_attrs,
	);
	expect([read, unset, any]).toEqual([["standby", "primary", null, null, null], null, null]);
});

test("An unsupported or empty target_session_attrs throws", async () => {
	const must =
		"The option target_session_attrs must be one of " +
		'null, "any", "read-write", "read-only", "primary", "standby", "prefer-standby", but it is ';
	expect([
		thrown(() => postgres({ target_session_attrs: "master" })).message,
		thrown(() => postgres({ target_session_attrs: "" })).message,
	]).toEqual([must + '"master"', must + '""']);
});

test("sql.array() is removed, and says so", async () => {
	expect(thrown(() => postgres({ max: 1 }).array([1])).code).toBe("ARRAY_REMOVED");
});

test("A custom type can have the name of a property of functions, such as name or length", async () => {
	const names = ["name", "length", "arguments", "caller", "__proto__"],
		type = { to: 19, from: [19], parse: (x) => x, serialize: (x) => x },
		sql = postgres({ max: 1, types: Object.fromEntries(names.map((name) => [name, type])) });
	const prototype = Object.getPrototypeOf(sql.types) === Function.prototype;
	expect([names.map((name) => sql.types[name]("x").type), prototype]).toEqual([
		Array(5).fill(19),
		true,
	]);
});

test("The removed casing transforms throw when read, and Object.assign does not copy them", async () => {
	const names = "camel toCamel fromCamel pascal toPascal fromPascal kebab toKebab fromKebab",
		codes = names.split(" ").map((name) => thrown(() => postgres[name]).code);
	const copied = Object.assign({}, postgres);
	expect([codes, names.split(" ").filter((name) => name in copied)]).toEqual([
		Array(9).fill("CASING_TRANSFORM_REMOVED"),
		[],
	]);
});

test("channel_binding from options, the url and PGCHANNELBINDING, as libpq reads it", async () => {
	const read = with_env({ PGCHANNELBINDING: "disable" }, () => [
		postgres({ max: 1 }).options.channel_binding,
		postgres("postgres://u@h/db?channel_binding=require", { max: 1 }).options.channel_binding,
		postgres({ max: 1, channel_binding: "prefer" }).options.channel_binding,
		postgres("postgres://u@h/db?channel_binding=require", { max: 1 }).options.connection
			.channel_binding,
	]);
	const must =
		'The option channel_binding must be one of "disable", "prefer", "require", but it is ';
	expect([
		read,
		thrown(() => postgres({ channel_binding: "yes" })).message,
		thrown(() => postgres({ channel_binding: null })).message,
	]).toEqual([["disable", "require", "prefer", undefined], must + '"yes"', must + "null"]);
});

test("sslnegotiation from options, the url and PGSSLNEGOTIATION; another value throws", async () => {
	const read = with_env({ PGSSLNEGOTIATION: "postgres" }, () => [
		postgres({ max: 1 }).options.sslnegotiation,
		postgres("postgres://u@h/db?sslnegotiation=direct", { max: 1 }).options.sslnegotiation,
		postgres({ max: 1, sslnegotiation: null }).options.sslnegotiation,
	]);
	expect([
		read,
		thrown(() => postgres("postgres://u@h/db?sslnegotiation=Direct", { max: 1 })).message,
	]).toEqual([
		["postgres", "direct", null],
		'The url parameter sslnegotiation must be one of null, "postgres", "direct", but it is "Direct"',
	]);
});

test("The scheduler is on by default, and off with scheduler: false, scheduler=false in the url, or max: 1", async () => {
	expect([
		postgres({ max: 2 }).options.scheduler,
		postgres({ max: 2, scheduler: false }).options.scheduler,
		postgres("postgres://u@h/db?scheduler=false", { max: 2 }).options.scheduler,
		postgres({ max: 1 }).options.scheduler,
	]).toEqual([true, false, false, false]);
});

test("A numeric option written as text is a number, from the url, a PG variable or the options", async () => {
	const x = with_env(
		{ PGMAX_PIPELINE: " 7\r\n" },
		() => postgres("postgres://u@h/db?max=1&connect_timeout=2.5", { idle_timeout: "60" }).options,
	);
	expect([x.max, x.connect_timeout, x.idle_timeout, x.max_pipeline, x.scheduler]).toEqual([
		1,
		2.5,
		60,
		7,
		false,
	]);
});

test("A numeric option that is not a finite, non-negative number, or text that is not a non-negative decimal number, throws, naming its source", async () => {
	const must = " must be a non-negative decimal number, but it is ";
	const from_variable = with_env(
		{ PGCONNECT_TIMEOUT: "30s" },
		() => thrown(() => postgres({ max: 1 })).message,
	);
	const texts = ["abc", "", " ", "-1", "1e3", "0x10", ".5", "Infinity", "9".repeat(400)];
	expect([
		from_variable,
		thrown(() => postgres({ max: 1, idle_timeout: "abc" })).message,
		thrown(() => postgres({ max: 1, connect_timeout: NaN })).message,
		thrown(() => postgres({ max: 1, keep_alive: -1 })).message,
		thrown(() => postgres({ max: 1, idle_timeout: Infinity })).message,
		...texts.map(
			(x) =>
				thrown(() => postgres("postgres://u@h/db?backoff=" + encodeURIComponent(x), { max: 1 }))
					.message,
		),
	]).toEqual([
		"The environment variable PGCONNECT_TIMEOUT" + must + '"30s"',
		"The option idle_timeout" + must + '"abc"',
		"The option connect_timeout" + must + "NaN",
		"The option keep_alive" + must + "-1",
		"The option idle_timeout" + must + "Infinity",
		...texts.map((x) => "The url parameter backoff" + must + JSON.stringify(x)),
	]);
});

test("max, min and max_pipeline must be integers of at least 1, 0 and 0", async () => {
	const must = (k, least, shown) =>
		"The " + k + " must be an integer of at least " + least + ", but it is " + shown;
	const read = postgres("postgres://u@h/db?max=2&min=0&max_pipeline=0").options;
	expect([
		[read.max, read.min, read.max_pipeline],
		thrown(() => postgres({ max: 0 })).message,
		thrown(() => postgres({ max: 2.5 })).message,
		thrown(() => postgres("postgres://u@h/db?max=false")).message,
		thrown(() => postgres({ max: 1, min: -1 })).message,
		thrown(() => postgres({ max: 1, min: "0.5" })).message,
		thrown(() => postgres({ max: 1, max_pipeline: 1.5 })).message,
	]).toEqual([
		[2, 0, 0],
		must("option max", 1, "0"),
		must("option max", 1, "2.5"),
		must("url parameter max", 1, '"false"'),
		must("option min", 0, "-1"),
		must("option min", 0, '"0.5"'),
		must("option max_pipeline", 0, "1.5"),
	]);
});

test("An option that is on or off is true or false, or the text true, false or disable; anything else throws", async () => {
	const must = (source, shown) => "The " + source + " must be true or false, but it is " + shown;
	const from_variable = with_env(
		{ PGFETCH_TYPES: "off" },
		() => thrown(() => postgres({ max: 1 })).message,
	);
	const read = postgres("postgres://u@h/db?infer=true&prepare=disable", {
		max: 1,
		fetch_types: "false",
	}).options;
	expect([
		[read.infer, read.prepare, read.fetch_types],
		from_variable,
		thrown(() => postgres("postgres://u@h/db?prepare=0", { max: 1 })).message,
		thrown(() => postgres({ max: 1, infer: "yes" })).message,
		thrown(() => postgres({ max: 2, scheduler: null })).message,
	]).toEqual([
		[true, false, false],
		must("environment variable PGFETCH_TYPES", '"off"'),
		must("url parameter prepare", '"0"'),
		must("option infer", '"yes"'),
		must("option scheduler", "null"),
	]);
});

test("The names of a publication and a replication slot are used as they are given, even false or disable", async () => {
	const x = postgres("postgres://u@h/db?publications=false", { max: 1, slot: "disable" }).options;
	expect([x.publications, x.slot]).toEqual(["false", "disable"]);
});

test("Url parameters named like Object.prototype properties go to the server", async () => {
	const url = "postgres://u@h/db?constructor=a&toString=b&__proto__=c&search_path=d";
	expect(Object.entries(postgres(url, { max: 1 }).options.connection)).toEqual([
		["application_name", "postgres.js"],
		["constructor", "a"],
		["toString", "b"],
		["__proto__", "c"],
		["search_path", "d"],
	]);
});

test("The url parameters that the client reads are not sent to the server", async () => {
	const url = "postgres://u@h/db?sslmode=require&sslrootcert=system&max=2&host=h2&port=1";
	const { connection, ssl } = postgres(url, { max: 1 }).options;
	expect([connection, ssl]).toEqual([{ application_name: "postgres.js" }, "verify-full"]);
});

test("The default setTimeout waits at most 2^31 - 1 ms, passes on its arguments, and is the setTimeout that was global when postgres() was called", async () => {
	const timers = postgres({ max: 1 }).options.timers;
	let fired = false,
		faked;
	vi.useFakeTimers();
	const timer = timers.setTimeout(() => (fired = true), 2 ** 40);
	try {
		faked = vi.getTimerCount();
	} finally {
		vi.useRealTimers();
	}
	await new Promise((resolve) => setTimeout(resolve, 20));
	timers.clearTimeout(timer);
	const passed = await new Promise((resolve) => timers.setTimeout(resolve, 1, "x"));
	expect([faked, fired, passed]).toEqual([0, false, "x"]);
});
