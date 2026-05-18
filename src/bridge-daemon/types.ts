/**
 * Daemon-internal types. These don't cross the UDS wire.
 */
import type { z } from 'zod';
import type { CallToolResult } from './protocol';

// -----------------------------------------------------------------------------
// Connected EasyEDA browser extension. Mirrors what the daemon tracks per
// open EDA Pro tab. Built-in tools (list_instances, server_info) read this.
// -----------------------------------------------------------------------------
export interface InstanceInfo {
	instanceId: string;
	connectedAt: number;
	projectName?: string;
	currentDocument?: string;
	documentType?: string;
	documents?: Array<{ title: string; uuid: string }>;
}

// -----------------------------------------------------------------------------
// Tool definition. Each module under tools/ exports a function that takes the
// daemon's ToolContext and returns an array of these.
//
// Handler params are loosely typed. The MCP-server side runs zod validation
// before forwarding call_tool, so handlers can trust the shape matches
// inputShape. Tighter typing via `z.infer<z.ZodObject<Shape>>` doesn't work
// for the intersection shapes produced by `withQueryParams` (the inferred
// type collapses fields to `unknown` and breaks destructuring of enums etc.).
// -----------------------------------------------------------------------------
export interface ToolDef<Shape extends z.ZodRawShape = z.ZodRawShape> {
	name: string;
	description: string;
	inputShape: Shape;
	handler: (params: Record<string, any>) => Promise<CallToolResult>;
}

// -----------------------------------------------------------------------------
// What tool handlers can do, beyond pure computation. The shape matches the
// old WebSocketBridge public API on purpose — porting handler bodies is then
// a search-and-replace of `bridge.xxx` to `ctx.xxx`.
// -----------------------------------------------------------------------------
export interface ToolContext {
	/**
	 * Send an RPC to an EasyEDA extension. If params contains `instance_id`,
	 * it's extracted for routing (not forwarded to the extension). If
	 * `instance_id` is absent and exactly one extension is connected, that one
	 * is auto-selected; if 0 or >1, throws a descriptive error.
	 */
	sendToExtension(method: string, params?: Record<string, unknown>): Promise<unknown>;

	/** Snapshot of currently-connected extensions. Used by built-in tools. */
	getConnectedInstances(): InstanceInfo[];

	/** Convenience: number of connected extensions. */
	getConnectedCount(): number;

	/** True if at least one extension is connected. */
	isConnected(): boolean;

	/** Active extension WS port (advertised by server_info). */
	getPort(): number;

	/** Force a fresh poll of every extension's instance.getInfo. */
	refreshAllInstanceInfo(): Promise<void>;

	/**
	 * Schedule a daemon shutdown. The current request will complete (response
	 * flushes to UDS) before exit. MCP server proxies will reconnect, respawning
	 * a fresh daemon on demand.
	 */
	requestRestart(delayMs?: number): void;
}
