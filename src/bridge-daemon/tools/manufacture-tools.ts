import type { ToolDef, ToolContext } from '../types';
import { z } from 'zod';
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';
import { withDocumentParam } from './query-params';

const EXPORT_HANDLER_MAP: Record<string, string> = {
	dsn: 'pcb.manufacture.getDsnFile',
	autoroute_json: 'pcb.manufacture.getAutoRouteJsonFile',
	autolayout_json: 'pcb.manufacture.getAutoLayoutJsonFile',
	gerber: 'pcb.manufacture.getGerberFile',
	bom: 'pcb.manufacture.getBomFile',
	pick_and_place: 'pcb.manufacture.getPickAndPlaceFile',
	'3d': 'pcb.manufacture.get3DFile',
	pdf: 'pcb.manufacture.getPdfFile',
	netlist: 'pcb.manufacture.getNetlistFile',
	dxf: 'pcb.manufacture.getDxfFile',
	altium: 'pcb.manufacture.getAltiumDesignerFile',
	pads: 'pcb.manufacture.getPadsFile',
	odbplus: 'pcb.manufacture.getOpenDatabaseDoublePlusFile',
	ipc_d_356: 'pcb.manufacture.getIpcD356AFile',
	flying_probe: 'pcb.manufacture.getFlyingProbeTestFile',
	test_point: 'pcb.manufacture.getTestPointFile',
};

const IMPORT_HANDLER_MAP: Record<string, string> = {
	autoroute_json: 'pcb.manufacture.importAutoRouteJson',
	autolayout_json: 'pcb.manufacture.importAutoLayoutJson',
	autoroute_ses: 'pcb.manufacture.importAutoRouteSes',
};

const ExportFormat = z.enum([
	'dsn', 'autoroute_json', 'autolayout_json', 'gerber', 'bom',
	'pick_and_place', '3d', 'pdf', 'netlist', 'dxf', 'altium', 'pads',
	'odbplus', 'ipc_d_356', 'flying_probe', 'test_point',
]);

// Note: unit values are the literal ESYS_Unit enum strings ("mm", "inch", "mil"),
// NOT the enum names ("MILLIMETER", "INCH", "MIL"). Passing the name will be
// silently ignored or rejected by the EasyEDA runtime.
const OPTIONS_HINT = `Most formats accept extra options forwarded as-is to the underlying EasyEDA \
getXxxFile call. Common ones (unit values are the literal strings "mm" / "inch" / "mil"):
  gerber:        { unit: "mm" | "inch", colorSilkscreen, digitalFormat: {integerNumber, decimalNumber}, other: {metallicDrillingInformation, nonMetallicDrillingInformation, drillTable, flyingProbeTestingFile}, layers: [{layerId, isMirror}], objects: [...] }
  odbplus:       { unit: "inch", otherData: {metallizedDrilledHoles, nonMetallizedDrilledHoles, drillTable, flyingProbeTestFile}, layers: [{layerId, mirror}], objects: [{objectName}] }
  pick_and_place:{ unit: "mm" | "mil" }
  3d:            { element: [...], modelMode: "Outfit" | "Parts", autoGenerateModels }
  bom:           { template, filterOptions, statistics, property, columns }
  dxf:           { layers: [{layerId, mirror}], objects: [...] }
Omit options to get sensible defaults. For gerber and odbplus, omitting \`layers\` exports
all enabled copper (Top, Bottom, and any Inner1..InnerN that are enabled) plus the standard
silk/mask/paste/outline aux layers — unlike EasyEDA's raw default which silently drops inner
copper even on 4L+ boards.

CAUTION: options keys cannot override the top-level document/instance_id routing fields —
those always take precedence to prevent accidental cross-document export.`;

export function manufactureTools(ctx: ToolContext): ToolDef[] {
	return [
		{
			name: 'pcb_export',
			description: `Export the PCB design in various formats. Returns { fileName, data (Base64), size }.

Formats: dsn (for FreeRouting), gerber (manufacturing), bom (bill of materials), pick_and_place (assembly),
3d (STEP/OBJ), pdf, netlist, dxf, altium, pads, odbplus (ODB++ archive with stackup+nets),
ipc_d_356 (netlist test format), flying_probe, test_point, autoroute_json, autolayout_json.
Use fileType for sub-formats: "xlsx"/"csv" (bom, pick_and_place, test_point), "step"/"obj" (3d).

WARNING: response is Base64 in the MCP reply — for large outputs (gerber zips, 3d STEP) prefer
pcb_export_to_file which writes straight to disk.

${OPTIONS_HINT}`,
			inputShape: withDocumentParam({
				format: ExportFormat.describe('Export format'),
				fileName: z.string().optional().describe('Output file name'),
				fileType: z
					.string()
					.optional()
					.describe('Sub-format (e.g. "xlsx"/"csv" for bom, "step"/"obj" for 3d)'),
				options: z
					.record(z.string(), z.unknown())
					.optional()
					.describe('Format-specific options passed through to the underlying EasyEDA call. See tool description for shape per format.'),
			}),
			handler: async ({ format, options, ...rest }) => {
				// rest spread AFTER options so routing fields (document, instance_id) can't be shadowed.
				const result = await ctx.sendToExtension(EXPORT_HANDLER_MAP[format], { ...(options ?? {}), ...rest });
				return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
			},
		},

		{
			name: 'pcb_export_to_file',
			description: `Export the PCB design in various formats directly to a local file path — preferred
over pcb_export when the output is large (gerber/odbplus zips, 3d STEP, pdf), since it avoids
shipping the bytes back through the MCP response as Base64.

Returns { saved: path, size, originalName, format }.

Formats: same as pcb_export. See pcb_export for option shapes.

${OPTIONS_HINT}`,
			inputShape: withDocumentParam({
				format: ExportFormat.describe('Export format'),
				filePath: z.string().describe('Absolute path to write the exported file to'),
				fileType: z
					.string()
					.optional()
					.describe('Sub-format (e.g. "xlsx"/"csv" for bom, "step"/"obj" for 3d)'),
				options: z
					.record(z.string(), z.unknown())
					.optional()
					.describe('Format-specific options passed through to the underlying EasyEDA call.'),
			}),
			handler: async ({ format, filePath, options, ...rest }) => {
				if (!isAbsolute(filePath)) {
					throw new Error(
						`pcb_export_to_file requires an absolute filePath; got ${JSON.stringify(filePath)}. ` +
						`Relative paths would land in the daemon's CWD (typically the user's home directory), ` +
						`making the file hard to locate.`,
					);
				}
				// rest spread AFTER options so routing fields (document, instance_id, filePath) can't be shadowed.
				const result = await ctx.sendToExtension(EXPORT_HANDLER_MAP[format], { ...(options ?? {}), ...rest }) as {
					fileName?: string;
					data?: string;
					size?: number;
				};
				if (typeof result?.data !== 'string') {
					throw new Error(
						`pcb_export_to_file: extension returned unexpected shape for format=${format} ` +
						`(missing or non-string 'data' field). Got keys: ${result ? Object.keys(result).join(',') : '(null)'}`,
					);
				}
				const raw = Buffer.from(result.data, 'base64');
				await mkdir(dirname(filePath), { recursive: true });
				await writeFile(filePath, raw);
				return {
					content: [{
						type: 'text',
						text: JSON.stringify({
							saved: filePath,
							size: raw.length,
							originalName: result.fileName,
							format,
						}, null, 2),
					}],
				};
			},
		},

		{
			name: 'pcb_import',
			description: `Import routing or layout result files into the PCB (Base64-encoded).
Formats: autoroute_json (JSON autoroute), autolayout_json (JSON autolayout), autoroute_ses (FreeRouting SES).`,
			inputShape: withDocumentParam({
				format: z
					.enum(['autoroute_json', 'autolayout_json', 'autoroute_ses'])
					.describe('Import format'),
				data: z.string().describe('Base64-encoded file content'),
				fileName: z.string().optional().describe('File name'),
			}),
			handler: async ({ format, ...rest }) => {
				const result = await ctx.sendToExtension(IMPORT_HANDLER_MAP[format], rest);
				return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
			},
		},
	];
}
