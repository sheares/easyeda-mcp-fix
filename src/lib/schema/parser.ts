/**
 * Shared NDJSON parser engine. `.esch` and `.esym` both wrap this with their
 * own schema maps.
 */

import type { z, ZodError } from 'zod';
import type {
	ParsedLine,
	SchemaDocType,
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
	docType: SchemaDocType;
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

/**
 * Wrap a freshly-built (writer-side) line tuple as a ParsedLine. Marks
 * mutated:true so the serializer re-stringifies from `data` rather than
 * looking at `raw`. lineIndex=-1 signals "not from the source document".
 *
 * Use the per-tag factories (e.g. makeComponentLine) to build `data` first;
 * this helper is the boundary between "validated tuple" and "ready to add
 * to a ParsedLine[] stream".
 */
export function wrapAsParsedLine<L>(data: L): ParsedLine<L> {
	return { kind: 'known', data, raw: JSON.stringify(data), lineIndex: -1, mutated: true };
}

/**
 * EasyEDA Pro 3 returns live documents (getDocumentSource, so
 * document_save_to_file) as `{header}||{body}|` lines rather than the JSON
 * arrays the per-tag schemas describe; project_export_file still writes JSON
 * arrays. The header names the line's `type` (and usually `id` and `ticket`);
 * the body holds the data, and every line but the last ends in a single `|`
 * (see normalisePipeLineEnds).
 */
export function isPipeFormatSource(source: string): boolean {
	const firstLine = source.trimStart().split('\n', 1)[0];
	return firstLine.startsWith('{') && firstLine.includes('}||');
}

export const PIPE_FORMAT_NOTE =
	'EasyEDA Pro 3 pipe-delimited source ({header}||{body} lines): each line was checked for structure only ' +
	'(a JSON header naming a string "type", then a JSON object body). The per-tag schemas cover the JSON-array format that project_export_file writes.';

function splitPipeLine(line: string): { ok: true; type: string } | { ok: false; reason: string } {
	// The header is the shortest prefix before a "||" that parses as JSON.
	for (let at = line.indexOf('||'); at >= 0; at = line.indexOf('||', at + 1)) {
		let header: unknown;
		try {
			header = JSON.parse(line.slice(0, at));
		} catch {
			continue;
		}
		if (header === null || typeof header !== 'object' || Array.isArray(header) || typeof (header as any).type !== 'string') {
			return { ok: false, reason: 'header is not a JSON object with a string "type"' };
		}
		let body = line.slice(at + 2);
		if (body.endsWith('|')) body = body.slice(0, -1);
		if (body === '') return { ok: true, type: (header as any).type };
		let parsed: unknown;
		try {
			parsed = JSON.parse(body);
		} catch (err) {
			return { ok: false, reason: `body is not valid JSON: ${err instanceof Error ? err.message : String(err)}` };
		}
		if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
			return { ok: false, reason: 'body is not a JSON object' };
		}
		return { ok: true, type: (header as any).type };
	}
	return { ok: false, reason: 'no JSON header followed by "||"' };
}

/** Index of the "||" that ends a line's JSON header, or -1. */
function pipeHeaderEnd(line: string): number {
	for (let at = line.indexOf('||'); at >= 0; at = line.indexOf('||', at + 1)) {
		try {
			JSON.parse(line.slice(0, at));
			return at;
		} catch {
			// not the header's end yet
		}
	}
	return -1;
}

/**
 * EasyEDA writes a pipe source as records joined by "|\n": every line ends in
 * "|" except the last. setDocumentSource rejects a source that breaks this
 * ("Failed to set document source - the format may be invalid"), which is easy
 * to do by hand: delete the record that was last, or append one after it. Seen
 * on EasyEDA Pro 3.2.209 (5 Nov 2026). This puts the line ends back the way
 * EasyEDA writes them and drops blank lines. Any other format is returned
 * unchanged.
 */
export function normalisePipeLineEnds(source: string): { source: string; fixed: number } {
	if (!isPipeFormatSource(source)) return { source, fixed: 0 };
	let fixed = 0;
	const lines: string[] = [];
	for (const raw of source.split('\n')) {
		const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
		if (line !== raw) fixed++;
		if (line.trim() === '') continue;
		lines.push(line);
	}
	const blankInside = source.replace(/\r?\n$/, '').split('\n').filter((l) => l.trim() === '').length;
	fixed += blankInside;
	for (let i = 0; i < lines.length; i++) {
		const at = pipeHeaderEnd(lines[i]);
		if (at < 0) continue; // left for the validator to report
		const rest = lines[i].slice(at + 2);
		const last = i === lines.length - 1;
		if (last && rest.endsWith('|')) {
			lines[i] = lines[i].slice(0, -1);
			fixed++;
		} else if (!last && !rest.endsWith('|')) {
			lines[i] += '|';
			fixed++;
		}
	}
	return { source: lines.join('\n'), fixed };
}

/** Structural check of a pipe-delimited source. See PIPE_FORMAT_NOTE. */
export function validatePipeSource(source: string, docType: SchemaDocType): ValidationReport {
	const rawLines = source.split('\n');
	const invalid: ValidationIssue[] = [];
	let knownCount = 0;
	let invalidCount = 0;
	let blankCount = 0;
	for (let i = 0; i < rawLines.length; i++) {
		const trimmed = rawLines[i].trim();
		if (!trimmed) {
			blankCount++;
			continue;
		}
		const result = splitPipeLine(trimmed);
		if (result.ok) {
			knownCount++;
			continue;
		}
		invalidCount++;
		if (invalid.length < MAX_SAMPLE_INVALIDS) {
			invalid.push({ lineIndex: i, classification: 'parse-error', tag: null, reason: result.reason });
		}
	}
	return {
		docType,
		note: PIPE_FORMAT_NOTE,
		lineCount: rawLines.length,
		knownCount,
		unknownTagCount: 0,
		invalidCount,
		blankCount,
		samples: { unknownTags: [], invalid },
	};
}

/**
 * The reader, writer and symbol editor only understand the JSON-array format.
 * Fed a pipe-delimited source they would see no lines they know and go on with
 * an empty model, so refuse it instead.
 */
export function assertArrayFormatSource(source: string, what: string): void {
	if (isPipeFormatSource(source)) {
		throw new Error(
			`${what}: this source is in EasyEDA Pro 3's pipe-delimited format ({header}||{body} lines), which this library cannot read. ` +
				'It reads the JSON-array format (lines like ["HEAD",{...}]) that project_export_file writes, so take the source from an .epro export, not document_save_to_file.',
		);
	}
}
