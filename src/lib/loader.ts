/**
 * Convenience loader for EasyEDA Pro schematics.
 *
 * Given an extracted .epro directory and a schematic page UUID, loads
 * the schematic source, all symbol files, and project.json, then
 * returns a fully-parsed SchematicModel ready for editing.
 */

import { readFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';
import { parseSchematic, SchematicModel, ProjectJson } from './schematic-reader';

export interface LoadedSchematic {
	/** The raw source string */
	source: string;
	/** Fully-parsed model with pins resolved */
	model: SchematicModel;
	/** Parsed project.json */
	projectJson: ProjectJson;
	/** Path to the .esch file that was loaded */
	schematicPath: string;
}

/**
 * Load a schematic from an extracted .epro directory.
 *
 * @param eproDir - Path to the extracted .epro directory (contains project.json, SHEET/, SYMBOL/, etc.)
 * @param schematicUuid - UUID of the schematic to load (the schematic UUID, not the page UUID)
 * @param pageId - Page number (default 1)
 */
export function loadSchematic(eproDir: string, schematicUuid: string, pageId: number = 1): LoadedSchematic {
	// Load project.json
	const projectJsonPath = join(eproDir, 'project.json');
	if (!existsSync(projectJsonPath)) {
		throw new Error(`project.json not found in ${eproDir}`);
	}
	const projectJson: ProjectJson = JSON.parse(readFileSync(projectJsonPath, 'utf8'));

	// Load schematic source
	const schPath = join(eproDir, 'SHEET', schematicUuid, `${pageId}.esch`);
	if (!existsSync(schPath)) {
		// Try to find it by listing SHEET directories
		const sheetDir = join(eproDir, 'SHEET');
		const available = existsSync(sheetDir) ? readdirSync(sheetDir) : [];
		throw new Error(
			`Schematic not found at ${schPath}. Available: ${available.join(', ')}`,
		);
	}
	const source = readFileSync(schPath, 'utf8');

	// Load all symbol files
	const symbolDir = join(eproDir, 'SYMBOL');
	const symbolSources: Record<string, string> = {};
	if (existsSync(symbolDir)) {
		for (const f of readdirSync(symbolDir)) {
			if (f.endsWith('.esym')) {
				const uuid = f.replace('.esym', '');
				symbolSources[uuid] = readFileSync(join(symbolDir, f), 'utf8');
			}
		}
	}

	// Parse
	const model = parseSchematic(source, symbolSources, projectJson);

	return { source, model, projectJson, schematicPath: schPath };
}

/**
 * List all schematics in an extracted .epro directory.
 * Returns an array of { uuid, name, pages } from project.json.
 */
export function listSchematics(eproDir: string): Array<{ uuid: string; name: string; boardName?: string; pages: Array<{ id: number; uuid: string; name: string }> }> {
	const projectJson = JSON.parse(readFileSync(join(eproDir, 'project.json'), 'utf8'));
	const result: Array<{ uuid: string; name: string; boardName?: string; pages: Array<{ id: number; uuid: string; name: string }> }> = [];

	// Schematics from project.json
	const schematics = projectJson.schematics ?? {};
	const boards = projectJson.boards ?? {};

	// Build board lookup: schematic uuid -> board name
	const schToBoard: Record<string, string> = {};
	for (const [boardName, board] of Object.entries(boards) as [string, any][]) {
		if (board.schematic) schToBoard[board.schematic] = boardName;
	}

	for (const [uuid, sch] of Object.entries(schematics) as [string, any][]) {
		const pages = (sch.sheets ?? []).map((s: any) => ({
			id: s.id,
			uuid: s.uuid,
			name: s.name,
		}));
		result.push({
			uuid,
			name: sch.name,
			boardName: schToBoard[uuid],
			pages,
		});
	}

	return result;
}
