import Stream from "stream";
import type postgres from "../types/index.js";

/**
 * Opens large object `oid` in a transaction that stays open until the handle's close() is called.
 * @param sql the pool, or a transaction's `tx`
 * @param oid the large object's oid; 0 or undefined creates a new large object
 * @param mode lo_open()'s mode; the default is INV_READ | INV_WRITE
 * @returns the handle, once the large object is open. Its close() resolves once the transaction
 *   has committed, and rejects if lo_close or the commit fails.
 */
export default function largeObject(
	sql: postgres.Sql,
	oid: number | undefined,
	mode = 0x00020000 | 0x00040000,
) {
	return new Promise((resolve, reject) => {
		const transaction = sql.begin(async (tx) => {
			const { promise: finished, resolve: finish, reject: fail } = Promise.withResolvers();
			if (!oid) {
				[{ oid }] = await tx`select lo_creat(-1) as oid`;
			}
			const [{ fd }] = await tx`select lo_open(${oid}, ${mode}) as fd`;

			const lo = {
				writable,
				readable,
				close: () => {
					tx`select lo_close(${fd})`.then(finish, fail);
					return transaction;
				},
				tell: () => tx`select lo_tell64(${fd})`,
				read: (x: number) => tx`select loread(${fd}, ${x}) as data`,
				write: (x: Uint8Array) => tx`select lowrite(${fd}, ${x})`,
				truncate: (x: number) => tx`select lo_truncate64(${fd}, ${x})`,
				seek: (x: number, whence = 0) => tx`select lo_lseek64(${fd}, ${x}, ${whence})`,
				size: () => tx`
          select
            lo_lseek64(${fd}, location, 0) as position,
            seek.size
          from (
            select
              lo_lseek64($1, 0, 2) as size,
              tell.location
            from (select lo_tell64($1) as location) tell
          ) seek
        `,
			};

			resolve(lo);

			return finished;

			async function readable({ highWaterMark = 2048 * 8, start = 0, end = Infinity } = {}) {
				let max = end - start;
				if (start) {
					await lo.seek(start);
				}

				return new Stream.Readable({
					highWaterMark,
					read(size) {
						const l = Math.min(size, max);
						max -= l;
						lo.read(l).then(
							(rows) => {
								const [{ data }] = rows;
								if (data.length) {
									this.push(data);
								}
								if (data.length < l || max === 0) {
									this.push(null);
								}
							},
							(error: Error) => this.destroy(error),
						);
					},
				});
			}

			async function writable({ highWaterMark = 2048 * 8, start = 0 } = {}) {
				if (start) {
					await lo.seek(start);
				}

				return new Stream.Writable({
					highWaterMark,
					write(chunk, encoding, callback) {
						lo.write(chunk).then(() => callback(), callback);
					},
				});
			}
		});
		transaction.catch(reject);
	});
}
