// Where an imported project file is saved.
//
// eda.sys_FileManager.importProjectByProjectFile resolves to undefined, with
// no reason given, when saveTo is omitted. A new-project import needs
// saveTo = { operation: 'New Project', newProjectOwnerTeamUuid }. On the
// EasyEDA Pro 3.2 desktop client the team uuid is the local projects folder
// path (e.g. /Users/x/Documents/EasyEDA-Pro/projects), so it is resolved from
// the open project rather than guessed. Found 2026-10-03: every new-project
// import failed, including re-importing EDA's own export.

export type ImportSaveTo =
	| { operation: 'New Project'; newProjectOwnerTeamUuid: string; newProjectFriendlyName?: string }
	| { operation: 'Existing Project'; existingProjectUuid: string };

export interface ImportDestinationParams {
	existingProjectUuid?: string;
	newProjectOwnerTeamUuid?: string;
	newProjectName?: string;
}

export interface ImportDestinationLookups {
	/** teamUuid of the project open in this window, if any */
	currentProjectTeamUuid: () => Promise<string | undefined>;
	/** uuid of the current team, if the client exposes one */
	currentTeamUuid: () => Promise<string | undefined>;
}

async function quietly(lookup: () => Promise<string | undefined>): Promise<string | undefined> {
	try {
		return (await lookup()) || undefined;
	} catch {
		return undefined;
	}
}

export async function resolveImportSaveTo(
	params: ImportDestinationParams,
	lookups: ImportDestinationLookups,
): Promise<ImportSaveTo> {
	if (params.existingProjectUuid) {
		return { operation: 'Existing Project', existingProjectUuid: params.existingProjectUuid };
	}
	const team = params.newProjectOwnerTeamUuid
		|| await quietly(lookups.currentProjectTeamUuid)
		|| await quietly(lookups.currentTeamUuid);
	if (!team) {
		throw new Error(
			'Cannot import as a new project: no owner team found (no project is open in this window and the '
			+ 'client reports no current team). Open any project first, or pass newProjectOwnerTeamUuid.',
		);
	}
	const saveTo: ImportSaveTo = { operation: 'New Project', newProjectOwnerTeamUuid: team };
	if (params.newProjectName) {
		saveTo.newProjectFriendlyName = params.newProjectName;
	}
	return saveTo;
}
