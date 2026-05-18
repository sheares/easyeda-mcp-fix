export { parseSchematic, parseSymbol } from './schematic-reader';
export type { SchematicModel, ComponentInfo, PinInfo, WireInfo, NetInfo, SymbolInfo, ComponentPalette, ProjectJson } from './schematic-reader';
export { SchematicWriter } from './schematic-writer';
export { loadSchematic, listSchematics } from './loader';
export type { LoadedSchematic } from './loader';
export * as schema from './schema';
export {
	shapeFromSymbol,
	shapeFromSymbolSource,
	transformShape,
	computeBoundingBox,
	boundingBoxesOverlap,
	polygonContainsPoint,
	polygonsOverlap,
	shapesOverlap,
} from './geometry';
export type { Polygon, Shape, BoundingBox, InstanceTransform, SymbolShapeOptions } from './geometry';
export * as symbol from './symbol';
