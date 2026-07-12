/**
 * Visit every schematic page in the project, running `visit` while that page
 * is active. EDA Pro ignores the `allSchematicPages` flag on the native
 * sch_PrimitiveComponent.getAll call (bug 2), which only ever returns the
 * active page, so project-wide reads must walk the pages via openDocument.
 *
 * This helper is the single implementation of that walk. sch-component.ts and
 * sch-document.ts must both route through it so they can never again disagree
 * about multi-page behaviour (regression P1: sch.connectivity.get silently
 * dropped off-page components while sch.component.getAll walked pages
 * correctly).
 *
 * Every open is verified to have landed on the target page (a failed open
 * leaves the previous page active, and re-reading it would silently duplicate
 * that page's primitives), and the user's original page is restored in a
 * finally block. If page info is unavailable, `visit` runs once against the
 * active page.
 *
 * Callers run inside the ws-client request queue (H11), so the page switching
 * here cannot interleave with another request's document expectations.
 */
export async function forEachSchematicPage(
	visit: (page: { uuid?: string; name?: string }) => Promise<void>,
): Promise<void> {
	const pages: any = await eda.dmt_Schematic.getAllSchematicPagesInfo();

	if (!Array.isArray(pages)) {
		const current: any = await eda.dmt_Schematic.getCurrentSchematicPageInfo();
		await visit({ uuid: current?.uuid, name: current?.name });
		return;
	}

	const currentPage: any = await eda.dmt_Schematic.getCurrentSchematicPageInfo();
	const originalUuid = currentPage?.uuid;

	try {
		for (const page of pages) {
			const uuid = page?.uuid;
			if (!uuid) continue;
			await eda.dmt_EditorControl.openDocument(uuid);
			const active: any = await eda.dmt_Schematic.getCurrentSchematicPageInfo();
			if (active?.uuid !== uuid) {
				throw new Error(
					`Failed to open schematic page ${uuid} (still on ${active?.uuid ?? 'unknown'}); aborting multi-page scan to avoid duplicated primitives.`,
				);
			}
			await visit({ uuid, name: page?.name });
		}
	} finally {
		// Always restore the user's original page, even if a page open failed
		// mid-walk. Best-effort: a restore failure must not mask the original
		// error.
		if (originalUuid) {
			try {
				await eda.dmt_EditorControl.openDocument(originalUuid);
			} catch { /* leave the editor where it is rather than mask the throw */ }
		}
	}
}
