import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { WebSocketBridge } from '../bridge';
import { withInstanceParam, withDocumentParam } from './query-params';
import { backupDocument, backupProject, type BackupResult } from '../backup';
import { validateByDocType, type DocumentContext } from './schema-tools';
import type { ValidationReport } from '../../lib/schema';

/**
 * Fast-batch-edit workflow (when surfaced to agents):
 *
 *   1. Export one document or the whole project to a local file.
 *   2. Edit the raw NDJSON / .epro contents directly on disk — far faster than many
 *      small per-primitive MCP calls.
 *   3. Re-upload the modified file with document_load_from_file / project_import_file.
 *
 * Every destructive upload (document_set_source, document_load_from_file, and
 * project_import_file with existingProjectUuid) is automatically backed up to a
 * local git-tracked repo first. The response includes `backup.sha` so you can
 * reference the pre-edit state if something goes wrong. Backup repo defaults to
 * ~/.easyeda-mcp-backup (override with the EDA_BACKUP_DIR env var).
 *
 * Validation: document_set_source and document_load_from_file accept an optional
 * `validate` parameter ('off' | 'warn' | 'strict', default 'warn'). Validation
 * runs only for schematic documents (documentType=1) — other types skip with a
 * status. In 'warn', schema-invalid known-tag lines and JSON parse errors abort
 * the upload (these are almost always writer bugs); only unknown-tag shapes are
 * tolerated. In 'strict', unknown tags also abort. Validation happens before
 * backup; if validation aborts, no backup is taken and EasyEDA is untouched.
 */

const WORKFLOW_HINT = `\n\nFAST-BATCH WORKFLOW: for making many changes at once, it is much faster to export \
the document or project (document_save_to_file / project_export_file), edit the raw \
source on disk, then re-upload (document_load_from_file / project_import_file) than \
to issue many small per-primitive MCP calls. The document source is newline-delimited \
JSON arrays; .epro files are ZIP archives of the same. Every destructive upload is \
auto-backed-up to a local git repo first — the response includes a backup SHA you can \
use to find the prior state if the edit goes wrong. Upload tools accept validate='off'\
|'warn'|'strict' (default 'warn') which runs the Zod schema on the new source — see\
 document_validate for standalone validation.`;

const ValidateMode = z.enum(['off', 'warn', 'strict']).default('warn');
type ValidateMode = z.infer<typeof ValidateMode>;

function formatBackupSummary(backup: BackupResult): string {
	return `Backed up prior state to ${backup.repo} @ ${backup.sha}${backup.changed ? '' : ' (unchanged from previous backup)'} — path: ${backup.path}`;
}

/** Returns an abort reason string if validation should block the upload, else null. */
function abortReason(mode: ValidateMode, report: ValidationReport): string | null {
	if (mode === 'off' || report.skipped) return null;
	if (report.invalidCount > 0) {
		return `validation aborted: ${report.invalidCount} invalid line(s). First: ${
			report.samples.invalid[0]?.reason ?? '(no detail)'
		}`;
	}
	if (mode === 'strict' && report.unknownTagCount > 0) {
		const tags = [...new Set(report.samples.unknownTags.map((u) => u.tag))].join(', ');
		return `validation aborted (strict): ${report.unknownTagCount} unknown-tag line(s). Tags: ${tags}`;
	}
	return null;
}

/**
 * Fetch the current document's identity context via getDocumentSource so we
 * can drive doc-type gating. Returns the source alongside context.
 */
async function fetchCurrentSourceAndContext(
	bridge: WebSocketBridge,
	params: { instance_id?: string; document: string },
): Promise<{ source: string; context: DocumentContext }> {
	const result = await bridge.send('fileManager.getDocumentSource', params) as {
		source: string;
		context?: DocumentContext;
	};
	return { source: result.source, context: result.context ?? {} };
}

export function registerFileManagerTools(server: McpServer, bridge: WebSocketBridge): void {
	server.tool(
		'document_get_source',
		`Get the raw source code of the currently active document (schematic page, PCB, or panel).
Returns the document as a string in EasyEDA's internal format (newline-delimited JSON arrays).
Use editor_open_document to switch to the desired document first, then call this tool.
The source can be modified and written back with document_set_source.${WORKFLOW_HINT}`,
		withDocumentParam({}),
		async ({ instance_id, ...rest }) => {
			const result = await bridge.send('fileManager.getDocumentSource', { instance_id, ...rest }) as { source: string };
			return { content: [{ type: 'text', text: result.source }] };
		},
	);

	server.tool(
		'document_set_source',
		`Replace the source code of the currently active document.
Accepts the full document source as a string (same format returned by document_get_source).
Returns { success, backup: { sha, path }, validation: {...} } on success, or throws if
validation aborts the upload or the pre-edit backup could not be written.
WARNING: This replaces the entire document. Always get the current source first, modify it,
then set it back. A backup of the prior state is taken automatically before the replacement
(after validation passes) and committed to a local git-tracked repo — the returned
backup.sha references the pre-edit state. Validation runs only for schematic documents
(documentType=1); other types skip with a status.${WORKFLOW_HINT}`,
		withDocumentParam({
			source: z.string().describe('The complete document source code to set'),
			validate: ValidateMode.optional().describe(
				"Schema validation mode for schematic uploads: 'off' skips entirely, 'warn' (default) aborts only on malformed known tags or JSON parse errors, 'strict' also aborts on any unknown-tag line.",
			),
		}),
		async ({ source, instance_id, document, validate }) => {
			const mode = validate ?? 'warn';

			// Need doc-type before we can decide whether to validate. Cheap round-trip.
			const { context } = await fetchCurrentSourceAndContext(bridge, { instance_id, document });

			const validation = mode === 'off'
				? { docType: 'other' as const, skipped: { reason: 'validate=off' }, lineCount: 0, knownCount: 0, unknownTagCount: 0, invalidCount: 0, blankCount: 0, samples: { unknownTags: [], invalid: [] } }
				: await validateByDocType(source, context.documentType, {
					projectUuid: context.projectUuid,
					documentUuid: context.documentUuid,
				});

			const abort = abortReason(mode, validation);
			if (abort) {
				throw new Error(`${abort}\n\nFull validation report:\n${JSON.stringify(validation, null, 2)}`);
			}

			const backup = await backupDocument(bridge, { instance_id, document, toolName: 'document_set_source' });
			const result = await bridge.send('fileManager.setDocumentSource', { source, instance_id, document }) as Record<string, unknown>;
			return { content: [{ type: 'text', text: JSON.stringify({ ...result, backup, validation, note: formatBackupSummary(backup) }, null, 2) }] };
		},
	);

	server.tool(
		'document_save_to_file',
		`Save the source code of the currently active document to a local file.
Fetches the document source from EasyEDA and writes it directly to disk.
The file will contain the document in EasyEDA's internal format (newline-delimited JSON arrays).
Use document_load_from_file to push a modified file back.${WORKFLOW_HINT}`,
		withDocumentParam({
			filePath: z.string().describe('Absolute path to write the document source to'),
		}),
		async ({ filePath, instance_id, ...rest }) => {
			const result = await bridge.send('fileManager.getDocumentSource', { instance_id, ...rest }) as { source: string };
			await mkdir(dirname(filePath), { recursive: true });
			await writeFile(filePath, result.source, 'utf8');
			return { content: [{ type: 'text', text: JSON.stringify({ saved: filePath, size: result.source.length }) }] };
		},
	);

	server.tool(
		'document_load_from_file',
		`Load document source from a local file and push it into the currently active document.
Reads the file from disk and calls setDocumentSource to replace the document contents.
The file must contain valid EasyEDA document source (same format as document_get_source / document_save_to_file).
WARNING: This replaces the entire document. A backup of the prior state is taken automatically
(after validation passes) and committed to a local git-tracked repo — the returned backup.sha
references the pre-edit state. Validation runs only for schematic documents (documentType=1);
other types skip with a status.${WORKFLOW_HINT}`,
		withDocumentParam({
			filePath: z.string().describe('Absolute path to read the document source from'),
			validate: ValidateMode.optional().describe(
				"Schema validation mode for schematic uploads: 'off' skips entirely, 'warn' (default) aborts only on malformed known tags or JSON parse errors, 'strict' also aborts on any unknown-tag line.",
			),
		}),
		async ({ filePath, instance_id, document, validate }) => {
			const mode = validate ?? 'warn';
			const source = await readFile(filePath, 'utf8');

			const { context } = await fetchCurrentSourceAndContext(bridge, { instance_id, document });

			const validation = mode === 'off'
				? { docType: 'other' as const, skipped: { reason: 'validate=off' }, lineCount: 0, knownCount: 0, unknownTagCount: 0, invalidCount: 0, blankCount: 0, samples: { unknownTags: [], invalid: [] } }
				: await validateByDocType(source, context.documentType, {
					projectUuid: context.projectUuid,
					documentUuid: context.documentUuid,
				});

			const abort = abortReason(mode, validation);
			if (abort) {
				throw new Error(`${abort}\n\nFull validation report:\n${JSON.stringify(validation, null, 2)}`);
			}

			const backup = await backupDocument(bridge, { instance_id, document, toolName: 'document_load_from_file' });
			const result = await bridge.send('fileManager.setDocumentSource', { source, instance_id, document }) as Record<string, unknown>;
			return { content: [{ type: 'text', text: JSON.stringify({ ...result, loaded: filePath, size: source.length, backup, validation, note: formatBackupSummary(backup) }, null, 2) }] };
		},
	);

	server.tool(
		'project_export_file',
		`Export the entire current project as a .epro file (ZIP archive) saved directly to a local path.
The .epro file contains: project.json (manifest with board/schematic/PCB associations),
SHEET/ (schematics), PCB/ (layouts), SYMBOL/ (component symbols), FOOTPRINT/ (footprints),
INSTANCE/ (per-instance attribute overrides), and more.
All internal files are human-readable newline-delimited JSON arrays.${WORKFLOW_HINT}`,
		withInstanceParam({
			filePath: z.string().describe('Absolute path to save the .epro file to'),
			fileType: z.enum(['epro', 'epro2']).optional().describe('File format (default: epro)'),
		}),
		async ({ filePath, instance_id, ...rest }) => {
			const result = await bridge.send('fileManager.getProjectFile', { instance_id, ...rest }) as { fileName: string; data: string; size: number };
			const raw = Buffer.from(result.data, 'base64');
			await mkdir(dirname(filePath), { recursive: true });
			await writeFile(filePath, raw);
			return { content: [{ type: 'text', text: JSON.stringify({ saved: filePath, size: raw.length, originalName: result.fileName }) }] };
		},
	);

	server.tool(
		'project_import_file',
		`Import a project file (.epro) from a local path into EasyEDA Pro.
Can import into an existing project (replacing its contents) or create a new project.
Supports EasyEDA Pro, Altium, KiCad, EAGLE, PADS, and LTspice formats.
When importing into an existing project (existingProjectUuid set), a backup of the prior
project state is taken automatically and committed to a local git-tracked repo — the
returned backup.sha references the pre-import state.${WORKFLOW_HINT}`,
		withInstanceParam({
			filePath: z.string().describe('Absolute path to the .epro file to import'),
			fileType: z.enum([
				'EasyEDA Pro', 'JLCEDA', 'JLCEDA Pro', 'EasyEDA',
				'Altium Designer', 'Protel', 'OrCAD', 'EAGLE', 'KiCad', 'PADS', 'LTspice', 'Allegro',
			]).optional().describe('Source format (default: EasyEDA Pro)'),
			existingProjectUuid: z.string().optional().describe(
				'UUID of existing project to import into. If omitted, creates a new project.',
			),
		}),
		async ({ filePath, instance_id, existingProjectUuid, ...rest }) => {
			const raw = await readFile(filePath);
			const data = raw.toString('base64');
			const fileName = filePath.split('/').pop() || 'import.epro';

			let backup: BackupResult | undefined;
			if (existingProjectUuid) {
				backup = await backupProject(bridge, {
					instance_id,
					projectUuid: existingProjectUuid,
					toolName: 'project_import_file',
				});
			}

			const result = await bridge.send('fileManager.importProjectByProjectFile', {
				data, fileName, instance_id, existingProjectUuid, ...rest,
			});
			const payload: Record<string, unknown> = { ...(result as object) };
			if (backup) {
				payload.backup = backup;
				payload.note = formatBackupSummary(backup);
			}
			return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
		},
	);
}
