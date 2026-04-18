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

/**
 * Constructor args for `makeAttrLine`. The ATTR tuple has two positions whose
 * meaning we don't fully model yet — exposed as `trailingSlot5` (position 5)
 * and `trailingSlot9` (position 9). Both default to null. Tighten when ATTR
 * narrowing-by-attrName lands.
 */
export interface AttrLineArgs {
	elementId: string;
	parentId: string;
	attrName: string;
	value: unknown;
	visible?: unknown;
	x?: unknown;
	y?: unknown;
	fontStyleId: string | null;
	layer?: number;
	trailingSlot5?: unknown;
	trailingSlot9?: unknown;
}

/**
 * Build a typed ATTR tuple. See ComponentLineArgs / makeComponentLine docs for
 * the rationale behind the `z.input<typeof …>` cast.
 */
export function makeAttrLine(args: AttrLineArgs): AttrLine {
	const tuple: z.input<typeof AttrLine> = [
		'ATTR',
		args.elementId,
		args.parentId,
		args.attrName,
		args.value,
		args.trailingSlot5 ?? null,
		args.visible ?? null,
		args.x ?? null,
		args.y ?? null,
		args.trailingSlot9 ?? null,
		args.fontStyleId,
		args.layer ?? 0,
	];
	return AttrLine.parse(tuple);
}
