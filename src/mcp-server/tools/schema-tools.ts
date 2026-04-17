import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import type { WebSocketBridge } from '../bridge';
import { withInstanceParam, withDocumentParam } from './query-params';
import {
	parseEschSource,
	parseEsymSource,
	logDiscovery,
	type ValidationReport,
} from '../../lib/schema';

/**
 * Documented document type codes from EasyEDA:
 *   1  = schematic page (.esch)
 *   3  = PCB (.epcb)
 *   26 = panel (.epan)
 */
const SCHEMATIC_DOC_TYPE = 1;

/**
 * Validate a schematic source string with the .esch schema. Unknowns are
 * appended to the discovery log as a side effect (best-effort, errors swallowed).
 */
export async function validateSchematicSource(
	source: string,
	context: { projectUuid?: string; documentUuid?: string },
): Promise<ValidationReport> {
	const { report } = parseEschSource(source);
	if (report.samples.unknownTags.length > 0) {
		try {
			await logDiscovery(report.samples.unknownTags, { docType: 'esch', ...context });
		} catch (err) {
			// Discovery log is best-effort; don't let it break validation.
			console.error('[schema] discovery log write failed:', err);
		}
	}
	return report;
}

export async function validateSymbolSource(
	source: string,
	context: { projectUuid?: string; documentUuid?: string },
): Promise<ValidationReport> {
	const { report } = parseEsymSource(source);
	if (report.samples.unknownTags.length > 0) {
		try {
			await logDiscovery(report.samples.unknownTags, { docType: 'esym', ...context });
		} catch (err) {
			console.error('[schema] discovery log write failed:', err);
		}
	}
	return report;
}

export interface DocumentContext {
	projectUuid?: string;
	projectName?: string;
	documentUuid?: string;
	documentType?: number;
}

/** Build a "skipped" validation report for non-schematic doc types. */
export function skippedReport(reason: string, docType: 'esch' | 'esym' | 'other' = 'other'): ValidationReport {
	return {
		docType,
		skipped: { reason },
		lineCount: 0,
		knownCount: 0,
		unknownTagCount: 0,
		invalidCount: 0,
		blankCount: 0,
		samples: { unknownTags: [], invalid: [] },
	};
}

/**
 * Run validation for a document of the given type. Non-schematic types return
 * a skipped report. Schematic types parse via the .esch schema.
 */
export async function validateByDocType(
	source: string,
	docType: number | undefined,
	context: { projectUuid?: string; documentUuid?: string },
): Promise<ValidationReport> {
	if (docType === SCHEMATIC_DOC_TYPE) {
		return validateSchematicSource(source, context);
	}
	return skippedReport(`no schema for documentType=${docType ?? 'unknown'}`);
}

export function registerSchemaTools(server: McpServer, bridge: WebSocketBridge): void {
	server.tool(
		'document_validate',
		`Validate a document's source against the Zod-backed EasyEDA schema.
Runs on the currently active document by default, or on a local file if filePath is provided.
Only schematic documents (.esch, documentType=1) are validated today — other types return a
"skipped" report with a reason. Unknown tags (shapes the schema doesn't cover yet) are
appended to the discovery log at ~/.easyeda-schema-discovery.jsonl (override via EDA_DISCOVERY_LOG).

Returns a JSON-serializable report: { docType, lineCount, knownCount, unknownTagCount,
invalidCount, samples: { unknownTags, invalid } }. Known issues are samples of known
tags whose shape failed validation (typically writer bugs); unknowns are tags not yet
in the schema vocabulary.`,
		withDocumentParam({
			filePath: z.string().optional().describe(
				'Absolute path to a local file to validate. If omitted, validates the currently active document.',
			),
		}),
		async ({ filePath, instance_id, document }) => {
			let source: string;
			let context: DocumentContext = {};

			if (filePath) {
				source = await readFile(filePath, 'utf8');
				// No live-doc context when validating a file.
			} else {
				const result = await bridge.send('fileManager.getDocumentSource', { instance_id, document }) as {
					source: string;
					context?: DocumentContext;
				};
				source = result.source;
				context = result.context || {};
			}

			const report = await validateByDocType(source, context.documentType, {
				projectUuid: context.projectUuid,
				documentUuid: context.documentUuid,
			});
			return { content: [{ type: 'text', text: JSON.stringify(report, null, 2) }] };
		},
	);
}

export { SCHEMATIC_DOC_TYPE };
