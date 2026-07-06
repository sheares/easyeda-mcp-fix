export interface ParsedNetlistComponent {
	designator: string;
	part: string;
	manufacturerPart: string;
	allProps: Record<string, any>; // all raw properties from the netlist
	pins: Record<string, string>; // pinNumber → netName (unconnected pins omitted)
}

// Keyed by component uniqueId
export type ParsedNetlist = Record<string, ParsedNetlistComponent>;

/**
 * Parse a raw netlist JSON string into ParsedNetlist.
 *
 * Handles both wire formats:
 * - getNetlistFile (v2.0.0): `{version, components: {uid: {props, pinInfoMap:
 *   {pinNumber: {name, number, net, props}}}}, designRule, ...}`. Unconnected
 *   pins carry `net: ""` and are omitted so they can't be mistaken for a
 *   shared net.
 * - deprecated getNetlist (fallback path only): flat `{uid: {props, pins:
 *   {pinNumber: netName}}}`.
 */
export function parseRawNetlist(raw: unknown): ParsedNetlist {
	const data: Record<string, any> = typeof raw === 'string' ? JSON.parse(raw) : (raw as any);
	const isV2 = data != null && typeof data.version === 'string' && data.components != null && typeof data.components === 'object';
	const components: Record<string, any> = isV2 ? data.components : (data ?? {});
	const result: ParsedNetlist = {};
	for (const [uniqueId, entry] of Object.entries(components)) {
		if (!entry || typeof entry !== 'object') continue;
		const props = (entry as any).props || {};
		const pins: Record<string, string> = {};
		const pinInfoMap = (entry as any).pinInfoMap;
		if (pinInfoMap && typeof pinInfoMap === 'object') {
			for (const [pinNumber, pin] of Object.entries(pinInfoMap)) {
				const net = (pin as any)?.net;
				if (typeof net === 'string' && net !== '') pins[pinNumber] = net;
			}
		} else if ((entry as any).pins && typeof (entry as any).pins === 'object') {
			Object.assign(pins, (entry as any).pins);
		}
		result[uniqueId] = {
			designator: props.Designator || '',
			part: props.Name || '',
			manufacturerPart: props['Manufacturer Part'] || '',
			allProps: props,
			pins,
		};
	}
	return result;
}
