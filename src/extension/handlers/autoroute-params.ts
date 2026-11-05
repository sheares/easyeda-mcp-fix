// Maps the pcb_autoroute_start tool's plain-English options to EasyEDA's
// IPCB_AutoRoutingProps. Pure module (no `eda` imports) so it can be
// unit-tested directly.
//
// Enum values are from @jlceda/pro-api-types 0.4.27:
//   EPCB_AutoRoutingCornerStyle           DEGREE_45 = 0, DEGREE_90 = 1
//   EPCB_AutoRoutingExistingPrimitiveMode KEEP = 'keep', REMOVE = 'remove'
//   EPCB_AutoRoutingOptimization          COMPLETION = 1, FASTER = 0
// The runtime (pro-api 0.3.59) turns these into its own routing config and,
// when `layers` is absent, routes on every enabled SIGNAL and PLANE layer.

import { BridgeUserError } from '../diag';
import { toLayerId } from './pcb-params';

export interface AutorouteToolParams {
	nets?: string[] | 'selected' | 'selectedComponents';
	ignoreNets?: string[];
	layers?: Array<string | number>;
	corner?: '45' | '90';
	existing?: 'keep' | 'remove';
	optimise?: 'completion' | 'speed';
}

export interface AutoRoutingProps {
	RoutingNets?: 'selected' | 'selectedComponents' | string[];
	cornerStyle?: 0 | 1;
	existingPrimitiveMode?: 'keep' | 'remove';
	optimization?: 0 | 1;
	layers?: number[];
	ignoreNets?: string[];
}

export function toAutoRoutingProps(p: AutorouteToolParams): AutoRoutingProps {
	const out: AutoRoutingProps = {};
	if (p.nets !== undefined) out.RoutingNets = p.nets;
	if (p.ignoreNets !== undefined && p.ignoreNets.length > 0) out.ignoreNets = p.ignoreNets;
	if (p.corner !== undefined) out.cornerStyle = p.corner === '90' ? 1 : 0;
	if (p.existing !== undefined) out.existingPrimitiveMode = p.existing;
	if (p.optimise !== undefined) out.optimization = p.optimise === 'speed' ? 0 : 1;
	if (p.layers !== undefined) {
		if (p.layers.length === 0) {
			throw new BridgeUserError('layers is empty. Leave it out to route on every enabled copper layer, or list at least one (e.g. ["TopLayer", "BottomLayer"]).');
		}
		out.layers = p.layers.map((l) => {
			const id = toLayerId(l);
			if (typeof id !== 'number') throw new BridgeUserError(`Unknown routing layer ${JSON.stringify(l)}.`);
			return id;
		});
	}
	return out;
}
