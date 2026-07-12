async function fileToBase64(file: File): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => {
			const dataUrl = reader.result as string;
			resolve(dataUrl.split(',')[1] || '');
		};
		reader.onerror = () => reject(new Error('Failed to read file'));
		reader.readAsDataURL(file);
	});
}

function base64ToFile(base64: string, fileName: string, mimeType = 'application/octet-stream'): File {
	const binaryStr = atob(base64);
	const bytes = new Uint8Array(binaryStr.length);
	for (let i = 0; i < binaryStr.length; i++) {
		bytes[i] = binaryStr.charCodeAt(i);
	}
	return new File([bytes], fileName, { type: mimeType });
}

async function exportFile(file: File | undefined): Promise<{ fileName: string; data: string; size: number }> {
	if (!file) throw new Error('Failed to export file');
	const data = await fileToBase64(file);
	return { fileName: file.name, data, size: file.size };
}

// getPdfFile and get3DFile are known to hang forever in the EasyEDA web app
// (the export dialogue's renderer never resolves headlessly). Cap them so the
// caller gets a diagnosis instead of an open-ended stall.
const EXPORT_TIMEOUT_MS = 30_000;

function withExportTimeout<T>(promise: Promise<T>, apiName: string): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => {
			reject(new Error(
				`${apiName} did not resolve within ${EXPORT_TIMEOUT_MS / 1000}s. ` +
				'This is a known EasyEDA hang in the web app; use the desktop client, ' +
				'or export manually via File menu.',
			));
		}, EXPORT_TIMEOUT_MS);
		promise.then(
			(value) => { clearTimeout(timer); resolve(value); },
			(err) => { clearTimeout(timer); reject(err); },
		);
	});
}

// Standard fab-layer types we want included by default when no explicit
// `layers` list is supplied. Without this, EasyEDA's getGerberFile /
// getOpenDatabaseDoublePlusFile only emit Top+Bottom copper — inner copper
// layers go missing even on 4L+ boards.
const DEFAULT_FAB_LAYER_TYPES = new Set([
	'TOP', 'BOTTOM', 'SIGNAL', // copper (SIGNAL = Inner1..InnerN)
	'TOP_SILK', 'BOT_SILK',
	'TOP_SOLDER_MASK', 'BOT_SOLDER_MASK',
	'TOP_PASTE_MASK', 'BOT_PASTE_MASK',
	'OUTLINE',
]);

async function defaultEnabledFabLayers(mirrorKey: 'isMirror' | 'mirror'): Promise<Array<Record<string, unknown>>> {
	const all = (await eda.pcb_Layer.getAllLayers()) as Array<{ id: number; type: string; layerStatus: number }>;
	return all
		.filter((l) => l.layerStatus === 1 && DEFAULT_FAB_LAYER_TYPES.has(l.type))
		.map((l) => ({ layerId: l.id, [mirrorKey]: false }));
}

export const manufactureHandlers: Record<string, (params: Record<string, any>) => Promise<any>> = {
	// === Export ===

	'pcb.manufacture.getDsnFile': async (params) => {
		const file = await eda.pcb_ManufactureData.getDsnFile(params.fileName);
		return exportFile(file);
	},

	'pcb.manufacture.getAutoRouteJsonFile': async (params) => {
		const file = await eda.pcb_ManufactureData.getAutoRouteJsonFile(params.fileName);
		return exportFile(file);
	},

	'pcb.manufacture.getAutoLayoutJsonFile': async (params) => {
		const file = await eda.pcb_ManufactureData.getAutoLayoutJsonFile(params.fileName);
		return exportFile(file);
	},

	'pcb.manufacture.getGerberFile': async (params) => {
		const layers = params.layers ?? (await defaultEnabledFabLayers('isMirror'));
		const file = await eda.pcb_ManufactureData.getGerberFile(
			params.fileName,
			params.colorSilkscreen,
			params.unit,
			params.digitalFormat,
			params.other,
			layers,
			params.objects,
		);
		return exportFile(file);
	},

	'pcb.manufacture.getBomFile': async (params) => {
		const file = await eda.pcb_ManufactureData.getBomFile(
			params.fileName,
			params.fileType,
			params.template,
			params.filterOptions,
			params.statistics,
			params.property,
			params.columns,
		);
		return exportFile(file);
	},

	'pcb.manufacture.getPickAndPlaceFile': async (params) => {
		const file = await eda.pcb_ManufactureData.getPickAndPlaceFile(
			params.fileName,
			params.fileType,
			params.unit,
		);
		return exportFile(file);
	},

	'pcb.manufacture.get3DFile': async (params) => {
		const file = await withExportTimeout(
			eda.pcb_ManufactureData.get3DFile(
				params.fileName,
				params.fileType,
				params.element,
				params.modelMode,
				params.autoGenerateModels,
			),
			'get3DFile',
		);
		return exportFile(file);
	},

	'pcb.manufacture.getPdfFile': async (params) => {
		const file = await withExportTimeout(
			eda.pcb_ManufactureData.getPdfFile(params.fileName),
			'getPdfFile',
		);
		return exportFile(file);
	},

	'pcb.manufacture.getNetlistFile': async (params) => {
		const file = await eda.pcb_ManufactureData.getNetlistFile(params.fileName, params.netlistType);
		return exportFile(file);
	},

	'pcb.manufacture.getDxfFile': async (params) => {
		const file = await eda.pcb_ManufactureData.getDxfFile(params.fileName, params.layers, params.objects);
		return exportFile(file);
	},

	'pcb.manufacture.getAltiumDesignerFile': async (params) => {
		const file = await eda.pcb_ManufactureData.getAltiumDesignerFile(params.fileName);
		return exportFile(file);
	},

	'pcb.manufacture.getPadsFile': async (params) => {
		const file = await eda.pcb_ManufactureData.getPadsFile(params.fileName);
		return exportFile(file);
	},

	'pcb.manufacture.getOpenDatabaseDoublePlusFile': async (params) => {
		const layers = params.layers ?? (await defaultEnabledFabLayers('mirror'));
		const file = await eda.pcb_ManufactureData.getOpenDatabaseDoublePlusFile(
			params.fileName,
			params.unit,
			params.otherData,
			layers,
			params.objects,
		);
		return exportFile(file);
	},

	'pcb.manufacture.getIpcD356AFile': async (params) => {
		const file = await eda.pcb_ManufactureData.getIpcD356AFile(params.fileName);
		return exportFile(file);
	},

	'pcb.manufacture.getFlyingProbeTestFile': async (params) => {
		const file = await eda.pcb_ManufactureData.getFlyingProbeTestFile(params.fileName);
		return exportFile(file);
	},

	'pcb.manufacture.getTestPointFile': async (params) => {
		const file = await eda.pcb_ManufactureData.getTestPointFile(params.fileName, params.fileType);
		return exportFile(file);
	},

	// === Import ===

	'pcb.manufacture.importAutoRouteJson': async (params) => {
		const file = base64ToFile(params.data, params.fileName || 'autoroute.json');
		return eda.pcb_Document.importAutoRouteJsonFile(file);
	},

	'pcb.manufacture.importAutoLayoutJson': async (params) => {
		const file = base64ToFile(params.data, params.fileName || 'autolayout.json');
		return eda.pcb_Document.importAutoLayoutJsonFile(file);
	},

	// importAutoRouteSesFile exists at runtime (used by freerouting extension) but not in type definitions
	'pcb.manufacture.importAutoRouteSes': async (params) => {
		const file = base64ToFile(params.data, params.fileName || 'autoroute.ses');
		const doc = eda.pcb_Document as any;
		if (typeof doc.importAutoRouteSesFile !== 'function') {
			throw new Error('importAutoRouteSesFile API is not available in this version');
		}
		return doc.importAutoRouteSesFile(file);
	},
};
