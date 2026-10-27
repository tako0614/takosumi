/**
 * Hosted resources one app created, for the app page's "What it created".
 *
 * The host contribution lists a Workspace's hosted resources and names the app
 * only when it can prove the relation (`workloadId`). This reads that list in
 * bounded pages and keeps the rows that belong to the app. A deployment with
 * no native hosted-resource contribution has nothing to show, which is the
 * normal case for self-hosted Takosumi.
 */
import {
  type HostedResourceInventoryItem,
  listHostedResourceInventoryPage,
  loadHostedResourceContribution,
} from "./hosted-resources.ts";

/** Upper bound on pages read for one app page view. */
export const APP_HOSTED_RESOURCE_PAGE_LIMIT = 8;

export interface AppHostedResource {
  readonly key: string;
  readonly name: string;
  readonly kind: string;
  /** `true` Ready, `false` not ready, `undefined` the host has not said. */
  readonly ready?: boolean;
}

export async function listAppHostedResources(
  workspaceId: string,
  capsuleId: string,
): Promise<readonly AppHostedResource[]> {
  let href: string;
  try {
    href = (await loadHostedResourceContribution()).href;
  } catch {
    // No contribution (or an unreadable catalog): nothing hosted to show.
    return [];
  }
  const rows: HostedResourceInventoryItem[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < APP_HOSTED_RESOURCE_PAGE_LIMIT; page += 1) {
    const inventory = await listHostedResourceInventoryPage(href, workspaceId, cursor);
    rows.push(...inventory.items.filter((item) => item.workloadId === capsuleId));
    if (!inventory.nextCursor) break;
    cursor = inventory.nextCursor;
  }
  return rows.map((item) => {
    const ready = item.conditions.find((condition) => condition.type === "Ready");
    return {
      key: item.uid,
      name: item.name,
      kind: item.kind,
      ...(ready && ready.status !== "Unknown" ? { ready: ready.status === "True" } : {}),
    };
  });
}
