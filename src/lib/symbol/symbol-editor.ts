/**
 * High-level mutator for EasyEDA symbol (.esym) sources.
 *
 * Loads a symbol, lets you find pins by name/number/predicate, and lets you
 * mutate the FONTSTYLE applied to each pin's NAME/NUMBER label. When mutating
 * a FONTSTYLE that's shared across multiple ATTRs, automatically forks off a
 * fresh FONTSTYLE so unrelated labels keep their original style — mirroring
 * EasyEDA's own behavior when you change formatting on a single label in the UI.
 *
 * Untouched lines round-trip byte-identically (the underlying parser preserves
 * `raw` strings and only re-stringifies lines explicitly marked `mutated`).
 */

import { parseEsymSource, serializeEsymLines, type EsymLine } from '../schema/esym';
import type { FontStyleLine } from '../schema/line-fontstyle';
import type { AttrLine } from '../schema/line-attr';
import type { ParsedLine } from '../schema/types';
import { wrapAsParsedLine } from '../schema/parser';
import {
	fontStyleFromTuple,
	fontStyleToTuple,
	mergeFontStyle,
	type FontStyleSpec,
} from './font-style';

export interface SymbolPin {
	pinId: string;
	number: string;
	name: string;
	pinType: string;
	x: number;
	y: number;
	length: number;
	angle: number;
	nameAttrId: string | null;
	numberAttrId: string | null;
	pinTypeAttrId: string | null;
}

export type PinPredicate = (pin: SymbolPin) => boolean;

export class SymbolEditor {
	private parsed: ParsedLine<EsymLine>[];
	private pins = new Map<string, SymbolPin>();
	private attrs = new Map<string, AttrLine>();
	private fontStyles = new Map<string, FontStyleLine>();
	private lineByEid = new Map<string, number>();
	private lineByFsId = new Map<string, number>();

	private constructor(parsed: ParsedLine<EsymLine>[]) {
		this.parsed = parsed;
		this.indexAll();
	}

	static load(source: string): SymbolEditor {
		const { lines, report } = parseEsymSource(source);
		if (report.invalidCount > 0) {
			const issue = report.samples.invalid[0];
			throw new Error(
				`Symbol source has ${report.invalidCount} invalid line(s); first: ${issue?.reason ?? 'unknown'}`,
			);
		}
		return new SymbolEditor(lines);
	}

	private indexAll(): void {
		this.pins.clear();
		this.attrs.clear();
		this.fontStyles.clear();
		this.lineByEid.clear();
		this.lineByFsId.clear();

		for (let i = 0; i < this.parsed.length; i++) {
			const ln = this.parsed[i];
			if (ln.kind !== 'known') continue;
			const d = ln.data as readonly unknown[];
			const tag = d[0];

			if (tag === 'PIN') {
				const pinId = d[1] as string;
				const pin: SymbolPin = {
					pinId,
					number: '',
					name: '',
					pinType: '',
					x: d[4] as number,
					y: d[5] as number,
					length: d[6] as number,
					angle: d[7] as number,
					nameAttrId: null,
					numberAttrId: null,
					pinTypeAttrId: null,
				};
				this.pins.set(pinId, pin);
				this.lineByEid.set(pinId, i);
			} else if (tag === 'ATTR') {
				const attr = ln.data as AttrLine;
				const eid = attr[1] as string;
				const parentId = attr[2] as string;
				const attrName = attr[3] as string;
				const value = attr[4];
				this.attrs.set(eid, attr);
				this.lineByEid.set(eid, i);
				const parent = this.pins.get(parentId);
				if (parent) {
					if (attrName === 'NAME') {
						parent.name = String(value ?? '');
						parent.nameAttrId = eid;
					} else if (attrName === 'NUMBER') {
						parent.number = String(value ?? '');
						parent.numberAttrId = eid;
					} else if (attrName === 'Pin Type') {
						parent.pinType = String(value ?? '');
						parent.pinTypeAttrId = eid;
					}
				}
			} else if (tag === 'FONTSTYLE') {
				const fs = ln.data as FontStyleLine;
				const id = fs[1] as string;
				this.fontStyles.set(id, fs);
				this.lineByFsId.set(id, i);
			}
		}
	}

	getAllPins(): SymbolPin[] {
		return Array.from(this.pins.values());
	}

	findPins(predicate: PinPredicate): SymbolPin[] {
		return this.getAllPins().filter(predicate);
	}

	/**
	 * Read the resolved FONTSTYLE spec for a NAME or NUMBER ATTR. Returns null
	 * if the ATTR has no font-style reference.
	 */
	getAttrFontStyle(attrEid: string): FontStyleSpec | null {
		const attr = this.attrs.get(attrEid);
		if (!attr) throw new Error(`No ATTR with id ${attrEid}`);
		const fsId = attr[10] as string | null;
		if (!fsId) return null;
		const fs = this.fontStyles.get(fsId);
		if (!fs) throw new Error(`ATTR ${attrEid} references missing FONTSTYLE ${fsId}`);
		return fontStyleFromTuple(fs);
	}

	/**
	 * Apply a partial FontStyleSpec to a single ATTR's font style. If the
	 * referenced FONTSTYLE is shared with other ATTRs, fork a fresh FONTSTYLE
	 * and rebind this ATTR to it; if it's the sole user, mutate in place.
	 *
	 * Doesn't fork when the resulting spec equals the current spec — keeps
	 * the round-trip byte-identical for no-op updates.
	 */
	updateAttrStyle(attrEid: string, partial: Partial<FontStyleSpec>): void {
		const attr = this.attrs.get(attrEid);
		if (!attr) throw new Error(`No ATTR with id ${attrEid}`);
		const currentFsId = attr[10] as string | null;
		if (!currentFsId) throw new Error(`ATTR ${attrEid} has no fontStyleId — cannot style`);
		const currentFs = this.fontStyles.get(currentFsId);
		if (!currentFs) throw new Error(`ATTR ${attrEid} references missing FONTSTYLE ${currentFsId}`);

		const baseSpec = fontStyleFromTuple(currentFs);
		const newSpec = mergeFontStyle(baseSpec, partial);

		// Fast path: no actual change → leave everything alone (preserves byte
		// identity for unchanged lines).
		if (specsTupleEqual(currentFs, newSpec)) return;

		const refs = this.countFontStyleRefs(currentFsId);
		if (refs === 1) {
			const newTuple = fontStyleToTuple(currentFsId, newSpec);
			this.replaceLineByFsId(currentFsId, newTuple);
		} else {
			const newId = this.allocFontStyleId();
			const newTuple = fontStyleToTuple(newId, newSpec);
			this.insertFontStyleAfter(currentFsId, newTuple);
			const newAttr = [...attr] as unknown as AttrLine;
			(newAttr as unknown[])[10] = newId;
			this.replaceLineByEid(attrEid, newAttr);
		}
	}

	/** Convenience: update NAME styles for all matching pins. */
	updateNameStyle(predicate: PinPredicate, partial: Partial<FontStyleSpec>): number {
		let count = 0;
		for (const pin of this.findPins(predicate)) {
			if (!pin.nameAttrId) continue;
			this.updateAttrStyle(pin.nameAttrId, partial);
			count++;
		}
		return count;
	}

	/** Convenience: update NUMBER styles for all matching pins. */
	updateNumberStyle(predicate: PinPredicate, partial: Partial<FontStyleSpec>): number {
		let count = 0;
		for (const pin of this.findPins(predicate)) {
			if (!pin.numberAttrId) continue;
			this.updateAttrStyle(pin.numberAttrId, partial);
			count++;
		}
		return count;
	}

	serialize(): string {
		return serializeEsymLines(this.parsed);
	}

	private countFontStyleRefs(fsId: string): number {
		let n = 0;
		for (const a of this.attrs.values()) {
			if ((a as unknown[])[10] === fsId) n++;
		}
		return n;
	}

	private allocFontStyleId(): string {
		let max = 0;
		for (const id of this.fontStyles.keys()) {
			const m = id.match(/^st(\d+)$/);
			if (m) max = Math.max(max, parseInt(m[1], 10));
		}
		return `st${max + 1}`;
	}

	private replaceLineByEid(eid: string, newLine: AttrLine): void {
		const idx = this.lineByEid.get(eid);
		if (idx == null) throw new Error(`No line for element ${eid}`);
		this.parsed[idx] = wrapAsParsedLine<EsymLine>(newLine as EsymLine);
		this.attrs.set(eid, newLine);
	}

	private replaceLineByFsId(fsId: string, newLine: FontStyleLine): void {
		const idx = this.lineByFsId.get(fsId);
		if (idx == null) throw new Error(`No line for FONTSTYLE ${fsId}`);
		this.parsed[idx] = wrapAsParsedLine<EsymLine>(newLine as EsymLine);
		this.fontStyles.set(fsId, newLine);
	}

	private insertFontStyleAfter(neighborFsId: string, newLine: FontStyleLine): void {
		const neighborIdx = this.lineByFsId.get(neighborFsId);
		if (neighborIdx == null) throw new Error(`No line for FONTSTYLE ${neighborFsId}`);
		const insertAt = neighborIdx + 1;
		this.parsed.splice(insertAt, 0, wrapAsParsedLine<EsymLine>(newLine as EsymLine));
		// Shift indexes of everything at or after insertAt.
		for (const [k, v] of this.lineByEid) {
			if (v >= insertAt) this.lineByEid.set(k, v + 1);
		}
		for (const [k, v] of this.lineByFsId) {
			if (v >= insertAt) this.lineByFsId.set(k, v + 1);
		}
		const newId = newLine[1] as string;
		this.fontStyles.set(newId, newLine);
		this.lineByFsId.set(newId, insertAt);
	}
}

function specsTupleEqual(currentFs: FontStyleLine, newSpec: FontStyleSpec): boolean {
	const id = currentFs[1] as string;
	const newTuple = fontStyleToTuple(id, newSpec);
	if (newTuple.length !== currentFs.length) return false;
	for (let i = 0; i < newTuple.length; i++) {
		if ((newTuple as unknown[])[i] !== (currentFs as unknown[])[i]) return false;
	}
	return true;
}
