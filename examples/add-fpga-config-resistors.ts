/**
 * Example: Add 22Ω series resistors between an FPGA's JTAG/config pins
 * and matching netports, plus add netports for the strapping pins.
 *
 * This is the actual task we did interactively on 2026-04-09 to validate
 * the schematic editing library, refactored as a reusable script.
 *
 * Workflow:
 *   1. In Claude Code, use MCP tool `project_export_file` to save the
 *      project as a .epro file:
 *        project_export_file(filePath: "/tmp/myproject.epro")
 *
 *   2. Unzip it:
 *        unzip /tmp/myproject.epro -d /tmp/myproject/
 *
 *   3. Edit the constants below to point at your project and schematic.
 *
 *   4. Run this script:
 *        npx ts-node examples/add-fpga-config-resistors.ts
 *
 *   5. Push the result back into EasyEDA:
 *        document_load_from_file(
 *          document: "<schematic page UUID>",
 *          filePath: "/tmp/output.esch"
 *        )
 *
 *   6. Verify with sch_get_connectivity to confirm the netlist sees
 *      all the new connections.
 */

import { writeFileSync } from 'fs';
import { loadSchematic, SchematicWriter } from '../src/lib';

// === Configure these for your project ===
const EPRO_DIR = '/tmp/easyeda-roundtrip/project';
const SCHEMATIC_UUID = '49824b837e2e4a0aa9218bb56d44ac5f';
const FPGA_DESIGNATOR = 'U2';
// Pick any resistor part that exists in your project palette. To see what's
// available, the script will print the palette if the part you choose is
// not found. EasyEDA part naming for chip resistors uses E96 codes:
//   "0402WGF2200TCE" = 220 × 10^0 = 220Ω
//   "0402WGF1001TCE" = 100 × 10^1 = 1kΩ
//   "0402WGF5101TCE" = 510 × 10^1 = 5.1kΩ
// For a 22Ω resistor you'd use something like "0402WGF22R0TCE" (the R is the
// decimal point). To use a different value, place one in EasyEDA first to
// embed it in the project, then re-export.
const RESISTOR_PART = '0402WGF2200TCE'; // 220Ω 0402 (placeholder for example)
const OUTPUT_PATH = '/tmp/output.esch';

// Pin name -> net name. The library looks up pins by name, so we don't need
// pin numbers or coordinates — the writer handles all of that automatically.
const PIN_TO_NET: Record<string, string> = {
	// Programming/JTAG pins (need series resistors for protection)
	'nSTATUS':   'FPGA_NSTATUS',
	'DCLK':      'FPGA_DCLK',
	'nCONFIG':   'FPGA_NCONFIG',
	'TDI':       'FPGA_TDI',
	'TCK':       'FPGA_TCK',
	'TMS':       'FPGA_TMS',
	'TDO':       'FPGA_TDO',
	'nCE':       'FPGA_NCE',
	// Strapping/status pins
	'CONF_DONE': 'FPGA_CDONE',
	'MSEL0':     'FPGA_MSEL0',
	'MSEL1':     'FPGA_MSEL1',
	'MSEL2':     'FPGA_MSEL2',
};

// === Load + edit ===
const { source, model } = loadSchematic(EPRO_DIR, SCHEMATIC_UUID);
console.log(`Loaded schematic: ${model.components.length} components, ${model.wires.length} wires`);

// Verify the FPGA exists and the pins we want are present
const fpga = model.components.find((c) => c.designator === FPGA_DESIGNATOR);
if (!fpga) {
	throw new Error(`Component ${FPGA_DESIGNATOR} not found`);
}
console.log(`Found ${FPGA_DESIGNATOR}: ${fpga.partName} with ${fpga.pins.length} pins`);

const missingPins: string[] = [];
for (const pinName of Object.keys(PIN_TO_NET)) {
	if (!fpga.pins.find((p) => p.name === pinName)) {
		missingPins.push(pinName);
	}
}
if (missingPins.length > 0) {
	throw new Error(`Pins not found on ${FPGA_DESIGNATOR}: ${missingPins.join(', ')}`);
}

// Apply edits
const writer = new SchematicWriter(source, model);
let count = 0;
for (const [pinName, netName] of Object.entries(PIN_TO_NET)) {
	const pinRef = `${FPGA_DESIGNATOR}:${pinName}`;
	writer.addSeriesResistor(RESISTOR_PART, pinRef, netName);
	console.log(`  + ${pinRef} → resistor → netport "${netName}"`);
	count++;
}

// Serialize
writeFileSync(OUTPUT_PATH, writer.serialize());
console.log(`\nWrote ${count} series resistors + netports to ${OUTPUT_PATH}`);
console.log(`\nNext step: push back with document_load_from_file`);
