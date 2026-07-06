import { fetchParsedNetlist, fetchPinNames, fetchRawNetlist, invalidateNetlistCache } from './sch-netlist-utils';

export const schDocumentHandlers: Record<string, (params: Record<string, any>) => Promise<any>> = {
	'sch.document.save': async () => {
		return eda.sch_Document.save();
	},

	'sch.document.importChanges': async () => {
		return eda.sch_Document.importChanges();
	},

	// 3rd param `includeVerboseError` causes the `sch_Drc.check` function to return Array<any> of all DRC errors instead of just a
	// boolean indicating whether or not DRC passed. Added in the @jlceda/pro-api-types NPM
	// package but not yet documented on
	// https://prodocs.easyeda.com/en/api/reference/pro-api.sch_drc.check.html
	'sch.drc.check': async (params) => {
		return eda.sch_Drc.check(params.strict, params.userInterface, true);
	},

	// Routed through getNetlistFile: the direct eda.sch_Netlist.getNetlist call is
	// deprecated and can hang ~5 minutes before rejecting with nothing (bug 4).
	'sch.netlist.get': async (params) => {
		return fetchRawNetlist(params.type);
	},

	'sch.netlist.set': async (params) => {
		const result = await eda.sch_Netlist.setNetlist(params.type, params.netlist);
		invalidateNetlistCache();
		return result;
	},

	'sch.connectivity.get': async (params) => {
		const depth: number = (params.depth as number) || 2;
		let designatorFilter: Set<string> | undefined = params.designators
			? new Set(params.designators as string[])
			: undefined;
		const netFilter: Set<string> | undefined = params.nets
			? new Set(params.nets as string[])
			: undefined;

		// 1. Fetch parsed netlist and all components
		const [netlist, allComponents] = await Promise.all([
			fetchParsedNetlist(params.refresh === true),
			(eda.sch_PrimitiveComponent as any).getAll('part', true),
		]);

		// 2. Build uniqueId → primitiveId map and designator → uniqueId map
		const uniqueToPrimitive: Record<string, string> = {};
		if (Array.isArray(allComponents)) {
			for (const comp of allComponents) {
				const c = comp as any;
				if (c.uniqueId && c.primitiveId) {
					uniqueToPrimitive[c.uniqueId] = c.primitiveId;
				}
			}
		}

		// 2b. If depth > 1 and designators specified, expand designator set by BFS through $-prefixed nets
		if (designatorFilter && depth > 1) {
			// Build lookup indices over the full netlist
			// netName → set of designators on that net
			const netToDesignators: Record<string, Set<string>> = {};
			// designator → set of $-prefixed nets the component is on
			const designatorToDollarNets: Record<string, Set<string>> = {};

			for (const [uniqueId, entry] of Object.entries(netlist)) {
				if (!uniqueToPrimitive[uniqueId]) continue;
				for (const [, netName] of Object.entries(entry.pins)) {
					if (!netName) continue;
					if (!netToDesignators[netName]) netToDesignators[netName] = new Set();
					netToDesignators[netName].add(entry.designator);
					if (netName.startsWith('$')) {
						if (!designatorToDollarNets[entry.designator]) designatorToDollarNets[entry.designator] = new Set();
						designatorToDollarNets[entry.designator].add(netName);
					}
				}
			}

			// BFS: expand through $-prefixed nets
			let frontier = new Set(designatorFilter);
			for (let hop = 1; hop < depth; hop++) {
				const nextFrontier = new Set<string>();
				for (const des of frontier) {
					const dollarNets = designatorToDollarNets[des];
					if (!dollarNets) continue;
					for (const net of dollarNets) {
						const neighbors = netToDesignators[net];
						if (!neighbors) continue;
						for (const neighbor of neighbors) {
							if (!designatorFilter.has(neighbor)) {
								nextFrontier.add(neighbor);
								designatorFilter.add(neighbor);
							}
						}
					}
				}
				if (nextFrontier.size === 0) break;
				frontier = nextFrontier;
			}
		}

		// 3. Fetch pin names for each component in parallel
		const pinNamesMap: Record<string, Record<string, string>> = {}; // uniqueId → pinNumber → pinName
		const fetchPromises: Promise<void>[] = [];
		for (const [uniqueId, entry] of Object.entries(netlist)) {
			const primitiveId = uniqueToPrimitive[uniqueId];
			if (!primitiveId) continue;
			// If filtering by designator, skip components not in the filter
			if (designatorFilter && !designatorFilter.has(entry.designator)) continue;
			fetchPromises.push(
				fetchPinNames(primitiveId).then((names) => {
					pinNamesMap[uniqueId] = names;
				}),
			);
		}
		await Promise.all(fetchPromises);

		// 4. Build nets view: netName → ["designator.pinNumber(pinName)", ...]
		const netsView: Record<string, string[]> = {};
		// 5. Build components view: designator → { part, pins: { pinNumber: { name, net } } }
		const componentsView: Record<string, { part: string; pins: Record<string, { name: string; net: string }> }> = {};

		// Track which designators have pins on filtered nets (for net-based filtering)
		const designatorsOnFilteredNets = new Set<string>();

		for (const [uniqueId, entry] of Object.entries(netlist)) {
			if (!uniqueToPrimitive[uniqueId]) continue;
			if (designatorFilter && !designatorFilter.has(entry.designator)) continue;

			const pinNames = pinNamesMap[uniqueId] || {};
			const compPins: Record<string, { name: string; net: string }> = {};
			let hasMatchingNet = false;

			for (const [pinNumber, netName] of Object.entries(entry.pins)) {
				const pinName = pinNames[pinNumber] || '';

				// Check if this pin's net matches the net filter
				if (netFilter && netName && netFilter.has(netName)) {
					hasMatchingNet = true;
				}

				// Build component pins view (always include all pins for included components)
				compPins[pinNumber] = { name: pinName, net: netName };

				// Build nets view: skip unconnected and auto-generated single-connection nets
				if (!netName || netName.startsWith('$')) continue;

				if (!netsView[netName]) netsView[netName] = [];
				const label = pinName
					? `${entry.designator}.${pinNumber}(${pinName})`
					: `${entry.designator}.${pinNumber}`;
				netsView[netName].push(label);
			}

			if (netFilter && !hasMatchingNet) continue;
			if (netFilter) designatorsOnFilteredNets.add(entry.designator);

			componentsView[entry.designator] = {
				part: entry.part,
				pins: compPins,
			};
		}

		// 6. Apply net filter to nets view
		let filteredNets = netsView;
		if (netFilter) {
			filteredNets = {};
			for (const netName of netFilter) {
				if (netsView[netName]) {
					filteredNets[netName] = netsView[netName];
				}
			}
		}

		// If filtering by designator but not by net, only include nets that touch filtered components
		if (designatorFilter && !netFilter) {
			const relevantNets: Record<string, string[]> = {};
			for (const [netName, connections] of Object.entries(filteredNets)) {
				const relevant = connections.some((conn) => {
					const designator = conn.split('.')[0];
					return designatorFilter.has(designator);
				});
				if (relevant) {
					relevantNets[netName] = connections;
				}
			}
			filteredNets = relevantNets;
		}

		const note = designatorFilter
			? `depth=${depth} used. $-prefixed nets were traced ${depth - 1} hop(s) from the requested designators. To reach further (e.g. through a chain of series resistors), pass a higher depth (max 5).`
			: `depth=${depth} applies only when designators are specified; ignored for whole-schematic queries.`;
		return { note, nets: filteredNets, components: componentsView };
	},
};
