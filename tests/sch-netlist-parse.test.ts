import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { parseRawNetlist } from '../src/extension/handlers/sch-netlist-parse';

// Shape as emitted by SCH_ManufactureData.getNetlistFile (verified against a
// real EasyEDA Pro 2.x export, Netlist_Schematic3_2026-07-06.enet).
const V2_NETLIST = JSON.stringify({
	version: '2.0.0',
	components: {
		gge1: {
			props: {
				Designator: 'U2',
				'Unique ID': 'gge1',
				Name: '={Manufacturer Part}',
				'Manufacturer Part': '74HC4051D,653',
				'Supplier Part': 'C9386',
			},
			pinInfoMap: {
				'1': { name: 'Y4', number: '1', net: 'CLK_CH5', props: { 'Pin Number': '1' } },
				'2': { name: 'Y6', number: '2', net: '', props: { 'Pin Number': '2' } },
				'3': { name: 'Z', number: '3', net: 'CLK', props: { 'Pin Number': '3' } },
				'6': { name: 'E', number: '6', net: 'GND', props: { 'Pin Number': '6' } },
			},
		},
		gge42: {
			props: {
				Designator: 'R13',
				Name: '10kΩ',
				'Manufacturer Part': '0603WAF1002T5E',
			},
			pinInfoMap: {
				'1': { name: '1', number: '1', net: '$1N93', props: {} },
				'2': { name: '2', number: '2', net: '+3V3', props: {} },
			},
		},
	},
	designRule: {},
	differentialPair: {},
	netClass: {},
	equalLengthNetGroup: {},
});

// Old flat shape returned by the deprecated eda.sch_Netlist.getNetlist fallback.
const LEGACY_NETLIST = JSON.stringify({
	gge7: {
		props: { Designator: 'C1', Name: '100nF', 'Manufacturer Part': 'CC0603KRX7R9BB104' },
		pins: { '1': '+3V3', '2': 'GND' },
	},
});

test('parseRawNetlist unwraps the v2 components map', () => {
	const parsed = parseRawNetlist(V2_NETLIST);
	assert.deepEqual(Object.keys(parsed).sort(), ['gge1', 'gge42']);
	const u2 = parsed['gge1'];
	assert.equal(u2.designator, 'U2');
	assert.equal(u2.part, '={Manufacturer Part}');
	assert.equal(u2.manufacturerPart, '74HC4051D,653');
	assert.equal(u2.allProps['Supplier Part'], 'C9386');
});

test('parseRawNetlist maps pinInfoMap to pinNumber → net', () => {
	const parsed = parseRawNetlist(V2_NETLIST);
	assert.deepEqual(parsed['gge1'].pins, { '1': 'CLK_CH5', '3': 'CLK', '6': 'GND' });
});

test('parseRawNetlist omits unconnected pins (net: "") rather than grouping them', () => {
	const parsed = parseRawNetlist(V2_NETLIST);
	assert.equal('2' in parsed['gge1'].pins, false);
});

test('parseRawNetlist keeps $-prefixed unnamed nets', () => {
	const parsed = parseRawNetlist(V2_NETLIST);
	assert.equal(parsed['gge42'].pins['1'], '$1N93');
});

test('parseRawNetlist still reads the legacy flat shape from the deprecated fallback', () => {
	const parsed = parseRawNetlist(LEGACY_NETLIST);
	assert.deepEqual(Object.keys(parsed), ['gge7']);
	assert.equal(parsed['gge7'].designator, 'C1');
	assert.deepEqual(parsed['gge7'].pins, { '1': '+3V3', '2': 'GND' });
});

test('parseRawNetlist accepts already-parsed objects and tolerates junk', () => {
	const parsed = parseRawNetlist(JSON.parse(V2_NETLIST));
	assert.equal(parsed['gge1'].designator, 'U2');
	assert.deepEqual(parseRawNetlist('{}'), {});
	assert.deepEqual(parseRawNetlist(null), {});
});
