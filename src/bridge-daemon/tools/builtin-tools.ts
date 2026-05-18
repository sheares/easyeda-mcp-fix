import { z } from 'zod';
import type { ToolDef, ToolContext } from '../types';

/**
 * Built-in tools that previously lived in mcp-server/index.ts. These are
 * "metadata" tools — they introspect the daemon's view of connected
 * extensions rather than forwarding RPCs to a specific extension.
 */
export function builtinTools(ctx: ToolContext): ToolDef[] {
	return [
		{
			name: 'server_info',
			description: 'Get MCP server status: WebSocket port, connection state, connected instances, and allowed origins',
			inputShape: {},
			handler: async () => {
				const instances = ctx.getConnectedInstances();
				return {
					content: [{
						type: 'text' as const,
						text: JSON.stringify({
							wsPort: ctx.getPort(),
							extensionConnected: ctx.isConnected(),
							connectedInstanceCount: instances.length,
							instances: instances.map((info) => ({
								instanceId: info.instanceId,
								projectName: info.projectName,
								currentDocument: info.currentDocument,
								documentType: info.documentType,
							})),
							allowAllOrigins: process.env.EDA_WS_ALLOW_ALL_ORIGINS === '1',
						}, null, 2),
					}],
				};
			},
		},
		{
			name: 'bridge_restart',
			description: `Restart the EasyEDA bridge daemon. Use this only after the bridge-daemon code itself
has changed (new tools, fixed handler logic, etc.) and you want the new code loaded without manually
killing the process.

DO NOT use this just because the EasyEDA browser extension was reloaded — the extension reconnects
to the existing daemon over WebSocket on its own. The daemon doesn't need restarting for that.

SIDE EFFECTS — please be aware before invoking:
  - Every other Claude Code session sharing this daemon also loses its connection mid-flight.
    Any tool call in progress (in any session) will fail with a connection-dropped error.
  - The EasyEDA extension's WebSocket drops and reconnects (typically within a second, capped at 15s).
    Tool calls landing during that window will fail.
  - Your own MCP proxy reconnects transparently and re-lists tools, so the next call after this
    one will Just Work — but the call itself returns before the new daemon is necessarily up.

Returns { ok, pidWas, message } before the daemon exits (~100ms grace for response to flush).`,
			inputShape: {
				reason: z
					.string()
					.optional()
					.describe('Free-text reason logged on the daemon side (e.g. "loaded new SI export tools").'),
			},
			handler: async ({ reason }) => {
				console.error(`[daemon] bridge_restart requested: ${reason ?? '(no reason given)'}`);
				ctx.requestRestart();
				return {
					content: [{
						type: 'text' as const,
						text: JSON.stringify({
							ok: true,
							pidWas: process.pid,
							message: 'daemon exiting in ~100ms; proxies will respawn it on reconnect',
						}, null, 2),
					}],
				};
			},
		},
		{
			name: 'list_instances',
			description: 'List all connected EasyEDA Pro instances with their current state (project, active document, open tabs). Use this to find the instance_id you need for other tools when multiple instances are connected.',
			inputShape: {},
			handler: async () => {
				await ctx.refreshAllInstanceInfo();
				const instances = ctx.getConnectedInstances();

				if (instances.length === 0) {
					return {
						content: [{
							type: 'text' as const,
							text: 'No EasyEDA Pro instances are connected. Please open EasyEDA Pro and click "Connect Claude" in the Claude menu.',
						}],
					};
				}

				return {
					content: [{
						type: 'text' as const,
						text: JSON.stringify({
							connectedInstanceCount: instances.length,
							instances: instances.map((info) => ({
								instanceId: info.instanceId,
								projectName: info.projectName,
								currentDocument: info.currentDocument,
								documentType: info.documentType,
								documents: info.documents,
								connectedAt: new Date(info.connectedAt).toISOString(),
							})),
							note: instances.length === 1
								? 'Only one instance connected — instance_id can be omitted from tool calls (auto-selected).'
								: 'Multiple instances connected — pass instance_id to tool calls to target a specific instance.',
						}, null, 2),
					}],
				};
			},
		},
	];
}

