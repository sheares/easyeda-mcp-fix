// Normalises what sch_Drc.check / pcb_Drc.check return with
// includeVerboseError=true. Pure module (no `eda` imports) so it can be
// unit-tested directly.
//
// Three shapes are seen in the field:
// - a bare boolean (EasyEDA 3.2.206 and older for PCB DRC; upstream
//   pro-api-sdk issue #27);
// - an array of violations, empty when the check passes (PCB DRC, 3.2.209);
// - a grouped tree whose top-level entries are CATEGORIES with a count, not
//   individual violations (schematic DRC, 3.2.209: [{type:'warn',count:4}]).
//   The 0.4.27 types say so too: the top-level length is the number of
//   categories, not the number of errors.
// - a nested tree {name, list: [{name, list: [violation, ...]}]} (PCB DRC with
//   violations, 3.2.209): category ("Clearance Error"), then kind ("Copper
//   Region(Filled) to Track"), then the violations, each about 2 KB of
//   display data. Seen live on 5 Nov 2026: 751 violations came to 1.7 million
//   characters, far past what a tool result can carry. These are flattened
//   into compact one-line violations and capped (maxErrors).
// `passed` and `errors` keep their old meaning so existing callers are
// unaffected; `summary` adds the real totals.

export interface DrcSummary {
	/** Top-level entries EasyEDA returned (categories for a grouped tree). */
	entries: number;
	/** Sum of the entries' `count`, or one per entry without a count. */
	total: number;
	/** Totals keyed by the entry's `type` (e.g. "warn", "error"), or by category for a nested tree; "unknown" when absent. */
	byType: Record<string, number>;
	/** Nested tree only: totals keyed by "category › kind". */
	byKind?: Record<string, number>;
}

/** One violation from the nested tree, cut down to what a reader needs. */
export interface DrcViolation {
	category: string;
	kind?: string;
	rule?: string;
	objects: string[];
	layer?: string;
	/** Position as EasyEDA reports it (mm on the boards seen so far). */
	at?: { x: number; y: number };
	message?: string;
}

export const DEFAULT_MAX_DRC_ERRORS = 100;

export interface NormalisedDrc {
	passed: boolean;
	errors?: unknown[];
	summary?: DrcSummary;
	note?: string;
	[key: string]: unknown;
}

const BOOLEAN_NOTE = 'This EDA Pro build returned only a pass/fail boolean (upstream pro-api-sdk issue #27); per-violation detail is unavailable here. Check the DRC panel in the EasyEDA UI for specifics.';
const STALE_POUR_NOTE = 'Most violations are copper pour fill against tracks, vias or holes. That is what stale pours look like after routing changed: rebuild every pour in EasyEDA (the API rebuild is broken on 3.2.209) and run DRC again before reading the rest.';
const GROUPED_NOTE = 'EasyEDA grouped the results: each entry in errors is a category with a count, not a single violation. summary.total is the real number of findings; passed is false for warnings too. Open the DRC panel in EasyEDA for the individual items.';

function entryCount(entry: unknown): number {
	if (entry && typeof entry === 'object') {
		const count = (entry as { count?: unknown }).count;
		if (typeof count === 'number' && Number.isFinite(count) && count >= 0) return count;
	}
	return 1;
}

function entryType(entry: unknown): string {
	if (entry && typeof entry === 'object') {
		const type = (entry as { type?: unknown }).type;
		if (typeof type === 'string' && type.length > 0) return type;
	}
	return 'unknown';
}

export function summariseDrcEntries(entries: readonly unknown[]): DrcSummary {
	const byType: Record<string, number> = {};
	let total = 0;
	for (const entry of entries) {
		const n = entryCount(entry);
		total += n;
		const type = entryType(entry);
		byType[type] = (byType[type] ?? 0) + n;
	}
	return { entries: entries.length, total, byType };
}

/** True when the entries look like the grouped tree (every entry carries a numeric count). */
function isGrouped(entries: readonly unknown[]): boolean {
	return entries.length > 0 && entries.every(
		(e) => !!e && typeof e === 'object' && typeof (e as { count?: unknown }).count === 'number',
	);
}

function isTreeNode(e: unknown): e is { name: string; list: unknown[] } {
	return !!e && typeof e === 'object' && typeof (e as any).name === 'string' && Array.isArray((e as any).list);
}

/** A nested tree: every top-level entry is a {name, list} node. */
function isNestedTree(entries: readonly unknown[]): boolean {
	return entries.length > 0 && entries.every(isTreeNode);
}

function str(v: unknown): string | undefined {
	return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function describeObject(o: unknown): string | undefined {
	if (!o || typeof o !== 'object') return undefined;
	const type = str((o as any).typeName);
	const suffix = str((o as any).suffix);
	if (!type) return undefined;
	return suffix && suffix !== '-' ? `${type} ${suffix}` : type;
}

function compactViolation(leaf: any, path: string[]): DrcViolation {
	const objects = [describeObject(leaf?.obj1), describeObject(leaf?.obj2)].filter((s): s is string => !!s);
	const v: DrcViolation = { category: str(leaf?.errorType) ?? path[0] ?? 'unknown', objects };
	const kind = str(leaf?.errorObjType) ?? path[1];
	if (kind) v.kind = kind;
	const rule = str(leaf?.ruleName);
	if (rule) v.rule = rule;
	const layer = str(leaf?.layer);
	if (layer) v.layer = layer;
	const pos = leaf?.pos ?? leaf?.errData?.position;
	if (pos && typeof pos.x === 'number' && typeof pos.y === 'number') v.at = { x: Math.round(pos.x * 1000) / 1000, y: Math.round(pos.y * 1000) / 1000 };
	const ex = leaf?.explanation;
	if (ex && typeof ex.str === 'string') {
		const param = ex.param ?? {};
		const names: Record<string, string | undefined> = { obj1: objects[0], obj2: objects[1] };
		v.message = ex.str.replace(/\{(\w+)\}/g, (m: string, k: string) => names[k] ?? (param[k] === undefined ? m : String(param[k])));
	}
	return v;
}

/** Flatten the nested tree into its violations, with the category path of each. */
export function flattenDrcTree(entries: readonly unknown[]): DrcViolation[] {
	const out: DrcViolation[] = [];
	const walk = (node: unknown, path: string[]): void => {
		if (isTreeNode(node) && (node as any).errorType === undefined) {
			for (const child of node.list) walk(child, [...path, node.name]);
		} else if (node && typeof node === 'object') {
			out.push(compactViolation(node, path));
		}
	};
	for (const e of entries) walk(e, []);
	return out;
}

function summariseViolations(entries: number, violations: readonly DrcViolation[]): DrcSummary {
	const byType: Record<string, number> = {};
	const byKind: Record<string, number> = {};
	for (const v of violations) {
		byType[v.category] = (byType[v.category] ?? 0) + 1;
		const k = v.kind ? `${v.category} › ${v.kind}` : v.category;
		byKind[k] = (byKind[k] ?? 0) + 1;
	}
	return { entries, total: violations.length, byType, byKind };
}

function looksLikeStalePours(violations: readonly DrcViolation[]): boolean {
	if (violations.length < 10) return false;
	const pour = violations.filter((v) => (v.kind ?? '').startsWith('Copper Region(Filled)')).length;
	return pour / violations.length >= 0.5;
}

/**
 * @param verboseRequested - false when the caller asked for the bare gate
 *   boolean, so getting one back is not worth a note.
 */
export function normaliseDrcResult(result: unknown, verboseRequested = true, maxErrors = DEFAULT_MAX_DRC_ERRORS): unknown {
	if (typeof result === 'boolean') {
		return (verboseRequested ? { passed: result, note: BOOLEAN_NOTE } : { passed: result }) satisfies NormalisedDrc;
	}
	if (Array.isArray(result) && isNestedTree(result)) {
		const violations = flattenDrcTree(result);
		const cap = Math.max(0, Math.floor(maxErrors));
		const summary = summariseViolations(result.length, violations);
		// Smallest groups first: a few hundred stale-pour hits must not push the
		// handful of real faults past the cap.
		const groupSize = (v: DrcViolation) => summary.byKind![v.kind ? `${v.category} › ${v.kind}` : v.category];
		const ordered = violations.map((v, i) => ({ v, i })).sort((a, b) => groupSize(a.v) - groupSize(b.v) || a.i - b.i).map((x) => x.v);
		const out: NormalisedDrc = { passed: violations.length === 0, errors: ordered.slice(0, cap), summary };
		if (violations.length > cap) out.truncated = { shown: cap, total: violations.length, hint: 'Raise maxErrors to see more, or fix the largest group in summary.byKind first.' };
		if (looksLikeStalePours(violations)) out.note = STALE_POUR_NOTE;
		return out;
	}
	if (Array.isArray(result)) {
		const out: NormalisedDrc = { passed: result.length === 0, errors: result };
		if (result.length > 0) {
			out.summary = summariseDrcEntries(result);
			if (isGrouped(result)) out.note = GROUPED_NOTE;
		}
		return out;
	}
	return result;
}
