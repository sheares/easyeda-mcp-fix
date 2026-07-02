// EDA Pro's PrimitiveComponent.modify() re-serialises the component from the
// property argument alone: any field absent from that argument is destructively
// rewritten — supplierId becomes the symbol filename and otherProperty (BOM
// data: Value, LCSC part, tolerance, voltage, datasheet) is blanked. The guard
// snapshots these fields before the write and merges back any the caller
// omitted. Caller-supplied values always win, so an explicit change still
// applies; only a field the caller leaves undefined is restored.

export const BASE_METADATA_PRESERVE_FIELDS = [
	'supplierId',
	'otherProperty',
	'manufacturer',
	'manufacturerId',
	'supplier',
	'uniqueId',
] as const;

interface PrimitiveComponentApi {
	get: (ids: string[]) => Promise<any>;
	modify: (primitiveId: string, property: Record<string, any>) => Promise<any>;
}

export async function preserveMetadataOnModify(
	api: PrimitiveComponentApi,
	fields: readonly string[],
	primitiveId: string,
	property: Record<string, any>,
): Promise<any> {
	const before: any = await api.get([primitiveId]);
	const snapshot = Array.isArray(before) ? before[0] : before;
	const merged: Record<string, any> = { ...property };
	if (snapshot) {
		for (const key of fields) {
			if (merged[key] === undefined && snapshot[key] !== undefined) {
				merged[key] = snapshot[key];
			}
		}
	}
	return api.modify(primitiveId, merged);
}
