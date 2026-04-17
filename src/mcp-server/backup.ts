import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile, mkdir, access, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import JSZip from 'jszip';
import type { WebSocketBridge } from './bridge';

const execFileP = promisify(execFile);

const DEFAULT_BACKUP_DIR = join(homedir(), '.easyeda-mcp-backup');
const MAX_LOCK_RETRIES = 5;
const LOCK_RETRY_BASE_MS = 100;

export function getBackupDir(): string {
	return process.env.EDA_BACKUP_DIR || DEFAULT_BACKUP_DIR;
}

function docExtensionFor(docType: number | undefined): string {
	switch (docType) {
		case 1: return '.esch';     // schematic page
		case 3: return '.epcb';     // PCB
		case 26: return '.epan';    // panel
		default: return '.doc';
	}
}

async function exists(path: string): Promise<boolean> {
	try { await access(path); return true; } catch { return false; }
}

async function ensureRepo(repoPath: string): Promise<void> {
	await mkdir(repoPath, { recursive: true });
	if (await exists(join(repoPath, '.git'))) return;
	await execFileP('git', ['init', '-q'], { cwd: repoPath });
	// Local-only config so commits work without depending on the user's global git config.
	await execFileP('git', ['config', 'user.name', 'easyeda-mcp-backup'], { cwd: repoPath });
	await execFileP('git', ['config', 'user.email', 'easyeda-mcp-backup@localhost'], { cwd: repoPath });
	// Automatic GC — let git manage repo size on its own over time.
	await execFileP('git', ['config', 'gc.auto', '256'], { cwd: repoPath });
	// Empty initial commit so HEAD exists for `rev-parse HEAD` queries.
	await execFileP('git', ['commit', '--allow-empty', '-q', '-m', 'Initial backup repo'], { cwd: repoPath });
}

function isLockError(err: any): boolean {
	const msg = (err?.stderr || err?.message || '') as string;
	return msg.includes('index.lock') || msg.includes('cannot lock ref') || msg.includes('Unable to create');
}

async function gitWithLockRetry(repoPath: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
	let lastErr: any;
	for (let attempt = 0; attempt < MAX_LOCK_RETRIES; attempt++) {
		try {
			return await execFileP('git', args, { cwd: repoPath });
		} catch (err: any) {
			lastErr = err;
			if (!isLockError(err)) throw err;
			const wait = LOCK_RETRY_BASE_MS * Math.pow(2, attempt);
			await new Promise((r) => setTimeout(r, wait));
		}
	}
	throw lastErr;
}

/**
 * Stage everything under `subpath`, commit if anything changed, return current HEAD SHA.
 * If nothing changed, skip the commit but still return HEAD (the SHA that represents "this state").
 */
async function commitAndGetSha(repoPath: string, subpath: string, message: string): Promise<string> {
	await gitWithLockRetry(repoPath, ['add', '-A', '--', subpath]);
	const { stdout: staged } = await gitWithLockRetry(repoPath, ['diff', '--cached', '--name-only', '--', subpath]);
	if (staged.trim()) {
		await gitWithLockRetry(repoPath, ['commit', '-q', '-m', message, '--', subpath]);
	}
	const { stdout } = await gitWithLockRetry(repoPath, ['rev-parse', 'HEAD']);
	return stdout.trim();
}

export interface BackupResult {
	sha: string;
	path: string;          // path relative to the backup repo root
	absolutePath: string;  // absolute path on disk
	repo: string;          // absolute path to the backup repo
	changed: boolean;      // false if the content was identical to the prior backup
}

interface DocSourceResponse {
	source: string;
	context?: {
		projectUuid?: string;
		projectName?: string;
		documentUuid?: string;
		documentType?: number;
	};
}

export interface DocumentBackupParams {
	instance_id?: string;
	document: string;
	toolName: string;
}

/**
 * Back up the currently active document to the local git-tracked backup repo.
 * Must be called before any destructive doc-level operation.
 * Throws on any failure — callers should NOT proceed with the destructive op if backup fails.
 */
export async function backupDocument(
	bridge: WebSocketBridge,
	{ instance_id, document, toolName }: DocumentBackupParams,
): Promise<BackupResult> {
	const result = await bridge.send('fileManager.getDocumentSource', { instance_id, document }) as DocSourceResponse;
	const ctx = result.context || {};
	const projectUuid = ctx.projectUuid || 'unknown-project';
	const docUuid = ctx.documentUuid || document.split('@')[0];
	const ext = docExtensionFor(ctx.documentType);

	const repo = getBackupDir();
	await ensureRepo(repo);

	const subpath = join('projects', projectUuid, 'documents', `${docUuid}${ext}`);
	const absPath = join(repo, subpath);
	await mkdir(dirname(absPath), { recursive: true });
	await writeFile(absPath, result.source, 'utf8');

	const projectSubpath = join('projects', projectUuid);
	const shaBefore = await getHead(repo);
	const sha = await commitAndGetSha(
		repo,
		projectSubpath,
		`${toolName}: doc ${docUuid}${ctx.projectName ? ` in "${ctx.projectName}"` : ''} (project ${projectUuid})`,
	);
	return { sha, path: subpath, absolutePath: absPath, repo, changed: sha !== shaBefore };
}

interface ProjectFileResponse {
	fileName: string;
	data: string;
	size: number;
	projectName?: string;
}

export interface ProjectBackupParams {
	instance_id?: string;
	projectUuid: string;
	toolName: string;
}

/**
 * Back up an entire project by UUID. Fetches the project as an .epro zip, unpacks it
 * into the backup repo (git handles delta compression between revisions), and commits.
 * Must be called before any destructive project-level operation.
 */
export async function backupProject(
	bridge: WebSocketBridge,
	{ instance_id, projectUuid, toolName }: ProjectBackupParams,
): Promise<BackupResult> {
	const result = await bridge.send('fileManager.getProjectFileByUuid', {
		instance_id,
		projectUuid,
	}) as ProjectFileResponse;

	const zipBytes = Buffer.from(result.data, 'base64');
	const zip = await JSZip.loadAsync(zipBytes);

	const repo = getBackupDir();
	await ensureRepo(repo);

	const snapshotSubpath = join('projects', projectUuid, 'snapshot');
	const absSnapshot = join(repo, snapshotSubpath);

	// Wipe the existing snapshot directory so removed files don't linger.
	// `git add -A` in commitAndGetSha will pick up both additions and removals.
	await rm(absSnapshot, { recursive: true, force: true });
	await mkdir(absSnapshot, { recursive: true });

	// Extract ZIP contents.
	for (const [name, entry] of Object.entries(zip.files)) {
		if (entry.dir) continue;
		const outPath = join(absSnapshot, name);
		const data = await entry.async('nodebuffer');
		await mkdir(dirname(outPath), { recursive: true });
		await writeFile(outPath, data);
	}

	const projectSubpath = join('projects', projectUuid);
	const shaBefore = await getHead(repo);
	const sha = await commitAndGetSha(
		repo,
		projectSubpath,
		`${toolName}: project ${projectUuid}${result.projectName ? ` ("${result.projectName}")` : ''}`,
	);
	return { sha, path: snapshotSubpath, absolutePath: absSnapshot, repo, changed: sha !== shaBefore };
}

async function getHead(repoPath: string): Promise<string> {
	const { stdout } = await gitWithLockRetry(repoPath, ['rev-parse', 'HEAD']);
	return stdout.trim();
}
