// The reference makes the EDA Pro ambient globals (eda, ESYS_NetlistType)
// resolvable when this module is compiled OUTSIDE tsconfig.extension.json —
// i.e. by ts-node when tests import it (tests/netlist-cache.test.ts stubs
// those globals at runtime). The extension build already gets them via the
// tsconfig "types" entry; this is a no-op there.
/// <reference types="@jlceda/pro-api-types" />
import { bridgeLog, describeError } from '../diag';
import { parseRawNetlist, type ParsedNetlist } from './sch-netlist-parse';

// EDA Pro's getNetlist() recomputes the whole-project netlist and can take tens
// of seconds on large boards (see bug 4). The result only changes when the
// schematic topology changes, so we memoise it and invalidate on every
// schematic-write handler. The TTL is a backstop for edits made directly in the
// EDA Pro UI (which don't go through our handlers); callers can also force a
// fresh read. The cache is keyed by project so switching projects in the same
// window never serves another project's netlist.
const NETLIST_CACHE_TTL_MS = 60_000;

interface NetlistCacheEntry {
	projectUuid: string | null;
	parsed: ParsedNetlist;
	fetchedAt: number;
}

let netlistCache: NetlistCacheEntry | null = null;
// Q8: generation counter guards both the in-flight join and the cache write.
// Every invalidation (schematic write) and every forced refresh bumps it; a
// fetch that started under an older generation must neither be joined by a
// refresh:true caller (it would hand back pre-edit data the caller explicitly
// asked to bypass) nor write its stale result into the cache when it lands.
let netlistGeneration = 0;
let netlistInflight: { promise: Promise<ParsedNetlist>; generation: number } | null = null;

async function currentProjectUuid(): Promise<string | null> {
	try {
		const info: any = await eda.dmt_Project.getCurrentProjectInfo();
		return info?.uuid ?? info?.projectId ?? info?.id ?? null;
	} catch {
		return null;
	}
}

/** Drop the memoised netlist so the next fetch recomputes it. Also bumps the
 * generation so an in-flight pre-edit fetch can no longer be joined by a
 * refresh caller or cache its (now stale) result on completion. */
export function invalidateNetlistCache(): void {
	netlistCache = null;
	netlistGeneration++;
}

/**
 * Fetch the raw project netlist as a string.
 *
 * Prefers the modern `SCH_ManufactureData.getNetlistFile` API. The older
 * `eda.sch_Netlist.getNetlist` is `@deprecated` and, on some projects, hangs for
 * ~5 minutes then rejects with nothing (bug 4): the deprecated call appears to
 * trigger a blocking JLC reconciliation that never resolves headlessly, even
 * though DRC and the UI "Export Netlist" (which uses getNetlistFile) both finish
 * in ~1s on the same project. We keep the JLCEDA netlist type so the payload
 * shape matches `parseRawNetlist`, and fall back to the deprecated call only if
 * the new API is missing on this EDA Pro build.
 *
 * Considered and rejected (types 0.3.5): the alpha `SCH_Net.getCurrentProjectAllNets`
 * returns nets as wire lists (wire name/id, page uuid) with no component pins,
 * designators, or props, so it cannot produce the per-component ParsedNetlist
 * shape every consumer here needs. Revisit if a later SDK adds pin info to
 * ISCH_NetInfo.
 */
export async function fetchRawNetlist(type?: ESYS_NetlistType): Promise<string> {
	const netlistType = type ?? ESYS_NetlistType.JLCEDA_PRO;
	const mfg: any = (eda as any).sch_ManufactureData;
	if (mfg?.getNetlistFile) {
		const t = Date.now();
		const file = await mfg.getNetlistFile('netlist', netlistType);
		if (!file) throw new Error('getNetlistFile returned no file');
		const text: string = await file.text();
		bridgeLog(
			`getNetlistFile(${netlistType}): ${text.length} chars in ${Date.now() - t}ms; head=${JSON.stringify(text.slice(0, 160))}`,
		);
		return text;
	}
	bridgeLog('getNetlistFile unavailable; using deprecated getNetlist');
	return eda.sch_Netlist.getNetlist(netlistType);
}

export async function fetchParsedNetlist(forceRefresh = false): Promise<ParsedNetlist> {
	const projectUuid = await currentProjectUuid();
	const now = Date.now();

	if (
		!forceRefresh &&
		netlistCache &&
		netlistCache.projectUuid === projectUuid &&
		now - netlistCache.fetchedAt < NETLIST_CACHE_TTL_MS
	) {
		return netlistCache.parsed;
	}

	// Coalesce concurrent fetches (e.g. get + getAll firing together) onto a
	// single getNetlist round-trip — but only same-generation, non-forced
	// ones. A refresh:true caller documented as "bypass the cache and force a
	// fresh recompute" must never be handed a fetch that started before their
	// edit (Q8); it bumps the generation instead, which also stops the old
	// in-flight fetch from caching its stale result when it lands.
	if (!forceRefresh && netlistInflight && netlistInflight.generation === netlistGeneration) {
		return netlistInflight.promise;
	}
	if (forceRefresh) {
		netlistGeneration++;
	}
	const generation = netlistGeneration;

	const promise = (async () => {
		const t0 = Date.now();
		bridgeLog(`getNetlist: start (project=${projectUuid ?? 'unknown'}, forceRefresh=${forceRefresh}, gen=${generation})`);
		try {
			const raw = await fetchRawNetlist();
			const parsed = parseRawNetlist(raw);
			if (generation === netlistGeneration) {
				netlistCache = { projectUuid, parsed, fetchedAt: Date.now() };
			} else {
				bridgeLog(`getNetlist: gen ${generation} result NOT cached (current gen ${netlistGeneration}); an edit or refresh superseded it`);
			}
			bridgeLog(`getNetlist: done in ${Date.now() - t0}ms (${Object.keys(parsed).length} components)`);
			return parsed;
		} catch (err) {
			bridgeLog(`getNetlist: FAILED after ${Date.now() - t0}ms: ${describeError(err)}`);
			throw err;
		} finally {
			if (netlistInflight?.generation === generation) {
				netlistInflight = null;
			}
		}
	})();

	netlistInflight = { promise, generation };
	return promise;
}

/**
 * Resolve EasyEDA template expressions like `={Manufacturer Part}` in a string
 * by looking up property values from the netlist.
 */
export function resolveTemplateExpressions(text: string, props: Record<string, any>): string {
	return text.replace(/=\{([^}]+)\}/g, (match, propName) => {
		const value = props[propName];
		return value != null ? String(value) : match;
	});
}

export async function fetchPinNames(primitiveId: string): Promise<Record<string, string>> {
	const pins = await eda.sch_PrimitiveComponent.getAllPinsByPrimitiveId(primitiveId);
	const result: Record<string, string> = {};
	if (Array.isArray(pins)) {
		for (const pin of pins) {
			const p = pin as any;
			if (p.pinNumber != null) {
				result[String(p.pinNumber)] = p.pinName || '';
			}
		}
	}
	return result;
}
