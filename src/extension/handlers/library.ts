import { BridgeUserError } from '../diag';

export const libraryHandlers: Record<string, (params: Record<string, any>) => Promise<any>> = {
	'lib.device.search': async (params) => {
		return eda.lib_Device.search(
			params.key,
			params.libraryUuid,
			params.classification,
			params.symbolType,
			params.itemsOfPage,
			params.page,
		);
	},

	'lib.device.get': async (params) => {
		return eda.lib_Device.get(params.deviceUuid, params.libraryUuid);
	},

	'lib.device.getByLcscIds': async (params) => {
		return eda.lib_Device.getByLcscIds(params.lcscIds, params.libraryUuid);
	},

	'lib.device.copy': async (params) => {
		return eda.lib_Device.copy(
			params.deviceUuid,
			params.libraryUuid,
			params.targetLibraryUuid,
			params.targetClassification,
			params.newDeviceName,
		);
	},

	'lib.device.modify': async (params) => {
		return eda.lib_Device.modify(
			params.deviceUuid,
			params.libraryUuid,
			params.deviceName,
			params.classification,
			params.association,
			params.description,
			params.property,
		);
	},

	'lib.device.delete': async (params) => {
		return eda.lib_Device.delete(params.deviceUuid, params.libraryUuid);
	},

	'lib.symbol.get': async (params) => {
		return eda.lib_Symbol.get(params.symbolUuid, params.libraryUuid);
	},

	'lib.symbol.copy': async (params) => {
		return eda.lib_Symbol.copy(
			params.symbolUuid,
			params.libraryUuid,
			params.targetLibraryUuid,
			params.targetClassification,
			params.newSymbolName,
		);
	},

	'lib.symbol.delete': async (params) => {
		return eda.lib_Symbol.delete(params.symbolUuid, params.libraryUuid);
	},

	'lib.symbol.openInEditor': async (params) => {
		const result = await eda.lib_Symbol.openInEditor(params.symbolUuid, params.libraryUuid, params.splitScreenId);
		// The SDK returns `false` (no throw, no tab) when it will not open the
		// symbol, which in the field includes every system-library symbol.
		// Surface that as an error instead of a bare boolean the caller then
		// tries to use as a tabId.
		if (typeof result !== 'string' || result.length === 0) {
			throw new BridgeUserError(
				`EDA Pro refused to open symbol ${params.symbolUuid} (library ${params.libraryUuid}) in the editor (returned ${JSON.stringify(result)}). System-library symbols cannot be opened this way; copy the symbol into a personal or project library first (lib_symbol_copy) and open that copy.`,
			);
		}
		return result;
	},

	'lib.symbol.updateDocumentSource': async (params) => {
		return eda.lib_Symbol.updateDocumentSource(
			params.symbolUuid,
			params.libraryUuid,
			params.documentSource,
		);
	},

	'lib.getSystemLibraryUuid': async () => {
		return eda.lib_LibrariesList.getSystemLibraryUuid();
	},

	'lib.getPersonalLibraryUuid': async () => {
		return eda.lib_LibrariesList.getPersonalLibraryUuid();
	},

	'lib.getProjectLibraryUuid': async () => {
		return eda.lib_LibrariesList.getProjectLibraryUuid();
	},

	'lib.getAllLibraries': async () => {
		return eda.lib_LibrariesList.getAllLibrariesList();
	},
};
