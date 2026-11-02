// Model-output: Claude Opus 5.5
// @ts-nocheck
import { expect, test } from "vitest";
import postgres from "../../src/index.ts";

// Options that are not given default to the PG* variables (as in libpq), so remove any that this
// process was started with, which would replace the defaults that these tests expect
for (const name of Object.keys(process.env)) {
	if (name.startsWith("PG")) {
		delete process.env[name];
	}
}

const parsed = (url, o) => {
	const x = postgres(url, { max: 1, ...o }).options;
	return JSON.stringify([x.host, x.port, x.user, x.pass, x.database, x.path || null]);
};

test("A bracketed IPv6 host in a url (#1232)", async () => {
	const expected = JSON.stringify([["::1"], [5433], "u", "p", "db", null]);
	expect(parsed("postgres://u:p@[::1]:5433/db")).toBe(expected);
});

test("Several bracketed IPv6 hosts with ports in a url (#1232)", async () => {
	const expected = JSON.stringify([["::1", "2001:db8::1"], [1, 5432], "u", "p", "db", null]);
	expect(parsed("postgres://u:p@[::1]:1,[2001:db8::1]/db")).toBe(expected);
});

test("A percent-encoded socket directory as the host of a url (#1057)", async () => {
	const expected = JSON.stringify([
		["/var/run/postgresql"],
		[5433],
		"u",
		"",
		"db",
		"/var/run/postgresql/.s.PGSQL.5433",
	]);
	expect(parsed("postgres://u@%2Fvar%2Frun%2Fpostgresql:5433/db")).toBe(expected);
});

test("A host in the query of a url, as libpq reads it (#984)", async () => {
	const expected = JSON.stringify([
		["/run/postgresql"],
		[5432],
		"u",
		"",
		"db",
		"/run/postgresql/.s.PGSQL.5432",
	]);
	expect(parsed("postgres://u@localhost/db?host=/run/postgresql")).toBe(expected);
});

test("A url with no host and a host in its query (#984)", async () => {
	const expected = JSON.stringify([
		["/run/postgresql"],
		[5432],
		"u",
		"",
		"db",
		"/run/postgresql/.s.PGSQL.5432",
	]);
	expect(parsed("postgres:///db?host=/run/postgresql", { user: "u" })).toBe(expected);
});

test("A password with characters that are not percent-encoded is used as written (#735, #890)", async () => {
	const expected = JSON.stringify([["h"], [5432], "u", "p@ss#w%rd\\x", "db", null]);
	expect(parsed("postgres://u:p@ss#w%rd\\x@h/db")).toBe(expected);
});

test("A percent-encoded password is decoded (#735)", async () => {
	const expected = JSON.stringify([["h"], [5432], "u", "p%ss#w@rd", "db", null]);
	expect(parsed("postgres://u:p%25ss%23w%40rd@h/db")).toBe(expected);
});

test("Hosts with ports in the host option, as in v3", async () => {
	const expected = JSON.stringify([["a", "b"], [1, 2], "u", "", "db", null]);
	expect(parsed(undefined, { host: "a:1,b:2", user: "u", database: "db" })).toBe(expected);
});

test("A port option applies to every host", async () => {
	const expected = JSON.stringify([["a", "b"], [7, 7], "u", "", "db", null]);
	expect(parsed("postgres://u@a:1,b:2/db", { port: 7 })).toBe(expected);
});

test("disable and false in the query of a url turn an option off", async () => {
	const x = postgres("postgres://u@h/db?prepare=false&ssl=disable&fetch_types=false", {
		max: 1,
	}).options;
	expect([x.prepare, x.ssl, x.fetch_types].join(" ")).toBe("false false false");
});

test("An unsupported target_session_attrs throws", async () => {
	expect(
		(() => {
			try {
				postgres({ target_session_attrs: "any" });
			} catch (e) {
				return e.message;
			}
		})(),
	).toBe("target_session_attrs any is not supported");
});

test("sql.array() is removed, and says so", async () => {
	expect(
		(() => {
			try {
				postgres({ max: 1 }).array([1]);
			} catch (e) {
				return e.code;
			}
		})(),
	).toBe("ARRAY_REMOVED");
});

test("channel_binding from options, the url and PGCHANNELBINDING, as libpq reads it", async () => {
	const before = process.env.PGCHANNELBINDING;
	process.env.PGCHANNELBINDING = "disable";
	const read = [
		postgres({ max: 1 }).options.channel_binding,
		postgres("postgres://u@h/db?channel_binding=require", { max: 1 }).options.channel_binding,
		postgres({ max: 1, channel_binding: "prefer" }).options.channel_binding,
		postgres("postgres://u@h/db?channel_binding=require", { max: 1 }).options.connection
			.channel_binding,
	];
	before === undefined
		? delete process.env.PGCHANNELBINDING
		: (process.env.PGCHANNELBINDING = before);
	const invalid = (() => {
		try {
			postgres({ channel_binding: "yes" });
		} catch (e) {
			return e.message;
		}
	})();
	expect(read.join() + " " + invalid).toBe(
		"disable,require,prefer, channel_binding yes is not supported",
	);
});

test("The scheduler is on by default, and off with scheduler: false, scheduler=false in the url, or max: 1", async () => {
	expect(
		[
			postgres({ max: 2 }).options.scheduler,
			postgres({ max: 2, scheduler: false }).options.scheduler,
			postgres("postgres://u@h/db?scheduler=false", { max: 2 }).options.scheduler,
			postgres({ max: 1 }).options.scheduler,
		].join(" "),
	).toBe("true false false false");
});
