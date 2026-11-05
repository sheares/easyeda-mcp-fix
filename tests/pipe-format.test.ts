// EasyEDA Pro 3 returns live documents as {header}||{body} lines. Validation
// checks their structure instead of reporting every line invalid, and the
// JSON-array reader/editor refuse them rather than reading an empty model.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isPipeFormatSource, validatePipeSource, normalisePipeLineEnds } from '../src/lib/schema';
import { validatePcbSource, validateSchematicSource } from '../src/bridge-daemon/tools/schema-tools';
import { parseSchematic, parseSymbol } from '../src/lib/schematic-reader';
import { SymbolEditor } from '../src/lib/symbol/symbol-editor';

// Trimmed from a real EasyEDA Pro 3.2.206 PCB source. The FILL line has no
// trailing pipe, as EasyEDA writes it.
const PIPE = [
	'{"type":"DOCHEAD"}||{"docType":"PCB","uuid":"88f4426d6a59248e","editVersion":"3.2.206"}|',
	'{"type":"LAYER","ticket":2,"id":"[\\"LAYER\\",1]"}||{"layerId":1,"layerType":"TOP","layerName":"Top Layer","use":true}|',
	'{"type":"PAD","ticket":135,"id":"92b07b50ea80424c"}||{"netName":"GND","layerId":1,"num":"1","centerX":0,"centerY":0,"hole":null,"defaultPad":{"padType":"ELLIPSE","width":60,"height":60}}|',
	'{"type":"FILL","ticket":139,"id":"b06600da70a33d44"}||{"netName":"GND","layerId":2,"width":0.2,"fillStyle":"SOLID","path":[[500,300,"L",500,500,700,500]]}',
	'',
].join('\n');

const ARRAY_ESCH = readFileSync(join(__dirname, 'fixtures', 'sample.esch'), 'utf8');

test('detects the pipe format and not the JSON-array format', () => {
	assert.equal(isPipeFormatSource(PIPE), true);
	assert.equal(isPipeFormatSource(ARRAY_ESCH), false);
	assert.equal(isPipeFormatSource(''), false);
});

test('a well-formed pipe source validates clean, with a note saying how', () => {
	const report = validatePipeSource(PIPE, 'epcb');
	assert.equal(report.invalidCount, 0);
	assert.equal(report.knownCount, 4);
	assert.equal(report.blankCount, 1);
	assert.match(report.note ?? '', /structure only/);
});

test('truncated lines and headers without a type are invalid, with a reason', () => {
	const lines = PIPE.split('\n');
	lines[2] = lines[2].slice(0, 80); // cut mid-body
	lines[1] = '{"ticket":2}||{"layerId":1}|';
	lines.push('not a pipe line at all');
	const report = validatePipeSource(lines.join('\n'), 'epcb');
	assert.equal(report.invalidCount, 3);
	const reasons = report.samples.invalid.map((i) => i.reason).join(' / ');
	assert.match(reasons, /string "type"/);
	assert.match(reasons, /body is not valid JSON/);
	assert.match(reasons, /no JSON header/);
});

test('the daemon validators route pipe sources to the structural check and arrays to the schemas', async () => {
	const pcb = await validatePcbSource(PIPE, {});
	assert.equal(pcb.invalidCount, 0);
	assert.ok(pcb.note);
	const sch = await validateSchematicSource(ARRAY_ESCH, {});
	assert.equal(sch.note, undefined);
	assert.equal(sch.invalidCount, 0);
});

test('the reader and symbol editor refuse a pipe source instead of reading an empty model', () => {
	assert.throws(() => parseSchematic(PIPE), /pipe-delimited format/);
	assert.throws(() => parseSymbol(PIPE), /pipe-delimited format/);
	assert.throws(() => SymbolEditor.load(PIPE), /project_export_file/);
});

test('normalisePipeLineEnds leaves a source EasyEDA wrote alone', () => {
	const r = normalisePipeLineEnds(PIPE);
	assert.equal(r.fixed, 0);
	assert.equal(r.source, PIPE.replace(/\n$/, ''));
});

test('normalisePipeLineEnds repairs a source whose last record was deleted or that had one appended', () => {
	const lines = PIPE.split('\n').filter((l) => l !== '');
	// Last record deleted: the new last line keeps its "|", which EasyEDA rejects.
	const deleted = normalisePipeLineEnds(lines.slice(0, -1).join('\n') + '\n');
	assert.equal(deleted.fixed, 1);
	assert.ok(!deleted.source.endsWith('|'));
	assert.ok(deleted.source.split('\n').slice(0, -1).every((l) => l.endsWith('|')));
	// A record appended after the old last line: that line now needs its "|".
	const appended = normalisePipeLineEnds([...lines, '{"type":"VIA","id":"v1"}||{"netName":"GND","centerX":1,"centerY":2}|'].join('\n'));
	assert.equal(appended.fixed, 2);
	const out = appended.source.split('\n');
	assert.ok(out.slice(0, -1).every((l) => l.endsWith('|')));
	assert.ok(out[out.length - 1].endsWith('}'));
	assert.equal(validatePipeSource(appended.source, 'epcb').invalidCount, 0);
});

test('normalisePipeLineEnds handles empty bodies, CRLF and blank lines, and ignores other formats', () => {
	const src = '{"type":"DOCHEAD"}||{"docType":"PCB"}|\r\n\r\n{"type":"PAD_NET","id":"x"}||\r\n{"type":"PAD_NET","id":"y"}|||';
	const r = normalisePipeLineEnds(src);
	assert.deepEqual(r.source.split('\n'), ['{"type":"DOCHEAD"}||{"docType":"PCB"}|', '{"type":"PAD_NET","id":"x"}|||', '{"type":"PAD_NET","id":"y"}||']);
	assert.equal(normalisePipeLineEnds(ARRAY_ESCH).source, ARRAY_ESCH);
	assert.equal(normalisePipeLineEnds(ARRAY_ESCH).fixed, 0);
});
