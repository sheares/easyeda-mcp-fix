// EasyEDA 3.2.206 resolves fill and region create/modify with the values the
// caller sent, not what it stored. A fill is stored solid with a 0.2 outline
// whatever fillMode and lineWidth say, and a region keeps neither its name nor
// its line width. Re-read the primitive so the caller sees what is really on
// the board, and name the requested values that did not stick.

export async function readBackPrimitive(
	api: { get(primitiveId: string): Promise<any> },
	made: any,
	requested: Record<string, unknown>,
): Promise<any> {
	const id =
		made?.primitiveId ?? (typeof made?.getState_PrimitiveId === 'function' ? made.getState_PrimitiveId() : undefined);
	if (!id) return made;
	let stored: any;
	try {
		stored = await api.get(String(id));
	} catch {
		return made;
	}
	if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return made;
	const notApplied = Object.keys(requested).filter(
		(key) => requested[key] !== undefined && !sameValue(requested[key], stored[key]),
	);
	return notApplied.length > 0 ? { ...stored, notApplied } : stored;
}

// Rule-type arrays come back sorted, so compare them as sets.
function sameValue(a: unknown, b: unknown): boolean {
	if (Array.isArray(a) && Array.isArray(b)) {
		const key = (v: unknown[]) => v.map(String).sort().join('\u0000');
		return a.length === b.length && key(a) === key(b);
	}
	return a === b;
}
