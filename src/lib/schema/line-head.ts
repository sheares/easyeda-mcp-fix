import { z } from 'zod';

/**
 * HEAD metadata. .esch documents carry originX/originY/version/maxId;
 * .esym documents carry symbolType as well. Kept loose (passthrough) so
 * unmodeled fields survive round-trip.
 */
export const HeadMeta = z.looseObject({
	originX: z.number().optional(),
	originY: z.number().optional(),
	version: z.string().optional(),
	maxId: z.number().optional(),
	symbolType: z.number().optional(),
});

export const HeadLine = z.tuple([
	z.literal('HEAD'),
	HeadMeta,
]).rest(z.unknown());

export type HeadLine = z.infer<typeof HeadLine>;
