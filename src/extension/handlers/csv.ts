// RFC-4180 parsing for EasyEDA's exported BOM files. Pure module (no
// `eda` imports) so it can be unit-tested directly with ts-node.
//
// EasyEDA's getBomFile('csv') actually returns tab-separated data, so we
// take a delimiter parameter rather than hard-coding a comma. sniffDelimiter
// picks whichever of comma or tab appears more often in the first line.

/**
 * Sniff the field delimiter from the first line of the text. Returns '\t'
 * if tabs outnumber commas in the first line, otherwise ','.
 */
export function sniffDelimiter(text: string): ',' | '\t' {
	const start = text.charCodeAt(0) === 0xfeff ? 1 : 0;
	const nl = text.indexOf('\n', start);
	const firstLine = text.slice(start, nl === -1 ? text.length : nl);
	let commas = 0;
	let tabs = 0;
	for (const ch of firstLine) {
		if (ch === ',') commas += 1;
		else if (ch === '\t') tabs += 1;
	}
	return tabs > commas ? '\t' : ',';
}

/**
 * Parse delimited text into records of fields.
 *
 * Handles quoted fields, escaped quotes (""), delimiter and newlines inside
 * quotes, CRLF and LF line endings, and a leading UTF-8 BOM character.
 * A trailing empty record (from a final newline) is ignored.
 */
export function parseCsv(text: string, delimiter: string = ','): string[][] {
	if (text.charCodeAt(0) === 0xfeff) {
		text = text.slice(1);
	}
	const records: string[][] = [];
	let record: string[] = [];
	let field = '';
	let inQuotes = false;
	let i = 0;
	while (i < text.length) {
		const ch = text[i];
		if (inQuotes) {
			if (ch === '"') {
				if (text[i + 1] === '"') {
					field += '"';
					i += 2;
				} else {
					inQuotes = false;
					i += 1;
				}
			} else {
				field += ch;
				i += 1;
			}
		} else if (ch === '"') {
			inQuotes = true;
			i += 1;
		} else if (ch === delimiter) {
			record.push(field);
			field = '';
			i += 1;
		} else if (ch === '\r' && text[i + 1] === '\n') {
			record.push(field);
			records.push(record);
			record = [];
			field = '';
			i += 2;
		} else if (ch === '\n' || ch === '\r') {
			record.push(field);
			records.push(record);
			record = [];
			field = '';
			i += 1;
		} else {
			field += ch;
			i += 1;
		}
	}
	if (field !== '' || record.length > 0) {
		record.push(field);
		records.push(record);
	}
	return records;
}

/**
 * Parse CSV text where the first record is a header row. Returns one object
 * per data row keyed by header; missing trailing cells become ''.
 */
export function csvToRows(
	text: string,
	delimiter: string = sniffDelimiter(text),
): Array<Record<string, string>> {
	const records = parseCsv(text, delimiter);
	if (records.length === 0) {
		return [];
	}
	const headers = records[0];
	return records.slice(1).map((record) => {
		const row: Record<string, string> = {};
		for (let i = 0; i < headers.length; i++) {
			row[headers[i]] = record[i] ?? '';
		}
		return row;
	});
}
