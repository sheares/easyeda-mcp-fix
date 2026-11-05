// Datasheet stash: one PDF per non-passive part in <project folder>/datasheets/,
// named {C-number}_{Manufacturer Part}.pdf, with INDEX.md for people and
// index.json for tools. Same recipe as the id-pcb toolkit (idpcb/parts.py):
//   1. the JLC parts record gives the datasheet URL (dataManualUrl);
//   2. LCSC's own URL often serves HTML to non-browsers, so the
//      wmsc.lcsc.com mirror of the same file name is tried next;
//   3. the device's own Datasheet attribute is tried last, and when it is an
//      HTML viewer page, the first PDF link on it;
//   4. a file is saved only if it really is a PDF (starts with %PDF).
// Nothing is guessed: a part with no PDF is reported with every URL tried so
// it can be fetched by hand. Network access is injected so tests run offline.

import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { mapWithConcurrency } from '../extension/handlers/concurrency';

export const JLC_PART_ENDPOINT = 'https://cart.jlcpcb.com/shoppingCart/smtGood/getComponentDetail?componentCode=';
const LCSC_MIRROR = 'https://wmsc.lcsc.com/wmsc/upload/file/pdf/v2/lcsc/';
// A generic browser user agent: LCSC refuses obvious scripts. Never the user's identity.
const USER_AGENT = 'Mozilla/5.0 (compatible; easyeda-mcp datasheet fetch)';
const MAX_PDF_BYTES = 40 * 1024 * 1024;
const FETCH_CONCURRENCY = 4;
const INDEX_MARKER = '<!-- written by easyeda-mcp project_fetch_datasheets -->';

export interface StashPart {
	lcsc?: string;
	mpn?: string;
	designators: string[];
	/** The device's own Datasheet attribute, if any. */
	deviceUrl?: string;
}

export type StashStatus = 'cached' | 'downloaded' | 'not-found' | 'no-lcsc-number';

export interface StashResult {
	lcsc?: string;
	mpn?: string;
	designators: string[];
	status: StashStatus;
	file: string | null;
	source?: string;
	bytes?: number;
	sha256?: string;
	tried: string[];
	note?: string;
}

export interface Fetched {
	status: number;
	contentType: string;
	body: Uint8Array;
}

export interface StashDeps {
	fetchUrl: (url: string) => Promise<Fetched>;
	today?: () => string;
}

const PASSIVE = /^(R|C|RN|JP|TP|FID|MH|H|NT)\d/i;
const LCSC_CODE = /^C\d+$/;

/** Every part worth a datasheet: everything but plain resistors, capacitors, jumpers, test points and fiducials. */
export function needsDatasheet(designators: string[]): boolean {
	return designators.some((d) => !PASSIVE.test(d));
}

export function safeName(s: string): string {
	return s.replace(/[^A-Za-z0-9.+-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80) || 'part';
}

export function mirrorUrls(url: string): string[] {
	const name = url.split('?')[0].split('/').pop() ?? '';
	if (!name.toLowerCase().endsWith('.pdf')) return [];
	const names = [name];
	if (name.startsWith('lcsc_datasheet_')) names.push(name.slice('lcsc_datasheet_'.length));
	return names.map((n) => LCSC_MIRROR + n);
}

function isPdf(body: Uint8Array): boolean {
	return body.length > 4 && body[0] === 0x25 && body[1] === 0x50 && body[2] === 0x44 && body[3] === 0x46;
}

/** A stashed file already holding this C-number, in either naming order (C123_MPN.pdf or MPN_C123.pdf). */
export function findCached(files: string[], lcsc: string): string | undefined {
	const token = new RegExp(`(^|[_.-])${lcsc}([_.-]|\\.pdf$)`, 'i');
	return files.find((f) => f.toLowerCase().endsWith('.pdf') && token.test(f));
}

async function jlcDatasheetUrl(lcsc: string, deps: StashDeps, tried: string[]): Promise<string | undefined> {
	const url = JLC_PART_ENDPOINT + encodeURIComponent(lcsc);
	tried.push(url);
	try {
		const res = await deps.fetchUrl(url);
		if (res.status !== 200) return undefined;
		const json = JSON.parse(new TextDecoder().decode(res.body));
		const u = json?.data?.dataManualUrl;
		return typeof u === 'string' && /^https?:\/\//.test(u) ? u : undefined;
	} catch {
		return undefined;
	}
}

async function tryPdf(url: string, deps: StashDeps, tried: string[]): Promise<{ body: Uint8Array; html?: string } | null> {
	tried.push(url);
	try {
		const res = await deps.fetchUrl(url);
		if (res.status !== 200) return null;
		if (isPdf(res.body)) return res.body.length <= MAX_PDF_BYTES ? { body: res.body } : null;
		if (/html/i.test(res.contentType)) return { body: new Uint8Array(), html: new TextDecoder().decode(res.body.subarray(0, 2_000_000)) };
		return null;
	} catch {
		return null;
	}
}

async function fetchOne(part: StashPart & { lcsc: string }, deps: StashDeps): Promise<{ body: Uint8Array; source: string } | { body?: undefined; tried: string[] }> {
	const tried: string[] = [];
	const candidates: string[] = [];
	const jlc = await jlcDatasheetUrl(part.lcsc, deps, tried);
	if (jlc) candidates.push(jlc, ...mirrorUrls(jlc));
	if (part.deviceUrl && /^https?:\/\//.test(part.deviceUrl)) candidates.push(part.deviceUrl, ...mirrorUrls(part.deviceUrl));
	const seen = new Set<string>();
	for (const url of candidates) {
		if (seen.has(url)) continue;
		seen.add(url);
		const got = await tryPdf(url, deps, tried);
		if (got?.body.length) return { body: got.body, source: url };
		// An HTML viewer page: follow its first PDF link, once.
		const link = got?.html?.match(/https?:\/\/[^"'\s<>]+?\.pdf/i)?.[0];
		if (link && !seen.has(link)) {
			seen.add(link);
			const inner = await tryPdf(link, deps, tried);
			if (inner?.body.length) return { body: inner.body, source: link };
		}
	}
	return { tried };
}

function indexMarkdown(results: StashResult[], today: string): string {
	const rows = results.map((r) => `| ${r.lcsc ?? ''} | ${r.mpn ?? ''} | ${r.designators.join(', ')} | ${r.file ?? ''} | ${r.status}${r.note ? `: ${r.note}` : ''} | ${r.source ?? (r.status === 'not-found' ? r.tried.join(' ') : '')} |`);
	return [
		INDEX_MARKER,
		'# Datasheets',
		'',
		`Written by the EasyEDA MCP (project_fetch_datasheets) on ${today}. A file is saved only when a URL served a real PDF. Plain resistors, capacitors, jumpers and test points are left out. Fetch any "not-found" part by hand.`,
		'',
		'| C-number | MPN | Designators | File | Status | Source |',
		'|---|---|---|---|---|---|',
		...rows,
		'',
	].join('\n');
}

/**
 * Stash datasheets into `dir` (created if needed). Parts sharing a C-number
 * are fetched once. Never throws for network trouble; returns one result per
 * part group.
 */
export async function stashDatasheets(parts: StashPart[], dir: string, deps: StashDeps): Promise<{ results: StashResult[]; indexWritten: string[] }> {
	await mkdir(dir, { recursive: true });
	const today = deps.today?.() ?? new Date().toISOString().slice(0, 10);

	// Group by C-number (or by MPN for parts without one).
	const groups = new Map<string, StashPart>();
	for (const p of parts) {
		const key = p.lcsc && LCSC_CODE.test(p.lcsc) ? p.lcsc : `mpn:${p.mpn ?? p.designators[0]}`;
		const g = groups.get(key);
		if (g) g.designators.push(...p.designators);
		else groups.set(key, { ...p, designators: [...p.designators] });
	}

	const existing = await readdir(dir).catch(() => [] as string[]);
	const results = await mapWithConcurrency([...groups.values()], FETCH_CONCURRENCY, async (part): Promise<StashResult> => {
		part.designators.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
		const base: StashResult = { lcsc: part.lcsc, mpn: part.mpn, designators: part.designators, status: 'not-found', file: null, tried: [] };
		if (!part.lcsc || !LCSC_CODE.test(part.lcsc)) {
			return { ...base, status: 'no-lcsc-number', note: part.deviceUrl ? `device lists ${part.deviceUrl}` : 'no supplier part number; fetch from the maker' };
		}
		const cached = findCached(existing, part.lcsc);
		if (cached) {
			const body = await readFile(join(dir, cached));
			return { ...base, status: 'cached', file: cached, bytes: body.length, sha256: createHash('sha256').update(body).digest('hex') };
		}
		const got = await fetchOne(part as StashPart & { lcsc: string }, deps);
		if (!got.body) {
			return { ...base, tried: got.tried, note: 'no URL served a PDF' };
		}
		const file = `${part.lcsc}_${safeName(part.mpn ?? 'part')}.pdf`;
		const tmp = join(dir, `.${file}.part`);
		await writeFile(tmp, got.body);
		await rename(tmp, join(dir, file));
		existing.push(file);
		return {
			...base,
			status: 'downloaded',
			file,
			source: got.source,
			bytes: got.body.length,
			sha256: createHash('sha256').update(got.body).digest('hex'),
		};
	});

	const indexWritten: string[] = [];
	await writeFile(join(dir, 'index.json'), JSON.stringify({ written: today, by: 'easyeda-mcp project_fetch_datasheets', parts: results }, null, 2) + '\n');
	indexWritten.push('index.json');
	// Do not overwrite an INDEX.md someone else wrote (id-pcb writes one too).
	const mdPath = join(dir, 'INDEX.md');
	const currentMd = await readFile(mdPath, 'utf8').catch(() => null);
	const mdName = currentMd === null || currentMd.startsWith(INDEX_MARKER) ? 'INDEX.md' : 'INDEX-easyeda-mcp.md';
	await writeFile(join(dir, mdName), indexMarkdown(results, today));
	indexWritten.push(basename(mdName));
	return { results, indexWritten };
}

/** The stashed datasheet for a part, from a datasheets folder listing. */
export function datasheetLookup(dir: string, files: string[]): (lcsc: string | undefined) => string | null {
	return (lcsc) => {
		if (!lcsc || !LCSC_CODE.test(lcsc)) return null;
		const f = findCached(files, lcsc);
		return f ? join(dir, f) : null;
	};
}
