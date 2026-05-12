import { storage } from "takosumi-contract";
import { conflict, freezeClone, ok } from "./common.ts";

export type SelfHostedSqlPrimitive = string | number | boolean | null;
export type SelfHostedSqlJson =
  | SelfHostedSqlPrimitive
  | { readonly [key: string]: SelfHostedSqlJson }
  | readonly SelfHostedSqlJson[];
export type SelfHostedSqlValue =
  | SelfHostedSqlPrimitive
  | SelfHostedSqlJson
  | Date;
export type SelfHostedSqlParameters =
  | Readonly<Record<string, SelfHostedSqlValue | undefined>>
  | readonly (SelfHostedSqlValue | undefined)[];

export interface SelfHostedSqlQueryResult<
  Row extends Record<string, unknown> = Record<string, unknown>,
> {
  readonly rows: readonly Row[];
  readonly rowCount: number;
}

export interface SelfHostedSqlClient {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    parameters?: SelfHostedSqlParameters,
  ): Promise<SelfHostedSqlQueryResult<Row>>;
  transaction?<T>(
    fn: (transaction: SelfHostedSqlTransaction) => T | Promise<T>,
  ): Promise<T>;
}

export interface SelfHostedSqlTransaction extends SelfHostedSqlClient {
  commit?(): Promise<void>;
  rollback?(): Promise<void>;
}

export interface SelfHostedSqlStorageDriverOptions {
  readonly client: SelfHostedSqlClient;
  readonly clock?: () => Date;
  readonly providerSupportReports?: readonly Record<string, unknown>[];
}

export class SelfHostedSqlStorageDriver implements storage.StorageDriver {
  readonly statements = storage.storageStatementCatalog;
  readonly #client: SelfHostedSqlClient;
  readonly #clock: () => Date;
  readonly #providerSupportReports: readonly Record<string, unknown>[];

  constructor(options: SelfHostedSqlStorageDriverOptions) {
    this.#client = options.client;
    this.#clock = options.clock ?? (() => new Date());
    this.#providerSupportReports = options.providerSupportReports ?? [];
  }

  async initialize(): Promise<void> {
    await createDocumentStore(this.#client, this.#clock).ensureSchema();
  }

  async transaction<T>(
    fn: (transaction: storage.StorageTransaction) => T | Promise<T>,
  ): Promise<T> {
    if (this.#client.transaction) {
      return await this.#client.transaction(async (transaction) => {
        const documents = createDocumentStore(transaction, this.#clock);
        await documents.ensureSchema();
        return await fn(
          new SelfHostedSqlStorageTransaction(
            documents,
            this.#providerSupportReports,
            this.#clock,
          ),
        );
      });
    }

    await this.#client.query("begin");
    try {
      const documents = createDocumentStore(this.#client, this.#clock);
      await documents.ensureSchema();
      const result = await fn(
        new SelfHostedSqlStorageTransaction(
          documents,
          this.#providerSupportReports,
          this.#clock,
        ),
      );
      await this.#client.query("commit");
      return result;
    } catch (error) {
      await this.#client.query("rollback");
      throw error;
    }
  }
}

class SelfHostedSqlStorageTransaction implements storage.StorageTransaction {
  readonly core: storage.CoreStorageStores;
  readonly deploy: storage.DeployStorageStores;
  readonly runtime: storage.RuntimeStorageStores;
  readonly resources: storage.ResourceStorageStores;
  readonly registry: storage.RegistryStorageStores;
  readonly audit: storage.AuditStorageStores;
  readonly usage: storage.UsageStorageStores;
  readonly serviceEndpoints: storage.ServiceEndpointStorageStores;

  constructor(
    documents: SelfHostedDocumentStore,
    providerSupportReports: readonly Record<string, unknown>[],
    private readonly clock: () => Date,
  ) {
    const descriptors = new JsonCollectionStore(
      documents,
      "registry_descriptors",
    );
    const resolutions = new JsonCollectionStore(
      documents,
      "registry_resolutions",
    );
    const trustRecords = new JsonCollectionStore(
      documents,
      "registry_trust_records",
    );

    this.core = {
      spaces: {
        create: async (space: { readonly id: string }) => {
          const existing = await documents.get("core_spaces", space.id);
          if (existing) {
            return conflict("space already exists", { spaceId: space.id });
          }
          await documents.put("core_spaces", space.id, space);
          return ok(freezeClone(space));
        },
        get: (spaceId: string) => documents.get("core_spaces", spaceId),
        list: () => documents.list("core_spaces"),
      } satisfies storage.CoreStorageStores["spaces"],
      groups: {
        create: async (
          group: {
            readonly id: string;
            readonly spaceId: string;
            readonly slug: string;
          },
        ) => {
          if (await documents.get("core_groups", group.id)) {
            return conflict("group already exists", { groupId: group.id });
          }
          const sameSlug =
            (await documents.list<Record<string, unknown>>("core_groups"))
              .find((item) =>
                item.spaceId === group.spaceId && item.slug === group.slug
              );
          if (sameSlug) {
            return conflict("group slug already exists", {
              spaceId: group.spaceId,
              slug: group.slug,
            });
          }
          await documents.put("core_groups", group.id, group);
          return ok(freezeClone(group));
        },
        get: (groupId: string) => documents.get("core_groups", groupId),
        findBySlug: async (spaceId: unknown, slug: unknown) =>
          (await documents.list<Record<string, unknown>>("core_groups"))
            .find((group) =>
              group.spaceId === spaceId && group.slug === slug
            ) as never,
        listBySpace: async (spaceId: unknown) =>
          (await documents.list<Record<string, unknown>>("core_groups"))
            .filter((group) => group.spaceId === spaceId) as never,
      } satisfies storage.CoreStorageStores["groups"],
      spaceMemberships: {
        upsert: async (
          membership: { readonly spaceId: string; readonly accountId: string },
        ) => {
          await documents.put(
            "core_space_memberships",
            `${membership.spaceId}:${membership.accountId}`,
            membership,
          );
          return freezeClone(membership);
        },
        get: (spaceId: string, accountId: string) =>
          documents.get("core_space_memberships", `${spaceId}:${accountId}`),
        listBySpace: async (spaceId: unknown) =>
          (await documents.list<Record<string, unknown>>(
            "core_space_memberships",
          ))
            .filter((membership) => membership.spaceId === spaceId) as never,
      } satisfies storage.CoreStorageStores["spaceMemberships"],
    };

    this.deploy = {
      deploys: {
        getDeployPlan: (id: string) => documents.get("deploy_plans", id),
        createDeployPlan: async (plan: { readonly id: string }) => {
          await putNew(documents, "deploy_plans", plan.id, plan, "deploy plan");
          return freezeClone(plan);
        },
        getActivationRecord: (id: string) =>
          documents.get("deploy_activation_records", id),
        createActivationRecord: async (record: { readonly id: string }) => {
          await putNew(
            documents,
            "deploy_activation_records",
            record.id,
            record,
            "activation record",
          );
          return freezeClone(record);
        },
        getGroupActivationPointer: (spaceId: string, groupId: string) =>
          documents.get(
            "deploy_group_activation_pointers",
            `${spaceId}:${groupId}`,
          ),
        advanceGroupActivationPointer: async (
          input: {
            readonly spaceId: string;
            readonly groupId: string;
            readonly activationId: string;
            readonly advancedAt?: string;
            readonly expectedCurrentActivationRecordId?: string;
            readonly expectedGeneration?: number;
          },
        ) => {
          if (
            !(await documents.get(
              "deploy_activation_records",
              input.activationId,
            ))
          ) {
            throw new Error(`unknown activation record: ${input.activationId}`);
          }
          const current = await documents.get<{
            readonly currentActivationRecordId?: string;
            readonly generation?: number;
          }>(
            "deploy_group_activation_pointers",
            `${input.spaceId}:${input.groupId}`,
          );
          if (
            "expectedCurrentActivationRecordId" in input &&
            current?.currentActivationRecordId !==
              input.expectedCurrentActivationRecordId
          ) {
            throw new Error(
              `stale group activation pointer: expected activation ${
                input.expectedCurrentActivationRecordId ?? "<none>"
              } but found ${current?.currentActivationRecordId ?? "<none>"}`,
            );
          }
          if (
            input.expectedGeneration !== undefined &&
            (current?.generation ?? 0) !== input.expectedGeneration
          ) {
            throw new Error(
              `stale group activation pointer: expected generation ${input.expectedGeneration} but found ${
                current?.generation ?? 0
              }`,
            );
          }
          const advancedAt = input.advancedAt ?? this.#now();
          const pointer = freezeClone({
            spaceId: input.spaceId,
            groupId: input.groupId,
            currentActivationRecordId: input.activationId,
            generation: (current?.generation ?? 0) + 1,
            updatedAt: advancedAt,
            activationId: input.activationId,
            advancedAt,
          });
          await documents.put(
            "deploy_group_activation_pointers",
            `${input.spaceId}:${input.groupId}`,
            pointer,
          );
          return pointer;
        },
        createOperationRecord: async (record: { readonly id: string }) => {
          await putNew(
            documents,
            "deploy_operation_records",
            record.id,
            record,
            "operation record",
          );
          return freezeClone(record);
        },
        updateOperationRecord: async (record: { readonly id: string }) => {
          if (!(await documents.get("deploy_operation_records", record.id))) {
            throw new Error(`unknown operation record: ${record.id}`);
          }
          await documents.put("deploy_operation_records", record.id, record);
          return freezeClone(record);
        },
      } satisfies storage.DeployStorageStores["deploys"],
    };

    this.runtime = {
      desiredStates: {
        put: async (state: { readonly id: string }) => {
          await documents.put("runtime_desired_states", state.id, state);
          return freezeClone(state);
        },
        get: (id: string) => documents.get("runtime_desired_states", id),
        findByActivation: async (
          spaceId: unknown,
          groupId: unknown,
          activationId: unknown,
        ) =>
          (await documents.list<Record<string, unknown>>(
            "runtime_desired_states",
          ))
            .find((state) =>
              state.spaceId === spaceId && state.groupId === groupId &&
              state.activationId === activationId
            ) as never,
        listByGroup: async (spaceId: unknown, groupId: unknown) =>
          (await documents.list<Record<string, unknown>>(
            "runtime_desired_states",
          ))
            .filter((state) =>
              state.spaceId === spaceId && state.groupId === groupId
            ) as never,
      } satisfies storage.RuntimeStorageStores["desiredStates"],
      observedStates: {
        record: async (snapshot: { readonly id: string }) => {
          await documents.put("runtime_observed_states", snapshot.id, snapshot);
          return freezeClone(snapshot);
        },
        get: (id: string) => documents.get("runtime_observed_states", id),
        latestForGroup: async (spaceId: unknown, groupId: unknown) =>
          (await documents.list<Record<string, unknown>>(
            "runtime_observed_states",
          ))
            .filter((snapshot) =>
              snapshot.spaceId === spaceId && snapshot.groupId === groupId
            )
            .sort((a, b) =>
              String(b.observedAt).localeCompare(String(a.observedAt))
            )[0] as never,
        listByGroup: async (spaceId: unknown, groupId: unknown) =>
          (await documents.list<Record<string, unknown>>(
            "runtime_observed_states",
          ))
            .filter((snapshot) =>
              snapshot.spaceId === spaceId && snapshot.groupId === groupId
            ) as never,
      } satisfies storage.RuntimeStorageStores["observedStates"],
      providerObservations: {
        record: async (observation: unknown) => {
          await documents.put(
            "runtime_provider_observations",
            providerObservationKey(observation),
            observation,
          );
          return freezeClone(observation);
        },
        latestForMaterialization: async (materializationId: unknown) =>
          (await documents.list<Record<string, unknown>>(
            "runtime_provider_observations",
          ))
            .filter((observation) =>
              observation.materializationId === materializationId
            )
            .sort((a, b) =>
              String(b.observedAt).localeCompare(String(a.observedAt))
            )[0] as never,
        listByMaterialization: async (materializationId: unknown) =>
          (await documents.list<Record<string, unknown>>(
            "runtime_provider_observations",
          ))
            .filter((observation) =>
              observation.materializationId === materializationId
            ) as never,
      } satisfies storage.RuntimeStorageStores["providerObservations"],
    };

    this.resources = {
      instances: jsonEntityStore(documents, "resource_instances", {
        listBySpace: "spaceId",
        listByGroup: "groupId",
      }) as never,
      bindings: {
        ...jsonEntityStore(documents, "resource_bindings", {
          listByGroup: "groupId",
          listByInstance: "instanceId",
        }),
        findByClaim: async (groupId: string, claimAddress: string) =>
          (await documents.list<Record<string, unknown>>("resource_bindings"))
            .find((binding) =>
              binding.groupId === groupId &&
              binding.claimAddress === claimAddress
            ) as never,
      } as never,
      bindingSetRevisions: jsonEntityStore(
        documents,
        "resource_binding_set_revisions",
        { listByGroup: "groupId" },
      ) as never,
      migrationLedger: {
        append: async (entry: { readonly id: string }) => {
          if (!(await documents.get("resource_migration_ledger", entry.id))) {
            await documents.put("resource_migration_ledger", entry.id, entry);
          }
          return freezeClone(entry);
        },
        get: (id: string) => documents.get("resource_migration_ledger", id),
        listByResource: async (instanceId: unknown) =>
          (await documents.list<Record<string, unknown>>(
            "resource_migration_ledger",
          ))
            .filter((entry) =>
              entry.resourceInstanceId === instanceId
            ) as never,
      } satisfies storage.ResourceStorageStores["migrationLedger"],
    };

    this.registry = {
      descriptors: {
        put: descriptors.put,
        get: (kind: string, ref: string, digest: string) =>
          descriptors.get(`${kind}:${ref}:${digest}`),
        listByRef: (kind: string, ref: string) =>
          descriptors.list((item) => item.kind === kind && item.ref === ref),
      } as never,
      resolutions: {
        record: resolutions.put,
        get: (kind: string, ref: string, digest: string) =>
          resolutions.get(`${kind}:${ref}:${digest}`),
        listByRef: (kind: string, ref: string) =>
          resolutions.list((item) => item.kind === kind && item.ref === ref),
      } as never,
      trustRecords: {
        put: trustRecords.put,
        get: trustRecords.get,
        findForPackage: async (kind: string, ref: string, digest: string) =>
          (await trustRecords.list((item) =>
            item.packageKind === kind && item.packageRef === ref &&
            item.packageDigest === digest
          ))[0] as never,
      } as never,
      bundledRegistry: {
        resolve: (async (kind: string, ref: string) => {
          const list = await resolutions.list((item) =>
            item.kind === kind && item.ref === ref
          );
          return list[list.length - 1] as never;
        }) as never,
        getDescriptor:
          ((kind: string, ref: string, digest: string) =>
            descriptors.get(`${kind}:${ref}:${digest}`)) as never,
        getTrustRecord: trustRecords.get as never,
        listProviderSupport: () =>
          Promise.resolve(freezeClone(providerSupportReports)) as never,
      },
    };

    this.audit = {
      events: {
        append: async (event: { readonly id: string }) => {
          if (!(await documents.get("audit_events", event.id))) {
            await documents.put("audit_events", event.id, event);
          }
          return freezeClone(event);
        },
        get: (id: string) => documents.get("audit_events", id),
        list: async (query: unknown = {}) => {
          const events = await documents.list<Record<string, unknown>>(
            "audit_events",
          );
          return events.filter((event) =>
            matchesAuditQuery(event, query as Record<string, unknown>)
          ) as never;
        },
      } satisfies storage.AuditStorageStores["events"],
    };

    this.usage = {
      aggregates: ({
        recordEvent: async (
          event: {
            readonly quantity: number;
            readonly occurredAt: string;
          },
          projectedAt: unknown,
        ) => {
          const key = usageAggregateKeyForEvent(event);
          const id = encodeUsageAggregateId(key);
          const current = await documents.get<Record<string, unknown>>(
            "usage_aggregates",
            id,
          );
          const aggregate = freezeClone(
            current
              ? {
                ...current,
                quantity: Number(current.quantity) + Number(event.quantity),
                eventCount: Number(current.eventCount) + 1,
                firstOccurredAt: minIso(
                  String(current.firstOccurredAt),
                  event.occurredAt,
                ),
                lastOccurredAt: maxIso(
                  String(current.lastOccurredAt),
                  event.occurredAt,
                ),
                updatedAt: projectedAt,
              }
              : {
                ...key,
                id,
                quantity: event.quantity,
                eventCount: 1,
                firstOccurredAt: event.occurredAt,
                lastOccurredAt: event.occurredAt,
                updatedAt: projectedAt,
              },
          );
          await documents.put("usage_aggregates", id, aggregate);
          return aggregate as never;
        },
        get: (key: unknown) =>
          documents.get("usage_aggregates", encodeUsageAggregateId(key)),
        listBySpace: async (spaceId: unknown) =>
          (await documents.list<Record<string, unknown>>("usage_aggregates"))
            .filter((aggregate) => aggregate.spaceId === spaceId) as never,
      }) satisfies storage.UsageStorageStores["aggregates"],
    };

    this.serviceEndpoints = {
      endpoints: {
        ...jsonEntityStore(documents, "service_endpoints", {
          listByService: "serviceId",
        }),
        listByGroup: async (spaceId: string, groupId: string) =>
          (await documents.list<Record<string, unknown>>("service_endpoints"))
            .filter((endpoint) =>
              endpoint.spaceId === spaceId && endpoint.groupId === groupId
            ),
        updateHealth: async (
          id: string,
          update: Record<string, unknown>,
        ) => {
          const existing = await documents.get<Record<string, unknown>>(
            "service_endpoints",
            id,
          );
          if (!existing) return undefined;
          const updated = freezeClone({
            ...existing,
            health: {
              status: update.status,
              checkedAt: update.checkedAt,
              ...(update.message === undefined
                ? {}
                : { message: update.message }),
            },
            updatedAt: update.updatedAt ?? update.checkedAt,
          });
          await documents.put("service_endpoints", id, updated);
          return updated;
        },
      } as never,
      trustRecords: {
        ...jsonEntityStore(documents, "service_trust_records", {
          listByEndpoint: "endpointId",
        }),
        listActiveByEndpoint: async (endpointId: string, now?: string) =>
          (await documents.list<Record<string, unknown>>(
            "service_trust_records",
          )).filter((record) =>
            record.endpointId === endpointId && record.status === "active" &&
            (now === undefined || record.expiresAt === undefined ||
              String(record.expiresAt) > now)
          ),
        revoke: async (
          id: string,
          input: Record<string, unknown>,
        ) => {
          const existing = await documents.get<Record<string, unknown>>(
            "service_trust_records",
            id,
          );
          if (!existing) return undefined;
          if (existing.status === "revoked") return existing;
          const revoked = freezeClone({
            ...existing,
            status: "revoked",
            updatedAt: input.revokedAt,
            revokedAt: input.revokedAt,
            ...(input.revokedBy === undefined
              ? {}
              : { revokedBy: input.revokedBy }),
            ...(input.reason === undefined
              ? {}
              : { revokeReason: input.reason }),
          });
          await documents.put("service_trust_records", id, revoked);
          return revoked;
        },
      } as never,
      grants: jsonEntityStore(documents, "service_grants", {
        listByTrustRecord: "trustRecordId",
        listBySubject: "subject",
      }) as never,
    };
  }

  #now(): string {
    return this.clock().toISOString();
  }
}

export interface SelfHostedDocumentStore {
  ensureSchema(): Promise<void>;
  put<T>(collection: string, id: string, body: T): Promise<T>;
  get<T>(collection: string, id: string): Promise<T | undefined>;
  list<T>(collection: string): Promise<readonly T[]>;
  delete(collection: string, id: string): Promise<boolean>;
}

export function createDocumentStore(
  client: SelfHostedSqlClient,
  clock: () => Date = () => new Date(),
): SelfHostedDocumentStore {
  return new SqlDocumentStore(client, clock);
}

class SqlDocumentStore implements SelfHostedDocumentStore {
  #ready = false;

  constructor(
    private readonly client: SelfHostedSqlClient,
    private readonly clock: () => Date,
  ) {}

  async ensureSchema(): Promise<void> {
    if (this.#ready) return;
    await this.client.query(`
      create table if not exists takos_paas_documents (
        collection text not null,
        id text not null,
        body_json jsonb not null,
        created_at text not null,
        updated_at text not null,
        primary key (collection, id)
      )
    `);
    this.#ready = true;
  }

  async put<T>(collection: string, id: string, body: T): Promise<T> {
    await this.ensureSchema();
    const now = this.clock().toISOString();
    await this.client.query(
      `insert into takos_paas_documents
        (collection, id, body_json, created_at, updated_at)
       values (:collection, :id, :bodyJson, :now, :now)
       on conflict (collection, id) do update
       set body_json = excluded.body_json, updated_at = excluded.updated_at`,
      { collection, id, bodyJson: body as SelfHostedSqlValue, now },
    );
    return freezeClone(body);
  }

  async get<T>(collection: string, id: string): Promise<T | undefined> {
    await this.ensureSchema();
    const result = await this.client.query<
      { body_json?: unknown; bodyJson?: unknown }
    >(
      `select body_json from takos_paas_documents
       where collection = :collection and id = :id`,
      { collection, id },
    );
    const row = result.rows[0];
    const body = row?.body_json ?? row?.bodyJson;
    return body === undefined ? undefined : freezeClone(body as T);
  }

  async list<T>(collection: string): Promise<readonly T[]> {
    await this.ensureSchema();
    const result = await this.client.query<
      { body_json?: unknown; bodyJson?: unknown }
    >(
      `select body_json from takos_paas_documents
       where collection = :collection
       order by created_at asc, id asc`,
      { collection },
    );
    return result.rows.map((row) =>
      freezeClone((row.body_json ?? row.bodyJson) as T)
    );
  }

  async delete(collection: string, id: string): Promise<boolean> {
    await this.ensureSchema();
    const result = await this.client.query(
      `delete from takos_paas_documents
       where collection = :collection and id = :id`,
      { collection, id },
    );
    return result.rowCount > 0;
  }
}

class JsonCollectionStore {
  constructor(
    private readonly documents: SelfHostedDocumentStore,
    private readonly collection: string,
  ) {}

  put = async <T extends Record<string, unknown>>(value: T): Promise<T> => {
    const id = entityId(value);
    await this.documents.put(this.collection, id, value);
    return freezeClone(value);
  };

  get = async <T>(id: string): Promise<T | undefined> =>
    await this.documents.get<T>(this.collection, id);

  list = async <T extends Record<string, unknown>>(
    predicate: (value: T) => boolean,
  ): Promise<readonly T[]> =>
    (await this.documents.list<T>(this.collection)).filter(predicate);
}

function jsonEntityStore(
  documents: SelfHostedDocumentStore,
  collection: string,
  listIndexes: Record<string, string>,
): Record<string, unknown> {
  const store: Record<string, unknown> = {
    put: async (value: Record<string, unknown>) => {
      await documents.put(collection, String(value.id), value);
      return freezeClone(value);
    },
    create: async (value: Record<string, unknown>) => {
      const id = String(value.id);
      const existing = await documents.get(collection, id);
      if (!existing) await documents.put(collection, id, value);
      return freezeClone(value);
    },
    get: (id: string) => documents.get(collection, id),
    update: async (value: Record<string, unknown>) => {
      await documents.put(collection, String(value.id), value);
      return freezeClone(value);
    },
  };
  for (const [method, field] of Object.entries(listIndexes)) {
    store[method] = async (value: string) =>
      (await documents.list<Record<string, unknown>>(collection))
        .filter((item) => item[field] === value);
  }
  return store;
}

async function putNew<T>(
  documents: SelfHostedDocumentStore,
  collection: string,
  id: string,
  value: T,
  label: string,
): Promise<void> {
  if (await documents.get(collection, id)) {
    throw new Error(`${label} already exists: ${id}`);
  }
  await documents.put(collection, id, value);
}

function entityId(value: Record<string, unknown>): string {
  if (value.id) return String(value.id);
  return `${value.kind}:${value.ref}:${value.digest}`;
}

function providerObservationKey(observation: unknown): string {
  const record = observation as Record<string, unknown>;
  return [
    record.materializationId,
    record.observedAt,
    record.role,
    record.desiredObjectRef,
    record.objectAddress,
  ].map((item) => encodeURIComponent(String(item ?? ""))).join(":");
}

function usageAggregateKeyForEvent(event: unknown): Record<string, unknown> {
  const record = event as Record<string, unknown>;
  return {
    spaceId: record.spaceId,
    groupId: record.groupId,
    ownerKind: record.kind,
    metric: record.metric,
    unit: record.unit,
  };
}

function encodeUsageAggregateId(key: unknown): string {
  const record = key as Record<string, unknown>;
  return [
    record.spaceId,
    record.groupId ?? "-",
    record.ownerKind,
    record.metric,
    record.unit,
  ].map((item) => encodeURIComponent(String(item))).join(":");
}

function minIso(left: string, right: string): string {
  return left <= right ? left : right;
}

function maxIso(left: string, right: string): string {
  return left >= right ? left : right;
}

function matchesAuditQuery(
  event: Record<string, unknown>,
  query: Record<string, unknown>,
): boolean {
  if (query.spaceId && event.spaceId !== query.spaceId) return false;
  if (query.groupId && event.groupId !== query.groupId) return false;
  if (query.targetType && event.targetType !== query.targetType) return false;
  if (query.targetId && event.targetId !== query.targetId) return false;
  if (query.type && event.type !== query.type) return false;
  if (query.since && String(event.occurredAt) < String(query.since)) {
    return false;
  }
  if (query.until && String(event.occurredAt) > String(query.until)) {
    return false;
  }
  return true;
}
