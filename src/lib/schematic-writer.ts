/**
 * Applies edits to an EasyEDA Pro .esch schematic source.
 *
 * Handles all low-level invariants automatically:
 * - Element ID allocation (sequential eN)
 * - Unique ID assignment (ggeN)
 * - Junction wire creation at component-to-component connections
 * - maxId bookkeeping in HEAD
 *
 * Usage:
 *   const { source, model } = loadSchematic('/tmp/project', schUuid);
 *   const writer = new SchematicWriter(source, model);
 *   writer.addNetport("FPGA_TCK", "U2.16");           // auto-position from pin
 *   writer.addSeriesResistor("0402WGF220JTCE", "U2.16", "FPGA_TCK"); // auto-designator
 *   const newSource = writer.serialize();
 *
 * New lines are built via schema-validated factories — a broken tuple shape
 * throws at construction time, not later when EasyEDA rejects the upload.
 */

import { SchematicModel, ComponentInfo, PinInfo } from './schematic-reader';
import {
	EschLine,
	HeadLine,
	makeComponentLine as buildComponentTuple,
	makeAttrLine as buildAttrTuple,
	makeWireLine as buildWireTuple,
	parseEschSource,
	serializeEschLines,
	wrapAsParsedLine,
	type ComponentLineArgs,
	type AttrLineArgs,
	type WireLineArgs,
	type ParsedLine,
	type ValidationReport,
} from './schema';

/**
 * Local wrappers that adapt the public schema factories (which return bare
 * validated tuples) to the writer's `ParsedLine<EschLine>[]` stream. Kept
 * inline so `appendedLines.push(makeXxxLine({...}))` reads naturally at the
 * call sites. Type errors at construction time bubble up from the underlying
 * factories' `z.input<typeof XLine>` casts.
 */
const makeComponentLine = (args: ComponentLineArgs): ParsedLine<EschLine> =>
	wrapAsParsedLine<EschLine>(buildComponentTuple(args));
const makeAttrLine = (args: AttrLineArgs): ParsedLine<EschLine> =>
	wrapAsParsedLine<EschLine>(buildAttrTuple(args));
const makeWireLine = (args: WireLineArgs): ParsedLine<EschLine> =>
	wrapAsParsedLine<EschLine>(buildWireTuple(args));

export class SchematicWriter {
	private model: SchematicModel;
	/** Parsed lines from the original source. Mutations are applied in place (e.g. HEAD.maxId). */
	private lines: ParsedLine<EschLine>[];
	/** New lines appended at the end on serialize. */
	private appendedLines: ParsedLine<EschLine>[] = [];
	/** Line indices in `lines` to skip on serialize. */
	private removedLineIndices = new Set<number>();
	private nextElementId: number;
	private nextGgeId: number;
	private nextDesignatorNum: Record<string, number> = {};

	constructor(_source: string, model: SchematicModel) {
		this.model = model;
		this.lines = model.parsedLines;
		this.nextElementId = model.maxId + 1;
		this.nextGgeId = model.maxGgeId + 1;

		// Scan existing designators to find the next available number per prefix
		for (const comp of model.components) {
			if (!comp.designator) continue;
			const match = comp.designator.match(/^([A-Z]+)(\d+)$/);
			if (match) {
				const prefix = match[1];
				const num = parseInt(match[2], 10);
				this.nextDesignatorNum[prefix] = Math.max(
					this.nextDesignatorNum[prefix] ?? 0,
					num + 1,
				);
			}
		}
	}

	/** Allocate the next sequential element ID */
	private allocId(): string {
		return `e${this.nextElementId++}`;
	}

	/** Allocate the next unique component ID */
	private allocGgeId(): string {
		return `gge${this.nextGgeId++}`;
	}

	/** Allocate the next designator for a given prefix (e.g., "R" -> "R25") */
	allocDesignator(prefix: string): string {
		const num = this.nextDesignatorNum[prefix] ?? 1;
		this.nextDesignatorNum[prefix] = num + 1;
		return `${prefix}${num}`;
	}

	/**
	 * Find a component by designator (e.g., "U2") or element ID (e.g., "e4422").
	 */
	findComponent(ref: string): ComponentInfo | undefined {
		return this.model.components.find(
			(c) => c.designator === ref || c.elementId === ref,
		);
	}

	/**
	 * Find a specific pin on a component.
	 * @param ref - "U2.16" (designator.pinNumber) or "U2:TCK" (designator:pinName)
	 */
	findPin(ref: string): { component: ComponentInfo; pin: PinInfo } | undefined {
		const dotIdx = ref.indexOf('.');
		const colonIdx = ref.indexOf(':');

		if (dotIdx > 0) {
			const desig = ref.slice(0, dotIdx);
			const pinNum = ref.slice(dotIdx + 1);
			const comp = this.findComponent(desig);
			if (!comp) return undefined;
			const pin = comp.pins.find((p) => p.number === pinNum);
			return pin ? { component: comp, pin } : undefined;
		}

		if (colonIdx > 0) {
			const desig = ref.slice(0, colonIdx);
			const pinName = ref.slice(colonIdx + 1);
			const comp = this.findComponent(desig);
			if (!comp) return undefined;
			const pin = comp.pins.find((p) => p.name === pinName);
			return pin ? { component: comp, pin } : undefined;
		}

		return undefined;
	}

	/**
	 * Determine the correct netport rotation for a pin, so the netport
	 * arrow points toward the component (IN-style).
	 *
	 * For IN-style netports, the arrow direction matches the pin's world angle —
	 * pin stub pointing right (angle 0) -> netport rotation 0 (arrow points right toward chip).
	 */
	private netportRotationForPin(pin: PinInfo): number {
		return pin.worldAngle;
	}

	/**
	 * Get the offset direction for placing things "outward" from a pin
	 * (away from the component body, along the pin stub direction).
	 * Coordinate system: +X = right, +Y = up. Angles CCW from +X.
	 */
	private pinOutwardOffset(pin: PinInfo, distance: number): [number, number] {
		switch (pin.worldAngle) {
			case 0: return [-distance, 0];    // pin stub points right; outward = left (-X)
			case 90: return [0, -distance];   // pin stub points up; outward = down (-Y)
			case 180: return [distance, 0];   // pin stub points left; outward = right (+X)
			case 270: return [0, distance];   // pin stub points down; outward = up (+Y)
			default: return [-distance, 0];
		}
	}

	/**
	 * Add a netport at a specific position.
	 */
	addNetportAt(netName: string, x: number, y: number, rotation: number): void {
		const np = this.model.palette.netport;
		if (!np) throw new Error('No netport template found in schematic palette');

		const compId = this.allocId();
		const wireId = this.allocId();

		const symFs = np.fontStyles['Symbol'] || 'st7';
		const nameFs = np.fontStyles['Name'] || 'st8';
		const devFs = np.fontStyles['Device'] || 'st5';

		this.appendedLines.push(
			makeComponentLine({
				elementId: compId, partName: '',
				x, y, rotation,
			}),
			makeAttrLine({
				elementId: this.allocId(), parentId: compId,
				attrName: 'Symbol', value: np.symbolUuid, fontStyleId: symFs,
			}),
			makeAttrLine({
				elementId: this.allocId(), parentId: compId,
				attrName: 'Name', value: netName, fontStyleId: nameFs,
			}),
			makeAttrLine({
				elementId: this.allocId(), parentId: compId,
				attrName: 'Device', value: np.deviceUuid,
				visible: 0, trailingSlot5: 0, trailingSlot9: 0, fontStyleId: devFs,
			}),
			makeAttrLine({
				elementId: this.allocId(), parentId: compId,
				attrName: 'Relevance', value: '[]',
				visible: 0, trailingSlot5: 0, x, y, trailingSlot9: 0, fontStyleId: 'st4',
			}),
			makeWireLine({
				elementId: wireId,
				segments: [[x, y, x, y]],
				lineStyleId: this.model.palette.wireLineStyle,
			}),
			makeAttrLine({
				elementId: this.allocId(), parentId: wireId,
				attrName: 'NET', value: netName,
				visible: 0, trailingSlot5: 0, x, y, trailingSlot9: 90, fontStyleId: 'st4',
			}),
		);
	}

	/**
	 * Add a netport connected to a specific component pin.
	 * Automatically computes position and rotation.
	 */
	addNetport(netName: string, pinRef: string): void {
		const found = this.findPin(pinRef);
		if (!found) throw new Error(`Pin not found: ${pinRef}`);
		const { pin } = found;

		const rotation = this.netportRotationForPin(pin);
		this.addNetportAt(netName, pin.worldX, pin.worldY, rotation);
	}

	/**
	 * Add a zero-length junction wire at a point.
	 * Required when two component pins overlap to create an electrical connection.
	 */
	addJunctionWire(x: number, y: number): void {
		this.appendedLines.push(
			makeWireLine({
				elementId: this.allocId(),
				segments: [[x, y, x, y]],
				lineStyleId: this.model.palette.wireLineStyle,
			}),
		);
	}

	/**
	 * Add a component instance from the palette.
	 * @param partName - Base part name (e.g., "0402WGF220JTCE")
	 * @param designator - Designator to assign (e.g., "R25")
	 * @param x - World X position
	 * @param y - World Y position
	 * @param rotation - Rotation (0/90/180/270)
	 */
	addComponent(partName: string, designator: string, x: number, y: number, rotation: number = 0): void {
		const template = this.model.palette.components[partName];
		if (!template) throw new Error(`Part "${partName}" not found in schematic palette. Available: ${Object.keys(this.model.palette.components).join(', ')}`);

		const compId = this.allocId();
		const ggeId = this.allocGgeId();

		const symFs = template.fontStyles['Symbol'] || template.fontStyles['Designator'] || 'st6';
		const desigFs = template.fontStyles['Designator'] || 'st6';
		const devFs = template.fontStyles['Device'] || 'st5';

		this.appendedLines.push(
			makeComponentLine({
				elementId: compId, partName: `${partName}.1`, x, y, rotation,
			}),
			makeAttrLine({
				elementId: this.allocId(), parentId: compId,
				attrName: 'Symbol', value: template.symbolUuid, fontStyleId: symFs,
			}),
			makeAttrLine({
				elementId: this.allocId(), parentId: compId,
				attrName: 'Designator', value: designator,
				visible: 1, x, y: y + 10, fontStyleId: desigFs,
			}),
			makeAttrLine({
				elementId: this.allocId(), parentId: compId,
				attrName: 'Name', value: null,
				visible: 1, x, y: y - 10, fontStyleId: 'st4',
			}),
			makeAttrLine({
				elementId: this.allocId(), parentId: compId,
				attrName: 'Device', value: template.deviceUuid,
				visible: 0, trailingSlot5: 0, trailingSlot9: 0, fontStyleId: devFs,
			}),
			makeAttrLine({
				elementId: this.allocId(), parentId: compId,
				attrName: 'Reuse Block', value: '',
				visible: 0, trailingSlot5: 0, trailingSlot9: 0, fontStyleId: 'st4',
			}),
			makeAttrLine({
				elementId: this.allocId(), parentId: compId,
				attrName: 'Group ID', value: '',
				visible: 0, trailingSlot5: 0, trailingSlot9: 0, fontStyleId: 'st4',
			}),
			makeAttrLine({
				elementId: this.allocId(), parentId: compId,
				attrName: 'Channel ID', value: '',
				visible: 0, trailingSlot5: 0, trailingSlot9: 0, fontStyleId: 'st4',
			}),
			makeAttrLine({
				elementId: this.allocId(), parentId: compId,
				attrName: 'Unique ID', value: ggeId,
				visible: 0, trailingSlot5: 0, trailingSlot9: 0, fontStyleId: 'st4',
			}),
		);
	}

	/**
	 * Add a resistor in series between a component pin and a netport.
	 *
	 * Places the resistor adjacent to the pin, with the netport beyond it.
	 * Automatically adds a junction wire at the pin-resistor connection.
	 *
	 * @param partName - Resistor part name in palette (e.g., "0402WGF220JTCE")
	 * @param pinRef - Pin reference (e.g., "U2.16" or "U2:TCK")
	 * @param netName - Net name for the netport
	 * @param designator - Resistor designator (e.g., "R25"). Auto-allocated if omitted.
	 */
	addSeriesResistor(partName: string, pinRef: string, netName: string, designator?: string): void {
		if (!designator) designator = this.allocDesignator('R');
		const found = this.findPin(pinRef);
		if (!found) throw new Error(`Pin not found: ${pinRef}`);
		const { pin } = found;

		// Resistor symbol: pin1 at (-20, 0), pin2 at (+20, 0), body from -10 to +10
		// At rotation 0, pin1 is on the left, pin2 on the right
		const RES_PIN_OFFSET = 20;

		// Place resistor so one pin touches the IC pin
		// The resistor orientation should be along the pin's outward direction
		const [outX, outY] = this.pinOutwardOffset(pin, RES_PIN_OFFSET);
		void outX; void outY; // consumed implicitly by the switch below

		let resRotation: number;
		let resCenterX: number;
		let resCenterY: number;
		let netportX: number;
		let netportY: number;

		// Resistor symbol at rotation 0: pin1 at x=-20 (left), pin2 at x=+20 (right)
		// At rotation 90: pin1 at y=-20 (bottom), pin2 at y=+20 (top)
		// We place the resistor so one pin touches the IC pin, the other faces outward.
		switch (pin.worldAngle) {
			case 0: // Pin stub points right; pin is on left side; outward = left (-X)
				resRotation = 0;
				resCenterX = pin.worldX - RES_PIN_OFFSET; // pin2 (+20) touches IC
				resCenterY = pin.worldY;
				netportX = resCenterX - RES_PIN_OFFSET;   // at pin1 (-20)
				netportY = pin.worldY;
				break;
			case 180: // Pin stub points left; pin is on right side; outward = right (+X)
				resRotation = 0;
				resCenterX = pin.worldX + RES_PIN_OFFSET; // pin1 (-20) touches IC
				resCenterY = pin.worldY;
				netportX = resCenterX + RES_PIN_OFFSET;   // at pin2 (+20)
				netportY = pin.worldY;
				break;
			case 90: // Pin stub points up; pin is on bottom; outward = down (-Y)
				resRotation = 90;
				resCenterX = pin.worldX;
				resCenterY = pin.worldY - RES_PIN_OFFSET; // pin2 (+20 rotated = top) touches IC
				netportX = pin.worldX;
				netportY = resCenterY - RES_PIN_OFFSET;   // at pin1 (-20 rotated = bottom)
				break;
			case 270: // Pin stub points down; pin is on top; outward = up (+Y)
				resRotation = 90;
				resCenterX = pin.worldX;
				resCenterY = pin.worldY + RES_PIN_OFFSET; // pin1 (-20 rotated = bottom) touches IC
				netportX = pin.worldX;
				netportY = resCenterY + RES_PIN_OFFSET;   // at pin2 (+20 rotated = top)
				break;
			default:
				throw new Error(`Unsupported pin angle: ${pin.worldAngle}`);
		}

		// Add the resistor
		this.addComponent(partName, designator, resCenterX, resCenterY, resRotation);

		// Add junction wire at the IC pin / resistor connection point
		this.addJunctionWire(pin.worldX, pin.worldY);

		// Add netport at the other end
		const netportRotation = this.netportRotationForPin(pin);
		this.addNetportAt(netName, netportX, netportY, netportRotation);
	}

	/**
	 * Add a power symbol (GND, VCC, etc.) to a component pin.
	 */
	addPowerSymbol(railName: string, pinRef: string): void {
		const found = this.findPin(pinRef);
		if (!found) throw new Error(`Pin not found: ${pinRef}`);
		const { pin } = found;

		const template = this.model.palette.powerSymbols[railName];
		if (!template) throw new Error(`Power symbol "${railName}" not found in palette. Available: ${Object.keys(this.model.palette.powerSymbols).join(', ')}`);

		const compId = this.allocId();
		const rotation = this.netportRotationForPin(pin);

		this.appendedLines.push(
			makeComponentLine({
				elementId: compId, partName: '',
				x: pin.worldX, y: pin.worldY, rotation,
			}),
			makeAttrLine({
				elementId: this.allocId(), parentId: compId,
				attrName: 'Symbol', value: template.symbolUuid, fontStyleId: 'st12',
			}),
			makeAttrLine({
				elementId: this.allocId(), parentId: compId,
				attrName: 'Device', value: template.deviceUuid,
				visible: 0, trailingSlot5: 0, trailingSlot9: 0, fontStyleId: 'st5',
			}),
			makeAttrLine({
				elementId: this.allocId(), parentId: compId,
				attrName: 'Name', value: railName,
				visible: 0, trailingSlot5: 0, trailingSlot9: 0, fontStyleId: 'st4',
			}),
			makeAttrLine({
				elementId: this.allocId(), parentId: compId,
				attrName: 'Relevance', value: '[]',
				visible: 0, trailingSlot5: 0, x: pin.worldX, y: pin.worldY, trailingSlot9: 0, fontStyleId: 'st4',
			}),
		);

		// Junction wire at the pin
		this.addJunctionWire(pin.worldX, pin.worldY);

		// Wire with NET attr
		const wireId = this.allocId();
		this.appendedLines.push(
			makeWireLine({
				elementId: wireId,
				segments: [[pin.worldX, pin.worldY, pin.worldX, pin.worldY]],
				lineStyleId: this.model.palette.wireLineStyle,
			}),
			makeAttrLine({
				elementId: this.allocId(), parentId: wireId,
				attrName: 'NET', value: railName,
				visible: 0, trailingSlot5: 0, x: pin.worldX, y: pin.worldY, trailingSlot9: 90, fontStyleId: 'st4',
			}),
		);
	}

	/**
	 * Remove lines by element ID — removes the element and all ATTRs that reference it.
	 */
	removeElement(elementId: string): void {
		for (const line of this.lines) {
			if (line.kind !== 'known') continue;
			const d = line.data;
			if (d[1] === elementId || d[2] === elementId) {
				this.removedLineIndices.add(line.lineIndex);
			}
		}
	}

	/**
	 * Serialize the modified schematic back to a string.
	 */
	serialize(): string {
		// Update HEAD.maxId in place (mutation).
		for (const line of this.lines) {
			if (line.kind !== 'known') continue;
			if (line.data[0] !== 'HEAD') continue;
			const meta = line.data[1] as { maxId?: number };
			const newMaxId = this.nextElementId - 1;
			if (meta.maxId !== newMaxId) {
				meta.maxId = newMaxId;
				line.mutated = true;
			}
			break;
		}

		// Skip removed lines; otherwise emit via the shared serializer.
		const keep = this.lines.filter((l) => !this.removedLineIndices.has(l.lineIndex));
		if (this.appendedLines.length === 0) return serializeEschLines(keep);
		// Insert appended lines BEFORE any trailing empty lines. A source that
		// ends with '\n' parses to a trailing blank line; naively concatenating
		// after it would emit an interior empty line between body and appended
		// content and drop the file's trailing newline.
		let cut = keep.length;
		while (cut > 0 && keep[cut - 1].kind === 'blank' && keep[cut - 1].raw === '') cut--;
		const merged = [...keep.slice(0, cut), ...this.appendedLines, ...keep.slice(cut)];
		return serializeEschLines(merged);
	}

	/**
	 * Run the .esch schema validator on the writer's current serialized output.
	 *
	 * Each new line built via the writer is already validated at construction
	 * time by the underlying schema factories — so a clean report here mostly
	 * confirms that mutations to existing lines (HEAD.maxId, removeElement)
	 * didn't break anything. Useful as a final pre-upload sanity check before
	 * pushing the source back to EasyEDA via document_set_source.
	 */
	validate(): ValidationReport {
		const { report } = parseEschSource(this.serialize());
		return report;
	}
}

// Re-exports kept for library consumers that imported these from writer previously.
export type { HeadLine };
