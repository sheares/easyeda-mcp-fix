import { bridgeLog, describeError } from '../diag';

export interface ParsedNetlistComponent {
	designator: string;
	part: string;
	manufacturerPart: string;
	allProps: Record<string, any>; // all raw properties from the netlist
	pins: Record<string, string>; // pinNumber → netName
}

// Keyed by component uniqueId
export type ParsedNetlist = Record<string, ParsedNetlistComponent>;

function parseRawNetlist(raw: unknown): ParsedNetlist {
	const data: Record<string, any> = typeof raw === 'string' ? JSON.parse(raw) : (raw as any);
	const result: ParsedNetlist = {};
	for (const [uniqueId, entry] of Object.entries(data ?? {})) {
		if (!entry || typeof entry !== 'object') continue;
		const props = (entry as any).props || {};
		result[uniqueId] = {
			designator: props.Designator || '',
			part: props.Name || '',
			manufacturerPart: props['Manufacturer Part'] || '',
			allProps: props,
			pins: (entry as any).pins || {},
		};
	}
	return result;
}

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
let netlistInflight: Promise<ParsedNetlist> | null = null;

async function currentProjectUuid(): Promise<string | null> {
	try {
		const info: any = await eda.dmt_Project.getCurrentProjectInfo();
		return info?.uuid ?? info?.projectId ?? info?.id ?? null;
	} catch {
		return null;
	}
}

/** Drop the memoised netlist so the next fetch recomputes it. */
export function invalidateNetlistCache(): void {
	netlistCache = null;
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
	// single getNetlist round-trip.
	if (netlistInflight) return netlistInflight;

	netlistInflight = (async () => {
		const t0 = Date.now();
		bridgeLog(`getNetlist: start (project=${projectUuid ?? 'unknown'}, forceRefresh=${forceRefresh})`);
		try {
			const raw = await eda.sch_Netlist.getNetlist(ESYS_NetlistType.JLCEDA_PRO);
			const parsed = parseRawNetlist(raw);
			netlistCache = { projectUuid, parsed, fetchedAt: Date.now() };
			bridgeLog(`getNetlist: done in ${Date.now() - t0}ms (${Object.keys(parsed).length} components)`);
			return parsed;
		} catch (err) {
			bridgeLog(`getNetlist: FAILED after ${Date.now() - t0}ms: ${describeError(err)}`);
			throw err;
		} finally {
			netlistInflight = null;
		}
	})();

	return netlistInflight;
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
