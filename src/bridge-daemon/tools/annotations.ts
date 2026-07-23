// Q3: shared MCP tool-annotation profiles. Every tool in the registry
// declares exactly one of these so clients can distinguish a read from a
// delete at the protocol level (auto-approve read-only tools, checkpoint
// destructive ones). The MCP spec defaults destructiveHint and openWorldHint
// to TRUE when absent, so each profile sets all four hints explicitly.
//
// Profiles, worst-case per tool (multi-action tools take their most
// dangerous action):
//   READ_ONLY        pure reads; no environment change
//   READ_ONLY_OPEN_WORLD  reads that hit the LCSC/JLC backend
//   NAV              editor state only (viewport, selection, active tab) —
//                    no design data touched; repeatable
//   WRITE_CREATE     adds new design data; repeating duplicates it
//   WRITE_MODIFY     updates existing data; same args, same result
//   WRITE_LOCAL_FILE writes bytes to a local path (exports); overwrites the
//                    target file but never touches design data
//   DESTRUCTIVE      deletes or replaces design data; not recoverable
//                    through this API (backups noted per description)
import type { ToolAnnotations } from '../types';

export const READ_ONLY: ToolAnnotations = {
	readOnlyHint: true,
	destructiveHint: false,
	idempotentHint: true,
	openWorldHint: false,
};

export const READ_ONLY_OPEN_WORLD: ToolAnnotations = {
	readOnlyHint: true,
	destructiveHint: false,
	idempotentHint: true,
	openWorldHint: true,
};

export const NAV: ToolAnnotations = {
	readOnlyHint: false,
	destructiveHint: false,
	idempotentHint: true,
	openWorldHint: false,
};

export const WRITE_CREATE: ToolAnnotations = {
	readOnlyHint: false,
	destructiveHint: false,
	idempotentHint: false,
	openWorldHint: false,
};

export const WRITE_MODIFY: ToolAnnotations = {
	readOnlyHint: false,
	destructiveHint: false,
	idempotentHint: true,
	openWorldHint: false,
};

export const WRITE_LOCAL_FILE: ToolAnnotations = {
	readOnlyHint: false,
	destructiveHint: false,
	idempotentHint: false,
	openWorldHint: false,
};

export const DESTRUCTIVE: ToolAnnotations = {
	readOnlyHint: false,
	destructiveHint: true,
	idempotentHint: false,
	openWorldHint: false,
};
