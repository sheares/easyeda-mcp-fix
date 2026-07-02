/**
 * MCP server: thin proxy in front of the bridge daemon.
 *
 * On startup, connects to the daemon, asks for its tool list, and registers
 * each tool with the MCP SDK. Tool calls from the agent are forwarded to the
 * daemon over UDS. If the daemon dies and respawns (e.g., upgraded), the
 * proxy reconnects, re-fetches the tool list, diffs against what's currently
 * registered, and adds/removes tools — the SDK auto-emits
 * notifications/tools/list_changed for each registration change so the agent
 * picks up new tools without a manual /mcp reconnect.
 */
import { McpServer, type RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { fromJSONSchema } from 'zod';
import { resolve as resolvePath } from 'node:path';
import { ProxyClient } from './proxy-client';
import type { ToolDescriptor } from '../bridge-daemon/protocol';

function buildInstructions(repoRoot: string): string {
	return [
		'This server provides direct access to schematic and PCB designs in EasyEDA Pro.',
		'When the user asks about their circuit designs, schematics, PCB layouts, components, footprints, or netlist connections, check this server in addition to (or instead of) searching the filesystem for design files.',
		'Start with `server_info` to check connectivity, then use `editor_get_open_tabs` or `project_get_structure` to discover what designs are available.',
		'',
		`This MCP server's source lives at ${repoRoot}. The editing library, schema, examples, and tests are all under that path; consult them when the tool descriptions aren't enough.`,
		'',
		'EDIT WORKFLOW — use this for anything beyond a single primitive change:',
		`  1. Pull the source: \`document_save_to_file\` (one document) or \`project_export_file\` (whole project as .epro ZIP of NDJSON).`,
		`  2. Edit the raw source on disk. For schematic edits, use the library at ${repoRoot}/src/lib/ (README at ${repoRoot}/src/lib/README.md, runnable examples at ${repoRoot}/examples/). It exposes a typed SchematicWriter that handles element IDs, unique IDs, junction wires, designator allocation, and maxId bookkeeping. Write a throwaway ts-node script rather than issuing many per-primitive MCP calls — it is orders of magnitude faster.`,
		`  3. Push the result back: \`document_load_from_file\` or \`project_import_file\`. Every destructive upload is auto-backed up to a git repo (default \`~/.easyeda-mcp-backup\`, override with EDA_BACKUP_DIR); the response returns a backup SHA you can reference if the edit goes wrong.`,
		'',
		'VALIDATION: uploads default to validate=\'strict\' (any unknown or malformed line aborts the upload). Downloads run in warn mode and attach a validation report.',
		`If a download or upload surfaces \`unknown-tag\` samples, this server's Zod schema is missing coverage for a shape EasyEDA actually emits. To extend it: read an existing per-line schema under ${repoRoot}/src/lib/schema/line-*.ts as precedent, add a new Line schema for the tag (or extend an existing one), wire it into the matching doc-type union + schemaMap in esch.ts / esym.ts / epcb.ts / eins.ts, and run \`npm test\` (from ${repoRoot}). The unknown-tag samples in the validation report include the tag name, tuple length, and a sample row — enough to start. When in doubt survey real files the same way ${repoRoot}/src/lib/schema/line-pcb.ts was derived.`,
	].join('\n');
}

/**
 * Convert a daemon-supplied tool descriptor into MCP SDK registration args.
 * The input schema travels as JSON Schema; the SDK requires zod, so we
 * rehydrate via fromJSONSchema.
 */
function hydrateInputSchema(descriptor: ToolDescriptor): any {
	// Daemon-side schemas are always built from z.object(shape), so they're
	// JSON Schema "object" types. fromJSONSchema returns a zod schema that
	// the SDK accepts directly via its AnySchema overload.
	return fromJSONSchema(descriptor.inputSchema as any);
}

async function main() {
	const proxy = new ProxyClient();
	await proxy.connect();

	const REPO_ROOT = resolvePath(__dirname, '..', '..');

	// listChanged must be declared up-front (Server.registerCapabilities throws
	// after connect()). The SDK then auto-fires notifications/tools/list_changed
	// on every registerTool / .remove() call after connect.
	const server = new McpServer(
		{
			name: 'easyeda-agent-mcp-server',
			version: '1.0.0',
		},
		{
			capabilities: { tools: { listChanged: true } },
			instructions: buildInstructions(REPO_ROOT),
		},
	);

	const registeredTools = new Map<string, RegisteredTool>();

	function registerDescriptor(d: ToolDescriptor): void {
		const inputSchema = hydrateInputSchema(d);
		// Cast to any: the SDK's CallToolResult type is much more precise than
		// what we want to ship across the NDJSON wire (e.g. it has typed
		// resource-link variants we don't model). The daemon validates its own
		// tool handler return shapes.
		const handle = server.registerTool(
			d.name,
			{
				description: d.description,
				inputSchema,
			},
			(async (args: Record<string, unknown>) => proxy.callTool(d.name, args)) as any,
		);
		registeredTools.set(d.name, handle);
	}

	function syncToolList(latest: ToolDescriptor[]): void {
		const seen = new Set<string>();
		for (const d of latest) {
			seen.add(d.name);
			if (registeredTools.has(d.name)) {
				// Already registered. We could detect schema/description changes and
				// re-register, but for now treat name as the identity — same name
				// means same tool. Daemon respawn with a new schema for an existing
				// tool will keep the old registration (rare; cheap to add later).
				continue;
			}
			registerDescriptor(d);
		}
		for (const [name, handle] of registeredTools) {
			if (!seen.has(name)) {
				handle.remove();
				registeredTools.delete(name);
			}
		}
	}

	// Initial registration before connecting transport (so the capability
	// declaration in the constructor is honored).
	const initialTools = await proxy.listTools();
	for (const d of initialTools) registerDescriptor(d);

	const transport = new StdioServerTransport();
	await server.connect(transport);

	console.error('[MCP] EasyEDA Agent MCP Server started');
	console.error(`[MCP] Registered ${initialTools.length} tools from bridge daemon`);

	// On daemon reconnect (after a crash or upgrade), re-list and diff. SDK
	// auto-fires notifications/tools/list_changed for each register/remove.
	proxy.onReconnected(() => {
		// .catch (not a two-arg .then) so a throw inside syncToolList /
		// registerDescriptor (e.g. fromJSONSchema on a schema from a newer
		// daemon) is caught too instead of becoming an unhandled rejection.
		proxy.listTools()
			.then((tools) => {
				syncToolList(tools);
				console.error(`[MCP] Re-synced tools after daemon reconnect — ${tools.length} now registered`);
			})
			.catch((err) => console.error('[MCP] Failed to re-sync tools after reconnect:', err));
	});

	process.on('SIGINT', async () => { await proxy.stop(); process.exit(0); });
	process.on('SIGTERM', async () => { await proxy.stop(); process.exit(0); });
}

main().catch((err) => {
	console.error('[MCP] Fatal error:', err);
	process.exit(1);
});
