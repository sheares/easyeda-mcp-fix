// The reference makes the EDA Pro ambient globals (eda) resolvable when ts-node
// compiles this module outside tsconfig.extension.json (handler unit tests).
/// <reference types="@jlceda/pro-api-types" />
import { BridgeUserError, describeError } from '../diag';

/**
 * pcb_get_design_rules returns {config, name}; the API wants only the config
 * object (the 0.4.26 JSDoc examples pass `current.config`). Unwrap the
 * envelope when that is what we were given.
 */
export function unwrapRuleConfiguration(input: unknown): unknown {
	if (input && typeof input === 'object' && !Array.isArray(input)) {
		const wrapped = input as Record<string, any>;
		const { config, name } = wrapped;
		if (config && typeof config === 'object' && !Array.isArray(config) && (name === undefined || typeof name === 'string')) {
			return config;
		}
	}
	return input;
}

/**
 * Reject values that cannot be a rule configuration before EasyEDA sees them.
 * Deliberately minimal (plain, non-empty object): it is meant to be tightened
 * from a real config dump, so do not add key requirements here without one.
 */
export function assertPlausibleRuleConfiguration(config: unknown): asserts config is Record<string, any> {
	const ok = config !== null && typeof config === 'object' && !Array.isArray(config) && Object.keys(config).length > 0;
	if (!ok) {
		throw new BridgeUserError(
			'Refusing to send this rule configuration to EasyEDA: it is not a non-empty configuration object. ' +
				'Pass the config returned by pcb_get_design_rules (its "config" field), edited in place. ' +
				'A hand-built or malformed configuration can corrupt EasyEDA\'s rule-config preference and hang Design Rules in every project.',
		);
	}
}

const PREFERENCE_REPAIR_MESSAGE =
	'EasyEDA rejected the rule configuration AND its saved rule-configuration list can no longer be read, so the rule-config preference is probably corrupted ' +
	'(symptom: Design Rules hangs in every project with "t is not iterable"). No automatic repair was attempted. Repair: ' +
	'(1) close EasyEDA and back up ~/Documents/EasyEDA-Pro/database/web.db; ' +
	'(2) reopen it, and save a configuration that EasyEDA itself produced (the config from pcb_get_design_rules, unedited) under a temporary name; ' +
	'(3) delete that temporary configuration; ' +
	'(4) confirm pcb_manage_rule_config get_all (includeSystem false) returns an array.';

/**
 * Run a rule-config write. If it returns false or throws, check that the
 * stored configuration list is still readable: on EasyEDA 3.2.149 a failed
 * saveRuleConfiguration left the preference malformed. A loud error beats a
 * silent "false" in that case.
 */
export async function guardedRuleConfigWrite(write: () => Promise<unknown>): Promise<unknown> {
	let result: unknown;
	let thrown: unknown;
	let didThrow = false;
	try {
		result = await write();
	} catch (err) {
		didThrow = true;
		thrown = err;
	}
	if (!didThrow && result !== false) return result;

	let listOk = false;
	try {
		listOk = Array.isArray(await eda.pcb_Drc.getAllRuleConfigurations(false));
	} catch {
		listOk = false;
	}
	if (!listOk) {
		throw new BridgeUserError(
			didThrow ? `${PREFERENCE_REPAIR_MESSAGE} (original error: ${describeError(thrown)})` : PREFERENCE_REPAIR_MESSAGE,
		);
	}
	if (didThrow) throw thrown;
	throw new BridgeUserError(
		'EasyEDA rejected the configuration (returned false). Only pass a configuration EasyEDA returned (pcb_get_design_rules), edited in place.',
	);
}

export const drcHandlers: Record<string, (params: Record<string, any>) => Promise<any>> = {
	// === DRC Check ===

	// D8: normalise the same way sch.drc.check does. Upstream pro-api-sdk
	// issue #27: despite the typed Promise<Array>, some EDA Pro builds return
	// a bare pass/fail boolean at runtime. pcb_run_drc is the fork's primary
	// pre-fab gate (the export tools point at it), so its output shape must
	// be the reliable one.
	'pcb.drc.check': async (params) => {
		const result: any = await eda.pcb_Drc.check(params.strict, params.ui, params.verbose);
		if (typeof result === 'boolean') {
			return {
				passed: result,
				note: 'This EDA Pro build returned only a pass/fail boolean (upstream pro-api-sdk issue #27); per-violation detail is unavailable here. Check the DRC panel in the EasyEDA UI for specifics.',
			};
		}
		if (Array.isArray(result)) {
			return { passed: result.length === 0, errors: result };
		}
		return result;
	},

	// === Rule Configuration ===

	'pcb.drc.getCurrentRuleConfigName': async () => {
		return eda.pcb_Drc.getCurrentRuleConfigurationName();
	},

	'pcb.drc.getRuleConfiguration': async () => {
		return eda.pcb_Drc.getCurrentRuleConfiguration();
	},

	'pcb.drc.getRuleConfigByName': async (params) => {
		return eda.pcb_Drc.getRuleConfiguration(params.configurationName);
	},

	'pcb.drc.getAllRuleConfigs': async (params) => {
		return eda.pcb_Drc.getAllRuleConfigurations(params.includeSystem);
	},

	'pcb.drc.saveRuleConfig': async (params) => {
		const config = unwrapRuleConfiguration(params.ruleConfiguration);
		assertPlausibleRuleConfiguration(config);
		return guardedRuleConfigWrite(() =>
			eda.pcb_Drc.saveRuleConfiguration(config, params.configurationName, params.allowOverwrite),
		);
	},

	// Applies a rule set to the open board (save only stores it by name).
	'pcb.drc.overwriteCurrentRuleConfig': async (params) => {
		const config = unwrapRuleConfiguration(params.ruleConfiguration);
		assertPlausibleRuleConfiguration(config);
		return guardedRuleConfigWrite(() => eda.pcb_Drc.overwriteCurrentRuleConfiguration(config));
	},

	'pcb.drc.renameRuleConfig': async (params) => {
		return eda.pcb_Drc.renameRuleConfiguration(params.originalName, params.newName);
	},

	'pcb.drc.deleteRuleConfig': async (params) => {
		return eda.pcb_Drc.deleteRuleConfiguration(params.configurationName);
	},

	'pcb.drc.getDefaultRuleConfigName': async () => {
		return eda.pcb_Drc.getDefaultRuleConfigurationName();
	},

	'pcb.drc.setAsDefaultRuleConfig': async (params) => {
		return eda.pcb_Drc.setAsDefaultRuleConfiguration(params.configurationName);
	},

	// === Net Rules ===

	'pcb.drc.getNetRules': async () => {
		return eda.pcb_Drc.getNetRules();
	},

	'pcb.drc.overwriteNetRules': async (params) => {
		return eda.pcb_Drc.overwriteNetRules(params.netRules);
	},

	'pcb.drc.getNetByNetRules': async () => {
		return eda.pcb_Drc.getNetByNetRules();
	},

	'pcb.drc.overwriteNetByNetRules': async (params) => {
		return eda.pcb_Drc.overwriteNetByNetRules(params.netByNetRules);
	},

	'pcb.drc.getRegionRules': async () => {
		return eda.pcb_Drc.getRegionRules();
	},

	'pcb.drc.overwriteRegionRules': async (params) => {
		return eda.pcb_Drc.overwriteRegionRules(params.regionRules);
	},

	// === Net Class ===

	'pcb.drc.getAllNetClasses': async () => {
		return eda.pcb_Drc.getAllNetClasses();
	},

	'pcb.drc.createNetClass': async (params) => {
		return eda.pcb_Drc.createNetClass(params.netClassName, params.nets, params.color);
	},

	'pcb.drc.deleteNetClass': async (params) => {
		return eda.pcb_Drc.deleteNetClass(params.netClassName);
	},

	'pcb.drc.modifyNetClassName': async (params) => {
		return eda.pcb_Drc.modifyNetClassName(params.originalName, params.newName);
	},

	'pcb.drc.addNetToNetClass': async (params) => {
		return eda.pcb_Drc.addNetToNetClass(params.netClassName, params.net);
	},

	'pcb.drc.removeNetFromNetClass': async (params) => {
		return eda.pcb_Drc.removeNetFromNetClass(params.netClassName, params.net);
	},

	// === Differential Pair ===

	'pcb.drc.getDiffPairs': async () => {
		return eda.pcb_Drc.getAllDifferentialPairs();
	},

	'pcb.drc.createDiffPair': async (params) => {
		return eda.pcb_Drc.createDifferentialPair(params.name, params.positiveNet, params.negativeNet);
	},

	'pcb.drc.deleteDiffPair': async (params) => {
		return eda.pcb_Drc.deleteDifferentialPair(params.name);
	},

	'pcb.drc.modifyDiffPairName': async (params) => {
		return eda.pcb_Drc.modifyDifferentialPairName(params.originalName, params.newName);
	},

	'pcb.drc.modifyDiffPairPositiveNet': async (params) => {
		return eda.pcb_Drc.modifyDifferentialPairPositiveNet(params.name, params.positiveNet);
	},

	'pcb.drc.modifyDiffPairNegativeNet': async (params) => {
		return eda.pcb_Drc.modifyDifferentialPairNegativeNet(params.name, params.negativeNet);
	},

	// === Equal Length Net Group ===

	'pcb.drc.getEqualLengthGroups': async () => {
		return eda.pcb_Drc.getAllEqualLengthNetGroups();
	},

	'pcb.drc.createEqualLengthGroup': async (params) => {
		return eda.pcb_Drc.createEqualLengthNetGroup(params.name, params.nets, params.color);
	},

	'pcb.drc.deleteEqualLengthGroup': async (params) => {
		return eda.pcb_Drc.deleteEqualLengthNetGroup(params.name);
	},

	'pcb.drc.modifyEqualLengthGroupName': async (params) => {
		return eda.pcb_Drc.modifyEqualLengthNetGroupName(params.originalName, params.newName);
	},

	'pcb.drc.addNetToEqualLengthGroup': async (params) => {
		return eda.pcb_Drc.addNetToEqualLengthNetGroup(params.name, params.net);
	},

	'pcb.drc.removeNetFromEqualLengthGroup': async (params) => {
		return eda.pcb_Drc.removeNetFromEqualLengthNetGroup(params.name, params.net);
	},

	// === Pad Pair Group ===

	'pcb.drc.createPadPairGroup': async (params) => {
		return eda.pcb_Drc.createPadPairGroup(params.name, params.padPairs);
	},

	'pcb.drc.deletePadPairGroup': async (params) => {
		return eda.pcb_Drc.deletePadPairGroup(params.name);
	},

	'pcb.drc.modifyPadPairGroupName': async (params) => {
		return eda.pcb_Drc.modifyPadPairGroupName(params.originalName, params.newName);
	},
};
