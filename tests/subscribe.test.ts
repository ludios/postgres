import { expect, onTestFinished, test } from "vitest";
import { postgres, options, delay, camel_case, snake_case, defer } from "./setup.ts";

test("subscribe", async () => {
	await using sql = postgres({
		database: options.db,
		publications: "alltables",
	});

	await sql.unsafe(
		"drop publication if exists alltables; create publication alltables for all tables",
	);
	await using _drop_publication = defer(() => sql`drop publication alltables`);

	const result = [];

	const { unsubscribe } = await sql.subscribe("*", (row, { command, old }) => {
		result.push([command, row.name, row.id, old && old.name, old && old.id]);
	});

	await sql`
    create table test (
      id serial primary key,
      name text
    )
  `;

	await sql`alter table test replica identity default`;
	await sql`insert into test (name) values ('Murray')`;
	await sql`update test set name = 'Rothbard'`;
	await sql`update test set id = 2`;
	await sql`delete from test`;
	await sql`alter table test replica identity full`;
	await sql`insert into test (name) values ('Murray')`;
	await sql`update test set name = 'Rothbard'`;
	await sql`delete from test`;
	await until(() => result.length === 7);
	await unsubscribe();
	await sql`insert into test (name) values ('Oh noes')`;
	await delay(50);
	expect(result).toEqual([
		["insert", "Murray", 1, undefined, undefined],
		["update", "Rothbard", 1, null, null],
		["update", "Rothbard", 2, null, 1],
		["delete", null, 2, undefined, undefined],
		["insert", "Murray", 2, undefined, undefined],
		["update", "Rothbard", 2, "Murray", 2],
		["delete", "Rothbard", 2, undefined, undefined],
	]);
});

test("subscribe with transform", async () => {
	await using sql = postgres({
		transform: {
			column: {
				from: camel_case,
				to: snake_case,
			},
		},
		database: options.db,
		publications: "alltables",
	});

	await sql.unsafe(
		"drop publication if exists alltables; create publication alltables for all tables",
	);
	await using _drop_publication = defer(() => sql`drop publication alltables`);

	const result = [];

	const { unsubscribe } = await sql.subscribe("*", (row, { command, old }) =>
		result.push([command, row.nameInCamel || row.id, old && old.nameInCamel]),
	);

	await sql`
    create table test (
      id serial primary key,
      name_in_camel text
    )
  `;

	await sql`insert into test (name_in_camel) values ('Murray')`;
	await sql`update test set name_in_camel = 'Rothbard'`;
	await sql`delete from test`;
	await sql`alter table test replica identity full`;
	await sql`insert into test (name_in_camel) values ('Murray')`;
	await sql`update test set name_in_camel = 'Rothbard'`;
	await sql`delete from test`;
	await until(() => result.length === 6);
	await unsubscribe();
	await sql`insert into test (name_in_camel) values ('Oh noes')`;
	await delay(50);
	expect(result).toEqual([
		["insert", "Murray", undefined],
		["update", "Rothbard", null],
		["delete", 1, undefined],
		["insert", "Murray", undefined],
		["update", "Rothbard", "Murray"],
		["delete", "Rothbard", undefined],
	]);
});

test("subscribe reconnects and calls onsubscribe", async () => {
	await using sql = postgres({
		database: options.db,
		publications: "alltables",
		fetch_types: false,
	});

	await sql.unsafe(
		"drop publication if exists alltables; create publication alltables for all tables",
	);
	await using _drop_publication = defer(() => sql`drop publication alltables`);

	const result = [],
		errors = [],
		state = () => JSON.stringify({ onsubscribes, result, errors });
	let onsubscribes = 0;

	const { unsubscribe, sql: subscribe_sql } = await sql.subscribe(
		"*",
		(row, { command, old }) => result.push([command, row.name || row.id, old && old.name]),
		() => onsubscribes++,
		(error) => errors.push(error.code || error.message),
	);

	await sql`
    create table test (
      id serial primary key,
      name text
    )
  `;

	await sql`insert into test (name) values ('Murray')`;
	await until(() => result.length === 1, 5000, state);
	await subscribe_sql.close();
	await until(() => onsubscribes === 2, 5000, state);
	await sql`delete from test`;
	await until(() => result.length === 2, 5000, state);
	await unsubscribe();
	expect([onsubscribes, result]).toEqual([
		2,
		[
			["insert", "Murray", undefined],
			["delete", 1, undefined],
		],
	]);
});

const until = async (fn, ms = 5000, state?) => {
	const start = Date.now();
	while (!fn()) {
		if (Date.now() - start > ms) {
			throw new Error("Timed out waiting for " + fn + (state ? " with " + state() : ""));
		}
		await delay(10);
	}
};

/**
 * Creates the publication alltables and the table `test (id serial primary key, name text)`, after
 * dropping the publication and the inactive postgresjs_* replication slots that an earlier test
 * may have left (tests/setup.ts drops the table `test` before each test).
 * @param slot - the name of the persistent replication slot that the pools from `replica()` use; if
 *   not given, they use temporary slots
 * @returns `sql`, a pool to change and check the table with; `replica()`, which returns a new pool
 *   for subscribing to alltables; and a disposer that drops the publication and the slot `slot`,
 *   and then ends `sql`
 */
async function replicating(slot?: string) {
	const sql = postgres({ database: options.db, publications: "alltables", max: 1 });
	await sql`drop publication if exists alltables`;
	await sql`select pg_drop_replication_slot(slot_name) from pg_replication_slots where slot_name like 'postgresjs_%' and not active`;
	await sql.unsafe("create publication alltables for all tables");
	await sql`create table test (id serial primary key, name text)`;
	return {
		sql,
		replica: () => postgres({ database: options.db, publications: "alltables", slot }),
		async [Symbol.asyncDispose]() {
			// Ends `sql` even if a drop below throws
			await using _end = sql;
			await sql`drop publication alltables`;
			if (slot) {
				await sql`select pg_drop_replication_slot(slot_name) from pg_replication_slots where slot_name = ${slot}`;
			}
		},
	};
}

test("subscribe with a persistent slot resumes where it left off", async () => {
	await using fixture = await replicating("postgresjs_resume");
	const { sql, replica } = fixture,
		seen = [];

	await using first = replica();
	await first.subscribe("insert:test", (row) => seen.push(row.name));
	await sql`insert into test (name) values ('a')`;
	await until(() => seen.length === 1);
	await first.end();

	await sql`insert into test (name) values ('b')`;
	await sql`insert into test (name) values ('c')`;

	await using second = replica();
	await second.subscribe("insert:test", (row) => seen.push(row.name));
	await until(() => seen.length === 3);
	await delay(50);
	await second.end();

	const [slot] =
		await sql`select temporary, active from pg_replication_slots where slot_name = 'postgresjs_resume'`;
	expect([seen, slot.temporary, slot.active]).toEqual([["a", "b", "c"], false, false]);
});

test("subscribe with a persistent slot runs async handlers in commit order", async () => {
	await using fixture = await replicating("postgresjs_order");
	const { sql, replica } = fixture,
		seen = [];
	await using sub = replica();

	await sub.subscribe("insert:test", async (row) => {
		await delay(Math.random() * 20);
		seen.push(row.id);
	});
	for (let i = 0; i < 10; i++) {
		await sql`insert into test (name) values (${"x" + i})`;
	}
	await until(() => seen.length === 10);
	expect(seen).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
});

test("subscribe with a persistent slot delivers a failed transaction again", async () => {
	await using fixture = await replicating("postgresjs_retry");
	const { sql, replica } = fixture,
		seen = [],
		errors = [];
	await using sub = replica();
	let fails = 1;

	await sub.subscribe(
		"insert:test",
		async (row) => {
			seen.push(row.name);
			if (row.name === "a" && fails-- > 0) {
				throw new Error("not yet");
			}
		},
		() => {},
		(error) => errors.push(error.message),
	);
	await sql`insert into test (name) values ('a')`;
	await sql`insert into test (name) values ('b')`;
	await until(() => seen.join() === "a,a,b", 6000);
	await delay(50);
	expect([seen, errors]).toEqual([["a", "a", "b"], ["not yet"]]);
});

test("subscribe confirms the slot only as far as handlers have finished", async () => {
	await using fixture = await replicating("postgresjs_confirm");
	const { sql, replica } = fixture;
	await using sub = replica();
	let release,
		calls = 0;
	const blocked = new Promise((r) => (release = r));

	await sub.subscribe("insert:test", () => (calls++, blocked));
	const [{ lsn: before }] = await sql`select pg_current_wal_lsn() as lsn`;
	await sql`insert into test (name) values ('a')`;
	await until(() => calls === 1);
	await delay(100);
	const [{ held }] = await sql`
    select confirmed_flush_lsn <= ${before}::pg_lsn as held from pg_replication_slots where slot_name = 'postgresjs_confirm'
  `;
	release();
	await delay(100);
	await sub.end();
	const [{ moved }] = await sql`
    select confirmed_flush_lsn > ${before}::pg_lsn as moved from pg_replication_slots where slot_name = 'postgresjs_confirm'
  `;
	expect([held, moved]).toEqual([true, true]);
});

test("subscribe gets truncate and the transaction of each change", async () => {
	await using fixture = await replicating();
	const { sql } = fixture,
		seen = [];
	await using sub = postgres({ database: options.db, publications: "alltables" });

	await sub.subscribe("*:test", (row, info) => seen.push(info));
	await sql`insert into test (name) values ('a')`;
	await sql`truncate test restart identity`;
	await until(() => seen.length === 2);
	const [insert, truncate] = seen;
	expect([
		insert.command,
		truncate.command,
		truncate.relation.table,
		truncate.restartIdentity,
		insert.lsn,
		insert.time,
		insert.xid,
	]).toEqual([
		"insert",
		"truncate",
		"test",
		true,
		expect.stringMatching(/^[0-9A-F]+\/[0-9A-F]+$/),
		expect.any(Date),
		expect.any(Number),
	]);
});

test("subscribe with a persistent slot reconnects after the server ends it, without loss or repeats", async () => {
	await using fixture = await replicating("postgresjs_reconnect");
	const { sql, replica } = fixture,
		seen = [];
	await using sub = replica();
	let subscribed = 0;

	await sub.subscribe(
		"insert:test",
		(row) => seen.push(row.name),
		() => subscribed++,
		() => {},
	);
	await sql`insert into test (name) values ('a')`;
	await until(() => seen.length === 1);
	await delay(100);
	await sql`select pg_terminate_backend(active_pid) from pg_replication_slots where slot_name = 'postgresjs_reconnect'`;
	await sql`insert into test (name) values ('b')`;
	await until(() => seen.length >= 2, 6000);
	await delay(100);
	expect([seen, subscribed]).toEqual([["a", "b"], 2]);
});

test("subscribe does not pile up listeners across reconnects (#1087)", async () => {
	const until = async (fn) => {
		while (!fn()) {
			await delay(20);
		}
	};
	await using sql = postgres({
		database: options.db,
		publications: "alltables",
		fetch_types: false,
	});
	await sql.unsafe(
		"drop publication if exists alltables; create publication alltables for all tables",
	);
	await using _drop_publication = defer(() => sql`drop publication alltables`);
	await sql`create table test (id serial primary key, name text)`;

	const warnings = [],
		onwarning = (x) => warnings.push(x.name),
		result = [];
	const seen = { subscribes: 0 };
	process.on("warning", onwarning);
	onTestFinished(() => {
		process.off("warning", onwarning);
	});

	const { unsubscribe, sql: subscribe_sql } = await sql.subscribe(
		"insert:test",
		(row) => result.push(row.name),
		() => seen.subscribes++,
		() => {},
	);

	for (let i = 1; i <= 12; i++) {
		const before = seen.subscribes;
		await subscribe_sql.close();
		await until(() => seen.subscribes !== before);
	}

	await sql`insert into test (name) values ('after')`;
	await until(() => result.length);
	await unsubscribe();
	expect([seen.subscribes, result, warnings]).toEqual([13, ["after"], []]);
}, 20_000);

test("subscribe parses custom array types and domains like queries do", async () => {
	await using sql = postgres({
		database: options.db,
		publications: "custom_types_pub",
	});

	await sql.unsafe(`
    create type subscribe_mood as enum ('a', 'b');
    create domain subscribe_positive as int check (value > 0);
    create table test (id serial primary key, moods subscribe_mood[], p subscribe_positive);
    create publication custom_types_pub for table test
  `);
	await using _drop = defer(() =>
		sql.unsafe(
			"drop publication custom_types_pub; drop table test; drop type subscribe_mood; drop domain subscribe_positive",
		),
	);

	const result = [];
	const { unsubscribe } = await sql.subscribe("insert:test", (row) => result.push(row));
	await sql`insert into test (moods, p) values ('{a,b}', 5)`;
	const [queried] = await sql`select moods, p from test`;
	await until(() => result.length);
	await unsubscribe();
	expect([result, queried]).toEqual([
		[{ id: 1, moods: ["a", "b"], p: 5 }],
		{ moods: ["a", "b"], p: 5 },
	]);
});

test("subscribe without publications rejects each time it is called", async () => {
	await using sql = postgres({ database: options.db, publications: "" });
	const errors = await Promise.all(
		[1, 2].map(() => sql.subscribe("*", () => {}).catch((e) => e.message)),
	);
	expect(errors).toEqual(["Missing publication names", "Missing publication names"]);
});

test("subscribe calls every handler of an event, until each unsubscribes", async () => {
	await using fixture = await replicating();
	const { sql } = fixture,
		seen = [];
	await using sub = postgres({ database: options.db, publications: "alltables" });

	const a = await sub.subscribe("insert:test", (row) => seen.push("a" + row.id));
	await sub.subscribe("insert:test", (row) => seen.push("b" + row.id));
	await sql`insert into test (name) values ('x')`;
	await until(() => seen.length === 2);
	a.unsubscribe();
	await sql`insert into test (name) values ('y')`;
	await until(() => seen.length === 3);
	await delay(50);
	expect(seen).toEqual(["a1", "b1", "b2"]);
});

/** The message of the error that the last console.error (when stubbed by a test below) logged */
let logged;

/**
 * Subscribe, make the subscription's next connection fail once (its user function throws), and insert
 * a row once it has connected again.
 * @param onerror - whether the subscription has an onerror; without one, the error is logged
 * @returns the names of the rows that the subscription saw, and the message of the error that it
 * gave to onerror or logged
 */
async function failing(onerror) {
	await using fixture = await replicating();
	const { sql } = fixture,
		{ user } = sql.options,
		seen = [],
		errors = [];
	let fail = false,
		subscribes = 0;

	await using sub = postgres({
		database: options.db,
		publications: "alltables",
		user: () => {
			if (fail) {
				throw new Error("no user now");
			}

			return user;
		},
	});

	const { sql: replication } = await sub.subscribe(
		"insert:test",
		(row) => seen.push(row.name),
		() => subscribes++,
		onerror && ((error) => errors.push(error.message)),
	);
	fail = true;
	await replication.close();
	await until(() => (onerror ? errors.length : logged));
	fail = false;
	await until(() => subscribes === 2);
	await sql`insert into test (name) values ('after')`;
	await until(() => seen.length);
	return [seen, errors[0] || logged];
}

test("subscribe reports a failed reconnect to onerror and retries", async () => {
	expect(await failing(true)).toEqual([["after"], "no user now"]);
});

test("subscribe logs a failed reconnect when no subscription has onerror", async () => {
	const error = console.error;
	logged = undefined;
	console.error = (...xs) => (logged = xs[1] && xs[1].message);
	onTestFinished(() => {
		console.error = error;
	});
	expect(await failing(false)).toEqual([["after"], "no user now"]);
});

test("subscribe confirms its position to the server on an interval", async () => {
	await using fixture = await replicating();
	const { sql } = fixture;
	await using sub = postgres({
		database: options.db,
		publications: "alltables",
		timers: {
			...sql.options.timers,
			setTimeout: (fn, ms) => setTimeout(fn, ms === 10000 ? 50 : ms),
		},
	});
	const seen = [];
	// The start of the commit record of the inserted row's transaction
	let commit_lsn;

	const { state } = await sub.subscribe("insert:test", (row, info) => {
		seen.push(row.name);
		commit_lsn = info.lsn;
	});
	await sql`insert into test (name) values ('a')`;
	await until(() => seen.length);
	await delay(200);
	// confirmed_flush_lsn is always the end of a WAL record, so a confirmed_flush_lsn past the
	// start of the commit record is at or past the end of the commit record
	const [{ confirmed }] = await sql`
    select confirmed_flush_lsn > ${commit_lsn}::pg_lsn as confirmed from pg_replication_slots
    where active_pid = ${state.pid}
  `;
	expect([seen, confirmed]).toEqual([["a"], true]);
});

test("subscribe gives unchanged TOAST values as undefined, transforms values and reports a throwing handler", async () => {
	await using fixture = await replicating();
	const { sql } = fixture,
		seen = [],
		errors = [];
	await using sub = postgres({
		database: options.db,
		publications: "alltables",
		transform: {
			value: { from: (x, column) => (column.name === "name" && x ? x.toUpperCase() : x) },
		},
	});

	await sql`alter table test add column big text`;
	await sub.subscribe("update:test", (row) => seen.push([row.name, typeof row.big]));
	await sub.subscribe(
		"update:test",
		() => {
			throw new Error("sync");
		},
		() => {},
		(e) => errors.push(e.message),
	);
	await sql`insert into test (name, big) values ('a', (select string_agg(md5(random()::text), '') from generate_series(1, 1000)))`;
	await sql`update test set name = 'b'`;
	await until(() => seen.length && errors.length);
	expect([seen, errors]).toEqual([[["B", "undefined"]], ["sync"]]);
}, 30_000);

test("subscribe gives a column named __proto__ as an own property of the row", async () => {
	await using fixture = await replicating();
	const { sql } = fixture,
		seen = [];
	await using sub = postgres({ database: options.db, publications: "alltables" });

	await sql`alter table test add column "__proto__" json`;
	await sub.subscribe("insert:test", (row) => seen.push(row));
	await sql`insert into test (name, "__proto__") values ('a', '{"isAdmin": true}')`;
	await until(() => seen.length);
	const [row] = seen,
		own = Object.getOwnPropertyDescriptor(row, "__proto__");
	expect([
		typeof row.isAdmin,
		Object.getPrototypeOf(row) === Object.prototype,
		own.value.isAdmin,
	]).toEqual(["undefined", true, true]);
});
