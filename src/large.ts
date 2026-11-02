import Stream from "stream";

export default function largeObject(sql, oid, mode = 0x00020000 | 0x00040000) {
	return new Promise((resolve, reject) => {
		sql
			.begin(async (tx) => {
				const { promise: finished, resolve: finish } = Promise.withResolvers();
				if (!oid) {
					[{ oid }] = await tx`select lo_creat(-1) as oid`;
				}
				const [{ fd }] = await tx`select lo_open(${oid}, ${mode}) as fd`;

				const lo = {
					writable,
					readable,
					close: () => tx`select lo_close(${fd})`.then(finish),
					tell: () => tx`select lo_tell64(${fd})`,
					read: (x) => tx`select loread(${fd}, ${x}) as data`,
					write: (x) => tx`select lowrite(${fd}, ${x})`,
					truncate: (x) => tx`select lo_truncate64(${fd}, ${x})`,
					seek: (x, whence = 0) => tx`select lo_lseek64(${fd}, ${x}, ${whence})`,
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
						async read(size) {
							const l = Math.min(size, max);
							max -= l;
							const [{ data }] = await lo.read(l);
							if (data.length) {
								this.push(data);
							}
							if (data.length < l || max === 0) {
								this.push(null);
							}
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
			})
			.catch(reject);
	});
}
