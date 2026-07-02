import { fetchParsedNetlist, resolveTemplateExpressions, type ParsedNetlist } from './sch-netlist-utils';
import { preserveMetadataOnModify, BASE_METADATA_PRESERVE_FIELDS } from './preserve-metadata';

/**
 * Resolve ={...} template expressions in all string fields of a component
 * using resolved property values from the netlist.
 */
function resolveComponentTemplates(comp: any, netlist: ParsedNetlist): void {
	if (!comp?.uniqueId) return;
	const entry = netlist[comp.uniqueId];
	if (!entry) return;
	for (const key of Object.keys(comp)) {
		if (typeof comp[key] === 'string' && comp[key].includes('={')) {
			comp[key] = resolveTemplateExpressions(comp[key], entry.allProps);
		}
	}
}

// Known-good library UUIDs for net flags and net ports.
// EasyEDA Pro's createNetFlag/createNetPort internally fetch the symbol definition
// from the library server using these UUIDs. The defaults are often stale, causing
// 404 "device not found" errors. We set them explicitly on every call to avoid this.
const SYSTEM_LIBRARY_UUID = '0819f05c4eef4c71ace90d822a990e87';

const NET_FLAG_UUIDS: Record<string, string> = {
	Power: 'df5797623e9a453a8e185b8ecff60622',
	Ground: '18e562bab0e24c4ab395153b0e617a77',
	AnalogGround: 'b0ac093c6086497c9da8da887c8876aa',
	ProtectGround: '8791cdedccf84dbcae5ec6ff270f5461',
};

const NET_PORT_UUIDS: Record<string, string> = {
	IN: '919ad5cad55a4957942399272575463a',
	OUT: '3e57f47b50c54427af587824696bcbde',
	BI: 'c6d0f66dd0ff440a9af8639aef562e24',
};

async function createOneNetFlag(params: Record<string, any>) {
	const component = params.component ?? {
		libraryUuid: SYSTEM_LIBRARY_UUID,
		uuid: NET_FLAG_UUIDS[params.identification],
	};
	if (component?.uuid) {
		const setterMap: Record<string, (c: any) => Promise<boolean>> = {
			Power: (c) => eda.sch_PrimitiveComponent.setNetFlagComponentUuid_Power(c),
			Ground: (c) => eda.sch_PrimitiveComponent.setNetFlagComponentUuid_Ground(c),
			AnalogGround: (c) => eda.sch_PrimitiveComponent.setNetFlagComponentUuid_AnalogGround(c),
			ProtectGround: (c) => eda.sch_PrimitiveComponent.setNetFlagComponentUuid_ProtectGround(c),
		};
		const setter = setterMap[params.identification];
		if (setter) await setter(component);
	}
	return eda.sch_PrimitiveComponent.createNetFlag(
		params.identification,
		params.net,
		params.x,
		params.y,
		params.rotation,
		params.mirror,
	);
}

async function createOneNetPort(params: Record<string, any>) {
	const component = params.component ?? {
		libraryUuid: SYSTEM_LIBRARY_UUID,
		uuid: NET_PORT_UUIDS[params.direction],
	};
	if (component?.uuid) {
		const setterMap: Record<string, (c: any) => Promise<boolean>> = {
			IN: (c) => eda.sch_PrimitiveComponent.setNetPortComponentUuid_IN(c),
			OUT: (c) => eda.sch_PrimitiveComponent.setNetPortComponentUuid_OUT(c),
			BI: (c) => eda.sch_PrimitiveComponent.setNetPortComponentUuid_BI(c),
		};
		const setter = setterMap[params.direction];
		if (setter) await setter(component);
	}
	return eda.sch_PrimitiveComponent.createNetPort(
		params.direction,
		params.net,
		params.x,
		params.y,
		params.rotation,
		params.mirror,
	);
}

const schPrimitiveApi = {
	get: (ids: string[]) => eda.sch_PrimitiveComponent.get(ids),
	modify: (id: string, prop: Record<string, any>) => eda.sch_PrimitiveComponent.modify(id, prop),
};

export const schComponentHandlers: Record<string, (params: Record<string, any>) => Promise<any>> = {
	'sch.component.create': async (params) => {
		return eda.sch_PrimitiveComponent.create(
			params.component,
			params.x,
			params.y,
			params.subPartName,
			params.rotation,
			params.mirror,
			params.addIntoBom,
			params.addIntoPcb,
		);
	},

	'sch.component.createNetFlag': async (params) => {
		if (params.batch) {
			const results = [];
			for (const item of params.batch) {
				results.push(await createOneNetFlag(item));
			}
			return results;
		}
		return createOneNetFlag(params);
	},

	'sch.component.createNetPort': async (params) => {
		if (params.batch) {
			const results = [];
			for (const item of params.batch) {
				results.push(await createOneNetPort(item));
			}
			return results;
		}
		return createOneNetPort(params);
	},

	'sch.component.delete': async (params) => {
		return eda.sch_PrimitiveComponent.delete(params.ids);
	},

	'sch.component.modify': async (params) => {
		return preserveMetadataOnModify(
			schPrimitiveApi,
			BASE_METADATA_PRESERVE_FIELDS,
			params.primitiveId,
			params.property,
		);
	},

	'sch.component.get': async (params) => {
		const [components, netlist] = await Promise.all([
			eda.sch_PrimitiveComponent.get(params.primitiveIds),
			fetchParsedNetlist(),
		]);
		const arr = Array.isArray(components) ? components : components ? [components] : [];
		for (const comp of arr) {
			resolveComponentTemplates(comp, netlist);
		}
		return components;
	},

	'sch.component.getAll': async (params) => {
		// Fetch netlist in parallel with component fetching so netlist retrieval
		// (which can be slow — see bug 4) doesn't serialise the response time.
		const netlistPromise = fetchParsedNetlist();
		// Swallow a standalone rejection: if the page walk below throws before we
		// await this, the parallel promise would otherwise surface as an
		// unhandled rejection. The real await further down still sees the error.
		netlistPromise.catch(() => { /* handled at the await below */ });

		let components: any[];
		if (params.allSchematicPages) {
			// EDA Pro ignores the flag on the native getAll(type, allSchematicPages)
			// call — it only ever returns the active page — so walk the pages
			// ourselves via openDocument and union the results.
			const pages: any = await eda.dmt_Schematic.getAllSchematicPagesInfo();
			const currentPage: any = await eda.dmt_Schematic.getCurrentSchematicPageInfo();
			const originalUuid = currentPage?.uuid;

			components = [];
			try {
				if (Array.isArray(pages)) {
					for (const page of pages) {
						const uuid = page?.uuid;
						if (!uuid) continue;
						await eda.dmt_EditorControl.openDocument(uuid);
						// Confirm the open actually landed on the target page. A
						// failed open leaves the editor on the previous page, and
						// re-reading it would duplicate that page's components into
						// the union — abort loudly instead.
						const active: any = await eda.dmt_Schematic.getCurrentSchematicPageInfo();
						if (active?.uuid !== uuid) {
							throw new Error(
								`Failed to open schematic page ${uuid} (still on ${active?.uuid ?? 'unknown'}); aborting multi-page scan to avoid duplicated components.`,
							);
						}
						const pageComponents = await eda.sch_PrimitiveComponent.getAll(params.componentType, false);
						if (Array.isArray(pageComponents)) {
							components.push(...pageComponents);
						}
					}
				} else {
					components = (await eda.sch_PrimitiveComponent.getAll(params.componentType, false)) as any[];
				}
			} finally {
				// Always restore the user's original page, even if a page open
				// failed mid-walk. Best-effort: a restore failure must not mask
				// the original error.
				if (originalUuid) {
					try {
						await eda.dmt_EditorControl.openDocument(originalUuid);
					} catch { /* leave the editor where it is rather than mask the throw */ }
				}
			}
		} else {
			components = (await eda.sch_PrimitiveComponent.getAll(params.componentType, false)) as any[];
		}

		const netlist = await netlistPromise;

		if (Array.isArray(components)) {
			for (const comp of components) {
				resolveComponentTemplates(comp, netlist);
			}
		}
		return components;
	},

	'sch.component.getAllPins': async (params) => {
		const pins = await eda.sch_PrimitiveComponent.getAllPinsByPrimitiveId(params.primitiveId);
		if (!Array.isArray(pins) || pins.length === 0) return pins;

		// Look up the component's uniqueId, then find its nets in the netlist
		const rawComp: any = await eda.sch_PrimitiveComponent.get(params.primitiveId);
		const comp = Array.isArray(rawComp) ? rawComp[0] : rawComp;
		if (!comp?.uniqueId) return pins;

		const netlist = await fetchParsedNetlist();
		const netEntry = netlist[comp.uniqueId];
		if (!netEntry) return pins;

		return pins.map((pin: any) => ({
			...pin,
			net: netEntry.pins[String(pin.pinNumber)] ?? '',
		}));
	},
};
