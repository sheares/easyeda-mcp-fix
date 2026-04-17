import { z } from 'zod';

/**
 * COMPONENT line.
 * Shape: ["COMPONENT", elementId, partName, x, y, rotation, flip, options, layer]
 * Example: ["COMPONENT","e4422","CH572D.1",1180,885,0,0,{},0]
 *
 * Empty partName ("") indicates a netport or power symbol instance.
 */
export const ComponentLine = z.tuple([
	z.literal('COMPONENT'),
	z.string(),                                   // elementId
	z.string(),                                   // partName
	z.number(),                                   // x
	z.number(),                                   // y
	z.number(),                                   // rotation (0/90/180/270)
	z.number(),                                   // flip (0|1)
	z.record(z.string(), z.unknown()),            // options
	z.number(),                                   // layer
]).rest(z.unknown());

export type ComponentLine = z.infer<typeof ComponentLine>;
