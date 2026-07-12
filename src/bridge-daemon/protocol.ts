import { homedir } from 'node:os';
import { join } from 'node:path';

// State directory layout (overridable via EDA_BRIDGE_STATE_DIR).
// Matches the existing ~/.easyeda-mcp-backup convention used by backup.ts.
export function stateDir(): string {
	return process.env.EDA_BRIDGE_STATE_DIR || join(homedir(), '.easyeda-mcp');
}

export function socketPath(): string {
	return join(stateDir(), 'bridge.sock');
}

export function pidPath(): string {
	return join(stateDir(), 'bridge.pid');
}

export function logPath(): string {
	return join(stateDir(), 'bridge.log');
}

// Per-run WS auth token (C4). Written 0600 by the daemon at startup; the
// extension proves it runs as the same user by reading it back when challenged.
export function wsTokenPath(): string {
	return join(stateDir(), 'ws-token');
}

// Browser-extension WS port. Single port now; no more scanning.
// Picked at 16168 (one above the legacy 15168-15207 scan range) so the
// new daemon doesn't collide with any stale processes from the old
// port-scanning architecture during migration.
export const DEFAULT_WS_PORT = 16168;
export function wsPort(): number {
	return Number(process.env.EDA_WS_PORT) || DEFAULT_WS_PORT;
}

// Timeout for a single extension RPC round-trip inside the daemon.
// Multi-page netlist queries on large schematics can exceed the default;
// override with EDA_REQUEST_TIMEOUT_MS (EASYEDA_REQUEST_TIMEOUT_MS is
// accepted as an alias). Shared here so the MCP-server proxy can size its
// own call_tool timeout to STRICTLY EXCEED the daemon's worst-case budget —
// if the proxy gave up first, the daemon would still complete the (possibly
// destructive) operation and a model retry would execute it twice.
export const DEFAULT_EXTENSION_REQUEST_TIMEOUT_MS = 45000;
export function extensionRequestTimeoutMs(): number {
	const raw = process.env.EDA_REQUEST_TIMEOUT_MS ?? process.env.EASYEDA_REQUEST_TIMEOUT_MS;
	if (!raw) return DEFAULT_EXTENSION_REQUEST_TIMEOUT_MS;
	const parsed = Number(raw);
	if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_EXTENSION_REQUEST_TIMEOUT_MS;
	return parsed;
}

// Worst case for one tool call daemon-side: up to three extension RPCs
// (e.g. document_set_source: context fetch + backup fetch + write) plus git
// work. The proxy must outlast that.
export function callToolTimeoutMs(): number {
	return extensionRequestTimeoutMs() * 3 + 30000;
}

// Idle exit: daemon exits this many seconds after the last MCP client
// disconnects. Extension connections do NOT count toward idle — when no MCP
// client is talking, there's nothing for the extension to do anyway.
export function idleExitSeconds(): number {
	const v = process.env.EDA_BRIDGE_IDLE_EXIT_SEC;
	if (v === undefined || v === '') return 5;
	const n = Number(v);
	return Number.isFinite(n) && n >= 0 ? n : 5;
}

// -----------------------------------------------------------------------------
// MCP tool surface — what the daemon advertises to MCP clients.
//
// Schemas travel as JSON Schema (the only serializable representation) and
// are re-hydrated to zod on the MCP-server side for registerTool. To keep
// wire bytes consistent with what the MCP SDK would have produced internally,
// daemon-side serialization uses target=draft-7, io=input, unrepresentable=any.
// -----------------------------------------------------------------------------
export interface ToolDescriptor {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>; // JSON Schema for the tool's arguments
}

// MCP `CallToolResult` shape, returned by every tool handler verbatim.
export interface CallToolResult {
	content: Array<
		| { type: 'text'; text: string }
		| { type: 'image'; data: string; mimeType: string }
		| Record<string, unknown> // forward-compat
	>;
	isError?: boolean;
	structuredContent?: Record<string, unknown>;
}

// -----------------------------------------------------------------------------
// NDJSON messages over the UDS, MCP client <-> daemon.
// One JSON object per line. JSON.stringify always escapes literal newlines,
// so newline-as-delimiter is safe.
// -----------------------------------------------------------------------------

// MCP client → daemon
export interface ListToolsRequest {
	kind: 'list_tools';
	id: string;
}

export interface CallToolRequest {
	kind: 'call_tool';
	id: string;
	name: string;
	arguments: Record<string, unknown>;
}

// Daemon → MCP client
export interface ListToolsResult {
	kind: 'list_tools_result';
	id: string;
	tools: ToolDescriptor[];
}

export interface CallToolResultMsg {
	kind: 'call_tool_result';
	id: string;
	result?: CallToolResult;
	error?: string;
}

// Note: there's no daemon → client "tools changed" notification. The tool set
// is static once the daemon starts; the only way it changes is via daemon
// restart, and the MCP server detects that via socket disconnect → reconnect
// → re-list. That path is already wired up in proxy-client.scheduleReconnect.

export type ClientToDaemon = ListToolsRequest | CallToolRequest;
export type DaemonToClient = ListToolsResult | CallToolResultMsg;
