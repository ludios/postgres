import util from "util";
import { expect, test } from "vitest";
import { PostgresError, copy_error, queryError } from "../../src/errors.ts";
import postgres from "../../src/index.ts";

const here = new URL(import.meta.url).pathname;
const offline = () => postgres({ host: "localhost", port: 1, connect_timeout: 1, max: 1 });

test("PostgresError from server fields", async () => {
	const e = new PostgresError({ message: "division by zero", code: "22012", severity: "ERROR" });
	expect([e instanceof Error, e.name, e.message, e.code, e.severity]).toEqual([
		true,
		"PostgresError",
		"division by zero",
		"22012",
		"ERROR",
	]);
});

test("PostgresError from a message string", async () => {
	const e = new PostgresError("Error message.");
	expect([e.message, "0" in e]).toEqual(["Error message.", false]);
});

test("copy_error copies an error as a native error of the same class, without a query's properties", async () => {
	const error = new PostgresError({ message: "terminating connection", code: "57P01" });
	queryError(error, { strings: ["select 1"], args: [1], origin: "" }, false);
	const copy = copy_error(error);
	expect([
		copy !== error,
		util.types.isNativeError(copy),
		copy instanceof PostgresError,
		copy.message,
		copy.code,
		copy.stack === error.stack,
		"query" in copy,
		"args" in copy,
		error.query,
	]).toEqual([true, true, true, "terminating connection", "57P01", true, false, false, "select 1"]);
});

test("copy_error returns a value that is not an object as is", async () => {
	expect([copy_error("wat"), copy_error(null), copy_error(undefined)]).toEqual([
		"wat",
		null,
		undefined,
	]);
});

test("PostgresError is exported from the package", async () => {
	expect(postgres.PostgresError === PostgresError).toBe(true);
});

test("Connection error stack is writable and configurable", async () => {
	const sql = offline();
	const e = await sql`select 1`.catch((x) => x);
	await sql.end();
	const d = Object.getOwnPropertyDescriptor(e, "stack");
	e.stack = "y";
	expect([d ? d.writable !== false || !!d.set : true, d ? d.configurable : true, e.stack]).toEqual([
		true,
		true,
		"y",
	]);
});

test("Connection error stack includes the calling line", async () => {
	const sql = offline();
	const e = await sql`select 1`.catch((x) => x);
	await sql.end();
	expect(e.stack.includes(here)).toBe(true);
});

test("Undefined value error stack includes the calling line", async () => {
	const sql = offline();
	const e = await sql`select ${undefined}`.catch((x) => x);
	await sql.end();
	expect([e.code, e.stack.includes(here)]).toEqual(["UNDEFINED_VALUE", true]);
});

test("Not tagged error has a code", async () => {
	const sql = offline();
	const e = await Promise.resolve()
		.then(() => sql("select 1"))
		.catch((x) => x);
	await sql.end();
	expect(e.code).toBe("NOT_TAGGED_CALL");
});
