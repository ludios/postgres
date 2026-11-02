// Model-output: Claude Opus 5.5
import util from "util";
import { expect, test } from "vitest";
import postgres from "../../src/index.ts";
import cases from "./build.cases.ts";
import { snake_case } from "../helpers.ts";

const sql = postgres({ host: "localhost", port: 1, max: 1 });
const show = (q) => JSON.stringify([q.text, q.parameters]);

cases.forEach(([name, fn, text, parameters]) =>
	// oxlint-disable-next-line vitest/valid-title -- the rule wants a literal title, not `name`
	test(name, async () => {
		const expected = JSON.stringify([text, parameters]);
		expect(show(fn(sql))).toBe(expected);
	}),
);

test("Insert and update helpers with no columns throw (#644)", async () => {
	expect(
		[
			() => sql`insert into x ${sql({})}`,
			() => sql`insert into x ${sql({ a: 1 }, [])}`,
			() => sql`update x set ${sql({})}`,
		]
			.map((fn) => {
				try {
					fn().text;
				} catch (e) {
					return e.code;
				}
			})
			.join(" "),
	).toBe("NO_COLUMNS NO_COLUMNS NO_COLUMNS");
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
		]
			.map((fn) => {
				try {
					fn().text;
				} catch (e) {
					return e.code;
				}
			})
			.join(" "),
	).toBe("UNDEFINED_VALUE UNDEFINED_VALUE");
});

test("A join has the length of the items it kept", async () => {
	expect(sql`and`.join([sql`a`, false, sql`b`]).length + " " + sql`and`.join([]).length).toBe(
		"2 0",
	);
});

test("Transform column names in helpers", async () => {
	const sql = postgres({ host: "localhost", port: 1, transform: { column: { to: snake_case } } });
	const expected = JSON.stringify(['insert into x ("foo_bar")values($1)', [1]]);
	expect(show(sql`insert into x ${sql({ fooBar: 1 })}`)).toBe(expected);
});

test("Transform undefined to null", async () => {
	const sql = postgres({ host: "localhost", port: 1, transform: { undefined: null } });
	const expected = JSON.stringify(["select $1", [null]]);
	expect(show(sql`select ${undefined}`)).toBe(expected);
});

test("Inspect hides text and parameters without debug", async () => {
	const x = util.inspect(sql`select ${"secret"} as x`);
	expect(x.includes("secret") || x.includes("select $1")).toBe(false);
});

test("Inspect shows text and parameters with debug", async () => {
	const sql = postgres({ host: "localhost", port: 1, debug: true });
	const x = util.inspect(sql`select ${"secret"} as x`);
	expect(x.includes("secret") && x.includes("select $1 as x")).toBe(true);
});

test("Building does not run the query", async () => {
	let ran = false;
	const sql = postgres({ host: "localhost", port: 1, debug: () => (ran = true) });
	sql`select 1`.text;
	await new Promise((r) => setTimeout(r, 10));
	expect(ran).toBe(false);
});
