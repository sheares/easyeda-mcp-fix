import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
	shapeFromSymbolSource,
	transformShape,
	shapesOverlap,
	boundingBoxesOverlap,
	polygonContainsPoint,
} from '../src/lib/geometry';

// Minimal .esym fixture modelled after the real Ground-GND symbol:
//   - one PIN at origin (angle 270 — stub going up in +Y=up world)
//   - POLY bars below at y=-10, -13, -16, -19
const GND_SOURCE = [
	'["DOCTYPE","SYMBOL","1.0"]',
	'["HEAD",{"originX":0,"originY":0,"version":"1.5","symbolType":18}]',
	'["PART","",{"BBOX":[-10,-10,10,-19]}]',
	'["PIN","e1",1,1,0,0,10,270,null,0,0]',
	'["LINESTYLE","st1",null,null,null,1]',
	'["POLY","e2",[-10,-10,10,-10],false,"st1",0]',
	'["POLY","e3",[-1,-19,1,-19],false,"st1",0]',
].join('\n');

// Minimal .esym fixture modelled after Netport-OUT:
//   - one PIN at (0,0) angle 0 (stub extends +X into the arrow body)
//   - one closed POLY forming a right-pointing arrow (tip at x=40)
const NETPORT_OUT_SOURCE = [
	'["DOCTYPE","SYMBOL","1.0"]',
	'["HEAD",{"originX":0,"originY":0,"version":"1.5","symbolType":19}]',
	'["PART","",{"BBOX":[10,5,40,-5]}]',
	'["PIN","e1",1,2,0,0,10,0,null,0,0]',
	'["LINESTYLE","st1",null,null,null,null]',
	'["POLY","e2",[10,5,30,5,40,0,30,-5,10,-5,10,5],true,"st1",0]',
].join('\n');

const EPS = 1e-9;
function approxEq(a: number, b: number): boolean { return Math.abs(a - b) < EPS; }

test('shapeFromSymbolSource extracts polygons + bounding box from .esym', () => {
	const shape = shapeFromSymbolSource(GND_SOURCE);
	assert.ok(shape.polygons.length >= 2, 'should extract pin + bars');
	// PIN stub from (0,0) angle 270 length 10 → stub at (0,-10)
	const pinPoly = shape.polygons.find((p) => p.source === 'PIN');
	assert.ok(pinPoly);
	const [sx, sy, ex, ey] = pinPoly!.points;
	assert.ok(approxEq(sx, 0) && approxEq(sy, 0), `stub start at origin, got (${sx},${sy})`);
	assert.ok(approxEq(ex, 0) && approxEq(ey, -10), `stub end at (0,-10), got (${ex},${ey})`);
	// Bar POLY at y=-10 between x=-10 and x=10
	const barPoly = shape.polygons.find((p) => p.source === 'POLY' && p.points[3] === -10);
	assert.ok(barPoly);
	assert.deepEqual(barPoly!.points, [-10, -10, 10, -10]);
	// Bounding box covers pin + bars
	assert.ok(approxEq(shape.bbox.minY, -19));
	assert.ok(approxEq(shape.bbox.maxY, 0));
});

test('transformShape: rotation=90 maps (0,-10) → (10,0) in +Y=up world', () => {
	const shape = shapeFromSymbolSource(GND_SOURCE);
	const transformed = transformShape(shape, { x: 0, y: 0, rotation: 90, flip: 0 });
	// PIN stub end: original (0,-10) → rotated 90° CCW → (10, 0)
	const pinPoly = transformed.polygons.find((p) => p.source === 'PIN');
	assert.ok(pinPoly);
	assert.ok(approxEq(pinPoly!.points[2], 10));
	assert.ok(approxEq(pinPoly!.points[3], 0));
});

test('transformShape: rotation=180 flips arrow tip left', () => {
	const shape = shapeFromSymbolSource(NETPORT_OUT_SOURCE);
	const transformed = transformShape(shape, { x: 0, y: 0, rotation: 180, flip: 0 });
	// Arrow tip in original is at (40,0); after 180° rotation → (-40, 0)
	const arrow = transformed.polygons.find((p) => p.source === 'POLY' && p.closed);
	assert.ok(arrow);
	const xs: number[] = [];
	for (let i = 0; i < arrow!.points.length; i += 2) xs.push(Math.round(arrow!.points[i]));
	assert.equal(Math.min(...xs), -40, 'tip should be at x=-40 after 180° rotation');
});

test('transformShape: flip=1 at rotation=0 mirrors arrow left about the pin', () => {
	const shape = shapeFromSymbolSource(NETPORT_OUT_SOURCE);
	const transformed = transformShape(shape, { x: 0, y: 0, rotation: 0, flip: 1 });
	// Original arrow tip at (40, 0) → mirrored about Y → (-40, 0)
	const arrow = transformed.polygons.find((p) => p.source === 'POLY' && p.closed);
	assert.ok(arrow);
	const xs: number[] = [];
	for (let i = 0; i < arrow!.points.length; i += 2) xs.push(Math.round(arrow!.points[i]));
	assert.equal(Math.min(...xs), -40);
});

test('transformShape: translation shifts the bbox as expected', () => {
	const shape = shapeFromSymbolSource(GND_SOURCE);
	const transformed = transformShape(shape, { x: 100, y: 200, rotation: 0, flip: 0 });
	assert.equal(transformed.bbox.minX, 100 + shape.bbox.minX);
	assert.equal(transformed.bbox.maxX, 100 + shape.bbox.maxX);
	assert.equal(transformed.bbox.minY, 200 + shape.bbox.minY);
	assert.equal(transformed.bbox.maxY, 200 + shape.bbox.maxY);
});

test('shapesOverlap: two netports placed far apart do NOT overlap', () => {
	const a = transformShape(shapeFromSymbolSource(NETPORT_OUT_SOURCE), { x: 0, y: 0, rotation: 0, flip: 0 });
	const b = transformShape(shapeFromSymbolSource(NETPORT_OUT_SOURCE), { x: 500, y: 0, rotation: 0, flip: 0 });
	assert.equal(shapesOverlap(a, b), false);
	assert.equal(boundingBoxesOverlap(a.bbox, b.bbox), false);
});

test('shapesOverlap: two netports stacked directly on top of each other DO overlap', () => {
	const a = transformShape(shapeFromSymbolSource(NETPORT_OUT_SOURCE), { x: 0, y: 0, rotation: 0, flip: 0 });
	const b = transformShape(shapeFromSymbolSource(NETPORT_OUT_SOURCE), { x: 20, y: 0, rotation: 0, flip: 0 });
	assert.equal(shapesOverlap(a, b), true);
});

test('polygonContainsPoint: inside vs outside a closed polygon', () => {
	const shape = shapeFromSymbolSource(NETPORT_OUT_SOURCE);
	const arrow = shape.polygons.find((p) => p.source === 'POLY' && p.closed);
	assert.ok(arrow);
	// (25, 0) is inside the arrow body
	assert.equal(polygonContainsPoint(arrow!, 25, 0), true);
	// (100, 100) is far outside
	assert.equal(polygonContainsPoint(arrow!, 100, 100), false);
	// Open polylines always return false
	const openPoly = shape.polygons.find((p) => !p.closed);
	if (openPoly) {
		assert.equal(polygonContainsPoint(openPoly, 0, 0), false);
	}
});
