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
 */

import { SchematicModel, ComponentInfo, PinInfo } from './schematic-reader';

interface NewLine {
	content: string;
}

export class SchematicWriter {
	private model: SchematicModel;
	private originalLines: string[];
	private appendedLines: NewLine[] = [];
	private removedLineIndices = new Set<number>();
	private nextElementId: number;
	private nextGgeId: number;
	private nextDesignatorNum: Record<string, number> = {};

	constructor(source: string, model: SchematicModel) {
		this.model = model;
		this.originalLines = source.split('\n');
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
	 * The netport should face the opposite direction from the pin stub:
	 * pin angle 0 (stub points right, pin is on left side) -> netport rotation 0 (points right, toward chip)
	 * pin angle 180 (stub points left, pin is on right side) -> netport rotation 180 (points left, toward chip)
	 * pin angle 90 (stub points up, pin is on bottom) -> netport rotation 90 (points up, toward chip)
	 * pin angle 270 (stub points down, pin is on top) -> netport rotation 270 (points down, toward chip)
	 *
	 * Wait — for IN-style netports, the arrow points in the same direction as the pin stub.
	 * The netport rotation matches the pin's world angle.
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
		const symAttrId = this.allocId();
		const nameAttrId = this.allocId();
		const devAttrId = this.allocId();
		const relAttrId = this.allocId();
		const wireId = this.allocId();
		const netAttrId = this.allocId();

		const symFs = np.fontStyles['Symbol'] || 'st7';
		const nameFs = np.fontStyles['Name'] || 'st8';
		const devFs = np.fontStyles['Device'] || 'st5';

		this.appendedLines.push(
			{ content: `["COMPONENT","${compId}","",${x},${y},${rotation},0,{},0]` },
			{ content: `["ATTR","${symAttrId}","${compId}","Symbol","${np.symbolUuid}",null,null,null,null,null,"${symFs}",0]` },
			{ content: `["ATTR","${nameAttrId}","${compId}","Name","${netName}",null,null,null,null,null,"${nameFs}",0]` },
			{ content: `["ATTR","${devAttrId}","${compId}","Device","${np.deviceUuid}",0,0,null,null,0,"${devFs}",0]` },
			{ content: `["ATTR","${relAttrId}","${compId}","Relevance","[]",0,0,${x},${y},0,"st4",0]` },
			{ content: `["WIRE","${wireId}",[[${x},${y},${x},${y}]],"${this.model.palette.wireLineStyle}",0]` },
			{ content: `["ATTR","${netAttrId}","${wireId}","NET","${netName}",0,0,${x},${y},90,"st4",0]` },
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
		const wireId = this.allocId();
		this.appendedLines.push({
			content: `["WIRE","${wireId}",[[${x},${y},${x},${y}]],"${this.model.palette.wireLineStyle}",0]`,
		});
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
			{ content: `["COMPONENT","${compId}","${partName}.1",${x},${y},${rotation},0,{},0]` },
			{ content: `["ATTR","${this.allocId()}","${compId}","Symbol","${template.symbolUuid}",null,null,null,null,null,"${symFs}",0]` },
			{ content: `["ATTR","${this.allocId()}","${compId}","Designator","${designator}",null,1,${x},${y + 10},null,"${desigFs}",0]` },
			{ content: `["ATTR","${this.allocId()}","${compId}","Name",null,null,1,${x},${y - 10},null,"st4",0]` },
			{ content: `["ATTR","${this.allocId()}","${compId}","Device","${template.deviceUuid}",0,0,null,null,0,"${devFs}",0]` },
			{ content: `["ATTR","${this.allocId()}","${compId}","Reuse Block","",0,0,null,null,0,"st4",0]` },
			{ content: `["ATTR","${this.allocId()}","${compId}","Group ID","",0,0,null,null,0,"st4",0]` },
			{ content: `["ATTR","${this.allocId()}","${compId}","Channel ID","",0,0,null,null,0,"st4",0]` },
			{ content: `["ATTR","${this.allocId()}","${compId}","Unique ID","${ggeId}",0,0,null,null,0,"st4",0]` },
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

		// Power symbols use similar structure to netports but with Global Net Name
		this.appendedLines.push(
			{ content: `["COMPONENT","${compId}","",${pin.worldX},${pin.worldY},${rotation},0,{},0]` },
			{ content: `["ATTR","${this.allocId()}","${compId}","Symbol","${template.symbolUuid}",null,null,null,null,null,"st12",0]` },
			{ content: `["ATTR","${this.allocId()}","${compId}","Device","${template.deviceUuid}",0,0,null,null,0,"st5",0]` },
			{ content: `["ATTR","${this.allocId()}","${compId}","Name","${railName}",0,0,null,null,0,"st4",0]` },
			{ content: `["ATTR","${this.allocId()}","${compId}","Relevance","[]",0,0,${pin.worldX},${pin.worldY},0,"st4",0]` },
		);

		// Junction wire
		this.addJunctionWire(pin.worldX, pin.worldY);

		// Wire with NET
		const wireId = this.allocId();
		this.appendedLines.push(
			{ content: `["WIRE","${wireId}",[[${pin.worldX},${pin.worldY},${pin.worldX},${pin.worldY}]],"${this.model.palette.wireLineStyle}",0]` },
			{ content: `["ATTR","${this.allocId()}","${wireId}","NET","${railName}",0,0,${pin.worldX},${pin.worldY},90,"st4",0]` },
		);
	}

	/**
	 * Remove lines by element ID — removes the element and all ATTRs that reference it.
	 */
	removeElement(elementId: string): void {
		for (let i = 0; i < this.originalLines.length; i++) {
			const trimmed = this.originalLines[i].trim();
			if (!trimmed) continue;
			try {
				const row = JSON.parse(trimmed);
				if (row[1] === elementId || row[2] === elementId) {
					this.removedLineIndices.add(i);
				}
			} catch {
				// Skip unparseable lines
			}
		}
	}

	/**
	 * Serialize the modified schematic back to a string.
	 */
	serialize(): string {
		const result: string[] = [];

		for (let i = 0; i < this.originalLines.length; i++) {
			if (this.removedLineIndices.has(i)) continue;

			const line = this.originalLines[i];
			const trimmed = line.trim();

			// Update HEAD with new maxId
			if (trimmed.startsWith('["HEAD"')) {
				const head = JSON.parse(trimmed);
				head[1].maxId = this.nextElementId - 1;
				result.push(JSON.stringify(head));
				continue;
			}

			result.push(line);
		}

		// Append new lines
		for (const nl of this.appendedLines) {
			result.push(nl.content);
		}

		return result.join('\n');
	}
}
