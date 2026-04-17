/**
 * Shared NDJSON parser engine. `.esch` and `.esym` both wrap this with their
 * own schema maps.
 */

import type { z, ZodError } from 'zod';
import type {
	ParsedLine,
	UnknownLineInfo,
	ValidationIssue,
	ValidationReport,
} from './types';
import { computeFingerprint } from './discovery';

const MAX_SAMPLE_UNKNOWNS = 20;
const MAX_SAMPLE_INVALIDS = 20;

type AnyTupleSchema = z.ZodTuple<any, any> | z.ZodType<any>;

function deriveTag(parsed: unknown): string | null {
	if (!Array.isArray(parsed)) return null;
	const first = parsed[0];
	return typeof first === 'string' ? first : null;
}

function attrNameOf(parsed: unknown): string | undefined {
	if (!Array.isArray(parsed)) return undefined;
	if (parsed[0] !== 'ATTR') return undefined;
	return typeof parsed[3] === 'string' ? parsed[3] : undefined;
}

function formatZodError(err: ZodError): string {
	return err.issues.slice(0, 3).map((i) => {
		const path = i.path.length > 0 ? i.path.join('.') : '(root)';
		return `${path}: ${i.message}`;
	}).join('; ');
}

export interface ParseOptions<L> {
	schemaMap: Record<string, AnyTupleSchema>;
	docType: 'esch' | 'esym';
}

export function parseNdjsonSource<L>(
	source: string,
	opts: ParseOptions<L>,
): { lines: ParsedLine<L>[]; report: ValidationReport } {
	const rawLines = source.split('\n');
	const out: ParsedLine<L>[] = [];
	const unknownSamples: UnknownLineInfo[] = [];
	const invalidSamples: ValidationIssue[] = [];
	const seenUnknownFingerprints = new Set<string>();

	let knownCount = 0;
	let unknownTagCount = 0;
	let invalidCount = 0;
	let blankCount = 0;

	for (let i = 0; i < rawLines.length; i++) {
		const raw = rawLines[i];
		const trimmed = raw.trim();

		if (!trimmed) {
			blankCount++;
			out.push({ kind: 'blank', raw, lineIndex: i });
			continue;
		}

		let parsed: unknown;
		try {
			parsed = JSON.parse(trimmed);
		} catch (err) {
			invalidCount++;
			const reason = err instanceof Error ? err.message : String(err);
			if (invalidSamples.length < MAX_SAMPLE_INVALIDS) {
				invalidSamples.push({
					lineIndex: i,
					classification: 'parse-error',
					tag: null,
					reason,
				});
			}
			out.push({ kind: 'invalid', tag: null, raw, lineIndex: i, reason });
			continue;
		}

		const tag = deriveTag(parsed);
		if (tag == null) {
			invalidCount++;
			const reason = 'expected array with string tag at position 0';
			if (invalidSamples.length < MAX_SAMPLE_INVALIDS) {
				invalidSamples.push({
					lineIndex: i,
					classification: 'invalid-known',
					tag: null,
					reason,
				});
			}
			out.push({ kind: 'invalid', tag: null, raw, lineIndex: i, reason });
			continue;
		}

		const schema = opts.schemaMap[tag];
		if (!schema) {
			unknownTagCount++;
			const tupleLen = Array.isArray(parsed) ? parsed.length : 0;
			const an = attrNameOf(parsed);
			const fingerprint = computeFingerprint(tag, tupleLen, 'unknown-tag', an);
			const info: UnknownLineInfo = {
				lineIndex: i,
				tag,
				tupleLen,
				attrName: an,
				sample: parsed,
				fingerprint,
			};
			if (!seenUnknownFingerprints.has(fingerprint) && unknownSamples.length < MAX_SAMPLE_UNKNOWNS) {
				seenUnknownFingerprints.add(fingerprint);
				unknownSamples.push(info);
			}
			out.push({ kind: 'unknown-tag', tag, raw, lineIndex: i, info });
			continue;
		}

		const result = schema.safeParse(parsed);
		if (!result.success) {
			invalidCount++;
			const reason = formatZodError(result.error);
			if (invalidSamples.length < MAX_SAMPLE_INVALIDS) {
				invalidSamples.push({
					lineIndex: i,
					classification: 'invalid-known',
					tag,
					reason,
					path: result.error.issues[0]?.path as Array<string | number>,
				});
			}
			out.push({ kind: 'invalid', tag, raw, lineIndex: i, reason });
			continue;
		}

		knownCount++;
		out.push({ kind: 'known', data: result.data as L, raw, lineIndex: i });
	}

	const report: ValidationReport = {
		docType: opts.docType,
		lineCount: rawLines.length,
		knownCount,
		unknownTagCount,
		invalidCount,
		blankCount,
		samples: { unknownTags: unknownSamples, invalid: invalidSamples },
	};

	return { lines: out, report };
}

/**
 * Serialize parsed lines. Known lines with `mutated: true` are re-stringified
 * from `data`; everything else emits its preserved `raw` string. This preserves
 * byte-identity for untouched lines (including unknown and invalid ones, which
 * we want to pass through without interpreting).
 */
export function serializeParsedLines<L>(lines: ParsedLine<L>[]): string {
	const out: string[] = [];
	for (const line of lines) {
		if (line.kind === 'known' && line.mutated) {
			out.push(JSON.stringify(line.data));
		} else {
			out.push(line.raw);
		}
	}
	return out.join('\n');
}
