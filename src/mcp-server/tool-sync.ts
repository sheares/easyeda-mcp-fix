// Which tools the stdio proxy must add, replace or remove after the daemon
// reconnects with a new tool list. Pure module so it can be unit-tested.

import type { ToolDescriptor } from '../bridge-daemon/protocol';

/** Everything the proxy registers for a tool; a change in any of it needs a re-registration. */
export function toolFingerprint(d: ToolDescriptor): string {
	return JSON.stringify([d.description, d.inputSchema, d.annotations ?? null]);
}

export interface ToolSyncPlan {
	add: ToolDescriptor[];
	replace: ToolDescriptor[];
	remove: string[];
}

/**
 * @param registered - fingerprint per tool name currently registered
 * @param latest - the daemon's current tool list
 */
export function planToolSync(registered: ReadonlyMap<string, string>, latest: readonly ToolDescriptor[]): ToolSyncPlan {
	const plan: ToolSyncPlan = { add: [], replace: [], remove: [] };
	const seen = new Set<string>();
	for (const d of latest) {
		seen.add(d.name);
		const before = registered.get(d.name);
		if (before === undefined) plan.add.push(d);
		else if (before !== toolFingerprint(d)) plan.replace.push(d);
	}
	for (const name of registered.keys()) if (!seen.has(name)) plan.remove.push(name);
	return plan;
}
