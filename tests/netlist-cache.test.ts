// Q8: the netlist cache's generation guard. A refresh:true caller
// ("bypass the cache and force a fresh recompute") must never be handed an
// in-flight fetch that started before their edit, and a fetch superseded by
// an invalidation must not cache its stale result when it lands.
//
// The module under test references the `eda` / `ESYS_NetlistType` globals
// only inside function bodies, so stubbing them on globalThis before the
// calls (not before the import) is sufficient.
import { test } from 'node:test';
import assert from 'node:assert/strict';

interface PendingFetch { resolve: (rawJson: string) => void; reject: (err: unknown) => void }
const pending: PendingFetch[] = [];
let fetchCount = 0;

const g = globalThis as any;
g.ESYS_NetlistType = { JLCEDA_PRO: 'JLCEDA_PRO' };
g.eda = {
	dmt_Project: {
		getCurrentProjectInfo: async () => ({ uuid: 'proj-1' }),
	},
	sch_ManufactureData: {
		getNetlistFile: (_kind: string, _type: unknown) =>
			new Promise((res, rej) => {
				fetchCount++;
				pending.push({
					resolve: (rawJson: string) => res({ text: async () => rawJson }),
					reject: rej,
				});
			}),
	},
};

// Import AFTER the globals exist (belt and braces; only call time matters).
import { fetchParsedNetlist, invalidateNetlistCache } from '../src/extension/handlers/sch-netlist-utils';

function v2(designator: string): string {
	return JSON.stringify({
		version: '2.0.0',
		components: {
			'uid-1': {
				props: { Designator: designator, Name: 'R_0603' },
				pinInfoMap: { '1': { net: 'NET_A' }, '2': { net: '' } },
			},
		},
	});
}

// Let the async prologue of fetchParsedNetlist (currentProjectUuid await)
// reach the getNetlistFile call.
async function settle(): Promise<void> {
	for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
}

test('concurrent non-forced calls coalesce onto one fetch', async () => {
	invalidateNetlistCache();
	const before = fetchCount;
	const p1 = fetchParsedNetlist(false);
	const p2 = fetchParsedNetlist(false);
	await settle();
	assert.equal(fetchCount, before + 1, 'second caller should join the in-flight fetch');
	pending.pop()!.resolve(v2('R1'));
	const [r1, r2] = await Promise.all([p1, p2]);
	assert.equal(r1['uid-1'].designator, 'R1');
	assert.equal(r2['uid-1'].designator, 'R1');
});

test('refresh:true never joins a stale in-flight fetch, and the stale fetch does not cache', async () => {
	invalidateNetlistCache();
	const before = fetchCount;

	const stale = fetchParsedNetlist(false);
	await settle();
	assert.equal(fetchCount, before + 1);
	const staleFetch = pending.pop()!;

	// The edit happened; the caller asks for a forced recompute while the
	// pre-edit fetch is still in flight.
	const fresh = fetchParsedNetlist(true);
	await settle();
	assert.equal(fetchCount, before + 2, 'refresh:true must start its own fetch');
	const freshFetch = pending.pop()!;

	staleFetch.resolve(v2('OLD'));
	freshFetch.resolve(v2('NEW'));

	assert.equal((await stale)['uid-1'].designator, 'OLD', 'the earlier caller still gets what it asked for');
	assert.equal((await fresh)['uid-1'].designator, 'NEW', 'the refresh caller must see post-edit data');

	// The stale fetch must NOT have won the cache: a follow-up read serves
	// NEW from cache without a third fetch.
	const cached = await fetchParsedNetlist(false);
	assert.equal(cached['uid-1'].designator, 'NEW');
	assert.equal(fetchCount, before + 2, 'follow-up read should be served from cache');
});

test('invalidation during an in-flight fetch prevents its result from being cached', async () => {
	invalidateNetlistCache();
	const before = fetchCount;

	const p = fetchParsedNetlist(false);
	await settle();
	const inflight = pending.pop()!;

	// A schematic write lands mid-fetch.
	invalidateNetlistCache();
	inflight.resolve(v2('PRE_EDIT'));
	assert.equal((await p)['uid-1'].designator, 'PRE_EDIT', 'the original caller still gets its answer');

	// Next read must refetch — the pre-edit result must not have been cached.
	const q = fetchParsedNetlist(false);
	await settle();
	assert.equal(fetchCount, before + 2, 'post-invalidation read must start a fresh fetch');
	pending.pop()!.resolve(v2('POST_EDIT'));
	assert.equal((await q)['uid-1'].designator, 'POST_EDIT');
});
