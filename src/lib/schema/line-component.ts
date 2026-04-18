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

/**
 * Constructor args for `makeComponentLine`. Each field maps to a position in
 * the ComponentLine tuple — keep in sync with the schema above. Optional
 * fields default to spec-canonical values (flip=0, options={}, layer=0).
 */
export interface ComponentLineArgs {
	elementId: string;
	partName: string;
	x: number;
	y: number;
	rotation: number;
	flip?: number;
	options?: Record<string, unknown>;
	layer?: number;
}

/**
 * Build a typed COMPONENT tuple. The intermediate `tuple` is typed as
 * `z.input<typeof ComponentLine>`, so a position/type mistake (wrong field
 * order, wrong literal type) fails at `tsc` time. `.parse()` is a runtime
 * backstop and produces the inferred output type for downstream use.
 */
export function makeComponentLine(args: ComponentLineArgs): ComponentLine {
	const tuple: z.input<typeof ComponentLine> = [
		'COMPONENT',
		args.elementId,
		args.partName,
		args.x,
		args.y,
		args.rotation,
		args.flip ?? 0,
		args.options ?? {},
		args.layer ?? 0,
	];
	return ComponentLine.parse(tuple);
}
