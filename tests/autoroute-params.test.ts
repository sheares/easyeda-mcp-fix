import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toAutoRoutingProps } from '../src/extension/handlers/autoroute-params';

test('no options sends nothing, so EasyEDA uses its own defaults', () => {
	assert.deepEqual(toAutoRoutingProps({}), {});
});

test('plain-English options map to the 0.4.27 enum values', () => {
	assert.deepEqual(
		toAutoRoutingProps({ corner: '90', existing: 'remove', optimise: 'speed', nets: ['SDA', 'SCL'], ignoreNets: ['GND'] }),
		{ RoutingNets: ['SDA', 'SCL'], ignoreNets: ['GND'], cornerStyle: 1, existingPrimitiveMode: 'remove', optimization: 0 },
	);
	assert.deepEqual(
		toAutoRoutingProps({ corner: '45', existing: 'keep', optimise: 'completion', nets: 'selectedComponents' }),
		{ RoutingNets: 'selectedComponents', cornerStyle: 0, existingPrimitiveMode: 'keep', optimization: 1 },
	);
});

test('layer names become EPCB_LayerId numbers; numbers pass through', () => {
	assert.deepEqual(toAutoRoutingProps({ layers: ['TopLayer', 'BottomLayer', 'Inner1', 16] }).layers, [1, 2, 15, 16]);
});

test('an empty ignoreNets is dropped; an empty or unknown layer list is refused', () => {
	assert.deepEqual(toAutoRoutingProps({ ignoreNets: [] }), {});
	assert.throws(() => toAutoRoutingProps({ layers: [] }), /layers is empty/);
	assert.throws(() => toAutoRoutingProps({ layers: ['Kitchen'] }), /Unknown PCB layer/);
});
