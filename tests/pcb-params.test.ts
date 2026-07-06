import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { toLayerId, normalizePcbParams, toPolygonSource } from '../src/extension/handlers/pcb-params';

test('toLayerId maps documented layer names to numeric EPCB_LayerId', () => {
	assert.equal(toLayerId('TopLayer'), 1);
	assert.equal(toLayerId('BottomLayer'), 2);
	assert.equal(toLayerId('top'), 1);
	assert.equal(toLayerId('BOTTOM'), 2);
	assert.equal(toLayerId('Multi'), 12);
	assert.equal(toLayerId('MultiLayer'), 12);
	assert.equal(toLayerId('BoardOutline'), 11);
	assert.equal(toLayerId('TopSilkscreen'), 3);
	assert.equal(toLayerId('TOP_SILKSCREEN'), 3);
	assert.equal(toLayerId('bottom-silk'), 4);
	assert.equal(toLayerId('TopSolderMask'), 5);
	assert.equal(toLayerId('Document'), 13);
	assert.equal(toLayerId('Mechanical'), 14);
	assert.equal(toLayerId('RatLine'), 57);
});

test('toLayerId maps inner and custom layers', () => {
	assert.equal(toLayerId('Inner1'), 15);
	assert.equal(toLayerId('InnerLayer1'), 15);
	assert.equal(toLayerId('Inner3'), 17);
	assert.equal(toLayerId('Inner30'), 44);
	assert.equal(toLayerId('Custom1'), 71);
	assert.equal(toLayerId('Custom30'), 100);
});

test('toLayerId passes numbers and numeric strings through as numbers', () => {
	assert.equal(toLayerId(1), 1);
	assert.equal(toLayerId(12), 12);
	assert.equal(toLayerId('1'), 1);
	assert.equal(toLayerId('2'), 2);
	assert.equal(toLayerId(' 12 '), 12);
});

test('toLayerId leaves null/undefined untouched', () => {
	assert.equal(toLayerId(undefined), undefined);
	assert.equal(toLayerId(null), null);
});

test('toLayerId throws on unknown layer names instead of storing dead ids', () => {
	assert.throws(() => toLayerId('CopperLayer'), /Unknown PCB layer "CopperLayer"/);
	assert.throws(() => toLayerId(''), /Unknown PCB layer/);
});

test('normalizePcbParams converts top-level layer for pcb.* methods only', () => {
	assert.deepEqual(
		normalizePcbParams('pcb.create.line', { net: 'GND', layer: 'TopLayer', startX: 0 }),
		{ net: 'GND', layer: 1, startX: 0 },
	);
	// sch.* and other methods untouched
	const schParams = { layer: 'TopLayer' };
	assert.equal(normalizePcbParams('sch.component.modify', schParams), schParams);
});

test('normalizePcbParams leaves params without a string layer unchanged', () => {
	assert.deepEqual(normalizePcbParams('pcb.getAll.line', { net: 'GND' }), { net: 'GND' });
	assert.deepEqual(normalizePcbParams('pcb.create.line', { layer: 2 }), { layer: 2 });
});

test('normalizePcbParams converts layer/layerId inside modify property objects', () => {
	assert.deepEqual(
		normalizePcbParams('pcb.modify.line', { primitiveId: 'e1', property: { layer: 'BottomLayer', lineWidth: 10 } }),
		{ primitiveId: 'e1', property: { layer: 2, lineWidth: 10 } },
	);
	assert.deepEqual(
		normalizePcbParams('pcb.modify.pad', { primitiveId: 'e2', property: { layerId: 'Multi' } }),
		{ primitiveId: 'e2', property: { layerId: 12 } },
	);
});

test('normalizePcbParams does not mutate the input params', () => {
	const params = { layer: 'TopLayer', property: { layer: 'BottomLayer' } };
	normalizePcbParams('pcb.create.line', params);
	assert.equal(params.layer, 'TopLayer');
	assert.equal(params.property.layer, 'BottomLayer');
});

test('toPolygonSource converts point arrays to x1 y1 L x2 y2 source arrays', () => {
	assert.deepEqual(toPolygonSource([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 5 }]), [0, 0, 'L', 10, 0, 10, 5]);
	assert.deepEqual(toPolygonSource([{ x: -200, y: -200 }, { x: -150, y: -200 }]), [-200, -200, 'L', -150, -200]);
});

test('toPolygonSource passes flat source arrays and non-arrays through', () => {
	const source = [0, 0, 'L', 10, 0];
	assert.equal(toPolygonSource(source), source);
	assert.equal(toPolygonSource(undefined), undefined);
	assert.deepEqual(toPolygonSource([]), []);
});
