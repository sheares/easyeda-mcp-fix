import type { ToolDef, ToolContext } from '../types';
import { z } from 'zod';
import JSZip from 'jszip';
import { readdir } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { withDocumentParam, withInstanceParam } from './query-params';
import * as ANN from './annotations';
import { parseEpru, type EpruModel } from '../orientation/epru';
import { decodeText, parseFlyingProbe, parsePickAndPlace } from '../orientation/fab';
import { checkOrientation } from '../orientation/check';
import { checkTrackWidths, parsePcbCopper } from '../track-widths';
import { datasheetLookup, needsDatasheet, stashDatasheets, type Fetched, type StashPart } from '../datasheets';

// pcb_check_orientation, pcb_check_track_widths and project_fetch_datasheets.
// All read EasyEDA's own files (project export, flying-probe file,
// pick-and-place file), never the live query APIs, whose answers have been
// wrong before (bottom-side rotation, the netlist read from the wrong
// schematic).

type ExportResult = { fileName: string; data: string; size: number };

function text(value: unknown) {
	return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] };
}

function isZip(buf: Buffer): boolean {
	return buf.length > 3 && buf[0] === 0x50 && buf[1] === 0x4b;
}

function requireAbsolute(dir: string, name: string): void {
	if (!isAbsolute(dir)) throw new Error(`${name} must be an absolute path (got "${dir}").`);
}

/** The current project as an .epro2 export: its .epru document stream. */
async function exportProjectEpru(ctx: ToolContext, instance_id?: string): Promise<{ text: string; source: string }> {
	const res = await ctx.sendToExtension('fileManager.getProjectFile', { instance_id, fileType: 'epro2' }) as ExportResult;
	const buf = Buffer.from(res.data, 'base64');
	if (!isZip(buf)) throw new Error(`The project export (${res.fileName}) is not a zip; this EasyEDA build may not support .epro2.`);
	const zip = await JSZip.loadAsync(buf);
	const epru = Object.values(zip.files).find((f) => !f.dir && f.name.toLowerCase().endsWith('.epru'));
	if (!epru) throw new Error(`The project export (${res.fileName}) holds no .epru document stream.`);
	return { text: await epru.async('string'), source: `${res.fileName} › ${epru.name}` };
}

/** The current project as an .epro2 export, parsed. */
async function exportProjectModel(ctx: ToolContext, instance_id?: string): Promise<{ model: EpruModel; source: string }> {
	const { text, source } = await exportProjectEpru(ctx, instance_id);
	return { model: parseEpru(text), source };
}

function partsForStash(model: EpruModel): StashPart[] {
	const parts: StashPart[] = [];
	const fromPcb = [...model.pcbs.values()].flatMap((p) => p.parts);
	const source = fromPcb.length > 0 ? fromPcb : model.schematicParts;
	const seen = new Set<string>();
	for (const p of source) {
		if (!p.designator || seen.has(p.designator)) continue;
		seen.add(p.designator);
		const dev = p.device ? model.devices.get(p.device) : undefined;
		parts.push({
			lcsc: dev?.attributes['Supplier Part'],
			mpn: dev?.attributes['Manufacturer Part'] ?? dev?.title,
			designators: [p.designator],
			deviceUrl: dev?.attributes.Datasheet,
		});
	}
	return parts;
}

async function fetchUrl(url: string): Promise<Fetched> {
	const res = await fetch(url, {
		headers: { 'User-Agent': 'Mozilla/5.0 (compatible; easyeda-mcp datasheet fetch)', Accept: 'application/pdf,application/json,text/html;q=0.8,*/*;q=0.5' },
		redirect: 'follow',
		signal: AbortSignal.timeout(30_000),
	});
	return { status: res.status, contentType: res.headers.get('content-type') ?? '', body: new Uint8Array(await res.arrayBuffer()) };
}

export function orientationTools(ctx: ToolContext): ToolDef[] {
	return [
		{
			name: 'project_fetch_datasheets',
			annotations: ANN.FETCH_TO_LOCAL_FILE,
			description: `Download the datasheet of every non-passive part in the open project (chips, LEDs, diodes, transistors, connectors, inductors, crystals; not plain resistors, capacitors, jumpers or test points) into <projectFolder>/datasheets/ as {C-number}_{Manufacturer Part}.pdf, and write INDEX.md and index.json there.
The URL comes from the JLC parts record for each LCSC number, then the wmsc.lcsc.com mirror, then the device's own Datasheet link; a file is saved only when a URL served a real PDF. Files already in the folder (either naming order) are kept and reported as cached. Parts with no PDF are listed with every URL tried, to fetch by hand.
READ THE DATASHEETS BEFORE DECIDING ANYTHING about a part: its pin configuration and package drawing before any orientation or pinout call, its recommended circuit before flagging a missing part. Use pdftotext -layout, or Read with pages for drawings.`,
			inputShape: withInstanceParam({
				projectFolder: z.string().describe('Absolute path of the user\'s project folder (the one holding their notes for this board). Datasheets go in its datasheets/ subfolder.'),
				datasheetsFolder: z.string().optional().describe('Absolute path to use instead of <projectFolder>/datasheets, for a project that already keeps its datasheets elsewhere'),
				designators: z.array(z.string()).optional().describe('Only these parts (default: every non-passive part)'),
			}),
			handler: async ({ instance_id, projectFolder, datasheetsFolder, designators }) => {
				requireAbsolute(projectFolder, 'projectFolder');
				if (datasheetsFolder) requireAbsolute(datasheetsFolder, 'datasheetsFolder');
				const { model, source } = await exportProjectModel(ctx, instance_id);
				let parts = partsForStash(model).filter((p) => needsDatasheet(p.designators));
				if (designators?.length) parts = parts.filter((p) => p.designators.some((d) => designators.includes(d)));
				const dir = datasheetsFolder ?? join(projectFolder, 'datasheets');
				const { results, indexWritten } = await stashDatasheets(parts, dir, { fetchUrl });
				const tally: Record<string, number> = {};
				for (const r of results) tally[r.status] = (tally[r.status] ?? 0) + 1;
				return text({
					folder: dir,
					partsFromExport: source,
					counts: tally,
					index: indexWritten,
					results,
					next: 'Read each part\'s pin configuration, package drawing and marking sections before any decision about it. Fetch any not-found part by hand (a browser usually works where a script is refused).',
				});
			},
		},

		{
			name: 'pcb_check_orientation',
			annotations: ANN.READ_ONLY,
			description: `Check that every LED, diode, polarised part and chip on the PCB will be fitted the right way round, using only files EasyEDA itself writes (the project export, the flying-probe file and the pick-and-place file), not live query results.
Per part: (1) the footprint's component-marking feature (layer 49) points at the cathode (diodes, LEDs) or pin 1 (chips), as named in the schematic symbol; (2) the pick-and-place pin-1 point, which the fab places from, sits on pad 1; (3) LED and diode anode and cathode nets make sense, and chip GND / VCC-type pins are on ground / supply nets.
Returns { verdict: pass | review | fail | inconclusive, summary, examined, parts, findings, limits, sources }. verdict is "pass" only when every part passed every check AND has a stashed datasheet: run project_fetch_datasheets first and pass the same projectFolder. Then read each flagged part's datasheet (pin configuration, package drawing, marking) before deciding; the tool cannot read PDFs.
Run it after any placement change (including pcb_autolayout_start) and before ordering. Still check the fab's own placement preview: it applies its own rotation library.`,
			inputShape: withDocumentParam({
				projectFolder: z.string().optional().describe('Absolute path of the project folder whose datasheets/ subfolder project_fetch_datasheets filled. Without it (or datasheetsFolder) no part can reach "ok".'),
				datasheetsFolder: z.string().optional().describe('Absolute path of the datasheets folder, when it is not <projectFolder>/datasheets'),
			}),
			handler: async ({ instance_id, document, projectFolder, datasheetsFolder }) => {
				if (projectFolder) requireAbsolute(projectFolder, 'projectFolder');
				if (datasheetsFolder) requireAbsolute(datasheetsFolder, 'datasheetsFolder');
				// One export at a time: parallel export calls have dropped data before.
				const { model, source: projectSource } = await exportProjectModel(ctx, instance_id);
				const pcbUuid = String(document).split('@')[0];
				const pcb = model.pcbs.get(pcbUuid) ?? (model.pcbs.size === 1 ? [...model.pcbs.values()][0] : undefined);
				const designators = (pcb?.parts ?? []).map((p) => p.designator).filter((d): d is string => !!d);

				const fpRes = await ctx.sendToExtension('pcb.manufacture.getFlyingProbeTestFile', { instance_id, document }) as ExportResult;
				let fpBuf = Buffer.from(fpRes.data, 'base64');
				let fpName = fpRes.fileName;
				if (isZip(fpBuf)) {
					const zip = await JSZip.loadAsync(fpBuf);
					const json = Object.values(zip.files).find((f) => !f.dir && f.name.toLowerCase().endsWith('.json'));
					if (!json) throw new Error(`The flying-probe export (${fpRes.fileName}) holds no .json file.`);
					fpBuf = Buffer.from(await json.async('uint8array'));
					fpName = `${fpRes.fileName} › ${json.name}`;
				}
				const probe = parseFlyingProbe(JSON.parse(fpBuf.toString('utf8')), designators);

				const cplRes = await ctx.sendToExtension('pcb.manufacture.getPickAndPlaceFile', { instance_id, document, fileType: 'csv', unit: 'mm' }) as ExportResult;
				const cplBuf = Buffer.from(cplRes.data, 'base64');
				if (isZip(cplBuf)) throw new Error('EasyEDA returned the pick-and-place file as a spreadsheet, not CSV; this build ignores fileType "csv".');
				const placement = parsePickAndPlace(decodeText(cplBuf));

				let datasheetFor: ((lcsc: string | undefined) => string | null) | undefined;
				let datasheetDir: string | null = null;
				if (datasheetsFolder || projectFolder) {
					const dir: string = datasheetsFolder ?? join(projectFolder!, 'datasheets');
					const files = await readdir(dir).catch(() => [] as string[]);
					datasheetFor = datasheetLookup(dir, files);
					datasheetDir = dir;
				}
				const report = checkOrientation({ model, pcbUuid, probe, placement, datasheetFor });
				return text({
					...report,
					sources: {
						projectExport: projectSource,
						flyingProbe: fpName,
						pickAndPlace: cplRes.fileName,
						datasheets: datasheetDir ?? 'none given (pass projectFolder)',
					},
				});
			},
		},

		{
			name: 'pcb_check_track_widths',
			annotations: ANN.READ_ONLY,
			description: `Check every copper track's width against the track rule that applies to its net, using the project export EasyEDA itself writes, not live queries. The rule comes from the net's own rule, then its differential pair's, then its net class's, then the board default.
Returns { verdict: pass | review | fail | inconclusive, summary, examined, nets, limits }. fail: tracks below their rule's minimum or above its maximum. review: tracks narrower than their net's own (net, pair or class) rule's default width; that is fine where a copper fill or pour carries the current (each net lists copperFills), so judge it against the current the net carries. Nets on the board default rule are held to its minimum and maximum only. Each finding lists track ids (for pcb_modify_track) and the first track's position in data coordinates (mil).
Run it after any routing, above all after pcb_autoroute_start: on EasyEDA 3.2.209 the autorouter used one width on every net, ignoring net-class rules, and EasyEDA's own DRC did not report the tracks it left below their class minimum.`,
			inputShape: withDocumentParam({}),
			handler: async ({ instance_id, document }) => {
				const { text: epru, source } = await exportProjectEpru(ctx, instance_id);
				const pcbUuid = String(document).split('@')[0];
				const model = parsePcbCopper(epru, pcbUuid);
				const report = checkTrackWidths(model);
				const note = model && model.pcbUuid !== pcbUuid ? `The export holds one PCB (${model.pcbUuid}), checked in place of ${pcbUuid}.` : undefined;
				return text({ ...report, ...(note ? { note } : {}), sources: { projectExport: source } });
			},
		},
	];
}
