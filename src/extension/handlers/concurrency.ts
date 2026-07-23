// D4: bounded-concurrency map. sch.connectivity.get fetches pins with one
// EDA API call per component; an unbounded Promise.all put hundreds of
// simultaneous calls into the renderer, and this codebase's history with EDA
// calls that never settle (getPdfFile, the About dialog, bug 4) argues for
// conservatism. Pure module (no `eda` imports) so it can be unit-tested
// directly.

/**
 * Map `items` through async `fn` with at most `limit` calls in flight.
 * Results keep input order. Any rejection rejects the whole call (matching
 * Promise.all semantics — callers treat a failed pin fetch as a failed
 * request, not a silent hole in the map).
 */
export async function mapWithConcurrency<T, R>(
	items: readonly T[],
	limit: number,
	fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
	if (!Number.isFinite(limit) || limit < 1) {
		throw new Error(`mapWithConcurrency: limit must be a positive integer, got ${limit}`);
	}
	const results: R[] = new Array(items.length);
	let next = 0;
	const workers: Promise<void>[] = [];
	const workerCount = Math.min(limit, items.length);
	for (let w = 0; w < workerCount; w++) {
		workers.push((async () => {
			while (true) {
				const i = next++;
				if (i >= items.length) return;
				results[i] = await fn(items[i], i);
			}
		})());
	}
	await Promise.all(workers);
	return results;
}
