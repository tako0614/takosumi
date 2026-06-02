import type {
  EventSubscriptionRevision,
  EventSubscriptionRevisionId,
  EventSubscriptionRevisionQuery,
  GroupId,
  SpaceId,
} from "./types.ts";

export interface EventSubscriptionRevisionStore {
  put(revision: EventSubscriptionRevision): Promise<EventSubscriptionRevision>;
  get(
    id: EventSubscriptionRevisionId,
  ): Promise<EventSubscriptionRevision | undefined>;
  latestForGroup(
    spaceId: SpaceId,
    groupId: GroupId,
  ): Promise<EventSubscriptionRevision | undefined>;
  list(
    query?: EventSubscriptionRevisionQuery,
  ): Promise<readonly EventSubscriptionRevision[]>;
}

export class InMemoryEventSubscriptionRevisionStore
  implements EventSubscriptionRevisionStore {
  readonly #revisions = new Map<
    EventSubscriptionRevisionId,
    EventSubscriptionRevision
  >();

  put(revision: EventSubscriptionRevision): Promise<EventSubscriptionRevision> {
    const frozen = deepFreeze(structuredClone(revision));
    this.#revisions.set(frozen.id, frozen);
    return Promise.resolve(frozen);
  }

  get(
    id: EventSubscriptionRevisionId,
  ): Promise<EventSubscriptionRevision | undefined> {
    return Promise.resolve(this.#revisions.get(id));
  }

  latestForGroup(
    spaceId: SpaceId,
    groupId: GroupId,
  ): Promise<EventSubscriptionRevision | undefined> {
    const matches = [...this.#revisions.values()]
      .filter((revision) =>
        revision.spaceId === spaceId && revision.groupId === groupId
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return Promise.resolve(matches[0]);
  }

  list(
    query: EventSubscriptionRevisionQuery = {},
  ): Promise<readonly EventSubscriptionRevision[]> {
    return Promise.resolve(
      [...this.#revisions.values()].filter((revision) =>
        matchesRevision(revision, query)
      ),
    );
  }
}

function matchesRevision(
  revision: EventSubscriptionRevision,
  query: EventSubscriptionRevisionQuery,
): boolean {
  if (query.spaceId && revision.spaceId !== query.spaceId) return false;
  if (query.groupId && revision.groupId !== query.groupId) return false;
  if (query.activationId && revision.activationId !== query.activationId) {
    return false;
  }
  if (query.appReleaseId && revision.appReleaseId !== query.appReleaseId) {
    return false;
  }
  return true;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) {
      deepFreeze(nested);
    }
  }
  return value;
}
