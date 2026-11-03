import { expect, test } from "vitest";
import { Errors, PostgresError } from "../../src/errors.ts";
import { excerpt, reason, target, tenths } from "../../src/log.ts";
import type { Options } from "../../src/index.ts";

/** @returns the options that target() reads, for a pool to db1:5432/shop as app, with `extra` */
function pool(extra: Record<string, unknown> = {}): Options {
	return {
		user: "app",
		host: ["db1"],
		port: [5432],
		database: "shop",
		path: false,
		...extra,
	} as Options;
}

test("target names the user, the host, the port and the database", () => {
	expect(target(pool())).toBe("app@db1:5432/shop");
	expect(target(pool(), "db1", 5432)).toBe("app@db1:5432/shop");
});

test("target lists every host of a pool, and the one host of a connection", () => {
	const options = pool({ host: ["db1", "db2"], port: [5432, 5433] });
	expect(target(options)).toBe("app@db1:5432,db2:5433/shop");
	expect(target(options, "db2", 5433)).toBe("app@db2:5433/shop");
});

test("target brackets an IPv6 address and the path of a Unix-domain socket", () => {
	expect(target(pool({ host: ["::1"] }))).toBe("app@[::1]:5432/shop");
	expect(target(pool({ path: "/run/postgresql/.s.PGSQL.5432" }), null, 5432)).toBe(
		"app@[/run/postgresql/.s.PGSQL.5432]/shop",
	);
});

test("target omits a user that is a function, and names the pool's role", () => {
	expect(target(pool({ user: () => "app" }))).toBe("db1:5432/shop");
	expect(target(pool({ role: "LISTEN" }))).toBe("app@db1:5432/shop (LISTEN)");
});

test("reason describes a PostgreSQL error by its code and message", () => {
	const error = new PostgresError({
		code: "28P01",
		message: 'password authentication failed for user "app"',
	});
	expect(reason(error)).toBe('28P01 password authentication failed for user "app"');
});

test("reason describes a connection error of the library by its code and address", () => {
	expect(reason(Errors.connection("CONNECT_TIMEOUT", pool(), "db1", 5432))).toBe(
		"CONNECT_TIMEOUT (db1:5432)",
	);
	expect(
		reason(
			Errors.connection("CONNECTION_CLOSED", pool({ path: "/tmp/.s.PGSQL.5432" }), null, 5432),
		),
	).toBe("CONNECTION_CLOSED (/tmp/.s.PGSQL.5432)");
});

test("reason keeps a message that has its code, and adds a code that the message lacks", () => {
	expect(
		reason(Errors.generic("UNEXPECTED_MESSAGE", "A DataRow came while nothing was in flight")),
	).toBe("UNEXPECTED_MESSAGE: A DataRow came while nothing was in flight");
	expect(
		reason(
			Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5432"), { code: "ECONNREFUSED" }),
		),
	).toBe("connect ECONNREFUSED 127.0.0.1:5432");
	expect(reason(Object.assign(new Error("boom"), { code: "EBOOM" }))).toBe("EBOOM: boom");
});

test("reason describes an error without a code by its message, and anything else thrown by its text", () => {
	expect(reason(new Error("boom"))).toBe("boom");
	expect(reason("boom")).toBe("boom");
	expect(reason(42)).toBe("42");
});

test("excerpt collapses whitespace, and cuts a long text to the limit with an ellipsis", () => {
	expect(excerpt("select\n\t1,\n\t2 ")).toBe("select 1, 2");
	const long = excerpt("select " + "x".repeat(300));
	expect(long).toHaveLength(200);
	expect(long.endsWith("…")).toBe(true);
	expect(excerpt("short", 10)).toBe("short");
});

test("tenths rounds milliseconds to a tenth of a second", () => {
	expect(tenths(1234)).toBe(1.2);
	expect(tenths(50)).toBe(0.1);
	expect(tenths(0)).toBe(0);
});
