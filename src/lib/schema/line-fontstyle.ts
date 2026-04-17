import { z } from 'zod';

/**
 * FONTSTYLE line. Many trailing positional fields; kept loose for MVP —
 * the lib only cares about the style ID (referenced from ATTR lines).
 * Example: ["FONTSTYLE","st6",null,null,null,null,0,0,0,null,2,0]
 */
export const FontStyleLine = z.tuple([
	z.literal('FONTSTYLE'),
	z.string(),              // styleId (e.g. "st6")
]).rest(z.unknown());

export type FontStyleLine = z.infer<typeof FontStyleLine>;
