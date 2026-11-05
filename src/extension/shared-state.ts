// Extension state kept on globalThis, stamped with the extension version.
// Pure module (no `eda` imports) so it can be unit-tested with ts-node.
//
// Why the stamp: globalThis outlives an extension reinstall in the same
// EasyEDA window, so without it a newer extension inherits objects built by
// the older one. Seen 5 Nov 2026: the ready-wait breaker that 1.7.0 tripped
// kept 1.7.1's new probe from ever running, until EasyEDA was restarted.
// A different (or missing) stamp rebuilds the value; the same stamp shares
// it, so a re-evaluated module still sees the state of the one it replaced.

/**
 * @param store - globalThis in the extension; any object in tests
 * @param version - the running extension's version
 */
export function versionedShared<T>(store: Record<string, unknown>, key: string, version: string, make: () => T): T {
	const slot = store[key] as { version?: unknown; value?: T } | null | undefined;
	if (slot && typeof slot === 'object' && slot.version === version) return slot.value as T;
	const value = make();
	store[key] = { version, value };
	return value;
}
