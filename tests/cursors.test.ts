import { expect, test } from "vitest";
import { postgres, sql, options, delay } from "./setup.ts";

test("forEach", async () => {
	let result;
	await sql`select 1 as x`.forEach(({ x }) => (result = x));
	expect(result).toBe(1);
});

test("forEach returns empty array", async () => {
	expect((await sql`select 1 as x`.forEach(() => {})).length).toBe(0);
});

test("Cursor", async () => {
	const order = [];
	await sql`select 1 as x union select 2 as x`.cursor(async ([x]) => {
		order.push(x.x + "a");
		await delay(100);
		order.push(x.x + "b");
	});
	expect(order).toEqual(["1a", "1b", "2a", "2b"]);
});

test("Unsafe cursor", async () => {
	const order = [];
	await sql.unsafe("select 1 as x union select 2 as x").cursor(async ([x]) => {
		order.push(x.x + "a");
		await delay(100);
		order.push(x.x + "b");
	});
	expect(order).toEqual(["1a", "1b", "2a", "2b"]);
});

test("Cursor custom n", async () => {
	const order = [];
	await sql`select * from generate_series(1,20)`.cursor(10, async (x) => {
		order.push(x.length);
	});
	expect(order).toEqual([10, 10]);
});

test("Cursor custom with rest n", async () => {
	const order = [];
	await sql`select * from generate_series(1,20)`.cursor(11, async (x) => {
		order.push(x.length);
	});
	expect(order).toEqual([11, 9]);
});

test("Cursor custom with less results than batch size", async () => {
	const order = [];
	await sql`select * from generate_series(1,20)`.cursor(21, async (x) => {
		order.push(x.length);
	});
	expect(order).toEqual([20]);
});

test("Cursor cancel", async () => {
	let result;
	await sql`select * from generate_series(1,10) as x`.cursor(async ([{ x }]) => {
		result = x;
		return sql.CLOSE;
	});
	expect(result).toBe(1);
});

test("Cursor throw", async () => {
	const order = [];
	await sql`select 1 as x union select 2 as x`
		.cursor(async ([x]) => {
			order.push(x.x + "a");
			await delay(100);
			throw new Error("watty");
		})
		.catch(() => order.push("err"));
	expect(order).toEqual(["1a", "err"]);
});

test("Cursor error", async () => {
	expect(await sql`wat`.cursor(() => {}).catch((err) => err.code)).toBe("42601");
});

test("Multiple Cursors", async () => {
	const result = [];
	await sql.begin(async (sql) => [
		await sql`select 1 as cursor, x from generate_series(1,4) as x`.cursor(async ([row]) => {
			result.push(row.x);
			await new Promise((r) => setTimeout(r, 20));
		}),
		await sql`select 2 as cursor, x from generate_series(101,104) as x`.cursor(async ([row]) => {
			result.push(row.x);
			await new Promise((r) => setTimeout(r, 10));
		}),
	]);

	expect(result).toEqual([1, 2, 3, 4, 101, 102, 103, 104]);
});

test("Cursor as async iterator", async () => {
	const order = [];
	for await (const [x] of sql`select generate_series(1,2) as x;`.cursor()) {
		order.push(x.x + "a");
		await delay(10);
		order.push(x.x + "b");
	}

	expect(order).toEqual(["1a", "1b", "2a", "2b"]);
});

test("Cursor as async iterator with break", async () => {
	const order = [];
	for await (const xs of sql`select generate_series(1,2) as x;`.cursor()) {
		order.push(xs[0].x + "a");
		await delay(10);
		order.push(xs[0].x + "b");
		break;
	}

	expect(order).toEqual(["1a", "1b"]);
});

test("Async Iterator Unsafe cursor", async () => {
	const order = [];
	for await (const [x] of sql.unsafe("select 1 as x union select 2 as x").cursor()) {
		order.push(x.x + "a");
		await delay(10);
		order.push(x.x + "b");
	}
	expect(order).toEqual(["1a", "1b", "2a", "2b"]);
});

test("Async Iterator Cursor custom n", async () => {
	const order = [];
	for await (const x of sql`select * from generate_series(1,20)`.cursor(10)) {
		order.push(x.length);
	}

	expect(order).toEqual([10, 10]);
});

test("Async Iterator Cursor custom with rest n", async () => {
	const order = [];
	for await (const x of sql`select * from generate_series(1,20)`.cursor(11)) {
		order.push(x.length);
	}

	expect(order).toEqual([11, 9]);
});

test("Async Iterator Cursor custom with less results than batch size", async () => {
	const order = [];
	for await (const x of sql`select * from generate_series(1,20)`.cursor(21)) {
		order.push(x.length);
	}
	expect(order).toEqual([20]);
});

test("forEach has result as second argument", async () => {
	let x;
	await sql`select 1 as x`.forEach((_, result) => (x = result));
	expect(x.columns[0].name).toBe("x");
});

test("concurrent cursors", async () => {
	const xs = [];

	await Promise.all(
		[...Array(7)]
			.map((x, i) => [
				sql`select ${i}::int as a, generate_series(1, 2) as x`.cursor(([x]) => xs.push(x.a + x.x)),
			])
			.flat(),
	);

	expect(xs).toEqual([1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8]);
});

test("concurrent cursors multiple connections", async () => {
	const sql = postgres({ ...options, max: 2 });
	const xs = [];

	await Promise.all(
		[...Array(7)]
			.map((x, i) => [
				sql`select ${i}::int as a, generate_series(1, 2) as x`.cursor(([x]) => xs.push(x.a + x.x)),
			])
			.flat(),
	);

	expect(xs.sort((a, b) => a - b)).toEqual([1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8]);
});

test("Async iterator cursor surfaces an error arriving between batches", async () => {
	const iterator = sql`select 1 / (3 - x) as x from generate_series(1, 5) as x`
		.cursor(1)
		[Symbol.asyncIterator]();
	await iterator.next();
	const code = await iterator
		.next()
		.then(() => iterator.next())
		.then(
			() => "no error",
			(e) => e.code,
		);
	await iterator.return();
	expect(code).toBe("22012");
});

test(
	"A cursor in a transaction that resumes while another query waits on its description gives each its own answer",
	async () => {
		const sql = postgres(options);
		const out = [];
		await sql.begin(async (sql) => {
			let release;
			const batches = [];
			const cursor = sql`select generate_series(1, 6) as x`.cursor(2, (rows) => {
				batches.push(rows.map((r) => r.x));
				return new Promise((r) => (release = r));
			});
			const done = cursor.then(() => batches),
				until = async (fn) => {
					while (!fn()) {
						await delay(5);
					}
				},
				next = async () => {
					const before = release;
					before();
					await until(() => release !== before || batches.length === 3);
				};
			await until(() => release);
			const q = sql`select ${"value"}::text as a, ${Math.random()}::float8 as cursor_order_shape`;
			q.catch(() => {});
			for (let i = 0; i < 10; i++) {
				await Promise.resolve();
			}
			await next();
			await next();
			release();
			out.push((await q)[0].a, await done);
		});
		expect(out).toEqual([
			"value",
			[
				[1, 2],
				[3, 4],
				[5, 6],
			],
		]);
		await sql.end();
	},
);

test(
	"A cursor on a reserved connection keeps its rows from a query made while it runs",
	async () => {
		const sql = postgres(options);
		const reserved = await sql.reserve();
		const batches = [];
		const cursor = reserved`select generate_series(1, 6) as x`.cursor(2, async (rows) => {
			batches.push(rows.map((r) => r.x));
			await delay(50);
		});
		cursor.catch(() => {});
		while (!batches.length) {
			await delay(2);
		}
		const [{ a }] = await reserved`select 'q1' as a`;
		await cursor;
		reserved.release();
		expect([a, batches]).toEqual([
			"q1",
			[
				[1, 2],
				[3, 4],
				[5, 6],
			],
		]);
		await sql.end();
	},
);

test(
	"A cursor that outlives its transaction is rejected instead of running in the next one",
	async () => {
		const sql = postgres({ ...options, max: 1 });
		await sql`create table test (a int)`;
		let cursor;
		const first = await sql
			.begin((sql) => {
				cursor = sql`select generate_series(1, 6) as x`.cursor(2, () => delay(100));
				return Promise.all([cursor, sql`select 1/0`]);
			})
			.catch((e) => e.code);
		const second = await sql
			.begin(async (sql) => {
				await sql`insert into test values (1)`;
				await delay(300);
				await sql`insert into test values (2)`;
				return "committed";
			})
			.catch((e) => e.code);
		const outlived = await cursor.catch((e) => e.code);
		const [{ n }] = await sql`select count(*)::int as n from test`;
		expect([first, second, n, outlived !== undefined]).toEqual(["22012", "committed", 2, true]);
		await sql`drop table test`;
		await sql.end();
	},
);

test("A pool cursor whose parameter serializer returns a number rejects and frees the connection", async () => {
	const sql = postgres({
		...options,
		max: 1,
		types: { ms: { to: 20, from: [], serialize: (x) => x.getTime() } },
	});
	const run = () =>
		sql`select ${sql.types.ms(new Date(0))}::int8 as x`
			.cursor(10, () => {})
			.then(
				() => "ok",
				(e) => e.name,
			);
	expect([await run(), await run(), (await sql`select 1 as x`)[0].x]).toEqual([
		"TypeError",
		"TypeError",
		1,
	]);
	await sql.end();
});

test("A transaction waits for a cursor it did not await before it commits", async () => {
	const batches = [];
	let cursor;
	await sql.begin(async (sql) => {
		cursor = sql`select generate_series(1, 4) as x`.cursor(1, async ([row]) => {
			batches.push(row.x);
			await delay(20);
		});
		cursor.catch(() => {});
		await delay(10);
	});
	expect([
		await cursor.then(
			() => "ok",
			(e) => e.code,
		),
		batches,
	]).toEqual(["ok", [1, 2, 3, 4]]);
});

test("A transaction that returns right after starting a cursor still lets the cursor finish", async () => {
	const batches = [];
	let cursor;
	await sql.begin((sql) => {
		cursor = sql`select generate_series(1, 3) as x`.cursor(1, ([row]) => {
			batches.push(row.x);
		});
		cursor.catch(() => {});
	});
	expect([
		await cursor.then(
			() => "ok",
			(e) => e.code,
		),
		batches,
	]).toEqual(["ok", [1, 2, 3]]);
});

test("A pool cursor whose callback throws on the last batch rejects and frees the connection", async () => {
	const sql = postgres({ ...options, max: 1 });
	const error = await sql`select generate_series(1, 3) as x`
		.cursor(2, (rows) => {
			if (rows[0].x === 3) {
				throw new Error("last");
			}
		})
		.then(
			() => "resolved",
			(e) => e.message,
		);
	expect([error, (await sql`select 1 as x`)[0].x]).toEqual(["last", 1]);
	await sql.end();
});

test("A pool cursor whose column parser throws rejects and frees the connection", async () => {
	const sql = postgres({
		...options,
		max: 1,
		types: {
			bad: {
				to: 0,
				from: [23],
				parse: (x) => {
					if (x === "3") {
						throw new Error("parser");
					}
					return +x;
				},
			},
		},
	});
	const error = await sql`select generate_series(1, 6)::int as x`
		.cursor(2, () => {})
		.then(
			() => "resolved",
			(e) => e.message,
		);
	expect([error, (await sql`select 1 as x`)[0].x]).toEqual(["parser", 1]);
	await sql.end();
});

test("A reserved cursor whose callback throws on the last batch rejects and leaves the connection usable", async () => {
	const sql = postgres({ ...options, max: 1 });
	const reserved = await sql.reserve();
	const error = await reserved`select generate_series(1, 3) as x`
		.cursor(2, (rows) => {
			if (rows[0].x === 3) {
				throw new Error("last");
			}
		})
		.then(
			() => "resolved",
			(e) => e.message,
		);
	const [{ x }] = await reserved`select 1 as x`;
	reserved.release();
	expect([error, x]).toEqual(["last", 1]);
	await sql.end();
});

async function outlives(fn) {
	const sql = postgres({ ...options, max: 1 });
	let cursor;
	await sql
		.begin((sql) => {
			cursor = sql`select generate_series(1, 6) as x`.cursor(2, () =>
				delay(100).then(() => fn(sql)),
			);
			return Promise.all([cursor, sql`select 1/0`]);
		})
		.catch(() => {});
	const second = await sql.begin(async () => (await delay(300), "committed"));
	const outcome = await cursor.then(
		(x) => "resolved " + x.length,
		(e) => e.code || e.message,
	);
	return [second, outcome, await sql.end()];
}

test(
	"A cursor that throws in its failed transaction rejects with its own error, and the next transaction commits",
	async () => {
		const [second, outcome] = await outlives(() => {
			throw new Error("late");
		});
		expect([second, outcome]).toEqual(["committed", "late"]);
	},
);

test(
	"A cursor that closes in its failed transaction rejects with 25P02, and the next transaction commits",
	async () => {
		const [second, outcome] = await outlives((sql) => sql.CLOSE);
		expect([second, outcome]).toEqual(["committed", "25P02"]);
	},
);

/**
 * Run a cursor that aborts its own query from its first callback.
 * @param sql - the sql to run the query on: the pool, a reserved connection, or a transaction
 * @param how - "signal" to abort through an AbortSignal, or "cancel" to call query.cancel()
 * @returns the cursor's outcome ("resolved", or the code it rejected with), and how many times its
 * callback ran
 */
async function aborted(sql, how) {
	const controller = new AbortController(),
		query = sql`select generate_series(1, 10) as x`;
	let calls = 0;
	if (how === "signal") {
		query.signal(controller.signal);
	}
	const outcome = await query
		.cursor(2, async () => {
			calls++;
			if (how === "signal") {
				controller.abort();
			} else {
				query.cancel();
			}
			await delay(20);
		})
		.then(
			() => "resolved",
			(e) => e.code,
		);
	return [outcome, calls];
}

test("Aborting a pool cursor while its callback runs stops it with 57014", async () => {
	const sql = postgres({ ...options, max: 1 });
	const outcomes = [
		await aborted(sql, "signal"),
		await aborted(sql, "cancel"),
		(await sql`select 1 as x`)[0].x,
	];
	expect(outcomes).toEqual([["57014", 1], ["57014", 1], 1]);
	await sql.end();
});

test("Cancelling a reserved cursor while its callback runs stops it with 57014", async () => {
	const sql = postgres({ ...options, max: 1 }),
		reserved = await sql.reserve();
	const outcome = await aborted(reserved, "cancel"),
		[{ x }] = await reserved`select 1 as x`;
	reserved.release();
	expect([outcome, x]).toEqual([["57014", 1], 1]);
	await sql.end();
});

test("Aborting a cursor in a transaction stops it with 57014, which rejects the transaction", async () => {
	const sql = postgres({ ...options, max: 1 });
	let inside;
	const outcome = await sql
		.begin(async (sql) => (inside = await aborted(sql, "signal")))
		.catch((e) => e.code);
	expect([inside, outcome]).toEqual([["57014", 1], "57014"]);
	await sql.end();
});

test("Aborting a cursor used as an async iterator stops it with 57014", async () => {
	const controller = new AbortController();
	let batches = 0,
		outcome = "done";
	try {
		for await (const rows of sql`select generate_series(1, 10) as x`
			.signal(controller.signal)
			.cursor(2)) {
			batches += rows.length / 2;
			controller.abort();
		}
	} catch (e) {
		outcome = e.code;
	}
	expect([outcome, batches]).toEqual(["57014", 1]);
});

test("A cursor waits for the callback of its last batch, and rejects if it does", async () => {
	const sql = postgres({ ...options, max: 1 }),
		/**
		 * Run a cursor over two batches, [1, 2] and [3], whose callback waits a little for each.
		 * @param sql - the sql to run the query on: the pool or a reserved connection
		 * @param fail - whether the callback throws for the last batch
		 * @returns the first x of each batch that the callback got, and the cursor's outcome
		 * ("resolved", or the message of the error it rejected with)
		 */
		last = async (sql, fail?) => {
			const seen = [];
			const outcome = await sql`select generate_series(1, 3) as x`
				.cursor(2, async (rows) => {
					await delay(20);
					seen.push(rows[0].x);
					if (fail && rows[0].x === 3) {
						throw new Error("last");
					}
				})
				.then(
					() => "resolved",
					(e) => e.message,
				);
			return [seen, outcome];
		};
	const outcomes = [await last(sql), await last(sql, true)],
		reserved = await sql.reserve();
	outcomes.push(await last(reserved), await last(reserved, true));
	reserved.release();
	expect(outcomes).toEqual([
		[[1, 3], "resolved"],
		[[1, 3], "last"],
		[[1, 3], "resolved"],
		[[1, 3], "last"],
	]);
	await sql.end();
});

test("A reserved cursor whose callback throws at once rejects and leaves the connection open", async () => {
	const sql = postgres({ ...options, max: 1 }),
		reserved = await sql.reserve();
	const error = await reserved`select generate_series(1, 10) as x`
		.cursor(2, () => {
			throw new Error("at once");
		})
		.catch((e) => e.message);
	const [{ x }] = await reserved`select 1 as x`;
	reserved.release();
	expect([error, x]).toEqual(["at once", 1]);
	await sql.end();
});
