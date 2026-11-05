import type { ToolDef, ToolContext } from '../types';
import { z } from 'zod';
import { withDocumentParam } from './query-params';
import { backupDocument, formatBackupSummary } from '../backup';
import * as ANN from './annotations';

// EasyEDA's autoroute / auto-layout, as jobs. Handlers:
// src/extension/handlers/auto-job.ts, which uses the @alpha job API when the
// host serves it and otherwise runs the blocking call in the background.

const EXPERIMENTAL = 'EXPERIMENTAL: try it on a copy of the board first.';

const MODES = `The response's mode says how the job runs:
- "job": EasyEDA's own job API, with progress, cancel and partial results.
- "blocking-fallback": the host does not serve the job API (EasyEDA Pro 3.2.209 does not, although its scripting runtime lists it), so the bridge runs EasyEDA's blocking call in the background behind the same tools. Status has emulated: true and progress null until it finishes; it cannot be cancelled; EasyEDA's fixed 15-minute ceiling applies and commits nothing if it runs out. While it runs, EasyEDA may be slow to answer other calls, so poll status (answered by the extension itself) rather than reading the board.`;

const FOLLOW_UP = 'Poll pcb_get_auto_job_status with the returned jobId until state is completed, failed or canceled; read pcb_get_auto_job_log for detail. When it completes, rebuild the pours, check the result (pcb_check_track_widths, then pcb_run_drc) and save with pcb_save.';

const JOB_DONE_NEXT = 'Rebuild the pours, then run pcb_check_track_widths and pcb_run_drc (and pcb_check_orientation after an auto-layout). The router\'s result is a draft until those pass.';

function text(value: unknown) {
	return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] };
}

export function autorouteTools(ctx: ToolContext): ToolDef[] {
	return [
		{
			name: 'pcb_autoroute_start',
			annotations: ANN.DESTRUCTIVE,
			description: `Start EasyEDA's autorouter on the PCB as a background job and return its jobId at once. ${EXPERIMENTAL}
Adds tracks and vias to the board; with existing: "remove" it first rips up the routing already there. The whole PCB is snapshotted to the local backup repo before the job starts, and the response includes the backup SHA.
${FOLLOW_UP}
${MODES}
Seen on EasyEDA 3.2.209 (a 4-layer test board, 43 nets): it routed every net in under a minute, but used the default track width on every net, ignoring net-class widths (power nets came out at 0.22-0.25 mm where their class asks for 0.8-1 mm), and it left DRC faults behind (stacked vias, a broken differential pair, nets it reported as routed but left open). Treat its result as a draft: run pcb_check_track_widths (EasyEDA's DRC did not report the under-width tracks), and run DRC after rebuilding the pours, which are not rebuilt for you.`,
			inputShape: withDocumentParam({
				nets: z
					.union([z.array(z.string()), z.enum(['selected', 'selectedComponents'])])
					.optional()
					.describe('Nets to route: an array of net names, "selected" (selected nets) or "selectedComponents" (nets of the selected parts). Omit or pass [] for every unrouted net.'),
				ignoreNets: z.array(z.string()).optional().describe('Nets to leave alone, e.g. ["GND"] when a pour will carry it'),
				layers: z
					.array(z.union([z.string(), z.number()]))
					.optional()
					.describe('Copper layers the router may use, as names ("TopLayer", "BottomLayer", "Inner1") or EPCB_LayerId numbers. Must be enabled layers: EasyEDA silently ignores disabled ones. Omit for every enabled signal and plane layer.'),
				corner: z.enum(['45', '90']).optional().describe('Corner style in degrees (EasyEDA default 45)'),
				existing: z.enum(['keep', 'remove']).optional().describe('keep (default): route around existing tracks and vias. remove: rip up existing vias and plain track segments and route from scratch. It does NOT rip up polyline tracks (POLY records, as scripted layouts and source uploads often write them), nor copper fills or pour fill, which then stay as obstacles: for a true from-scratch run, strip those from the source first (document_save_to_file, edit, document_load_from_file).'),
				optimise: z.enum(['completion', 'speed']).optional().describe('completion (default): route as many nets as possible. speed: finish sooner.'),
			}),
			handler: async (params) => {
				const backup = await backupDocument(ctx, { instance_id: params.instance_id, document: params.document, toolName: 'pcb_autoroute_start' });
				const result = await ctx.sendToExtension('pcb.autoJob.startRouting', params);
				return text({ ...(result as object), backup, note: formatBackupSummary(backup) });
			},
		},

		{
			name: 'pcb_autolayout_start',
			annotations: ANN.DESTRUCTIVE,
			description: `Start EasyEDA's automatic component placement on the PCB as a background job and return its jobId at once. ${EXPERIMENTAL}
Moves components across the board. The whole PCB is snapshotted to the local backup repo first, and the response includes the backup SHA.
${FOLLOW_UP} Then run pcb_check_orientation: placement moves and turns parts, so re-check every LED, diode and chip.
${MODES}`,
			inputShape: withDocumentParam({}),
			handler: async (params) => {
				const backup = await backupDocument(ctx, { instance_id: params.instance_id, document: params.document, toolName: 'pcb_autolayout_start' });
				const result = await ctx.sendToExtension('pcb.autoJob.startLayout', params);
				return text({ ...(result as object), backup, note: formatBackupSummary(backup) });
			},
		},

		{
			name: 'pcb_get_auto_job_status',
			annotations: ANN.READ_ONLY,
			description: `Get the state of an autoroute or auto-layout job: { jobId, state: queued | running | completed | canceled | failed, progress: 0-100, error?: { code, message }, partial?: whether intermediate results were committed }. An emulated job (mode "blocking-fallback") adds emulated: true, elapsedMs and, once finished, EasyEDA's result (for routing: totalNetsCount, successNetsCount, failedNets, duration); its progress is null while running. A completed job adds next: the checks to run before trusting the result. ${EXPERIMENTAL}`,
			inputShape: withDocumentParam({
				jobId: z.string().describe('From pcb_autoroute_start or pcb_autolayout_start'),
			}),
			handler: async (params) => {
				const status = await ctx.sendToExtension('pcb.autoJob.getStatus', params) as Record<string, unknown> | null;
				if (status && status.state === 'completed') return text({ ...status, next: JOB_DONE_NEXT });
				return text(status);
			},
		},

		{
			name: 'pcb_get_auto_job_log',
			annotations: ANN.READ_ONLY,
			description: `Get the log of an autoroute or auto-layout job, as entries { at (ms timestamp), level: info | warn | error, code?, message }. ${EXPERIMENTAL}`,
			inputShape: withDocumentParam({
				jobId: z.string().describe('From pcb_autoroute_start or pcb_autolayout_start'),
			}),
			handler: async (params) => text(await ctx.sendToExtension('pcb.autoJob.getLog', params)),
		},

		{
			name: 'pcb_cancel_auto_job',
			annotations: ANN.WRITE_MODIFY,
			description: `Cancel a running autoroute or auto-layout job. Returns { cancelRequested }. Routing already committed may stay on the board: check pcb_get_auto_job_status (partial) and restore from the start call's backup SHA if needed. An emulated job (mode "blocking-fallback") cannot be cancelled: the answer is cancelRequested false with a note. ${EXPERIMENTAL}`,
			inputShape: withDocumentParam({
				jobId: z.string().describe('From pcb_autoroute_start or pcb_autolayout_start'),
			}),
			handler: async (params) => text(await ctx.sendToExtension('pcb.autoJob.cancel', params)),
		},
	];
}
