// project_import_file destination (2026-10-03). Without saveTo, EasyEDA's
// importProjectByProjectFile resolves undefined for every new-project import,
// so the extension must name an owner team itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveImportSaveTo } from '../src/extension/import-destination';

const TEAM = '/Users/test/Documents/EasyEDA-Pro/projects';
const lookups = (project?: string, team?: string) => ({
	currentProjectTeamUuid: async () => project,
	currentTeamUuid: async () => team,
});

test('existing project uuid -> Existing Project, no team lookup needed', async () => {
	const saveTo = await resolveImportSaveTo({ existingProjectUuid: 'p1' }, lookups());
	assert.deepEqual(saveTo, { operation: 'Existing Project', existingProjectUuid: 'p1' });
});

test('new project takes the open project\'s team', async () => {
	const saveTo = await resolveImportSaveTo({}, lookups(TEAM, 'other-team'));
	assert.deepEqual(saveTo, { operation: 'New Project', newProjectOwnerTeamUuid: TEAM });
});

test('falls back to the current team when no project is open', async () => {
	const saveTo = await resolveImportSaveTo({}, lookups(undefined, 'team-9'));
	assert.deepEqual(saveTo, { operation: 'New Project', newProjectOwnerTeamUuid: 'team-9' });
});

test('a lookup that throws counts as absent, not as a failure', async () => {
	const saveTo = await resolveImportSaveTo({}, {
		currentProjectTeamUuid: async () => { throw new Error('no project'); },
		currentTeamUuid: async () => 'team-9',
	});
	assert.equal(saveTo.operation, 'New Project');
	assert.equal((saveTo as any).newProjectOwnerTeamUuid, 'team-9');
});

test('explicit team and name are passed through', async () => {
	const saveTo = await resolveImportSaveTo({ newProjectOwnerTeamUuid: 'T', newProjectName: 'Colpen LDO test' }, lookups(TEAM));
	assert.deepEqual(saveTo, { operation: 'New Project', newProjectOwnerTeamUuid: 'T', newProjectFriendlyName: 'Colpen LDO test' });
});

test('no team anywhere -> a clear error instead of EasyEDA\'s silent undefined', async () => {
	await assert.rejects(resolveImportSaveTo({}, lookups()), /no owner team found/);
});
