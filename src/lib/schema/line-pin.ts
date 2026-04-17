import { z } from 'zod';

/**
 * PIN line (symbol files only).
 * Shape: ["PIN", elementId, ?, ?, x, y, length, angle, ?, ?, ?]
 * Example: ["PIN","e5",1,null,-180,20,10,0,null,0,0]
 */
export const PinLine = z.tuple([
	z.literal('PIN'),
	z.string(),      // elementId
	z.unknown(),
	z.unknown(),
	z.number(),      // x
	z.number(),      // y
	z.number(),      // length
	z.number(),      // angle (degrees, 0/90/180/270)
]).rest(z.unknown());

export type PinLine = z.infer<typeof PinLine>;
