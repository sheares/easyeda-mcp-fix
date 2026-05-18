/**
 * Semantic representation of an EasyEDA FONTSTYLE tuple.
 *
 * Tuple layout (decoded empirically 2026-04-19):
 *   ["FONTSTYLE", id, ?, color, family, size, italic, bold, underline, ?, vAlign, hAlign]
 *      slot 0    1   2    3      4     5     6      7      8       9    10      11
 *
 * Slot 2 and slot 9 always observed as null. Treated as opaque pass-through.
 */

import { FontStyleLine } from '../schema/line-fontstyle';

export type VAlign = 'top' | 'middle' | 'bottom';
export type HAlign = 'left' | 'center' | 'right';

const V_TO_NUM: Record<VAlign, number> = { top: 0, middle: 1, bottom: 2 };
const NUM_TO_V: Record<number, VAlign> = { 0: 'top', 1: 'middle', 2: 'bottom' };

const H_TO_NUM: Record<HAlign, number> = { left: 0, center: 1, right: 2 };
const NUM_TO_H: Record<number, HAlign> = { 0: 'left', 1: 'center', 2: 'right' };

/**
 * High-level representation of a FONTSTYLE.
 *
 * `null` means "explicitly unset" (slot value is null in the tuple — render
 * with default). `false` for a flag means slot value is 0 (explicit off).
 * The distinction matters: `st_hidden`-style tuples have slots 6/7/8 as
 * literal null rather than 0.
 */
export interface FontStyleSpec {
	color: string | null;
	fontFamily: string | null;
	/** Font size in 1/100 inch units. null = renderer default (10 = 0.1"). */
	fontSize: number | null;
	italic: boolean | null;
	bold: boolean | null;
	underline: boolean | null;
	vAlign: VAlign | null;
	hAlign: HAlign | null;
	/** Opaque slot 2 — always null in observed data. Round-trip preserved. */
	slot2: unknown;
	/** Opaque slot 9 — always null in observed data. Round-trip preserved. */
	slot9: unknown;
}

/** Decode a FONTSTYLE tuple into a FontStyleSpec. */
export function fontStyleFromTuple(tuple: FontStyleLine): FontStyleSpec {
	const t = tuple as readonly unknown[];
	const slot6 = t[6];
	const slot7 = t[7];
	const slot8 = t[8];
	const slot10 = t[10];
	const slot11 = t[11];

	return {
		color: typeof t[3] === 'string' ? (t[3] as string) : null,
		fontFamily: typeof t[4] === 'string' ? (t[4] as string) : null,
		fontSize: typeof t[5] === 'number' ? (t[5] as number) : null,
		italic: slot6 == null ? null : slot6 === 1,
		bold: slot7 == null ? null : slot7 === 1,
		underline: slot8 == null ? null : slot8 === 1,
		vAlign: typeof slot10 === 'number' ? (NUM_TO_V[slot10] ?? null) : null,
		hAlign: typeof slot11 === 'number' ? (NUM_TO_H[slot11] ?? null) : null,
		slot2: t[2],
		slot9: t[9],
	};
}

/** Encode a FontStyleSpec into a FONTSTYLE tuple with the given id. */
export function fontStyleToTuple(id: string, spec: FontStyleSpec): FontStyleLine {
	const flag = (b: boolean | null): 0 | 1 | null => (b == null ? null : b ? 1 : 0);
	const tuple: unknown[] = [
		'FONTSTYLE',
		id,
		spec.slot2 ?? null,
		spec.color,
		spec.fontFamily,
		spec.fontSize,
		flag(spec.italic),
		flag(spec.bold),
		flag(spec.underline),
		spec.slot9 ?? null,
		spec.vAlign != null ? V_TO_NUM[spec.vAlign] : null,
		spec.hAlign != null ? H_TO_NUM[spec.hAlign] : null,
	];
	return tuple as FontStyleLine;
}

/**
 * Apply a partial FontStyleSpec on top of a base spec. Fields explicitly set
 * in `partial` (including to null) override the base; absent fields keep
 * their base value.
 */
export function mergeFontStyle(base: FontStyleSpec, partial: Partial<FontStyleSpec>): FontStyleSpec {
	const out: FontStyleSpec = { ...base };
	for (const key of Object.keys(partial) as Array<keyof FontStyleSpec>) {
		if (partial[key] !== undefined) {
			(out as any)[key] = partial[key];
		}
	}
	return out;
}

/** Structural equality between two specs (including opaque slot 2 / slot 9). */
export function fontStyleEquals(a: FontStyleSpec, b: FontStyleSpec): boolean {
	return (
		a.color === b.color &&
		a.fontFamily === b.fontFamily &&
		a.fontSize === b.fontSize &&
		a.italic === b.italic &&
		a.bold === b.bold &&
		a.underline === b.underline &&
		a.vAlign === b.vAlign &&
		a.hAlign === b.hAlign &&
		(a.slot2 ?? null) === (b.slot2 ?? null) &&
		(a.slot9 ?? null) === (b.slot9 ?? null)
	);
}
