/**
 * Shared types for the EasyEDA NDJSON schema layer.
 */

export type ParseIssueClass = 'unknown-tag' | 'invalid-known' | 'parse-error';

export interface ValidationIssue {
	lineIndex: number;
	classification: ParseIssueClass;
	tag: string | null;
	reason: string;
	path?: Array<string | number>;
}

export interface UnknownLineInfo {
	lineIndex: number;
	tag: string;
	tupleLen: number;
	attrName?: string;
	sample: unknown;
	fingerprint: string;
}

/**
 * A single parsed line from an NDJSON document. Preserves the original `raw`
 * string so untouched lines round-trip byte-identically; set `mutated: true`
 * on a `known` line to have the serializer re-stringify from `data`.
 */
export type ParsedLine<L> =
	| { kind: 'known'; data: L; raw: string; lineIndex: number; mutated?: boolean }
	| { kind: 'unknown-tag'; tag: string; raw: string; lineIndex: number; info: UnknownLineInfo }
	| { kind: 'invalid'; tag: string | null; raw: string; lineIndex: number; reason: string }
	| { kind: 'blank'; raw: string; lineIndex: number };

export interface ValidationReport {
	docType: 'esch' | 'esym' | 'other';
	skipped?: { reason: string };
	lineCount: number;
	knownCount: number;
	unknownTagCount: number;
	invalidCount: number;
	blankCount: number;
	samples: {
		unknownTags: UnknownLineInfo[];
		invalid: ValidationIssue[];
	};
}
