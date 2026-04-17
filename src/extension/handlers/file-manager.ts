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

export const fileManagerHandlers: Record<string, (params: Record<string, any>) => Promise<any>> = {
	'fileManager.getDocumentSource': async () => {
		const [source, project, doc] = await Promise.all([
			eda.sys_FileManager.getDocumentSource(),
			eda.dmt_Project.getCurrentProjectInfo(),
			eda.dmt_SelectControl.getCurrentDocumentInfo(),
		]);
		if (source === undefined) {
			throw new Error('No document is currently open, or document source could not be retrieved');
		}
		const proj = project as any;
		const d = doc as any;
		return {
			source,
			context: {
				projectUuid: proj?.uuid,
				projectName: proj?.friendlyName ?? proj?.name,
				documentUuid: d?.uuid,
				documentType: d?.documentType,
			},
		};
	},

	'fileManager.setDocumentSource': async (params) => {
		const success = await eda.sys_FileManager.setDocumentSource(params.source);
		if (!success) {
			throw new Error('Failed to set document source — the format may be invalid');
		}
		return { success };
	},

	'fileManager.getProjectFile': async (params) => {
		const file = await eda.sys_FileManager.getProjectFile(
			params.fileName,
			params.password,
			params.fileType,
		);
		if (!file) {
			throw new Error('Failed to export project file — no project is open or export was denied');
		}
		const data = await fileToBase64(file);
		return { fileName: file.name, data, size: file.size };
	},

	'fileManager.getProjectFileByUuid': async (params) => {
		const file = await eda.sys_FileManager.getProjectFileByProjectUuid(
			params.projectUuid,
			params.fileName,
			params.password,
			params.fileType,
		);
		if (!file) {
			throw new Error(`Failed to export project file for UUID ${params.projectUuid} — project not found or export was denied`);
		}
		const data = await fileToBase64(file);
		let projectName: string | undefined;
		try {
			const proj = await eda.dmt_Project.getProjectInfo(params.projectUuid);
			projectName = (proj as any)?.friendlyName ?? (proj as any)?.name;
		} catch {
			// Best-effort — projectName is a nice-to-have for commit messages.
		}
		return { fileName: file.name, data, size: file.size, projectName };
	},

	'fileManager.importProjectByProjectFile': async (params) => {
		const file = base64ToFile(
			params.data,
			params.fileName || 'import.epro',
			'application/octet-stream',
		);
		const saveTo = params.existingProjectUuid
			? { operation: 'Existing Project' as const, existingProjectUuid: params.existingProjectUuid }
			: undefined;
		const result = await eda.sys_FileManager.importProjectByProjectFile(
			file,
			params.fileType || 'EasyEDA Pro',
			undefined,
			saveTo,
		);
		if (!result) {
			throw new Error('Failed to import project file');
		}
		return result;
	},
};
