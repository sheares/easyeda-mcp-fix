import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findCached, mirrorUrls, needsDatasheet, safeName, stashDatasheets, type Fetched } from '../src/bridge-daemon/datasheets';

const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]); // "%PDF-1.7"
const enc = (s: string) => new TextEncoder().encode(s);

/** A fake web: URL -> response. Anything else is a 404. Records every request. */
function web(routes: Record<string, Partial<Fetched>>) {
	const asked: string[] = [];
	return {
		asked,
		fetchUrl: async (url: string): Promise<Fetched> => {
			asked.push(url);
			const r = routes[url];
			return r ? { status: 200, contentType: '', body: new Uint8Array(), ...r } : { status: 404, contentType: 'text/html', body: enc('nope') };
		},
	};
}

const jlc = (code: string, url: string) => ({
	[`https://cart.jlcpcb.com/shoppingCart/smtGood/getComponentDetail?componentCode=${code}`]: { contentType: 'application/json', body: enc(JSON.stringify({ code: 200, data: { dataManualUrl: url } })) },
});

test('passives are left out; chips, diodes, connectors and inductors are kept', () => {
	assert.equal(needsDatasheet(['R1', 'R2']), false);
	assert.equal(needsDatasheet(['C5']), false);
	for (const d of ['U1', 'D3', 'LED1', 'J2', 'L1', 'Q1', 'Y1', 'SW1']) assert.equal(needsDatasheet([d]), true, d);
});

test('helpers: mirror URL, safe names, cached files in either naming order', () => {
	assert.deepEqual(mirrorUrls('https://www.lcsc.com/datasheet/lcsc_datasheet_X_C1.pdf'), [
		'https://wmsc.lcsc.com/wmsc/upload/file/pdf/v2/lcsc/lcsc_datasheet_X_C1.pdf',
		'https://wmsc.lcsc.com/wmsc/upload/file/pdf/v2/lcsc/X_C1.pdf',
	]);
	assert.deepEqual(mirrorUrls('https://item.szlcsc.com/datasheet/X/1.html'), []);
	assert.equal(safeName('SN74LVC1G/Q 1'), 'SN74LVC1G_Q_1');
	const files = ['TVS-DEMO_MAKER_C900001.pdf', 'C900002_BOOST-DEMO.pdf', 'C9000010_other.pdf', 'notes.txt'];
	assert.equal(findCached(files, 'C900001'), 'TVS-DEMO_MAKER_C900001.pdf');
	assert.equal(findCached(files, 'C900002'), 'C900002_BOOST-DEMO.pdf');
	assert.equal(findCached(files, 'C1'), undefined);
});

test('JLC URL refused, mirror serves the PDF: saved under {C}_{MPN}.pdf with an index', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'ds-'));
	const url = 'https://www.lcsc.com/datasheet/lcsc_datasheet_DEMO.pdf';
	const w = web({
		...jlc('C900002', url),
		[url]: { contentType: 'text/html', body: enc('<html>no</html>') },
		'https://wmsc.lcsc.com/wmsc/upload/file/pdf/v2/lcsc/lcsc_datasheet_DEMO.pdf': { contentType: 'application/pdf', body: PDF },
	});
	const { results, indexWritten } = await stashDatasheets([{ lcsc: 'C900002', mpn: 'BOOST-DEMO', designators: ['U1'] }], dir, { fetchUrl: w.fetchUrl, today: () => '2026-11-05' });
	assert.equal(results[0].status, 'downloaded');
	assert.equal(results[0].file, 'C900002_BOOST-DEMO.pdf');
	assert.deepEqual([...(await readFile(join(dir, 'C900002_BOOST-DEMO.pdf')))], [...PDF]);
	assert.deepEqual(indexWritten, ['index.json', 'INDEX.md']);
	assert.match(await readFile(join(dir, 'INDEX.md'), 'utf8'), /\| C900002 \| BOOST-DEMO \| U1 \| C900002_BOOST-DEMO.pdf \| downloaded/);
	assert.ok(!(await readdir(dir)).some((f) => f.endsWith('.part')), 'no temp file left behind');
});

test('an HTML viewer page is followed to its PDF link; shared C-numbers are fetched once', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'ds-'));
	const page = 'https://item.szlcsc.com/datasheet/KT-0603R/1.html';
	const w = web({
		[page]: { contentType: 'text/html; charset=utf-8', body: enc('<a href="https://atta.szlcsc.com/upload/x/KT.pdf">pdf</a>') },
		'https://atta.szlcsc.com/upload/x/KT.pdf': { contentType: 'application/pdf', body: PDF },
	});
	const { results } = await stashDatasheets([
		{ lcsc: 'C2290', mpn: 'KT-0603R', designators: ['LED2'], deviceUrl: page },
		{ lcsc: 'C2290', mpn: 'KT-0603R', designators: ['LED1'], deviceUrl: page },
	], dir, { fetchUrl: w.fetchUrl });
	assert.equal(results.length, 1);
	assert.deepEqual(results[0].designators, ['LED1', 'LED2']);
	assert.equal(results[0].source, 'https://atta.szlcsc.com/upload/x/KT.pdf');
	assert.equal(w.asked.filter((u) => u.endsWith('KT.pdf')).length, 1);
});

test('cached files are kept without any network call; failures list every URL tried', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'ds-'));
	await writeFile(join(dir, 'TVS-DEMO_MAKER_C900001.pdf'), PDF);
	const w = web({});
	const { results } = await stashDatasheets([
		{ lcsc: 'C900001', mpn: 'TVS-DEMO', designators: ['D1'] },
		{ lcsc: 'C999', mpn: 'GHOST', designators: ['U9'], deviceUrl: 'https://example.com/ghost.html' },
		{ mpn: 'HAND-BOUGHT', designators: ['J9'] },
	], dir, { fetchUrl: w.fetchUrl });
	const by = Object.fromEntries(results.map((r) => [r.designators[0], r]));
	assert.equal(by.D1.status, 'cached');
	assert.equal(by.D1.file, 'TVS-DEMO_MAKER_C900001.pdf');
	assert.equal(by.U9.status, 'not-found');
	assert.ok(by.U9.tried.includes('https://example.com/ghost.html'));
	assert.equal(by.J9.status, 'no-lcsc-number');
	assert.ok(!w.asked.some((u) => u.includes('C900001')), 'cached part made no request');
});

test('a non-PDF body is never saved, and someone else\'s INDEX.md is left alone', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'ds-'));
	await writeFile(join(dir, 'INDEX.md'), '# Datasheets\n\nWritten by idpcb.parts\n');
	const url = 'https://www.lcsc.com/x.pdf';
	const w = web({ ...jlc('C5', url), [url]: { contentType: 'application/pdf', body: enc('<html>login</html>') } });
	const { results, indexWritten } = await stashDatasheets([{ lcsc: 'C5', mpn: 'X', designators: ['U1'] }], dir, { fetchUrl: w.fetchUrl });
	assert.equal(results[0].status, 'not-found');
	assert.deepEqual((await readdir(dir)).filter((f) => f.endsWith('.pdf')), []);
	assert.deepEqual(indexWritten, ['index.json', 'INDEX-easyeda-mcp.md']);
	assert.match(await readFile(join(dir, 'INDEX.md'), 'utf8'), /idpcb/);
});
