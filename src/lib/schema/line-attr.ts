import { z } from 'zod';

/**
 * ATTR line. Polymorphic on attrName at position 3; kept loose for MVP.
 * Shape: ["ATTR", elementId, parentId, attrName, value, ?, visible, x, y, ?, fontStyleId|null, layer]
 * Example: ["ATTR","e291","e267","Designator","R1",null,1,370,575,null,"st13",0]
 */
export const AttrLine = z.tuple([
	z.literal('ATTR'),
	z.string(),                  // elementId
	z.string(),                  // parentId
	z.string(),                  // attrName (the polymorphism discriminator)
	z.unknown(),                 // value (string | number | null | array | object)
	z.unknown(),                 // ?
	z.unknown(),                 // visible (0 | 1 | null)
	z.unknown(),                 // x override (number | null)
	z.unknown(),                 // y override (number | null)
	z.unknown(),                 // ?
	z.string().nullable(),       // fontStyleId (e.g. "st4") or null
	z.number(),                  // layer
]).rest(z.unknown());

export type AttrLine = z.infer<typeof AttrLine>;
