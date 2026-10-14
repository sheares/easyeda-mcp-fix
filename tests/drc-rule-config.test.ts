// Rule-config save safety: unwrap the {config, name} envelope, reject
// implausible configs before EDA is called, and after a failed save check
// whether the stored rule-config list is still readable (a failed save once
// left the preference malformed). `eda` is referenced only inside function
// bodies, so stubbing globalThis.eda per test is sufficient.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { drcHandlers, unwrapRuleConfiguration, assertPlausibleRuleConfiguration } from '../src/extension/handlers/drc';

const g = globalThis as any;
let saved: any[];
let overwritten: any[];
let saveImpl: (cfg: any) => Promise<boolean>;
let listImpl: () => Promise<unknown>;

beforeEach(() => {
	saved = [];
	overwritten = [];
	saveImpl = async () => true;
	listImpl = async () => [];
	g.eda = {
		pcb_Drc: {
			saveRuleConfiguration: async (cfg: any, name: string, overwrite?: boolean) => {
				saved.push({ cfg, name, overwrite });
				return saveImpl(cfg);
			},
			overwriteCurrentRuleConfiguration: async (cfg: any) => {
				overwritten.push(cfg);
				return saveImpl(cfg);
			},
			getAllRuleConfigurations: async () => listImpl(),
		},
	};
});

// Trimmed from a real pcb_get_design_rules().config (EasyEDA 3.2.206).
const CONFIG = {
	Physics: {
		Track: {
			copperThickness1oz: {
				editName: 'copperThickness1oz',
				unit: 'mm',
				isSetDefault: true,
				form: { status: 1, data: { 1: { minValue: 0.102, defaultValue: 0.254, maxValue: 2.54 } } },
			},
		},
		'Blind/Buried Via': { blindVia: { editName: 'blindVia', isSetDefault: true, table: [] } },
	},
};

test('unwrapRuleConfiguration passes .config of a {config, name} envelope and leaves a bare config alone', () => {
	assert.equal(unwrapRuleConfiguration({ config: CONFIG, name: 'Default' }), CONFIG);
	assert.equal(unwrapRuleConfiguration({ config: CONFIG }), CONFIG);
	assert.equal(unwrapRuleConfiguration(CONFIG), CONFIG);
});

test('save sends the unwrapped config to EasyEDA', async () => {
	const result = await drcHandlers['pcb.drc.saveRuleConfig']({
		ruleConfiguration: { config: CONFIG, name: 'Default' },
		configurationName: 'tmp',
		allowOverwrite: true,
	});
	assert.equal(result, true);
	assert.equal(saved[0].cfg, CONFIG);
	assert.equal(saved[0].name, 'tmp');
	assert.equal(saved[0].overwrite, true);
});

test('pre-check rejects non-objects, arrays and empty objects before EDA is called', async () => {
	for (const bad of [undefined, null, 'x', 5, [], [1], {}, { config: {}, name: 'Default' }]) {
		await assert.rejects(
			drcHandlers['pcb.drc.saveRuleConfig']({ ruleConfiguration: bad, configurationName: 'tmp' }),
			/pcb_get_design_rules/,
		);
	}
	assert.equal(saved.length, 0);
	assert.throws(() => assertPlausibleRuleConfiguration({}), /pcb_get_design_rules/);
	assert.doesNotThrow(() => assertPlausibleRuleConfiguration(CONFIG));
});

test('pre-check rejects hand-built configs that lack the category/group/rule-set shape', () => {
	const handBuilt = [
		{ Physics: { Track: { min: 6 } } },
		{ Physics: { Track: { pwr: { min: 0.5 } } } },
		{ Physics: 'Track' },
		{ Physics: { Track: [] } },
	];
	for (const bad of handBuilt) {
		assert.throws(() => assertPlausibleRuleConfiguration(bad), /editName|not an object/);
	}
});

test('false return with a readable list gives a normal rejection message', async () => {
	saveImpl = async () => false;
	listImpl = async () => [{ name: 'Default' }];
	await assert.rejects(
		drcHandlers['pcb.drc.saveRuleConfig']({ ruleConfiguration: CONFIG, configurationName: 'tmp' }),
		(err: any) => /rejected the configuration \(returned false\)/.test(err.message) && !/corrupt/.test(err.message),
	);
});

test('false return with a non-array list raises the preference-corruption error', async () => {
	saveImpl = async () => false;
	listImpl = async () => undefined;
	await assert.rejects(
		drcHandlers['pcb.drc.saveRuleConfig']({ ruleConfiguration: CONFIG, configurationName: 'tmp' }),
		(err: any) => /corrupt/.test(err.message) && /web\.db/.test(err.message) && err.userFacing === true,
	);
});

test('a throwing save with an unreadable list raises the corruption error and keeps the cause', async () => {
	saveImpl = async () => {
		throw new Error('boom');
	};
	listImpl = async () => {
		throw new TypeError('t is not iterable');
	};
	await assert.rejects(
		drcHandlers['pcb.drc.saveRuleConfig']({ ruleConfiguration: CONFIG, configurationName: 'tmp' }),
		(err: any) => /corrupt/.test(err.message) && /boom/.test(err.message),
	);
});

test('a throwing save with a readable list rethrows the original error', async () => {
	saveImpl = async () => {
		throw new Error('boom');
	};
	await assert.rejects(
		drcHandlers['pcb.drc.saveRuleConfig']({ ruleConfiguration: CONFIG, configurationName: 'tmp' }),
		/boom/,
	);
});

test('overwrite_current unwraps, pre-checks and handles false like save', async () => {
	assert.equal(await drcHandlers['pcb.drc.overwriteCurrentRuleConfig']({ ruleConfiguration: { config: CONFIG, name: 'D' } }), true);
	assert.equal(overwritten[0], CONFIG);
	await assert.rejects(drcHandlers['pcb.drc.overwriteCurrentRuleConfig']({ ruleConfiguration: {} }), /pcb_get_design_rules/);
	assert.equal(overwritten.length, 1);
	saveImpl = async () => false;
	await assert.rejects(
		drcHandlers['pcb.drc.overwriteCurrentRuleConfig']({ ruleConfiguration: CONFIG }),
		/returned false/,
	);
});
