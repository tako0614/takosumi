/**
 * Which installed apps use each connection, for the 接続 page.
 *
 * Derived from the existing reads: the workspace's app list and each app's
 * ProviderBinding set (`GET /api/v1/capsules/:id/provider-bindings`). The
 * control plane keeps binding sets per app and has no workspace-wide binding
 * index, so this is a bounded client fan-out instead of a new endpoint: reads
 * run a few at a time, and an app whose bindings cannot be read makes the
 * result incomplete rather than silently "unused".
 */
import {
  type Capsule,
  getCapsuleProviderBindingSet,
  listCapsules,
} from "./control-api.ts";

export interface ConnectionAppRef {
  readonly capsuleId: string;
  readonly name: string;
}

export interface ConnectionUsage {
  /** connectionId → apps whose bindings name that connection. */
  readonly appsByConnection: ReadonlyMap<string, readonly ConnectionAppRef[]>;
  /** True when some app's bindings could not be read (or were not read). */
  readonly incomplete: boolean;
}

/** At most this many binding reads run at once. */
export const CONNECTION_USAGE_CONCURRENCY = 4;
/** Apps beyond this many are not inspected; the result says it is incomplete. */
export const CONNECTION_USAGE_APP_LIMIT = 200;

type Deps = {
  readonly listCapsules: (workspaceId: string) => Promise<readonly Capsule[]>;
  readonly getBindingSet: typeof getCapsuleProviderBindingSet;
};

const DEFAULT_DEPS: Deps = {
  listCapsules: (workspaceId) =>
    listCapsules(workspaceId, { includeDestroyed: false }),
  getBindingSet: getCapsuleProviderBindingSet,
};

function appName(capsule: Capsule): string {
  return capsule.name?.trim() || capsule.slug || capsule.id;
}

export async function loadConnectionUsage(
  workspaceId: string,
  deps: Deps = DEFAULT_DEPS,
): Promise<ConnectionUsage> {
  const capsules = (await deps.listCapsules(workspaceId)).filter(
    (capsule) => capsule.status !== "destroyed",
  );
  const inspected = capsules.slice(0, CONNECTION_USAGE_APP_LIMIT);
  let incomplete = inspected.length < capsules.length;
  const apps = new Map<string, ConnectionAppRef[]>();
  let next = 0;
  const worker = async () => {
    while (next < inspected.length) {
      const capsule = inspected[next++]!;
      try {
        const set = await deps.getBindingSet(capsule.id);
        const seen = new Set<string>();
        for (const binding of set?.bindings ?? []) {
          if (!binding.connectionId || seen.has(binding.connectionId)) continue;
          seen.add(binding.connectionId);
          const list = apps.get(binding.connectionId) ?? [];
          list.push({ capsuleId: capsule.id, name: appName(capsule) });
          apps.set(binding.connectionId, list);
        }
      } catch {
        incomplete = true;
      }
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(CONNECTION_USAGE_CONCURRENCY, inspected.length) },
      worker,
    ),
  );
  for (const list of apps.values()) {
    list.sort((a, b) => a.name.localeCompare(b.name));
  }
  return { appsByConnection: apps, incomplete };
}
