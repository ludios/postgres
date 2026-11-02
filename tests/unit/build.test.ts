import util from "util";
import { expect, test } from "vitest";
import postgres from "../../src/index.ts";
import cases from "./build.cases.ts";
import { snake_case, thrown } from "../helpers.ts";

const sql = postgres({ host: "localhost", port: 1, max: 1 });
/** @returns the text and the parameters of `q`, a query that is built but not run */
const show = (q) => [q.text, q.parameters];

cases.forEach(([name, fn, text, parameters]) =>
	// oxlint-disable-next-line vitest/valid-title -- the rule wants a literal title, not `name`
	test(name, async () => {
		expect(show(fn(sql))).toEqual([text, parameters]);
	}),
);

test("Insert and update helpers with no columns throw (#644)", async () => {
	expect(
		[
			() => sql`insert into x ${sql({})}`,
			() => sql`insert into x ${sql({ a: 1 }, [])}`,
			() => sql`update x set ${sql({})}`,
		].map((fn) => thrown(() => fn().text).code),
	).toEqual(["NO_COLUMNS", "NO_COLUMNS", "NO_COLUMNS"]);
});

test("Undefined values in any row of a multi row insert throw, whatever the order (#889)", async () => {
	expect(
		[
			() =>
				sql`insert into x ${sql([
					{ a: 1, b: 1 },
					{ a: 2, b: undefined },
				])}`,
			() =>
				sql`insert into x ${sql([
					{ a: 2, b: undefined },
					{ a: 1, b: 1 },
				])}`,
		].map((fn) => thrown(() => fn().text).code),
	).toEqual(["UNDEFINED_VALUE", "UNDEFINED_VALUE"]);
});

test("A join has the length of the items it kept", async () => {
	expect([sql`and`.join([sql`a`, false, sql`b`]).length, sql`and`.join([]).length]).toEqual([2, 0]);
});

test("Transform column names in helpers", async () => {
	const sql = postgres({ host: "localhost", port: 1, transform: { column: { to: snake_case } } });
	expect(show(sql`insert into x ${sql({ fooBar: 1 })}`)).toEqual([
		'insert into x ("foo_bar")values($1)',
		[1],
	]);
});

test("Transform undefined to null", async () => {
	const sql = postgres({ host: "localhost", port: 1, transform: { undefined: null } });
	expect(show(sql`select ${undefined}`)).toEqual(["select $1", [null]]);
});

test("Inspect hides text and parameters without debug", async () => {
	const x = util.inspect(sql`select ${"secret"} as x`);
	expect(x).not.toContain("secret");
	expect(x).not.toContain("select $1");
});

test("Inspect shows text and parameters with debug", async () => {
	const sql = postgres({ host: "localhost", port: 1, debug: true });
	const x = util.inspect(sql`select ${"secret"} as x`);
	expect(x).toContain("secret");
	expect(x).toContain("select $1 as x");
});

test("Building does not run the query", async () => {
	let ran = false;
	const sql = postgres({ host: "localhost", port: 1, debug: () => (ran = true) });
	sql`select 1`.text;
	await new Promise((r) => setTimeout(r, 10));
	expect(ran).toBe(false);
});
