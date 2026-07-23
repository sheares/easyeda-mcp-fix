// Q1: verify that a per-request document switch actually landed.
//
// switchToDocument awaits dmt_EditorControl.openDocument (or the lib editor
// open calls) but EDA Pro can fail such an open without throwing, leaving the
// PREVIOUS document active. requireDocumentType only checks the document
// TYPE (schematic vs PCB), so on a project with two PCBs a silently failed
// switch sends every subsequent write to the wrong board — and the daemon's
// pre-write backup snapshots the document it THINKS is active, so it does
// not protect the board that actually changes. sch-page-walk.ts already
// guards its page opens the same way; this module is the request-level
// equivalent.
//
// Identity rules (see handlers/editor.ts, which relies on
// tab.tabId.startsWith(uuid)):
//   - the requested document is either a bare itemUuid or itemUuid@suffix;
//   - getCurrentDocumentInfo() exposes `uuid` (item uuid) and `tabId`
//     (itemUuid, optionally with an @suffix).
// We accept an exact tabId match, a match on the pre-@ segment of either
// field, and we stay PERMISSIVE when the info object lacks both fields
// (older EDA Pro builds, lib editors that do not surface identity) — a
// missing signal must not break every routed request, it just skips the
// guard with a note the caller can log.
//
// Pure module (no `eda` imports) so it can be unit-tested directly.

export interface ActiveDocumentInfo {
	uuid?: unknown;
	tabId?: unknown;
}

export type ActiveDocumentCheck =
	| { ok: true; note?: string }
	| { ok: false; reason: string };

function preAt(value: string): string {
	const at = value.indexOf('@');
	return at === -1 ? value : value.slice(0, at);
}

export function checkActiveDocument(
	requested: string,
	info: ActiveDocumentInfo | null | undefined,
): ActiveDocumentCheck {
	if (!requested) {
		// Nothing was requested; there is nothing to verify.
		return { ok: true };
	}
	if (info == null) {
		return { ok: true, note: 'active document info unavailable; switch verification skipped' };
	}

	const uuid = typeof info.uuid === 'string' && info.uuid.length > 0 ? info.uuid : undefined;
	const tabId = typeof info.tabId === 'string' && info.tabId.length > 0 ? info.tabId : undefined;

	if (uuid === undefined && tabId === undefined) {
		return { ok: true, note: 'active document reports no uuid/tabId; switch verification skipped' };
	}

	const requestedBase = preAt(requested);

	if (tabId !== undefined && (tabId === requested || preAt(tabId) === requestedBase)) {
		return { ok: true };
	}
	if (uuid !== undefined && (uuid === requested || preAt(uuid) === requestedBase)) {
		return { ok: true };
	}

	const actual = tabId ?? uuid;
	return {
		ok: false,
		reason: `requested document ${JSON.stringify(requested)} but the active document is ${JSON.stringify(actual)}`,
	};
}
