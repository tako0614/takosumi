/**
 * Which installed apps use each connection, for the 接続 page.
 *
 * Derived from the caller's owner apps and each app's ProviderBinding set
 * (`GET /api/v1/capsules/:id/provider-bindings`). The control plane keeps
 * binding sets per app and has no owner-wide binding index, so this is a
 * bounded client fan-out: reads run a few at a time, and an app whose bindings
 * cannot be read makes the result incomplete rather than silently "unused".
 * Legacy workspace app listing is used only when `/api/v1/apps` is absent.
 */
import {
  type Capsule,
  listAccessibleApps,
  getCapsuleProviderBindingSet,
  listCapsules,
} from "./control-api.ts";
import type { AccessibleApp } from "./control-api.ts";

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
  readonly listAccessibleApps?: typeof listAccessibleApps;
  readonly listCapsules: (workspaceId: string) => Promise<readonly Capsule[]>;
  readonly getBindingSet: typeof getCapsuleProviderBindingSet;
};

const DEFAULT_DEPS: Deps = {
  listAccessibleApps,
  listCapsules: (workspaceId) =>
    listCapsules(workspaceId, { includeDestroyed: false }),
  getBindingSet: getCapsuleProviderBindingSet,
};

function appName(capsule: Capsule): string {
  return capsule.name?.trim() || capsule.slug || capsule.id;
}

export async function loadConnectionUsage(
  workspaceId?: string,
  deps: Deps = DEFAULT_DEPS,
): Promise<ConnectionUsage> {
  const accessibleApps = deps.listAccessibleApps
    ? await deps.listAccessibleApps()
    : undefined;
  let capsules: readonly Capsule[];
  let ownerApps: readonly ConnectionAppRef[];
  if (accessibleApps === undefined) {
    // A missing apps route is safe to bridge only if a known legacy workspace
    // is available. Without one, usage is unknown rather than empty.
    if (!workspaceId) return { appsByConnection: new Map(), incomplete: true };
    capsules = (await deps.listCapsules(workspaceId)).filter(
      (capsule) => capsule.status !== "destroyed",
    );
    ownerApps = capsules.map((capsule) => ({
      capsuleId: capsule.id,
      name: appName(capsule),
    }));
  } else {
    // Members do not receive the owner's connection inventory; never include
    // their apps in the connection-impact read either.
    ownerApps = accessibleApps
      .filter((app) => app.role === "owner")
      .map(accessibleAppRef);
  }
  const inspected = ownerApps.slice(0, CONNECTION_USAGE_APP_LIMIT);
  let incomplete = inspected.length < ownerApps.length;
  const apps = new Map<string, ConnectionAppRef[]>();
  let next = 0;
  const worker = async () => {
    while (next < inspected.length) {
      const app = inspected[next++]!;
      try {
        const set = await deps.getBindingSet(app.capsuleId);
        const seen = new Set<string>();
        for (const binding of set?.bindings ?? []) {
          if (!binding.connectionId || seen.has(binding.connectionId)) continue;
          seen.add(binding.connectionId);
          const list = apps.get(binding.connectionId) ?? [];
          list.push(app);
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

function accessibleAppRef(app: AccessibleApp): ConnectionAppRef {
  return {
    capsuleId: app.capsuleId,
    name: app.name.trim() || app.capsuleId,
  };
}
