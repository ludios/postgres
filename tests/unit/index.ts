// @ts-nocheck
import { t } from "../test.ts";

t.ready = Promise.all(
	["protocol", "socket", "types", "build", "errors", "pool", "options"].map((area) =>
		import("./" + area + ".ts").catch((error) =>
			t(area + " loads", async () => {
				throw error;
			}),
		),
	),
).then(() => new Promise((r) => setTimeout(r)));
