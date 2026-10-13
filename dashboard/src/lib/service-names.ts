/**
 * Service id → current name for the selected Workspace, for screens whose
 * records carry only the opaque Capsule id (history, hosted resources,
 * Interface recovery). Deleted services are included because those records
 * outlive them. A failed read yields an empty map: callers fall back to the
 * unnamed wording or the id, never to an error.
 */
import { type Accessor, createMemo, createResource } from "solid-js";
import { listCapsulesCached } from "./capsule-list.ts";
import { readyOrUndefined } from "./resource-read.ts";

export function createServiceNames(
  workspaceId: () => string | null | undefined,
): Accessor<ReadonlyMap<string, string>> {
  const [services] = createResource(
    () => workspaceId() || null,
    (id) => listCapsulesCached(id, { includeDestroyed: true }),
  );
  return createMemo(
    () =>
      new Map(
        (readyOrUndefined(services) ?? []).map(
          (service) => [service.id, service.name] as const,
        ),
      ),
  );
}
