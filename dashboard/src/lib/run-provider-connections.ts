import {
  listProviderConnectionsWithSignal,
  listReleaseOwnedProviderConnectionsWithSignal,
  type ProviderConnection,
  type ProviderResolution,
} from "./control-api.ts";

export type ProviderConnectionLoader = (
  workspaceId: string,
  signal?: AbortSignal,
) => Promise<readonly ProviderConnection[]>;

export interface RunProviderConnectionLoaders {
  readonly releaseOwned: ProviderConnectionLoader;
  readonly workspace: ProviderConnectionLoader;
}

export interface RunProviderConnectionRequestLoader {
  load(
    workspaceId: string,
    referencedConnectionIds: readonly string[],
  ): Promise<readonly ProviderConnection[]>;
  abort(): void;
}

const defaultLoaders: RunProviderConnectionLoaders = {
  releaseOwned: listReleaseOwnedProviderConnectionsWithSignal,
  workspace: listProviderConnectionsWithSignal,
};

/**
 * Returns the exact ProviderConnection ids named by a Run's public resolution
 * evidence. A resolution's explicit id is authoritative; the evidence id is
 * only a compatibility fallback for projections that omit that field.
 */
export function providerConnectionIdsFromResolutions(
  resolutions: readonly ProviderResolution[] | undefined,
): readonly string[] {
  const ids = new Set<string>();
  for (const resolution of resolutions ?? []) {
    const id =
      resolution.connectionId ??
      (resolution.evidence.kind === "provider_connection"
        ? resolution.evidence.connectionId
        : undefined);
    if (typeof id === "string" && id.length > 0) ids.add(id);
  }
  return [...ids];
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw (
    signal.reason ?? new DOMException("The operation was aborted", "AbortError")
  );
}

/**
 * Resolve only the ProviderConnections referenced by one Run.
 *
 * Release-owned capacity is the fast path. The durable Workspace list is
 * consulted only when an exact referenced id is absent from that projection;
 * release-owned rows are applied last so the release projection remains the
 * authority if both sources contain the same id. Loader failures intentionally
 * reject so the caller can preserve the Run's raw resolution evidence while
 * surfacing a retryable read error.
 */
export async function loadRunProviderConnections(
  workspaceId: string,
  referencedConnectionIds: readonly string[],
  signal?: AbortSignal,
  loaders: RunProviderConnectionLoaders = defaultLoaders,
): Promise<readonly ProviderConnection[]> {
  if (typeof workspaceId !== "string" || workspaceId.trim().length === 0) {
    return [];
  }

  const referencedIds = new Set(
    referencedConnectionIds.filter(
      (id): id is string => typeof id === "string" && id.length > 0,
    ),
  );
  if (referencedIds.size === 0) return [];

  throwIfAborted(signal);
  const releaseOwned = await loaders.releaseOwned(workspaceId, signal);
  throwIfAborted(signal);
  const releaseById = new Map<string, ProviderConnection>();
  for (const connection of releaseOwned) {
    if (referencedIds.has(connection.id)) {
      releaseById.set(connection.id, connection);
    }
  }

  if ([...referencedIds].every((id) => releaseById.has(id))) {
    return [...releaseById.values()];
  }

  throwIfAborted(signal);
  const workspaceConnections = await loaders.workspace(workspaceId, signal);
  throwIfAborted(signal);
  const merged = new Map<string, ProviderConnection>();
  for (const connection of workspaceConnections) {
    if (referencedIds.has(connection.id)) merged.set(connection.id, connection);
  }
  for (const connection of releaseById.values()) {
    merged.set(connection.id, connection);
  }
  return [...merged.values()];
}

/**
 * Owns the AbortController for one RunView's current provider read. Solid's
 * createResource fetcher does not expose a signal, so the view uses this
 * wrapper to abort the previous source/refetch before starting another one and
 * to abort the active request on component cleanup.
 */
export function createRunProviderConnectionRequestLoader(
  loaders: RunProviderConnectionLoaders = defaultLoaders,
): RunProviderConnectionRequestLoader {
  let activeController: AbortController | undefined;

  return {
    load(workspaceId, referencedConnectionIds) {
      activeController?.abort();
      const controller = new AbortController();
      activeController = controller;
      return loadRunProviderConnections(
        workspaceId,
        referencedConnectionIds,
        controller.signal,
        loaders,
      ).finally(() => {
        if (activeController === controller) activeController = undefined;
      });
    },
    abort() {
      activeController?.abort();
      activeController = undefined;
    },
  };
}
