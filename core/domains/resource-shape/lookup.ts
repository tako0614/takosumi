/**
 * Canonical-id read helper.
 *
 * Composition code holds a canonical Resource id and needs the record behind
 * it. Splitting that id is Resource-Shape vocabulary, so it stays inside this
 * domain instead of leaking the shape namespace into source-and-run code.
 */
import type { ResourceObject } from "takosumi-contract";
import { parseResourceShapeId, type ResourceShapeRecordId } from "./records.ts";
import type { ResourceShapeService } from "./service.ts";

/**
 * Reads the Resource a canonical id names. A malformed id or a missing record
 * both return undefined: a caller never gets a partially resolved answer.
 */
export async function getResourceByCanonicalId(
  service: ResourceShapeService,
  id: ResourceShapeRecordId,
): Promise<ResourceObject | undefined> {
  const parsed = parseResourceShapeId(id);
  if (!parsed) return undefined;
  const result = await service.get(parsed.spaceId, parsed.kind, parsed.name);
  return result.ok ? result.value : undefined;
}
