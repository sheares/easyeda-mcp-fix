/**
 * Symbol-body geometry extraction + polygon-level overlap reasoning.
 *
 * A symbol's visible body is extracted as a set of {@link Polygon}s in
 * symbol-local coordinates, then transformed into world coordinates by
 * applying an instance's position/rotation/mirror. Two transformed shapes
 * can be tested for overlap with {@link shapesOverlap}.
 *
 * Coordinate system: EasyEDA schematic/symbol coordinates are +Y=up. Rotations
 * are in degrees CCW. Verified against live EasyEDA renders at rotations
 * 0/90/180/270 and with mirror=true for both netflags (GND) and netports
 * (OUT). When rendering to SVG for debug, apply `transform="scale(1,-1)"`
 * since SVG's default is +Y=down.
 *
 * The overlap test is an approximation — a signal for "these components are
 * visually clashing," not a proof of pixel-exact intersection. Curved
 * primitives (CIRCLE/ELLIPSE/ARC) are polygonalised with a caller-controlled
 * segment count. Open polylines and pin stubs are returned as open polygons
 * and contribute to the bounding box but are treated as zero-area for the
 * edge-intersection test — two open strokes that only touch at a vertex
 * won't count as overlapping.
 */

import { parseEsymSource } from './schema';
import type { EsymLine, ParsedLine } from './schema';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A 2D polygon. Points are a flat `[x0,y0,x1,y1,...]` array. `closed=true`
 * means the last edge wraps to the first point (a filled region); `false`
 * means an open polyline (a stroke).
 */
export interface Polygon {
	points: number[];
	closed: boolean;
	/** Which primitive did this polygon come from? Diagnostic. */
	source: 'RECT' | 'CIRCLE' | 'ELLIPSE' | 'ARC' | 'POLY' | 'PIN';
}

export interface BoundingBox {
	minX: number;
	minY: number;
	maxX: number;
	maxY: number;
}

export interface Shape {
	polygons: Polygon[];
	bbox: BoundingBox;
}

export interface InstanceTransform {
	x: number;
	y: number;
	/** Degrees, CW in EasyEDA (+Y=down) screen coords. */
	rotation: number;
	/** Non-zero means mirror about the local Y axis before translating. */
	flip: number;
}

export interface SymbolShapeOptions {
	/** Include pin stubs as open line-segment polygons. Default: true. */
	includePins?: boolean;
	/** Segments used to polygonalise CIRCLE / ELLIPSE. Default: 24. */
	circleSegments?: number;
	/** Segments used to polygonalise ARC. Default: 16. */
	arcSegments?: number;
}

const DEFAULTS: Required<SymbolShapeOptions> = {
	includePins: true,
	circleSegments: 24,
	arcSegments: 16,
};

// ---------------------------------------------------------------------------
// Primitive → polygon helpers
// ---------------------------------------------------------------------------

function rectPolygon(x1: number, y1: number, x2: number, y2: number): Polygon {
	return {
		points: [x1, y1, x2, y1, x2, y2, x1, y2],
		closed: true,
		source: 'RECT',
	};
}

function circlePolygon(cx: number, cy: number, r: number, segments: number): Polygon {
	const points: number[] = [];
	for (let i = 0; i < segments; i++) {
		const theta = (i / segments) * 2 * Math.PI;
		points.push(cx + r * Math.cos(theta), cy + r * Math.sin(theta));
	}
	return { points, closed: true, source: 'CIRCLE' };
}

function ellipsePolygon(cx: number, cy: number, rx: number, ry: number, segments: number): Polygon {
	const points: number[] = [];
	for (let i = 0; i < segments; i++) {
		const theta = (i / segments) * 2 * Math.PI;
		points.push(cx + rx * Math.cos(theta), cy + ry * Math.sin(theta));
	}
	return { points, closed: true, source: 'ELLIPSE' };
}

/**
 * Three-point (start, mid, end) arc → polyline approximation. Finds the
 * unique circle through the three points, then samples `segments` points
 * along the arc from start to end, going through mid. Falls back to a
 * straight line if the points are collinear.
 */
function arcPolygon(
	x1: number, y1: number,
	xm: number, ym: number,
	x2: number, y2: number,
	segments: number,
): Polygon {
	// Circumcenter of the triangle (x1,y1)-(xm,ym)-(x2,y2).
	const det = (xm - x1) * (y2 - ym) - (ym - y1) * (x2 - xm);
	if (Math.abs(det) < 1e-9) {
		// Collinear — fall back to a polyline through all three points.
		return { points: [x1, y1, xm, ym, x2, y2], closed: false, source: 'ARC' };
	}
	const ux = ((xm - x1) * (xm + x1) + (ym - y1) * (ym + y1)) / 2;
	const uy = ((x2 - xm) * (x2 + xm) + (y2 - ym) * (y2 + ym)) / 2;
	const ccx = (ux * (y2 - ym) - uy * (ym - y1)) / det;
	const ccy = ((xm - x1) * uy - (x2 - xm) * ux) / det;
	const r = Math.hypot(ccx - x1, ccy - y1);

	const a1 = Math.atan2(y1 - ccy, x1 - ccx);
	const am = Math.atan2(ym - ccy, xm - ccx);
	const a3 = Math.atan2(y2 - ccy, x2 - ccx);

	// Pick the sweep direction that passes through the mid point.
	let sweep = a3 - a1;
	while (sweep <= -Math.PI) sweep += 2 * Math.PI;
	while (sweep > Math.PI) sweep -= 2 * Math.PI;
	let dm = am - a1;
	while (dm <= -Math.PI) dm += 2 * Math.PI;
	while (dm > Math.PI) dm -= 2 * Math.PI;
	if ((sweep > 0 && dm < 0) || (sweep < 0 && dm > 0)) {
		sweep = sweep > 0 ? sweep - 2 * Math.PI : sweep + 2 * Math.PI;
	}

	const points: number[] = [];
	for (let i = 0; i <= segments; i++) {
		const t = a1 + (sweep * i) / segments;
		points.push(ccx + r * Math.cos(t), ccy + r * Math.sin(t));
	}
	return { points, closed: false, source: 'ARC' };
}

function polyLinePolygon(points: number[], closed: boolean): Polygon {
	return { points: [...points], closed, source: 'POLY' };
}

function pinPolygon(x: number, y: number, length: number, angleDeg: number): Polygon {
	const rad = (angleDeg * Math.PI) / 180;
	const ex = x + length * Math.cos(rad);
	const ey = y + length * Math.sin(rad);
	return { points: [x, y, ex, ey], closed: false, source: 'PIN' };
}

// ---------------------------------------------------------------------------
// Symbol → Shape
// ---------------------------------------------------------------------------

/**
 * Extract the drawn body of a parsed symbol as a polygon-based Shape in
 * symbol-local coordinates. ATTRs (text labels) are not included — they're
 * noise for overlap reasoning. Use {@link transformShape} to place the
 * shape at an instance's world position.
 */
export function shapeFromSymbol(
	lines: ParsedLine<EsymLine>[],
	opts: SymbolShapeOptions = {},
): Shape {
	const o = { ...DEFAULTS, ...opts };
	const polygons: Polygon[] = [];

	for (const line of lines) {
		if (line.kind !== 'known') continue;
		const d = line.data;
		const tag = d[0];

		if (tag === 'RECT') {
			polygons.push(rectPolygon(d[2] as number, d[3] as number, d[4] as number, d[5] as number));
		} else if (tag === 'CIRCLE') {
			polygons.push(circlePolygon(
				d[2] as number, d[3] as number, d[4] as number, o.circleSegments,
			));
		} else if (tag === 'ELLIPSE') {
			polygons.push(ellipsePolygon(
				d[2] as number, d[3] as number, d[4] as number, d[5] as number, o.circleSegments,
			));
		} else if (tag === 'ARC') {
			// .esym ARC: ["ARC", id, x1, y1, xm, ym, x2, y2, styleId, layer]
			// The slot layout is an assumption (ArcLine only pins tag + id; no
			// real ARC fixture confirms it yet), so guard every read: a malformed
			// ARC must be skipped, not allowed to push NaNs that poison the
			// bounding box and silently disable overlap detection.
			const slots = [d[2], d[3], d[4], d[5], d[6], d[7]];
			if (slots.every((n) => typeof n === 'number' && Number.isFinite(n))) {
				polygons.push(arcPolygon(
					d[2] as number, d[3] as number,
					d[4] as number, d[5] as number,
					d[6] as number, d[7] as number,
					o.arcSegments,
				));
			}
		} else if (tag === 'POLY') {
			const pts = d[2] as number[];
			const closedRaw = d[3] as boolean | number;
			const closed = closedRaw === true || closedRaw === 1;
			polygons.push(polyLinePolygon(pts, closed));
		} else if (tag === 'PIN' && o.includePins) {
			// PIN: [tag, id, ?, ?, x, y, length, angle, ...]
			polygons.push(pinPolygon(
				d[4] as number, d[5] as number, d[6] as number, d[7] as number,
			));
		}
	}

	return { polygons, bbox: computeBoundingBox(polygons) };
}

/**
 * Convenience: parse a .esym source string and extract its shape.
 */
export function shapeFromSymbolSource(source: string, opts: SymbolShapeOptions = {}): Shape {
	const { lines } = parseEsymSource(source);
	return shapeFromSymbol(lines, opts);
}

// ---------------------------------------------------------------------------
// Instance transform + bounding box
// ---------------------------------------------------------------------------

function transformPoint(
	px: number, py: number,
	t: InstanceTransform,
): [number, number] {
	let x = px;
	let y = py;
	if (t.flip) x = -x;
	if (t.rotation !== 0) {
		const rad = (t.rotation * Math.PI) / 180;
		const cos = Math.cos(rad);
		const sin = Math.sin(rad);
		const rx = x * cos - y * sin;
		const ry = x * sin + y * cos;
		x = rx;
		y = ry;
	}
	return [t.x + x, t.y + y];
}

/**
 * Apply an instance's world position/rotation/mirror to a symbol-local
 * shape. Mirror is applied first (flip about local Y), then rotation, then
 * translation — matching EasyEDA's convention.
 */
export function transformShape(shape: Shape, t: InstanceTransform): Shape {
	const polygons = shape.polygons.map((p) => ({
		...p,
		points: transformPoints(p.points, t),
	}));
	return { polygons, bbox: computeBoundingBox(polygons) };
}

function transformPoints(points: number[], t: InstanceTransform): number[] {
	const out = new Array<number>(points.length);
	for (let i = 0; i < points.length; i += 2) {
		const [tx, ty] = transformPoint(points[i], points[i + 1], t);
		out[i] = tx;
		out[i + 1] = ty;
	}
	return out;
}

export function computeBoundingBox(polygons: Polygon[]): BoundingBox {
	let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
	for (const p of polygons) {
		for (let i = 0; i < p.points.length; i += 2) {
			const x = p.points[i];
			const y = p.points[i + 1];
			if (x < minX) minX = x;
			if (y < minY) minY = y;
			if (x > maxX) maxX = x;
			if (y > maxY) maxY = y;
		}
	}
	if (!Number.isFinite(minX)) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
	return { minX, minY, maxX, maxY };
}

export function boundingBoxesOverlap(a: BoundingBox, b: BoundingBox): boolean {
	return a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;
}

// ---------------------------------------------------------------------------
// Overlap test
// ---------------------------------------------------------------------------

/**
 * Does the point `(px, py)` lie inside the closed polygon? Standard
 * even-odd ray cast. Undefined for open polylines — caller must not
 * invoke on those.
 */
export function polygonContainsPoint(poly: Polygon, px: number, py: number): boolean {
	if (!poly.closed) return false;
	const pts = poly.points;
	let inside = false;
	for (let i = 0, j = pts.length - 2; i < pts.length; j = i, i += 2) {
		const xi = pts[i], yi = pts[i + 1];
		const xj = pts[j], yj = pts[j + 1];
		const intersect =
			(yi > py) !== (yj > py) &&
			px < ((xj - xi) * (py - yi)) / (yj - yi + (yj === yi ? 1e-12 : 0)) + xi;
		if (intersect) inside = !inside;
	}
	return inside;
}

function segmentsIntersect(
	ax: number, ay: number, bx: number, by: number,
	cx: number, cy: number, dx: number, dy: number,
): boolean {
	const d1 = cross(dx - cx, dy - cy, ax - cx, ay - cy);
	const d2 = cross(dx - cx, dy - cy, bx - cx, by - cy);
	const d3 = cross(bx - ax, by - ay, cx - ax, cy - ay);
	const d4 = cross(bx - ax, by - ay, dx - ax, dy - ay);
	if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
		((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) {
		return true;
	}
	// Collinear overlap and endpoint touches are intentionally excluded
	// to avoid flagging shared vertices as overlap.
	return false;
}

function cross(ax: number, ay: number, bx: number, by: number): number {
	return ax * by - ay * bx;
}

function polygonEdges(poly: Polygon): Iterable<[number, number, number, number]> {
	const pts = poly.points;
	const n = pts.length / 2;
	if (n < 2) return [];
	const edges: Array<[number, number, number, number]> = [];
	for (let i = 0; i < n - 1; i++) {
		edges.push([pts[i * 2], pts[i * 2 + 1], pts[i * 2 + 2], pts[i * 2 + 3]]);
	}
	if (poly.closed && n >= 3) {
		edges.push([pts[(n - 1) * 2], pts[(n - 1) * 2 + 1], pts[0], pts[1]]);
	}
	return edges;
}

/**
 * Do two closed polygons overlap (intersect or one contains the other)?
 * Open polylines are skipped for the edge-cross check but still contribute
 * their bounding box — so two open strokes that only touch at a vertex
 * are not reported as overlapping.
 */
export function polygonsOverlap(a: Polygon, b: Polygon): boolean {
	// Edge-intersection test.
	for (const [ax, ay, bx, by] of polygonEdges(a)) {
		for (const [cx, cy, dx, dy] of polygonEdges(b)) {
			if (segmentsIntersect(ax, ay, bx, by, cx, cy, dx, dy)) return true;
		}
	}
	// Containment test: test one point from each polygon against the other.
	if (a.closed && b.points.length >= 2) {
		if (polygonContainsPoint(a, b.points[0], b.points[1])) return true;
	}
	if (b.closed && a.points.length >= 2) {
		if (polygonContainsPoint(b, a.points[0], a.points[1])) return true;
	}
	return false;
}

/**
 * Do two shapes overlap? Fast-reject by bounding box, then test each
 * polygon pair.
 */
export function shapesOverlap(a: Shape, b: Shape): boolean {
	if (!boundingBoxesOverlap(a.bbox, b.bbox)) return false;
	for (const pa of a.polygons) {
		for (const pb of b.polygons) {
			if (!boundingBoxesOverlap(polygonBbox(pa), polygonBbox(pb))) continue;
			if (polygonsOverlap(pa, pb)) return true;
		}
	}
	return false;
}

function polygonBbox(p: Polygon): BoundingBox {
	let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
	for (let i = 0; i < p.points.length; i += 2) {
		const x = p.points[i];
		const y = p.points[i + 1];
		if (x < minX) minX = x;
		if (y < minY) minY = y;
		if (x > maxX) maxX = x;
		if (y > maxY) maxY = y;
	}
	if (!Number.isFinite(minX)) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
	return { minX, minY, maxX, maxY };
}
