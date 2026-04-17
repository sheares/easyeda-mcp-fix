import { z } from 'zod';
import { HeadLine } from './line-head';
import { PinLine } from './line-pin';
import { AttrLine } from './line-attr';
import { FontStyleLine } from './line-fontstyle';
import { parseNdjsonSource, serializeParsedLines } from './parser';
import type { ParsedLine, ValidationReport } from './types';

export const EsymLine = z.union([
	HeadLine,
	PinLine,
	AttrLine,
	FontStyleLine,
]);

export type EsymLine = z.infer<typeof EsymLine>;

const ESYM_SCHEMAS = {
	HEAD: HeadLine,
	PIN: PinLine,
	ATTR: AttrLine,
	FONTSTYLE: FontStyleLine,
};

export function parseEsymSource(source: string): {
	lines: ParsedLine<EsymLine>[];
	report: ValidationReport;
} {
	return parseNdjsonSource<EsymLine>(source, {
		schemaMap: ESYM_SCHEMAS,
		docType: 'esym',
	});
}

export function serializeEsymLines(lines: ParsedLine<EsymLine>[]): string {
	return serializeParsedLines(lines);
}
