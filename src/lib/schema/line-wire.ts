import { z } from 'zod';

/**
 * WIRE line.
 * Shape: ["WIRE", elementId, segments: number[][], lineStyleId, layer]
 * Example: ["WIRE","e4711",[[900,875,900,855],[900,855,1000,855]],"st9",0]
 *
 * Zero-length segments (x1==x2 && y1==y2) are junction markers.
 */
export const WireLine = z.tuple([
	z.literal('WIRE'),
	z.string(),                                      // elementId
	z.array(z.array(z.number())),                    // segments: [[x1,y1,x2,y2], ...]
	z.string(),                                      // lineStyleId
	z.number(),                                      // layer
]).rest(z.unknown());

export type WireLine = z.infer<typeof WireLine>;

/** Constructor args for `makeWireLine`. */
export interface WireLineArgs {
	elementId: string;
	segments: number[][];
	lineStyleId: string;
	layer?: number;
}

/**
 * Build a typed WIRE tuple. See ComponentLineArgs / makeComponentLine docs
 * for the rationale behind the `z.input<typeof …>` cast.
 */
export function makeWireLine(args: WireLineArgs): WireLine {
	const tuple: z.input<typeof WireLine> = [
		'WIRE',
		args.elementId,
		args.segments,
		args.lineStyleId,
		args.layer ?? 0,
	];
	return WireLine.parse(tuple);
}
