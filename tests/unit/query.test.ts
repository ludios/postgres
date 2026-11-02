import { expect, test } from "vitest";
import { Query } from "../../src/query.ts";

/** A Query whose cancel requests all fail, as when the network is down. */
function uncancelable_query() {
	const handler = {
		cancel: () => Promise.reject(new Error("the cancel request could not be sent")),
	};
	return new Query(["select 1"], [], handler);
}

/**
 * Runs `fn`, then waits until Node would have reported any error that `fn` left unhandled.
 *
 * @param fn A function that may leave an error unhandled.
 * @returns The errors that Node reported as uncaught exceptions or as unhandled rejections.
 */
async function unhandled_errors(fn: () => void) {
	const errors = [];
	const on_error = (error) => errors.push(error);
	process.on("uncaughtException", on_error);
	process.on("unhandledRejection", on_error);
	try {
		fn();
		// Node reports both kinds of error once the microtask queue has drained
		await new Promise((resolve) => setImmediate(resolve));
	} finally {
		process.off("uncaughtException", on_error);
		process.off("unhandledRejection", on_error);
	}
	return errors;
}

test("A query given an aborted AbortSignal ignores a failed cancel request", async () => {
	const errors = await unhandled_errors(() => {
		void uncancelable_query().signal(AbortSignal.abort());
	});
	expect(errors).toEqual([]);
});

test("A query whose AbortSignal aborts later ignores a failed cancel request", async () => {
	const controller = new AbortController();
	const errors = await unhandled_errors(() => {
		void uncancelable_query().signal(controller.signal);
		controller.abort();
	});
	expect(errors).toEqual([]);
});
