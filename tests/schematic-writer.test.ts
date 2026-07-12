/**
 * Writer-core tests (H22): addNetport(At), addComponent, addSeriesResistor,
 * addPowerSymbol, removeElement, allocDesignator, loadSchematic.
 *
 * The shared sample.esch fixture's symbol map only ships the resistor symbol;
 * the netport tests extend the map with a minimal symbolType-19 .esym so the
 * palette resolves a netport template (without it, addNetportAt throws, which
 * is itself asserted below).
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseSchematic } from '../src/lib/schematic-reader';
import { SchematicWriter } from '../src/lib/schematic-writer';
import { loadSchematic } from '../src/lib/loader';

const ESCH_FIXTURE = readFileSync(join(__dirname, 'fixtures/sample.esch'), 'utf8');
const ESYM_FIXTURE = readFileSync(join(__dirname, 'fixtures/sample.esym'), 'utf8');

// Minimal netport symbol: symbolType 19 marks the fixture's e16 component as a
// netport so the palette picks up its symbol/device UUIDs and font styles.
const NETPORT_ESYM = [
	'["HEAD",{"originX":0,"originY":0,"version":"2.0","maxId":4,"symbolType":19}]',
	'["FONTSTYLE","st4",null,null,null,null,0,0,0,null,2,0]',
	'["PIN","e1",1,null,0,0,10,0,null,0,0]',
	'["ATTR","e2","e1","NUMBER","1",null,null,null,null,null,"st4",0]',
].join('\n');

const SYMBOLS_NO_NETPORT = { 'sym-resistor-uuid': ESYM_FIXTURE };
const SYMBOLS_WITH_NETPORT = {
	'sym-resistor-uuid': ESYM_FIXTURE,
	'sym-netport-uuid': NETPORT_ESYM,
};

function makeWriter(symbols: Record<string, string>): SchematicWriter {
	const model = parseSchematic(ESCH_FIXTURE, symbols);
	return new SchematicWriter(ESCH_FIXTURE, model);
}

function contentLines(source: string): string[] {
	return source.split('\n').filter((l) => l !== '');
}

// ---------------------------------------------------------------------------
// addNetportAt / addNetport
// ---------------------------------------------------------------------------

test('addNetportAt throws when the palette has no netport template', () => {
	// The stock fixture symbol map has no netport symbol, so the palette
	// cannot resolve a template. Documents the fixture gotcha explicitly.
	const writer = makeWriter(SYMBOLS_NO_NETPORT);
	assert.throws(() => writer.addNetportAt('X', 0, 0, 0), /No netport template/);
});

test('addNetportAt appends a netport component with wire and NET attr', () => {
	const writer = makeWriter(SYMBOLS_WITH_NETPORT);
	const id = writer.addNetportAt('MY_NET', 700, 300, 0);

	assert.match(id, /^e\d+$/);
	const out = writer.serialize();
	assert.ok(out.includes(`["COMPONENT","${id}","",700,300,0,`), 'netport COMPONENT line present');
	assert.ok(out.includes('"Name","MY_NET"'), 'Name attr carries the net name');
	assert.ok(out.includes('"NET","MY_NET"'), 'zero-length wire carries the NET attr');
	assert.ok(out.includes('[[700,300,700,300]]'), 'net wire is zero-length at the netport position');

	const report = writer.validate();
	assert.equal(report.invalidCount, 0);
	assert.equal(report.unknownTagCount, 0);
});

test('addNetport places the netport at the resolved pin world position', () => {
	const writer = makeWriter(SYMBOLS_WITH_NETPORT);
	// R1 sits at (1000,500) rotation 0; symbol pin 1 is at (-20,0) => world (980,500).
	const id = writer.addNetport('TCK', 'R1.1');
	const out = writer.serialize();
	assert.ok(out.includes(`["COMPONENT","${id}","",980,500,0,`), 'netport lands on the pin');
	assert.throws(() => writer.addNetport('TCK', 'R99.1'), /Pin not found/);
});

// ---------------------------------------------------------------------------
// addComponent
// ---------------------------------------------------------------------------

test('addComponent appends a full component line set with fresh ids', () => {
	const writer = makeWriter(SYMBOLS_NO_NETPORT);
	const id = writer.addComponent('R_0402', 'R7', 1100, 600, 90);

	// Fixture maxId is 20, so the first allocated element id is e21.
	assert.equal(id, 'e21');
	const out = writer.serialize();
	assert.ok(out.includes(`["COMPONENT","${id}","R_0402.1",1100,600,90,`), 'COMPONENT line present');
	assert.ok(out.includes('"Designator","R7"'), 'designator attr present');
	// Fixture max gge is gge1, so the new Unique ID must be gge2.
	assert.ok(out.includes('"Unique ID","gge2"'), 'fresh Unique ID allocated');

	const report = writer.validate();
	assert.equal(report.invalidCount, 0);
});

test('addComponent throws for a part missing from the palette', () => {
	const writer = makeWriter(SYMBOLS_NO_NETPORT);
	assert.throws(() => writer.addComponent('NOPE_PART', 'R9', 0, 0), /not found in schematic palette/);
});

// ---------------------------------------------------------------------------
// addSeriesResistor / addPowerSymbol
// ---------------------------------------------------------------------------

test('addSeriesResistor places resistor, junction and netport; removal cascades to the junction', () => {
	const writer = makeWriter(SYMBOLS_WITH_NETPORT);
	const resId = writer.addSeriesResistor('R_0402', 'R1.1', 'FPGA_TCK');

	let out = writer.serialize();
	// Auto designator: fixture already has R1, so the new resistor is R2.
	assert.ok(out.includes('"Designator","R2"'), 'auto-allocated designator');
	// Pin R1.1 world (980,500), angle 0: resistor centre at (960,500), netport at (940,500).
	assert.ok(out.includes(`["COMPONENT","${resId}","R_0402.1",960,500,0,`), 'resistor placed one pin-offset outward');
	assert.ok(out.includes('"Name","FPGA_TCK"'), 'netport net name present');
	// Wires: fixture e20 + junction at the pin + the netport net wire = 3.
	assert.equal(contentLines(out).filter((l) => l.startsWith('["WIRE"')).length, 3);

	writer.removeElement(resId);
	out = writer.serialize();
	assert.ok(!out.includes('"Designator","R2"'), 'resistor lines removed');
	// The companion junction wire goes with it; the netport and its wire stay.
	assert.equal(contentLines(out).filter((l) => l.startsWith('["WIRE"')).length, 2);
	assert.ok(out.includes('"Name","FPGA_TCK"'), 'netport survives resistor removal');
});

test('addPowerSymbol throws when the rail has no palette template', () => {
	// The fixture has no power-symbol component, so the palette has no rails.
	const writer = makeWriter(SYMBOLS_WITH_NETPORT);
	assert.throws(() => writer.addPowerSymbol('GND', 'R1.1'), /Power symbol "GND" not found/);
});

// ---------------------------------------------------------------------------
// removeElement
// ---------------------------------------------------------------------------

test('removeElement removes a pre-existing component and all its ATTRs', () => {
	const writer = makeWriter(SYMBOLS_NO_NETPORT);
	writer.removeElement('e10');
	const out = writer.serialize();
	assert.ok(!out.includes('"e10"'), 'component line and ATTR parent refs gone');
	assert.ok(!out.includes('"Designator","R1"'), 'R1 attrs gone');
	// Unrelated elements survive.
	assert.ok(out.includes('"NET_IN"'), 'netport component untouched');
});

test('removeElement removes elements appended earlier in the same session', () => {
	const writer = makeWriter(SYMBOLS_WITH_NETPORT);
	const id = writer.addNetportAt('TEMP_NET', 640, 320, 0);
	writer.removeElement(id);
	const out = writer.serialize();
	assert.ok(!out.includes('TEMP_NET'), 'appended netport (and its companion net wire) fully removed');
	// Only HEAD.maxId differs from the original fixture.
	const diff = contentLines(out).filter((l, i) => l !== contentLines(ESCH_FIXTURE)[i]);
	assert.equal(diff.length, 1);
	assert.ok(diff[0].startsWith('["HEAD"'));
});

// ---------------------------------------------------------------------------
// allocDesignator
// ---------------------------------------------------------------------------

test('allocDesignator continues from existing designators per prefix', () => {
	const writer = makeWriter(SYMBOLS_NO_NETPORT);
	assert.equal(writer.allocDesignator('R'), 'R2'); // R1 exists in the fixture
	assert.equal(writer.allocDesignator('R'), 'R3');
	assert.equal(writer.allocDesignator('C'), 'C1'); // fresh prefix starts at 1
});

// ---------------------------------------------------------------------------
// loadSchematic
// ---------------------------------------------------------------------------

test('loadSchematic loads source, symbols and project.json from an extracted .epro dir', (t) => {
	const dir = mkdtempSync(join(tmpdir(), 'esch-writer-test-'));
	t.after(() => rmSync(dir, { recursive: true, force: true }));

	writeFileSync(join(dir, 'project.json'), JSON.stringify({ devices: {} }));
	mkdirSync(join(dir, 'SHEET', 'sch-uuid'), { recursive: true });
	writeFileSync(join(dir, 'SHEET', 'sch-uuid', '1.esch'), ESCH_FIXTURE);
	mkdirSync(join(dir, 'SYMBOL'));
	writeFileSync(join(dir, 'SYMBOL', 'sym-resistor-uuid.esym'), ESYM_FIXTURE);

	const { source, model, schematicPath } = loadSchematic(dir, 'sch-uuid');
	assert.equal(source, ESCH_FIXTURE);
	assert.ok(schematicPath.endsWith(join('sch-uuid', '1.esch')));
	assert.equal(model.components.length, 2);
	assert.ok(model.palette.components['R_0402'], 'resistor resolved into the palette');

	assert.throws(() => loadSchematic(dir, 'missing-uuid'), /Schematic not found/);
	assert.throws(() => loadSchematic(join(dir, 'SHEET'), 'sch-uuid'), /project\.json not found/);
});
