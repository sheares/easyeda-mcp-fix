// AND-of-conditions filter for schematic component records. Matches
// ws-client.ts's generic query filter (exact / OR-array / prefix-glob) so
// callers get the same semantics whether they filter on a read tool or on
// the sch_swap_supplier_part write tool.
//
// Pure module (no `eda` imports) so it can be unit-tested directly.

export type MatchValue = string | number | boolean | string[];
export type MatchFilter = Record<string, MatchValue>;

export function matchesFilter(item: any, filter: MatchFilter): boolean {
	for (const [key, condition] of Object.entries(filter)) {
		const value = item?.[key];
		if (Array.isArray(condition)) {
			if (!condition.includes(String(value))) return false;
		} else if (typeof condition === 'string' && condition.endsWith('*')) {
			const prefix = condition.slice(0, -1);
			if (typeof value !== 'string' || !value.startsWith(prefix)) return false;
		} else {
			if (value !== condition) return false;
		}
	}
	return true;
}
