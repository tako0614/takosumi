import type { JsonObject } from "./types.ts";

export interface ShapeValidationIssue {
  readonly path: string;
  readonly message: string;
}

export interface Shape<
  Spec = JsonObject,
  Outputs = JsonObject,
  Capability extends string = string,
> {
  readonly id: string;
  readonly version: string;
  readonly description?: string;
  readonly capabilities: readonly Capability[];
  readonly outputFields: readonly string[];
  validateSpec(value: unknown, issues: ShapeValidationIssue[]): void;
  validateOutputs(value: unknown, issues: ShapeValidationIssue[]): void;
}

export function parseShapeRef(
  ref: string,
): { readonly id: string; readonly version: string } | undefined {
  const at = ref.indexOf("@");
  if (at <= 0 || at === ref.length - 1) return undefined;
  const id = ref.slice(0, at);
  const version = ref.slice(at + 1);
  if (id.length === 0 || version.length === 0) return undefined;
  return { id, version };
}

export function formatShapeRef(id: string, version: string): string {
  return `${id}@${version}`;
}

const SHAPE_REGISTRY = new Map<string, Shape>();

function shapeKey(id: string, version: string): string {
  return formatShapeRef(id, version);
}

export function registerShape(shape: Shape): Shape | undefined {
  const key = shapeKey(shape.id, shape.version);
  const previous = SHAPE_REGISTRY.get(key);
  SHAPE_REGISTRY.set(key, shape);
  return previous;
}

export function unregisterShape(id: string, version: string): boolean {
  return SHAPE_REGISTRY.delete(shapeKey(id, version));
}

export function getShape(id: string, version: string): Shape | undefined {
  return SHAPE_REGISTRY.get(shapeKey(id, version));
}

export function getShapeByRef(ref: string): Shape | undefined {
  const parsed = parseShapeRef(ref);
  if (!parsed) return undefined;
  return getShape(parsed.id, parsed.version);
}

export function listShapes(): readonly Shape[] {
  return Array.from(SHAPE_REGISTRY.values());
}

export function isShapeRegistered(id: string, version: string): boolean {
  return SHAPE_REGISTRY.has(shapeKey(id, version));
}
