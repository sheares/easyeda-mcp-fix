import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectFabLayers } from '../src/extension/handlers/fab-layers';

// 4-layer board: Top, Inner1 (plane), Inner2 (signal), Bottom, plus aux layers.
const layers = [
	{ id: 1, type: 'SIGNAL', layerStatus: 1 },
	{ id: 15, type: 'PLANE', layerStatus: 1 },
	{ id: 16, type: 'SIGNAL', layerStatus: 2 },
	{ id: 2, type: 'SIGNAL', layerStatus: 1 },
	{ id: 3, type: 'SILKSCREEN', layerStatus: 1 },
	{ id: 4, type: 'SILKSCREEN', layerStatus: 2 }, // used but hidden
	{ id: 5, type: 'SOLDER_MASK', layerStatus: 1 },
	{ id: 6, type: 'SOLDER_MASK', layerStatus: 1 },
	{ id: 7, type: 'PASTE_MASK', layerStatus: 1 },
	{ id: 8, type: 'PASTE_MASK', layerStatus: 0 },
	{ id: 17, type: 'SIGNAL', layerStatus: 0 }, // unused inner
	{ id: 9, type: 'ASSEMBLY', layerStatus: 1 },
	{ id: 12, type: 'OTHER', layerStatus: 1 }, // document layer
	{ id: 11, type: 'OTHER', layerStatus: 1 }, // board outline
	{ id: 99, type: 'CUSTOM', layerStatus: 1 },
];

test('selectFabLayers keeps used fab layers, hidden ones and the outline', () => {
	const ids = selectFabLayers(layers, 'isMirror').map((l) => l.layerId);
	assert.deepEqual(ids, [1, 15, 16, 2, 3, 4, 5, 6, 7, 11]);
});

test('selectFabLayers drops unused, assembly, document and custom layers', () => {
	const ids = selectFabLayers(layers, 'isMirror').map((l) => l.layerId);
	for (const bad of [8, 17, 9, 12, 99]) assert.ok(!ids.includes(bad), `layer ${bad}`);
});

test('selectFabLayers uses the requested mirror key', () => {
	assert.deepEqual(selectFabLayers(layers.slice(0, 1), 'isMirror'), [{ layerId: 1, isMirror: false }]);
	assert.deepEqual(selectFabLayers(layers.slice(0, 1), 'mirror'), [{ layerId: 1, mirror: false }]);
});
