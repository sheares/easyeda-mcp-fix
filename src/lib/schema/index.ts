/**
 * Zod-backed schema for EasyEDA NDJSON line types.
 *
 * Parses `.esch` and `.esym` documents into typed, validated lines while
 * preserving the original raw strings for round-trip fidelity. Unknown tags
 * and known-but-malformed lines are surfaced via ValidationReport; unknown
 * shapes can optionally be appended to a discovery log for schema growth.
 */

export * from './types';
export { wrapAsParsedLine, serializeParsedLines } from './parser';
export * from './line-head';
export * from './line-component';
export * from './line-attr';
export * from './line-wire';
export * from './line-pin';
export * from './line-fontstyle';
export * from './line-graphics';
export * from './esch';
export * from './esym';
export * from './epcb';
export * from './eins';
export * from './line-pcb';
export {
	computeFingerprint,
	logDiscovery,
	_resetDiscoverySession,
	type DiscoveryContext,
} from './discovery';
