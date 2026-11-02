// Model-output: Claude Opus 5.5
import { expect, test } from "vitest";

/** Runs a test, and returns (or resolves to) `[expected, got, ...rest]`; any element may be a promise */
type TestFn = () => unknown[] | Promise<unknown[]>;

/**
 * Register a vitest test that is written for upstream's harness. The test passes if `got` is
 * `expected` (by `Object.is`, which differs from `===` only for NaN, and for 0 and -0), after every
 * element of what the test returns has resolved; the elements after `got` are only awaited (e.g.
 * to clean up).
 *
 * @param name - the test's name
 * @param options - `timeout`: the number of seconds that the test may take (default 5)
 * @param fn - the test
 */
export function t(name: string, fn: TestFn): void;
export function t(name: string, options: { timeout?: number }, fn: TestFn): void;
export function t(name: string, options_or_fn: { timeout?: number } | TestFn, fn?: TestFn): void {
	const options = typeof options_or_fn === "function" ? {} : options_or_fn;
	const run = typeof options_or_fn === "function" ? options_or_fn : fn;
	// oxlint-disable-next-line vitest/valid-title -- the rule wants a literal title, not `name`
	test(name, { timeout: (options.timeout || 5) * 1000 }, async () => {
		const result = await run();
		expect(Array.isArray(result), "a test should return [expected, got]").toBe(true);
		const [expected, got] = await Promise.all(result);
		expect(got).toBe(expected);
	});
}
