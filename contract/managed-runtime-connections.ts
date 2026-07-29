export const TAKOSUMI_MANAGED_RUNTIME_CONNECTION_CONTRACT =
  "takosumi.managed-runtime-connection/v1" as const;
export const TAKOSUMI_MANAGED_RUNTIME_GATEWAY_BINDING =
  "TAKOSUMI_MANAGED_RUNTIME" as const;
export const TAKOSUMI_MANAGED_RUNTIME_INVOKE_PERMISSION =
  "takosumi.managed-runtime.invoke" as const;
export const TAKOSUMI_MANAGED_RUNTIME_CAPABILITY_REF_HEADER =
  "x-takosumi-managed-runtime-capability-ref" as const;
export const TAKOSUMI_MANAGED_RUNTIME_KV_EXPIRATION_HEADER =
  "x-takosumi-managed-runtime-kv-expiration" as const;
export const TAKOSUMI_MANAGED_RUNTIME_KV_EXPIRATION_TTL_HEADER =
  "x-takosumi-managed-runtime-kv-expiration-ttl" as const;
export const TAKOSUMI_MANAGED_RUNTIME_KV_METADATA_HEADER =
  "x-takosumi-managed-runtime-kv-metadata" as const;
export const TAKOSUMI_MANAGED_RUNTIME_OBJECT_METADATA_HEADER =
  "x-takosumi-object-custom-metadata" as const;

export type ManagedRuntimeResourceKind =
  | "ObjectBucket"
  | "KeyValueStore"
  | "RelationalDatabase"
  | "Queue"
  | "VectorIndex"
  | "DurableWorkflow"
  | "StatefulActorNamespace";

export interface ManagedRuntimeConnectionAuthority {
  readonly workspaceId: string;
  readonly subject: string;
  readonly resourceId: string;
  readonly resourceKind: ManagedRuntimeResourceKind;
  readonly resourceGeneration: number;
  readonly permissions: readonly string[];
  readonly interfaceId: string;
  readonly interfaceBindingId: string;
  readonly interfaceResolvedRevision: number;
  /** Exact OAuth resource/audience. It is the provider-neutral runtime base. */
  readonly audience: string;
  /** Opaque host secret reference. A bearer token is never serialized here. */
  readonly capabilityRef: string;
}

/**
 * Portable app-owned declaration. It selects only a canonical Resource and
 * required public permissions; all revision and credential material is added
 * by the selected host after authorization.
 */
export interface ManagedRuntimeConnectionDeclaration {
  readonly alias: string;
  readonly resourceId: string;
  readonly resourceKind: ManagedRuntimeResourceKind;
  readonly requiredPermissions: readonly string[];
}

export interface ManagedRuntimeConnection {
  /** App-owned logical name such as `media`, `queue`, or `cache`. */
  readonly alias: string;
  readonly authority: ManagedRuntimeConnectionAuthority;
}

/**
 * Host materialization extension for one Fetch-compatible gateway plus exact
 * logical connections.
 *
 * `ManagedRuntimeConnectionDeclaration` is the portable app input. Interface
 * and capability fields below are host-issued Takosumi authority, not an app
 * declaration and not a Cloud/provider binding.
 *
 * Provider bindings, native ids, account ids, and credential values are never
 * part of this materialization.
 */
export interface ManagedRuntimeConnectionMaterialization {
  readonly contract: typeof TAKOSUMI_MANAGED_RUNTIME_CONNECTION_CONTRACT;
  readonly gateway: {
    /** Host-selected environment/binding name; the constant is a default. */
    readonly binding: string;
    readonly transport: "fetch";
  };
  readonly connections: readonly ManagedRuntimeConnection[];
  readonly requirements?: readonly ManagedRuntimeRequirement[];
}

/**
 * Yurucommu's current Drizzle/D1 use cannot be represented by data.indexed.
 * This exact requirement participates in host negotiation so a deployment
 * fails before runtime when the selected host does not provide it.
 */
export interface ManagedRelationalSqliteRequirement {
  readonly kind: "relational.sqlite";
  readonly version: 1;
  readonly connectionAlias: string;
  readonly queryMode: "prepared_sql";
  readonly batchMode: "ordered_atomic";
  readonly migrationMode: "ordered_sql";
  readonly requiredFeatures: readonly (
    | "ddl"
    | "joins"
    | "grouping"
    | "transactions"
  )[];
  readonly requiredMeta: readonly (
    | "changes"
    | "last_row_id"
    | "changed_db"
    | "duration"
    | "size_after"
    | "rows_read"
    | "rows_written"
  )[];
  readonly schemaDigest: string;
  readonly migrationSetDigest: string;
}

export type ManagedRuntimeRequirement = ManagedRelationalSqliteRequirement;

export interface ManagedRuntimeHostCapabilities {
  readonly relationalSqlite?: {
    readonly queryMode: "prepared_sql";
    readonly batchMode: "ordered_atomic";
    readonly migrationMode: "ordered_sql";
    readonly features: readonly ManagedRelationalSqliteRequirement["requiredFeatures"][number][];
    readonly meta: readonly ManagedRelationalSqliteRequirement["requiredMeta"][number][];
  };
}

export interface ManagedRuntimeQueueMessage {
  readonly type: "text" | "json" | "bytes";
  /** `bytes` uses canonical padded base64. */
  readonly body: unknown;
}

export interface ManagedRuntimeQueueSendRequest {
  readonly message: ManagedRuntimeQueueMessage;
  readonly delaySeconds?: number;
}

export interface ManagedRuntimeQueueBatchSendRequest {
  readonly messages: readonly {
    readonly message: ManagedRuntimeQueueMessage;
    readonly delaySeconds?: number;
  }[];
  readonly defaultDelaySeconds?: number;
}

export interface ManagedRuntimeQueuePullRequest {
  readonly limit?: number;
  readonly visibilityTimeoutSeconds?: number;
}

export interface ManagedRuntimeQueueAckRequest {
  readonly leases: readonly string[];
}

export interface ManagedRuntimeQueueDelivery {
  readonly leaseId: string;
  readonly id: string;
  readonly message: ManagedRuntimeQueueMessage;
}

export interface ManagedRuntimeQueuePullResponse {
  readonly messages: readonly ManagedRuntimeQueueDelivery[];
}

export interface ManagedRuntimeQueueAckResponse {
  readonly acknowledged: number;
}

export interface ManagedRuntimeQueueSendResponse {
  readonly accepted: true;
  readonly messageId?: string;
}

export interface ManagedRuntimeKeyValuePutOptions {
  readonly expirationTtl?: number;
  readonly expiration?: number;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface ManagedRuntimeKeyValueListResponse {
  readonly keys: readonly {
    readonly name: string;
    readonly expiration?: number;
    readonly metadata?: unknown;
  }[];
  readonly cursor?: string;
}

export interface ManagedRuntimeObjectListResponse {
  readonly objects: readonly {
    readonly key: string;
    readonly size: number;
    readonly uploaded: string;
    readonly etag?: string;
  }[];
  readonly truncated: boolean;
  readonly cursor?: string;
  readonly delimitedPrefixes?: readonly string[];
}

export class ManagedRuntimeConnectionContractError extends TypeError {
  constructor(readonly code: string) {
    super(code);
    this.name = "ManagedRuntimeConnectionContractError";
  }
}

export function parseManagedRuntimeConnectionMaterialization(
  value: unknown,
): ManagedRuntimeConnectionMaterialization {
  const input = record(value, "materialization_invalid");
  onlyKeys(
    input,
    ["contract", "gateway", "connections", "requirements"],
    "materialization_invalid",
  );
  if (input.contract !== TAKOSUMI_MANAGED_RUNTIME_CONNECTION_CONTRACT) {
    throw invalid("materialization_contract_invalid");
  }
  const gateway = record(input.gateway, "gateway_invalid");
  onlyKeys(gateway, ["binding", "transport"], "gateway_invalid");
  if (
    !bindingName(gateway.binding) ||
    gateway.transport !== "fetch"
  ) {
    throw invalid("gateway_invalid");
  }
  if (!Array.isArray(input.connections) || input.connections.length > 64) {
    throw invalid("connections_invalid");
  }
  const aliases = new Set<string>();
  const capabilityRefs = new Set<string>();
  const connections = input.connections.map((entry) => {
    const row = record(entry, "connection_invalid");
    onlyKeys(row, ["alias", "authority"], "connection_invalid");
    const alias = aliasToken(row.alias, "connection_alias_invalid");
    if (aliases.has(alias)) throw invalid("connection_alias_duplicate");
    aliases.add(alias);
    const authority = parseAuthority(row.authority);
    if (capabilityRefs.has(authority.capabilityRef)) {
      throw invalid("connection_capability_ref_reused");
    }
    capabilityRefs.add(authority.capabilityRef);
    return { alias, authority };
  });
  const requirements =
    input.requirements === undefined
      ? undefined
      : parseRequirements(input.requirements, aliases);
  return {
    contract: TAKOSUMI_MANAGED_RUNTIME_CONNECTION_CONTRACT,
    gateway: {
      binding: gateway.binding,
      transport: "fetch",
    },
    connections,
    ...(requirements ? { requirements } : {}),
  };
}

export function assertManagedRuntimeRequirementsSupported(
  materialization: ManagedRuntimeConnectionMaterialization,
  capabilities: ManagedRuntimeHostCapabilities,
): void {
  for (const requirement of materialization.requirements ?? []) {
    const supported = capabilities.relationalSqlite;
    if (
      !supported ||
      supported.queryMode !== requirement.queryMode ||
      supported.batchMode !== requirement.batchMode ||
      supported.migrationMode !== requirement.migrationMode ||
      !containsEvery(supported.features, requirement.requiredFeatures) ||
      !containsEvery(supported.meta, requirement.requiredMeta)
    ) {
      throw invalid("relational_sqlite_requirement_unsupported");
    }
  }
}

export function managedRuntimeConnection(
  materialization: ManagedRuntimeConnectionMaterialization,
  alias: string,
  input: {
    readonly expectedKind: ManagedRuntimeResourceKind;
    readonly requiredPermission: string;
  },
): ManagedRuntimeConnection {
  const exactAlias = aliasToken(alias, "connection_alias_invalid");
  const matches = materialization.connections.filter(
    (entry) => entry.alias === exactAlias,
  );
  if (matches.length !== 1) throw invalid("connection_not_found");
  const connection = matches[0]!;
  if (
    connection.authority.resourceKind !== input.expectedKind ||
    !connection.authority.permissions.includes(
      token(input.requiredPermission, "permission_invalid"),
    )
  ) {
    throw invalid("connection_authority_mismatch");
  }
  return connection;
}

export function managedRuntimeResourceUrl(
  authority: ManagedRuntimeConnectionAuthority,
  suffix: string,
): URL {
  const base = exactAudience(authority.audience);
  if (!suffix.startsWith("/") || suffix.startsWith("//")) {
    throw invalid("runtime_suffix_invalid");
  }
  const url = new URL(base);
  url.pathname = `${url.pathname}/${encodeURIComponent(authority.resourceId)}${suffix}`;
  return url;
}

export function managedRuntimeGatewayRequest(
  authority: ManagedRuntimeConnectionAuthority,
  input: {
    readonly method: "GET" | "HEAD" | "POST" | "PUT" | "DELETE";
    readonly suffix: string;
    readonly idempotencyKey: string;
    readonly body?: unknown;
    readonly headers?: HeadersInit;
  },
): Request {
  const headers = new Headers(input.headers);
  headers.set(
    TAKOSUMI_MANAGED_RUNTIME_CAPABILITY_REF_HEADER,
    authority.capabilityRef,
  );
  headers.set("idempotency-key", idempotencyKeyOf(input.idempotencyKey));
  const body =
    input.body === undefined ? undefined : JSON.stringify(input.body);
  if (body !== undefined && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  return new Request(managedRuntimeResourceUrl(authority, input.suffix), {
    method: input.method,
    headers,
    ...(body === undefined ? {} : { body }),
  });
}

export function managedRuntimeKeyValueRequest(
  authority: ManagedRuntimeConnectionAuthority,
  input: {
    readonly method: "GET" | "PUT" | "DELETE";
    readonly key: string;
    readonly idempotencyKey: string;
    readonly value?: BodyInit;
    readonly options?: ManagedRuntimeKeyValuePutOptions;
  },
): Request {
  const key = runtimeKey(input.key, "kv_key_invalid", 512);
  const headers = capabilityHeaders(authority, input.idempotencyKey);
  if (input.method === "PUT") {
    if (input.value === undefined) throw invalid("kv_request_invalid");
    applyKeyValuePutHeaders(headers, input.options);
  } else if (input.value !== undefined || input.options !== undefined) {
    throw invalid("kv_request_invalid");
  }
  return new Request(
    managedRuntimeResourceUrl(
      authority,
      `/kv/keys/${encodeURIComponent(key)}`,
    ),
    {
      method: input.method,
      headers,
      ...(input.value === undefined ? {} : { body: input.value }),
    },
  );
}

export function managedRuntimeKeyValueListRequest(
  authority: ManagedRuntimeConnectionAuthority,
  input: {
    readonly idempotencyKey: string;
    readonly prefix?: string;
    readonly limit?: number;
    readonly cursor?: string;
  },
): Request {
  const url = managedRuntimeResourceUrl(authority, "/kv/keys");
  if (input.prefix !== undefined) {
    url.searchParams.set(
      "prefix",
      runtimeKey(input.prefix, "kv_list_request_invalid", 512, true),
    );
  }
  if (input.limit !== undefined) {
    url.searchParams.set(
      "limit",
      String(safeInteger(input.limit, 1, 1_000, "kv_list_request_invalid")),
    );
  }
  if (input.cursor !== undefined) {
    url.searchParams.set(
      "cursor",
      token(input.cursor, "kv_list_request_invalid", 4_096),
    );
  }
  return new Request(url, {
    method: "GET",
    headers: capabilityHeaders(authority, input.idempotencyKey),
  });
}

export function parseManagedRuntimeKeyValueListResponse(
  value: unknown,
): ManagedRuntimeKeyValueListResponse {
  const input = record(value, "kv_list_response_invalid");
  onlyKeys(input, ["keys", "cursor"], "kv_list_response_invalid");
  if (!Array.isArray(input.keys) || input.keys.length > 1_000) {
    throw invalid("kv_list_response_invalid");
  }
  return {
    keys: input.keys.map((value) => {
      const entry = record(value, "kv_list_response_invalid");
      onlyKeys(
        entry,
        ["name", "expiration", "metadata"],
        "kv_list_response_invalid",
      );
      return {
        name: runtimeKey(entry.name, "kv_list_response_invalid", 512),
        ...(entry.expiration === undefined
          ? {}
          : {
              expiration: safeInteger(
                entry.expiration,
                0,
                Number.MAX_SAFE_INTEGER,
                "kv_list_response_invalid",
              ),
            }),
        ...(entry.metadata === undefined ? {} : { metadata: entry.metadata }),
      };
    }),
    ...(input.cursor === undefined
      ? {}
      : { cursor: token(input.cursor, "kv_list_response_invalid", 4_096) }),
  };
}

export function managedRuntimeObjectRequest(
  authority: ManagedRuntimeConnectionAuthority,
  input: {
    readonly method: "GET" | "HEAD" | "PUT" | "DELETE";
    readonly key: string;
    readonly idempotencyKey: string;
    readonly value?: BodyInit;
    readonly httpMetadata?: Readonly<{
      readonly contentType?: string;
      readonly cacheControl?: string;
      readonly contentDisposition?: string;
      readonly contentEncoding?: string;
      readonly contentLanguage?: string;
    }>;
    readonly customMetadata?: Readonly<Record<string, string>>;
  },
): Request {
  const key = runtimeKey(input.key, "object_key_invalid", 1_024);
  const headers = capabilityHeaders(authority, input.idempotencyKey);
  if (input.method === "PUT") {
    if (input.value === undefined) throw invalid("object_request_invalid");
    applyObjectMetadataHeaders(
      headers,
      input.httpMetadata,
      input.customMetadata,
    );
  } else if (
    input.value !== undefined ||
    input.httpMetadata !== undefined ||
    input.customMetadata !== undefined
  ) {
    throw invalid("object_request_invalid");
  }
  return new Request(
    managedRuntimeResourceUrl(
      authority,
      `/objects/${encodeURIComponent(key)}`,
    ),
    {
      method: input.method,
      headers,
      ...(input.value === undefined ? {} : { body: input.value }),
    },
  );
}

export function managedRuntimeObjectListRequest(
  authority: ManagedRuntimeConnectionAuthority,
  input: {
    readonly idempotencyKey: string;
    readonly prefix?: string;
    readonly limit?: number;
    readonly cursor?: string;
    readonly delimiter?: string;
  },
): Request {
  const url = managedRuntimeResourceUrl(authority, "/objects");
  for (const [name, value] of [
    ["prefix", input.prefix],
    ["cursor", input.cursor],
    ["delimiter", input.delimiter],
  ] as const) {
    if (value !== undefined) {
      url.searchParams.set(
        name,
        runtimeKey(value, "object_list_request_invalid", 4_096, true),
      );
    }
  }
  if (input.limit !== undefined) {
    url.searchParams.set(
      "limit",
      String(
        safeInteger(input.limit, 1, 1_000, "object_list_request_invalid"),
      ),
    );
  }
  return new Request(url, {
    method: "GET",
    headers: capabilityHeaders(authority, input.idempotencyKey),
  });
}

export function parseManagedRuntimeObjectListResponse(
  value: unknown,
): ManagedRuntimeObjectListResponse {
  const input = record(value, "object_list_response_invalid");
  onlyKeys(
    input,
    ["objects", "truncated", "cursor", "delimitedPrefixes"],
    "object_list_response_invalid",
  );
  if (
    !Array.isArray(input.objects) ||
    input.objects.length > 1_000 ||
    typeof input.truncated !== "boolean"
  ) {
    throw invalid("object_list_response_invalid");
  }
  const objects = input.objects.map((value) => {
    const entry = record(value, "object_list_response_invalid");
    onlyKeys(
      entry,
      ["key", "size", "uploaded", "etag"],
      "object_list_response_invalid",
    );
    const uploaded = token(
      entry.uploaded,
      "object_list_response_invalid",
      128,
    );
    if (!Number.isFinite(Date.parse(uploaded))) {
      throw invalid("object_list_response_invalid");
    }
    return {
      key: runtimeKey(entry.key, "object_list_response_invalid", 1_024),
      size: safeInteger(
        entry.size,
        0,
        Number.MAX_SAFE_INTEGER,
        "object_list_response_invalid",
      ),
      uploaded,
      ...(entry.etag === undefined
        ? {}
        : { etag: token(entry.etag, "object_list_response_invalid", 512) }),
    };
  });
  let delimitedPrefixes: readonly string[] | undefined;
  if (input.delimitedPrefixes !== undefined) {
    if (
      !Array.isArray(input.delimitedPrefixes) ||
      input.delimitedPrefixes.length > 1_000
    ) {
      throw invalid("object_list_response_invalid");
    }
    delimitedPrefixes = input.delimitedPrefixes.map((value) =>
      runtimeKey(value, "object_list_response_invalid", 4_096, true),
    );
  }
  const cursor =
    input.cursor === undefined
      ? undefined
      : token(input.cursor, "object_list_response_invalid", 4_096);
  if (input.truncated && cursor === undefined) {
    throw invalid("object_list_response_invalid");
  }
  return {
    objects,
    truncated: input.truncated,
    ...(cursor === undefined ? {} : { cursor }),
    ...(delimitedPrefixes === undefined ? {} : { delimitedPrefixes }),
  };
}

export function managedRuntimeQueueSendGatewayRequest(
  authority: ManagedRuntimeConnectionAuthority,
  input: ManagedRuntimeQueueSendRequest,
  idempotencyKey: string,
): Request {
  return managedRuntimeGatewayRequest(authority, {
    method: "POST",
    suffix: "/queue/messages",
    idempotencyKey,
    body: parseManagedRuntimeQueueSendRequest(input),
  });
}

export function managedRuntimeQueueBatchSendGatewayRequest(
  authority: ManagedRuntimeConnectionAuthority,
  input: ManagedRuntimeQueueBatchSendRequest,
  idempotencyKey: string,
): Request {
  return managedRuntimeGatewayRequest(authority, {
    method: "POST",
    suffix: "/queue/messages/batch",
    idempotencyKey,
    body: parseManagedRuntimeQueueBatchSendRequest(input),
  });
}

export function parseManagedRuntimeQueueSendRequest(
  value: unknown,
): ManagedRuntimeQueueSendRequest {
  const input = record(value, "queue_send_request_invalid");
  onlyKeys(input, ["message", "delaySeconds"], "queue_send_request_invalid");
  return {
    message: queueMessage(input.message, "queue_send_request_invalid"),
    ...(input.delaySeconds === undefined
      ? {}
      : {
          delaySeconds: safeInteger(
            input.delaySeconds,
            0,
            43_200,
            "queue_send_request_invalid",
          ),
        }),
  };
}

export function parseManagedRuntimeQueueBatchSendRequest(
  value: unknown,
): ManagedRuntimeQueueBatchSendRequest {
  const input = record(value, "queue_batch_send_request_invalid");
  onlyKeys(
    input,
    ["messages", "defaultDelaySeconds"],
    "queue_batch_send_request_invalid",
  );
  if (
    !Array.isArray(input.messages) ||
    input.messages.length < 1 ||
    input.messages.length > 100
  ) {
    throw invalid("queue_batch_send_request_invalid");
  }
  const defaultDelaySeconds =
    input.defaultDelaySeconds === undefined
      ? undefined
      : safeInteger(
          input.defaultDelaySeconds,
          0,
          43_200,
          "queue_batch_send_request_invalid",
        );
  return {
    messages: input.messages.map((value) => {
      const row = record(value, "queue_batch_send_request_invalid");
      onlyKeys(
        row,
        ["message", "delaySeconds"],
        "queue_batch_send_request_invalid",
      );
      return {
        message: queueMessage(row.message, "queue_batch_send_request_invalid"),
        ...(row.delaySeconds === undefined
          ? {}
          : {
              delaySeconds: safeInteger(
                row.delaySeconds,
                0,
                43_200,
                "queue_batch_send_request_invalid",
              ),
            }),
      };
    }),
    ...(defaultDelaySeconds === undefined ? {} : { defaultDelaySeconds }),
  };
}

export function parseManagedRuntimeQueueSendResponse(
  value: unknown,
): ManagedRuntimeQueueSendResponse {
  const input = record(value, "queue_send_response_invalid");
  onlyKeys(input, ["accepted", "messageId"], "queue_send_response_invalid");
  if (
    input.accepted !== true ||
    (input.messageId !== undefined && typeof input.messageId !== "string")
  ) {
    throw invalid("queue_send_response_invalid");
  }
  return {
    accepted: true,
    ...(input.messageId === undefined ? {} : { messageId: input.messageId }),
  };
}

export interface ManagedRuntimeGatewayFailure {
  readonly code: string;
  readonly status: number;
  /**
   * Retry only with the same Idempotency-Key. 409 is explicit recovery work,
   * not an automatic replay.
   */
  readonly retryable: boolean;
}

export async function managedRuntimeGatewayFailure(
  response: Response,
): Promise<ManagedRuntimeGatewayFailure | undefined> {
  if (response.ok) return undefined;
  const body = await response
    .clone()
    .json()
    .catch(() => undefined);
  const code =
    body !== null &&
    typeof body === "object" &&
    !Array.isArray(body) &&
    typeof (body as Record<string, unknown>).error === "string"
      ? String((body as Record<string, unknown>).error)
      : "managed_runtime_request_failed";
  return {
    code,
    status: response.status,
    retryable: response.status === 429 || response.status >= 500,
  };
}

export function parseManagedRuntimeQueuePullRequest(
  value: unknown,
): ManagedRuntimeQueuePullRequest {
  const input = record(value, "queue_pull_request_invalid");
  onlyKeys(
    input,
    ["limit", "visibilityTimeoutSeconds"],
    "queue_pull_request_invalid",
  );
  return {
    ...(input.limit === undefined
      ? {}
      : {
          limit: safeInteger(
            input.limit,
            1,
            100,
            "queue_pull_request_invalid",
          ),
        }),
    ...(input.visibilityTimeoutSeconds === undefined
      ? {}
      : {
          visibilityTimeoutSeconds: safeInteger(
            input.visibilityTimeoutSeconds,
            1,
            43_200,
            "queue_pull_request_invalid",
          ),
        }),
  };
}

export function parseManagedRuntimeQueueAckRequest(
  value: unknown,
): ManagedRuntimeQueueAckRequest {
  const input = record(value, "queue_ack_request_invalid");
  onlyKeys(input, ["leases"], "queue_ack_request_invalid");
  if (
    !Array.isArray(input.leases) ||
    input.leases.length < 1 ||
    input.leases.length > 100
  ) {
    throw invalid("queue_ack_request_invalid");
  }
  const seen = new Set<string>();
  const leases = input.leases.map((value) => {
    const lease = token(value, "queue_ack_request_invalid", 4_096);
    if (seen.has(lease)) throw invalid("queue_ack_request_invalid");
    seen.add(lease);
    return lease;
  });
  return { leases };
}

export function parseManagedRuntimeQueuePullResponse(
  value: unknown,
): ManagedRuntimeQueuePullResponse {
  const input = record(value, "queue_pull_response_invalid");
  onlyKeys(input, ["messages"], "queue_pull_response_invalid");
  if (!Array.isArray(input.messages) || input.messages.length > 100) {
    throw invalid("queue_pull_response_invalid");
  }
  return {
    messages: input.messages.map((value) => {
      const row = record(value, "queue_pull_response_invalid");
      onlyKeys(
        row,
        ["leaseId", "id", "message"],
        "queue_pull_response_invalid",
      );
      return {
        leaseId: token(row.leaseId, "queue_pull_response_invalid", 4_096),
        id: token(row.id, "queue_pull_response_invalid", 512),
        message: queueMessage(row.message, "queue_pull_response_invalid"),
      };
    }),
  };
}

function parseAuthority(value: unknown): ManagedRuntimeConnectionAuthority {
  const input = record(value, "connection_authority_invalid");
  onlyKeys(
    input,
    [
      "workspaceId",
      "subject",
      "resourceId",
      "resourceKind",
      "resourceGeneration",
      "permissions",
      "interfaceId",
      "interfaceBindingId",
      "interfaceResolvedRevision",
      "audience",
      "capabilityRef",
    ],
    "connection_authority_invalid",
  );
  const workspaceId = token(input.workspaceId, "workspace_id_invalid");
  const resourceKind = resourceKindOf(input.resourceKind);
  const resourceId = token(input.resourceId, "resource_id_invalid");
  const expectedPrefix = `tkrn:${workspaceId}:${resourceKind}:`;
  if (
    !resourceId.startsWith(expectedPrefix) ||
    resourceId.length <= expectedPrefix.length ||
    resourceId.slice(expectedPrefix.length).includes(":")
  ) {
    throw invalid("resource_id_invalid");
  }
  if (
    !Array.isArray(input.permissions) ||
    input.permissions.length < 1 ||
    input.permissions.length > 16
  ) {
    throw invalid("permissions_invalid");
  }
  const permissions = input.permissions.map((permission) =>
    token(permission, "permissions_invalid"),
  );
  if (
    new Set(permissions).size !== permissions.length ||
    permissions.some(
      (permission, index) =>
        index > 0 && permissions[index - 1]!.localeCompare(permission) >= 0,
    ) ||
    !permissions.includes(TAKOSUMI_MANAGED_RUNTIME_INVOKE_PERMISSION)
  ) {
    throw invalid("permissions_invalid");
  }
  return {
    workspaceId,
    subject: token(input.subject, "subject_invalid"),
    resourceId,
    resourceKind,
    resourceGeneration: positiveInteger(
      input.resourceGeneration,
      "resource_generation_invalid",
    ),
    permissions,
    interfaceId: token(input.interfaceId, "interface_id_invalid"),
    interfaceBindingId: token(
      input.interfaceBindingId,
      "interface_binding_id_invalid",
    ),
    interfaceResolvedRevision: positiveInteger(
      input.interfaceResolvedRevision,
      "interface_revision_invalid",
    ),
    audience: exactAudience(input.audience).toString(),
    capabilityRef: secretRef(input.capabilityRef),
  };
}

function parseRequirements(
  value: unknown,
  aliases: ReadonlySet<string>,
): readonly ManagedRuntimeRequirement[] {
  if (!Array.isArray(value) || value.length > 16) {
    throw invalid("requirements_invalid");
  }
  return value.map((entry) => {
    const input = record(entry, "requirement_invalid");
    onlyKeys(
      input,
      [
        "kind",
        "version",
        "connectionAlias",
        "queryMode",
        "batchMode",
        "migrationMode",
        "requiredFeatures",
        "requiredMeta",
        "schemaDigest",
        "migrationSetDigest",
      ],
      "requirement_invalid",
    );
    if (
      input.kind !== "relational.sqlite" ||
      input.version !== 1 ||
      input.queryMode !== "prepared_sql" ||
      input.batchMode !== "ordered_atomic" ||
      input.migrationMode !== "ordered_sql"
    ) {
      throw invalid("requirement_invalid");
    }
    const connectionAlias = aliasToken(
      input.connectionAlias,
      "requirement_connection_invalid",
    );
    if (!aliases.has(connectionAlias)) {
      throw invalid("requirement_connection_invalid");
    }
    return {
      kind: "relational.sqlite",
      version: 1,
      connectionAlias,
      queryMode: "prepared_sql",
      batchMode: "ordered_atomic",
      migrationMode: "ordered_sql",
      requiredFeatures: exactEnumSet(
        input.requiredFeatures,
        ["ddl", "joins", "grouping", "transactions"],
        "requirement_features_invalid",
      ),
      requiredMeta: exactEnumSet(
        input.requiredMeta,
        [
          "changes",
          "last_row_id",
          "changed_db",
          "duration",
          "size_after",
          "rows_read",
          "rows_written",
        ],
        "requirement_meta_invalid",
      ),
      schemaDigest: digest(input.schemaDigest, "schema_digest_invalid"),
      migrationSetDigest: digest(
        input.migrationSetDigest,
        "migration_set_digest_invalid",
      ),
    };
  });
}

function queueMessage(value: unknown, code: string): ManagedRuntimeQueueMessage {
  const input = record(value, code);
  onlyKeys(input, ["type", "body"], code);
  if (input.type === "text" && typeof input.body === "string") {
    return { type: "text", body: input.body };
  }
  if (input.type === "json" && input.body !== undefined) {
    JSON.stringify(input.body);
    return { type: "json", body: input.body };
  }
  if (
    input.type === "bytes" &&
    typeof input.body === "string" &&
    validBase64(input.body)
  ) {
    return { type: "bytes", body: input.body };
  }
  throw invalid(code);
}

function capabilityHeaders(
  authority: ManagedRuntimeConnectionAuthority,
  idempotencyKey: string,
): Headers {
  const headers = new Headers();
  headers.set(
    TAKOSUMI_MANAGED_RUNTIME_CAPABILITY_REF_HEADER,
    authority.capabilityRef,
  );
  headers.set("idempotency-key", idempotencyKeyOf(idempotencyKey));
  return headers;
}

function applyKeyValuePutHeaders(
  headers: Headers,
  options: ManagedRuntimeKeyValuePutOptions | undefined,
): void {
  if (!options) return;
  if (
    options.expiration !== undefined &&
    options.expirationTtl !== undefined
  ) {
    throw invalid("kv_put_options_invalid");
  }
  if (options.expiration !== undefined) {
    headers.set(
      TAKOSUMI_MANAGED_RUNTIME_KV_EXPIRATION_HEADER,
      String(
        safeInteger(
          options.expiration,
          1,
          Number.MAX_SAFE_INTEGER,
          "kv_put_options_invalid",
        ),
      ),
    );
  }
  if (options.expirationTtl !== undefined) {
    headers.set(
      TAKOSUMI_MANAGED_RUNTIME_KV_EXPIRATION_TTL_HEADER,
      String(
        safeInteger(
          options.expirationTtl,
          60,
          Number.MAX_SAFE_INTEGER,
          "kv_put_options_invalid",
        ),
      ),
    );
  }
  if (options.metadata !== undefined) {
    const json = jsonMetadata(options.metadata, "kv_put_options_invalid", 1_024);
    headers.set(
      TAKOSUMI_MANAGED_RUNTIME_KV_METADATA_HEADER,
      encodeURIComponent(json),
    );
  }
}

function applyObjectMetadataHeaders(
  headers: Headers,
  httpMetadata:
    | Readonly<{
        readonly contentType?: string;
        readonly cacheControl?: string;
        readonly contentDisposition?: string;
        readonly contentEncoding?: string;
        readonly contentLanguage?: string;
      }>
    | undefined,
  customMetadata: Readonly<Record<string, string>> | undefined,
): void {
  for (const [field, header] of [
    ["contentType", "content-type"],
    ["cacheControl", "cache-control"],
    ["contentDisposition", "content-disposition"],
    ["contentEncoding", "content-encoding"],
    ["contentLanguage", "content-language"],
  ] as const) {
    const value = httpMetadata?.[field];
    if (value !== undefined) {
      headers.set(header, token(value, "object_metadata_invalid", 1_024));
    }
  }
  if (customMetadata === undefined) return;
  for (const [name, value] of Object.entries(customMetadata)) {
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/u.test(name)) {
      throw invalid("object_metadata_invalid");
    }
    token(value, "object_metadata_invalid", 1_024);
  }
  const json = jsonMetadata(
    customMetadata,
    "object_metadata_invalid",
    4_096,
  );
  headers.set(
    TAKOSUMI_MANAGED_RUNTIME_OBJECT_METADATA_HEADER,
    encodeURIComponent(json),
  );
}

function runtimeKey(
  value: unknown,
  code: string,
  maximumBytes: number,
  allowEmpty = false,
): string {
  if (
    typeof value !== "string" ||
    (!allowEmpty && value.length === 0) ||
    new TextEncoder().encode(value).byteLength > maximumBytes ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw invalid(code);
  }
  return value;
}

function jsonMetadata(
  value: unknown,
  code: string,
  maximumBytes: number,
): string {
  assertJsonValue(value, code, new Set<object>());
  const json = JSON.stringify(value);
  if (
    json === undefined ||
    new TextEncoder().encode(json).byteLength > maximumBytes
  ) {
    throw invalid(code);
  }
  return json;
}

function assertJsonValue(
  value: unknown,
  code: string,
  ancestors: Set<object>,
): void {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw invalid(code);
    return;
  }
  if (typeof value !== "object") throw invalid(code);
  if (ancestors.has(value)) throw invalid(code);
  ancestors.add(value);
  if (Array.isArray(value)) {
    for (const entry of value) assertJsonValue(entry, code, ancestors);
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw invalid(code);
    }
    for (const entry of Object.values(value as Record<string, unknown>)) {
      assertJsonValue(entry, code, ancestors);
    }
  }
  ancestors.delete(value);
}

function resourceKindOf(value: unknown): ManagedRuntimeResourceKind {
  if (
    value === "ObjectBucket" ||
    value === "KeyValueStore" ||
    value === "RelationalDatabase" ||
    value === "Queue" ||
    value === "VectorIndex" ||
    value === "DurableWorkflow" ||
    value === "StatefulActorNamespace"
  ) {
    return value;
  }
  throw invalid("resource_kind_invalid");
}

function bindingName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[A-Za-z][A-Za-z0-9_]{0,63}$/u.test(value)
  );
}

function idempotencyKeyOf(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u.test(value)
  ) {
    throw invalid("idempotency_key_invalid");
  }
  return value;
}

function exactAudience(value: unknown): URL {
  if (typeof value !== "string") throw invalid("audience_invalid");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalid("audience_invalid");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname === "/" ||
    url.pathname.endsWith("/")
  ) {
    throw invalid("audience_invalid");
  }
  return url;
}

function exactEnumSet<T extends string>(
  value: unknown,
  allowed: readonly T[],
  code: string,
): readonly T[] {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.some((entry) => !allowed.includes(entry as T))
  ) {
    throw invalid(code);
  }
  const entries = value as T[];
  if (
    new Set(entries).size !== entries.length ||
    entries.some(
      (entry, index) =>
        index > 0 && entries[index - 1]!.localeCompare(entry) >= 0,
    )
  ) {
    throw invalid(code);
  }
  return entries;
}

function containsEvery<T>(
  values: readonly T[],
  required: readonly T[],
): boolean {
  const available = new Set(values);
  return required.every((value) => available.has(value));
}

function secretRef(value: unknown): string {
  const result = token(value, "capability_ref_invalid");
  if (!/^secret:[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u.test(result)) {
    throw invalid("capability_ref_invalid");
  }
  return result;
}

function digest(value: unknown, code: string): string {
  if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(value)) {
    throw invalid(code);
  }
  return value;
}

function aliasToken(value: unknown, code: string): string {
  const result = token(value, code, 64);
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/u.test(result)) throw invalid(code);
  return result;
}

function positiveInteger(value: unknown, code: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw invalid(code);
  return Number(value);
}

function safeInteger(
  value: unknown,
  minimum: number,
  maximum: number,
  code: string,
): number {
  if (
    !Number.isSafeInteger(value) ||
    Number(value) < minimum ||
    Number(value) > maximum
  ) {
    throw invalid(code);
  }
  return Number(value);
}

function token(value: unknown, code: string, maximum = 256): string {
  if (
    typeof value !== "string" ||
    !value ||
    value.trim() !== value ||
    value.length > maximum ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw invalid(code);
  }
  return value;
}

function validBase64(value: string): boolean {
  return (
    value.length > 0 &&
    value.length % 4 === 0 &&
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(
      value,
    )
  );
}

function onlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  code: string,
): void {
  const names = new Set(allowed);
  if (Object.keys(value).some((key) => !names.has(key))) throw invalid(code);
}

function record(value: unknown, code: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw invalid(code);
  }
  return value as Record<string, unknown>;
}

function invalid(code: string): ManagedRuntimeConnectionContractError {
  return new ManagedRuntimeConnectionContractError(code);
}
