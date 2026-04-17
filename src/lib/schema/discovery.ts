/**
 * Unknown-line discovery logger.
 *
 * When the parser encounters a line with a tag it doesn't recognize, callers
 * can opt into appending a dedup'd sample to a JSONL log at
 * ~/.easyeda-schema-discovery.jsonl (override via EDA_DISCOVERY_LOG).
 *
 * Dedup fingerprint: tag | tupleLen | reason | attrName?. One sample per
 * unique fingerprint per process.
 */

import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import type { UnknownLineInfo } from './types';

const DEFAULT_DISCOVERY_LOG = join(homedir(), '.easyeda-schema-discovery.jsonl');

const sessionSeen = new Set<string>();

function logPath(): string {
	return process.env.EDA_DISCOVERY_LOG || DEFAULT_DISCOVERY_LOG;
}

export function computeFingerprint(
	tag: string,
	tupleLen: number,
	reason: string,
	attrName?: string,
): string {
	return `${tag}|len=${tupleLen}|reason=${reason}|attr=${attrName ?? '-'}`;
}

export interface DiscoveryContext {
	docType: 'esch' | 'esym';
	projectUuid?: string;
	documentUuid?: string;
}

/**
 * Append unknown-line samples to the discovery log. Returns the count newly
 * written (i.e. fingerprints not previously seen in this process).
 */
export async function logDiscovery(
	unknowns: UnknownLineInfo[],
	context: DiscoveryContext,
): Promise<number> {
	const records: string[] = [];
	const now = new Date().toISOString();
	for (const info of unknowns) {
		if (sessionSeen.has(info.fingerprint)) continue;
		sessionSeen.add(info.fingerprint);
		records.push(JSON.stringify({
			timestamp: now,
			docType: context.docType,
			tag: info.tag,
			tupleLen: info.tupleLen,
			reason: 'unknown-tag',
			attrName: info.attrName ?? null,
			sample: info.sample,
			lineIndex: info.lineIndex,
			projectUuid: context.projectUuid,
			documentUuid: context.documentUuid,
		}));
	}
	if (records.length === 0) return 0;
	const path = logPath();
	await mkdir(dirname(path), { recursive: true });
	await appendFile(path, records.join('\n') + '\n', 'utf8');
	return records.length;
}

/** Test hook — reset the session-seen set so tests don't leak state. */
export function _resetDiscoverySession(): void {
	sessionSeen.clear();
}
