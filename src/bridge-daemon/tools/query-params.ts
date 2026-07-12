import { z } from 'zod';

const documentDescription =
	'Target document UUID — auto-switches to this document before executing. Get UUIDs from list_instances or editor_get_open_tabs.';

/**
 * Shared coordinate blurb for PCB tools (H6). Units verified against
 * @jlceda/pro-api-types remarks: PCB/footprint canvas coordinates are in mil
 * (schematic/symbol canvases use 0.01 inch); the API system data unit is mil
 * and does not change. Axis direction matches the verified schematic
 * convention in docs/schematic-format.md.
 */
export const PCB_COORD_NOTE =
	'Coordinates are PCB canvas coordinates in mil (1 mil = 0.001 inch), relative to the canvas origin: +X = rightward, +Y = upward. Lengths (widths, diameters) are also in mil. Use pcb_canvas_origin to read/set the origin offset and pcb_convert_coordinates to convert between canvas and data coordinates.';

/**
 * Instance ID parameter — added to every tool to support multi-instance routing.
 */
export const instanceParam = {
	instance_id: z
		.string()
		.optional()
		.describe(
			'Target EasyEDA instance ID (8-char hex). Required when multiple instances are connected. Omit when only one instance is connected (auto-selected). Use list_instances to see connected instances.',
		),
};

/**
 * Document parameter — required on pcb_* and sch_* tools so agents always
 * declare which document they're targeting, enabling safe multi-agent access.
 */
export const documentParam = {
	document: z.string().describe(documentDescription),
};

/**
 * Optional document parameter — for tools where a document context is useful
 * but not strictly required (e.g. editor tools).
 */
export const optionalDocumentParam = {
	document: z.string().optional().describe(documentDescription),
};

/**
 * Generic query parameters for post-processing results from data-returning tools.
 * These are extracted by the extension's ws-client before dispatching to handlers,
 * then applied as post-processing on the result.
 */
export const queryParams = {
	...instanceParam,
	...documentParam,
	fields: z
		.array(z.string())
		.optional()
		.describe(
			'Project results to only these top-level keys. Response includes _availableFields showing all keys. IMPORTANT: Always specify fields when you know what you need — without it, responses include every property and can be extremely large (100KB+), wasting context.',
		),
	filter: z
		.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]))
		.optional()
		.describe(
			'Keep items matching all conditions (AND). Exact: {key: value}, prefix glob: {key: "R*"}, OR: {key: ["a","b"]}',
		),
	limit: z
		.number()
		.int()
		.positive()
		.optional()
		.describe('Truncate result array to at most N items'),
};

/** Spread into a tool's params object to add query param support (includes required document). */
export function withQueryParams<T extends Record<string, z.ZodTypeAny>>(
	params: T,
): T & typeof queryParams {
	return { ...params, ...queryParams };
}

/** Add instance_id + required document to a tool's params. For pcb/sch tools that don't use withQueryParams. */
export function withDocumentParam<T extends Record<string, z.ZodTypeAny>>(
	params: T,
): T & typeof instanceParam & typeof documentParam {
	return { ...params, ...instanceParam, ...documentParam };
}

/** Add only instance_id to a tool's params. For tools that don't need a document (e.g. lib, editor). */
export function withInstanceParam<T extends Record<string, z.ZodTypeAny>>(
	params: T,
): T & typeof instanceParam {
	return { ...params, ...instanceParam };
}
