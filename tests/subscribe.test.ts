import { expect, test } from "vitest";
import { postgres, options, delay, camel_case, snake_case } from "./setup.ts";

test("subscribe", async () => {
	const sql = postgres({
		database: options.db,
		publications: "alltables",
	});

	await sql.unsafe(
		"drop publication if exists alltables; create publication alltables for all tables",
	);

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
	try {
		expect(result).toEqual([
			["insert", "Murray", 1, undefined, undefined],
			["update", "Rothbard", 1, null, null],
			["update", "Rothbard", 2, null, 1],
			["delete", null, 2, undefined, undefined],
			["insert", "Murray", 2, undefined, undefined],
			["update", "Rothbard", 2, "Murray", 2],
			["delete", "Rothbard", 2, undefined, undefined],
		]);
	} finally {
		await sql`drop table test`;
		await sql`drop publication alltables`;
		await sql.end();
	}
});

test("subscribe with transform", async () => {
	const sql = postgres({
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
	try {
		expect(result).toEqual([
			["insert", "Murray", undefined],
			["update", "Rothbard", null],
			["delete", 1, undefined],
			["insert", "Murray", undefined],
			["update", "Rothbard", "Murray"],
			["delete", "Rothbard", undefined],
		]);
	} finally {
		await sql`drop table test`;
		await sql`drop publication alltables`;
		await sql.end();
	}
});

test("subscribe reconnects and calls onsubscribe", async () => {
	const sql = postgres({
		database: options.db,
		publications: "alltables",
		fetch_types: false,
	});

	await sql.unsafe(
		"drop publication if exists alltables; create publication alltables for all tables",
	);

	const result = [],
		errors = [],
		state = () => JSON.stringify({ onsubscribes, result, errors });
	let onsubscribes = 0;

	const { unsubscribe, sql: subscribeSql } = await sql.subscribe(
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
	await subscribeSql.close();
	await until(() => onsubscribes === 2, 5000, state);
	await sql`delete from test`;
	await until(() => result.length === 2, 5000, state);
	await unsubscribe();
	try {
		expect([onsubscribes, result]).toEqual([
			2,
			[
				["insert", "Murray", undefined],
				["delete", 1, undefined],
			],
		]);
	} finally {
		await sql`drop table test`;
		await sql`drop publication alltables`;
		await sql.end();
	}
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

async function replicating(name?) {
	const sql = postgres({ database: options.db, publications: "alltables", max: 1 });
	await sql`drop table if exists test`;
	await sql`drop publication if exists alltables`;
	await sql`select pg_drop_replication_slot(slot_name) from pg_replication_slots where slot_name like 'postgresjs_%' and not active`;
	await sql.unsafe("create publication alltables for all tables");
	await sql`create table test (id serial primary key, name text)`;
	return {
		sql,
		async done(...slots) {
			await sql`drop table test`;
			await sql`drop publication alltables`;
			for (const slot of slots) {
				await sql`select pg_drop_replication_slot(slot_name) from pg_replication_slots where slot_name = ${slot}`;
			}
			await sql.end();
		},
		replica: () => postgres({ database: options.db, publications: "alltables", slot: name }),
	};
}

test(
	"subscribe with a persistent slot resumes where it left off",
	async () => {
		const { sql, done, replica } = await replicating("postgresjs_resume"),
			seen = [];

		const first = replica();
		await first.subscribe("insert:test", (row) => seen.push(row.name));
		await sql`insert into test (name) values ('a')`;
		await until(() => seen.length === 1);
		await first.end();

		await sql`insert into test (name) values ('b')`;
		await sql`insert into test (name) values ('c')`;

		const second = replica();
		await second.subscribe("insert:test", (row) => seen.push(row.name));
		await until(() => seen.length === 3);
		await delay(50);
		await second.end();

		const [slot] =
			await sql`select temporary, active from pg_replication_slots where slot_name = 'postgresjs_resume'`;
		try {
			expect([seen, slot.temporary, slot.active]).toEqual([["a", "b", "c"], false, false]);
		} finally {
			await done("postgresjs_resume");
		}
	},
);

test(
	"subscribe with a persistent slot runs async handlers in commit order",
	async () => {
		const { sql, done, replica } = await replicating("postgresjs_order"),
			seen = [],
			sub = replica();

		await sub.subscribe("insert:test", async (row) => {
			await delay(Math.random() * 20);
			seen.push(row.id);
		});
		for (let i = 0; i < 10; i++) {
			await sql`insert into test (name) values (${"x" + i})`;
		}
		await until(() => seen.length === 10);
		await sub.end();
		try {
			expect(seen).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
		} finally {
			await done("postgresjs_order");
		}
	},
);

test(
	"subscribe with a persistent slot delivers a failed transaction again",
	async () => {
		const { sql, done, replica } = await replicating("postgresjs_retry"),
			seen = [],
			errors = [],
			sub = replica();
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
		await sub.end();
		try {
			expect([seen, errors]).toEqual([["a", "a", "b"], ["not yet"]]);
		} finally {
			await done("postgresjs_retry");
		}
	},
);

test(
	"subscribe confirms the slot only as far as handlers have finished",
	async () => {
		const { sql, done, replica } = await replicating("postgresjs_confirm"),
			sub = replica();
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
		try {
			expect([held, moved]).toEqual([true, true]);
		} finally {
			await done("postgresjs_confirm");
		}
	},
);

test(
	"subscribe gets truncate and the transaction of each change",
	async () => {
		const { sql, done } = await replicating(),
			seen = [],
			sub = postgres({ database: options.db, publications: "alltables" });

		await sub.subscribe("*:test", (row, info) => seen.push(info));
		await sql`insert into test (name) values ('a')`;
		await sql`truncate test restart identity`;
		await until(() => seen.length === 2);
		await sub.end();
		const [insert, truncate] = seen;
		try {
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
		} finally {
			await done();
		}
	},
);

test(
	"subscribe with a persistent slot reconnects after the server ends it, without loss or repeats",
	async () => {
		const { sql, done, replica } = await replicating("postgresjs_reconnect"),
			seen = [],
			sub = replica();
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
		await sub.end();
		try {
			expect([seen, subscribed]).toEqual([["a", "b"], 2]);
		} finally {
			await done("postgresjs_reconnect");
		}
	},
);

test(
	"subscribe does not pile up listeners across reconnects (#1087)",
	async () => {
		const until = async (fn) => {
			while (!fn()) {
				await delay(20);
			}
		};
		const sql = postgres({
			database: options.db,
			publications: "alltables",
			fetch_types: false,
		});
		await sql.unsafe(
			"drop publication if exists alltables; create publication alltables for all tables",
		);
		await sql`create table test (id serial primary key, name text)`;

		const warnings = [],
			onwarning = (x) => warnings.push(x.name),
			result = [];
		const seen = { subscribes: 0 };
		process.on("warning", onwarning);

		const { unsubscribe, sql: subscribeSql } = await sql.subscribe(
			"insert:test",
			(row) => result.push(row.name),
			() => seen.subscribes++,
			() => {},
		);

		for (let i = 1; i <= 12; i++) {
			const before = seen.subscribes;
			await subscribeSql.close();
			await until(() => seen.subscribes !== before);
		}

		await sql`insert into test (name) values ('after')`;
		await until(() => result.length);
		await unsubscribe();
		process.off("warning", onwarning);

		try {
			expect([seen.subscribes, result, warnings]).toEqual([13, ["after"], []]);
		} finally {
			await sql`drop table test`;
			await sql`drop publication alltables`;
			await sql.end();
		}
	},
	20_000,
);

test(
	"subscribe parses custom array types and domains like queries do",
	async () => {
		const sql = postgres({
			database: options.db,
			publications: "custom_types_pub",
		});

		await sql.unsafe(`
    create type subscribe_mood as enum ('a', 'b');
    create domain subscribe_positive as int check (value > 0);
    create table test (id serial primary key, moods subscribe_mood[], p subscribe_positive);
    create publication custom_types_pub for table test
  `);

		const result = [];
		const { unsubscribe } = await sql.subscribe("insert:test", (row) => result.push(row));
		await sql`insert into test (moods, p) values ('{a,b}', 5)`;
		const [queried] = await sql`select moods, p from test`;
		await until(() => result.length);
		await unsubscribe();

		try {
			expect([result, queried]).toEqual([
				[{ id: 1, moods: ["a", "b"], p: 5 }],
				{ moods: ["a", "b"], p: 5 },
			]);
		} finally {
			await sql.unsafe(
				"drop publication custom_types_pub; drop table test; drop type subscribe_mood; drop domain subscribe_positive",
			);
			await sql.end();
		}
	},
);

test("subscribe without publications rejects each time it is called", async () => {
	const sql = postgres({ database: options.db, publications: "" });
	const errors = await Promise.all(
		[1, 2].map(() => sql.subscribe("*", () => {}).catch((e) => e.message)),
	);
	expect(errors).toEqual(["Missing publication names", "Missing publication names"]);
	await sql.end();
});

test(
	"subscribe calls every handler of an event, until each unsubscribes",
	async () => {
		const { sql, done } = await replicating(),
			sub = postgres({ database: options.db, publications: "alltables" }),
			seen = [];

		const a = await sub.subscribe("insert:test", (row) => seen.push("a" + row.id));
		await sub.subscribe("insert:test", (row) => seen.push("b" + row.id));
		await sql`insert into test (name) values ('x')`;
		await until(() => seen.length === 2);
		a.unsubscribe();
		await sql`insert into test (name) values ('y')`;
		await until(() => seen.length === 3);
		await delay(50);
		await sub.end();
		try {
			expect(seen).toEqual(["a1", "b1", "b2"]);
		} finally {
			await done();
		}
	},
);

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
	const { sql, done } = await replicating(),
		{ user } = sql.options,
		seen = [],
		errors = [];
	let fail = false,
		subscribes = 0;

	const sub = postgres({
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
	await sub.end();
	await done();
	return [seen, errors[0] || logged];
}

test(
	"subscribe reports a failed reconnect to onerror and retries",
	async () => {
		expect(await failing(true)).toEqual([["after"], "no user now"]);
	},
);

test(
	"subscribe logs a failed reconnect when no subscription has onerror",
	async () => {
		const error = console.error;
		logged = undefined;
		console.error = (...xs) => (logged = xs[1] && xs[1].message);
		try {
			expect(await failing(false)).toEqual([["after"], "no user now"]);
		} finally {
			console.error = error;
		}
	},
);

test(
	"subscribe confirms its position to the server on an interval",
	async () => {
		const { sql, done } = await replicating();
		const sub = postgres({
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
		await sub.end();
		try {
			expect([seen, confirmed]).toEqual([["a"], true]);
		} finally {
			await done();
		}
	},
);

test(
	"subscribe gives unchanged TOAST values as undefined, transforms values and reports a throwing handler",
	async () => {
		const { sql, done } = await replicating(),
			seen = [],
			errors = [],
			sub = postgres({
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
		await sub.end();
		try {
			expect([seen, errors]).toEqual([[["B", "undefined"]], ["sync"]]);
		} finally {
			await done();
		}
	},
	30_000,
);

test(
	"subscribe gives a column named __proto__ as an own property of the row",
	async () => {
		const { sql, done } = await replicating(),
			sub = postgres({ database: options.db, publications: "alltables" }),
			seen = [];

		await sql`alter table test add column "__proto__" json`;
		await sub.subscribe("insert:test", (row) => seen.push(row));
		await sql`insert into test (name, "__proto__") values ('a', '{"isAdmin": true}')`;
		await until(() => seen.length);
		await sub.end();
		const [row] = seen,
			own = Object.getOwnPropertyDescriptor(row, "__proto__");
		try {
			expect([
				typeof row.isAdmin,
				Object.getPrototypeOf(row) === Object.prototype,
				own.value.isAdmin,
			]).toEqual(["undefined", true, true]);
		} finally {
			await done();
		}
	},
);
