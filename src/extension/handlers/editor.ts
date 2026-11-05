import { waitForDocumentReady, waitForProjectReady } from '../ready-wait-eda';

/**
 * Recursively strip keys that are useless to LLMs (e.g. titleBlockData, showTitleBlock).
 * Mutates in place for efficiency — callers should pass a fresh copy if needed.
 */
function stripBloat(obj: any): any {
	if (obj == null || typeof obj !== 'object') return obj;
	if (Array.isArray(obj)) {
		for (const item of obj) stripBloat(item);
		return obj;
	}
	delete obj.titleBlockData;
	delete obj.showTitleBlock;
	for (const val of Object.values(obj)) {
		if (val && typeof val === 'object') stripBloat(val);
	}
	return obj;
}

// Screenshot/image capture is NOT implemented. As of 2026-03-15, all three
// candidate EasyEDA Pro APIs fail in the web app:
//   - sch_ManufactureData.getExportDocumentFile() — hangs forever (never resolves),
//     regardless of file type (PNG/SVG/PDF) or parameters. The function exists and
//     is callable, but the returned Promise never settles.
//   - pcb_ManufactureData.getPdfFile() — same behavior (never resolves).
//   - dmt_EditorControl.getCurrentRenderedAreaImage() — returns undefined immediately.
// These APIs may work in the desktop Electron app but not the web version.
// Reported to EasyEDA Pro engineering (Haidy @ LCSC/JLCPCB).

export const editorHandlers: Record<string, (params: Record<string, any>) => Promise<any>> = {
	'editor.project.getStructure': async () => {
		// A project that is still loading reads as `data: []` (seen live on
		// 3.2.209 straight after opening one). A no-op before 3.2.209.
		await waitForProjectReady();
		const [project, currentDoc] = await Promise.all([
			eda.dmt_Project.getCurrentProjectInfo(),
			eda.dmt_SelectControl.getCurrentDocumentInfo(),
		]);
		return { project: stripBloat(project), currentDocument: currentDoc };
	},

	'editor.getCurrentDocument': async () => {
		const doc = await eda.dmt_SelectControl.getCurrentDocumentInfo();
		if (!doc) {
			return { document: undefined };
		}

		const result: Record<string, any> = { document: doc };

		// Schematic page (documentType 1)
		if (doc.documentType === 1) {
			const [page, schematic] = await Promise.all([
				eda.dmt_Schematic.getCurrentSchematicPageInfo(),
				eda.dmt_Schematic.getCurrentSchematicInfo(),
			]);
			result.schematicPage = page;
			result.schematic = schematic;
		}

		// PCB (documentType 3)
		if (doc.documentType === 3) {
			const [pcb, board] = await Promise.all([
				eda.dmt_Pcb.getCurrentPcbInfo(),
				eda.dmt_Board.getCurrentBoardInfo(),
			]);
			result.pcb = pcb;
			result.board = board;
		}

		return result;
	},

	'editor.openDocument': async (params) => {
		const opened = await eda.dmt_EditorControl.openDocument(params.documentUuid);
		// Return only once the document can be read, so a follow-up call does
		// not see it half-loaded. A no-op before 3.2.209.
		await waitForDocumentReady(params.documentUuid);
		return opened;
	},

	'editor.getOpenTabs': async () => {
		const [tree, currentDoc] = await Promise.all([
			eda.dmt_EditorControl.getSplitScreenTree(),
			eda.dmt_SelectControl.getCurrentDocumentInfo(),
		]);

		const tabs: Array<{ title: string; tabId: string; isActive: boolean }> = [];
		const activeUuid = currentDoc?.uuid;

		function collectTabs(node: any): void {
			if (node.tabs) {
				for (const tab of node.tabs) {
					tabs.push({
						title: tab.title,
						tabId: tab.tabId,
						isActive: activeUuid ? tab.tabId.startsWith(activeUuid) : false,
					});
				}
			}
			if (node.children) {
				for (const child of node.children) {
					collectTabs(child);
				}
			}
		}

		if (tree) {
			collectTabs(tree);
		}

		return { tabs, splitScreenTree: tree };
	},
};
