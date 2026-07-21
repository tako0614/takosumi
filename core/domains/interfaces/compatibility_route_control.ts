import type {
  ActorContext,
  Interface,
  InterfaceBinding,
  ResourceObject,
} from "takosumi-contract";
import { isTakosumiCompatibilityProfileToken } from "takosumi-contract/capabilities";
import {
  COMPATIBILITY_ROUTE_INTERFACE_TYPE,
  COMPATIBILITY_ROUTE_INTERFACE_VERSION,
  COMPATIBILITY_ROUTE_PERMISSION,
} from "takosumi-contract";
import { stableJsonDigest } from "../../adapters/source/digest.ts";
import { InterfaceService, InterfaceServiceError } from "./service.ts";

// The route type/version/permission tokens are shared wire vocabulary and live
// on the contract surface with the rest of them; re-exported here so existing
// importers of this module keep working.
export {
  COMPATIBILITY_ROUTE_INTERFACE_TYPE,
  COMPATIBILITY_ROUTE_INTERFACE_VERSION,
  COMPATIBILITY_ROUTE_PERMISSION,
};
export const COMPATIBILITY_ROUTE_ENDPOINT_INPUT = "endpoint";
export const COMPATIBILITY_ROUTE_ENDPOINT_OUTPUT = "url";

const PROFILE_LABEL = "takosumi.dev/compat-profile";
const ROUTE_KEY_LABEL = "takosumi.dev/compat-route-key";
const RESOURCE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const CONTEXT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u;
const ROUTE_KEY_PATTERN = /^[a-f0-9]{64}$/u;

export type CompatibilityRouteControlErrorCode =
  "invalid_argument" | "not_found" | "conflict" | "failed_precondition";

export class CompatibilityRouteControlError extends Error {
  constructor(
    readonly code: CompatibilityRouteControlErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "CompatibilityRouteControlError";
  }
}

export interface CompatibilityRouteRecord {
  readonly interfaceId: string;
  readonly bindingId: string;
  readonly workspaceId: string;
  readonly profile: string;
  readonly resourceName: string;
  readonly pathPattern: string;
  readonly endpoint: string;
  readonly pattern: string;
  readonly principalId: string;
  readonly permission: typeof COMPATIBILITY_ROUTE_PERMISSION;
  readonly interfaceGeneration: number;
  readonly interfaceResolvedRevision: number;
  readonly bindingGeneration: number;
  readonly etag: string;
}

export interface CompatibilityRouteRetireResult {
  readonly interfaceId: string;
  readonly retired: true;
}

export interface CompatibilityRouteControlScope {
  readonly profile: string;
  readonly workspaceId: string;
  readonly actor?: ActorContext;
}

export interface CompatibilityRouteResourceResolver {
  resolveReadyEdgeWorker(input: {
    readonly workspaceId: string;
    readonly resourceName: string;
  }): Promise<ResourceObject | undefined>;
}

export class CompatibilityRouteControlService {
  constructor(
    private readonly interfaces: InterfaceService,
    private readonly resources: CompatibilityRouteResourceResolver,
  ) {}

  async ensure(
    scope: CompatibilityRouteControlScope,
    input: {
      readonly resourceName: string;
      readonly pathPattern: string;
      readonly expectedEndpoint?: string;
    },
  ): Promise<CompatibilityRouteRecord> {
    const normalized = normalizeScopeAndDesired(scope, input);
    const resource = await this.requireReadyOwnedResource(normalized);
    const active = await this.ownedInterfaces(normalized);
    for (const candidate of active) {
      const ownership = ownedRoute(candidate, normalized);
      if (!ownership) continue;
      if (ownership.pathPattern !== normalized.pathPattern) {
        throw new CompatibilityRouteControlError(
          "conflict",
          "EdgeWorker already has an active compatibility route; update that route instead",
        );
      }
      const reconciled = await this.interfaces.reconcile(
        candidate.metadata.id,
        { allowSafetyRecovery: true },
      );
      if (
        ownedRoute(reconciled, normalized)?.pathPattern !==
        normalized.pathPattern
      ) {
        continue;
      }
      const binding = await this.ensureBinding(
        reconciled,
        normalized,
        ownership.routeKey,
      );
      return routeRecord(reconciled, binding, resource.endpoint, normalized);
    }

    const routeKey = await compatibilityRouteKey(normalized);
    const name = routeInterfaceName(routeKey);
    const sameName = active.find(
      (candidate) => candidate.metadata.name === name,
    );
    if (sameName) {
      throw new CompatibilityRouteControlError(
        "conflict",
        "compatibility route creation key is already bound to different desired state",
      );
    }

    let iface: Interface;
    await this.requireReadyOwnedResource(normalized);
    try {
      iface = await this.interfaces.create(
        {
          workspaceId: normalized.workspaceId,
          name,
          ownerRef: { kind: "Resource", id: normalized.resourceId },
          labels: routeLabels(normalized.profile, routeKey),
          spec: routeSpec(normalized, normalized.pathPattern),
        },
        normalized.actor,
        {
          compatibilityProfile: normalized.profile,
          compatibilityKey: routeKey,
        },
      );
    } catch (error) {
      if (!isInterfaceError(error, "already_exists")) throw error;
      const winner = (await this.ownedInterfaces(normalized)).find(
        (candidate) => candidate.metadata.name === name,
      );
      const ownership = winner ? ownedRoute(winner, normalized) : undefined;
      if (
        !winner ||
        ownership?.routeKey !== routeKey ||
        ownership.pathPattern !== normalized.pathPattern
      ) {
        throw new CompatibilityRouteControlError(
          "conflict",
          "compatibility route creation lost an ownership race",
        );
      }
      iface = winner;
    }

    const ownership = ownedRoute(iface, normalized);
    if (!ownership || ownership.pathPattern !== normalized.pathPattern) {
      throw new CompatibilityRouteControlError(
        "conflict",
        "canonical Interface does not match the compatibility route request",
      );
    }
    const binding = await this.ensureBinding(
      iface,
      normalized,
      ownership.routeKey,
    );
    return routeRecord(
      await this.interfaces.reconcile(iface.metadata.id),
      binding,
      resource.endpoint,
      normalized,
    );
  }

  async list(
    scope: CompatibilityRouteControlScope,
    input: { readonly resourceName?: string } = {},
  ): Promise<readonly CompatibilityRouteRecord[]> {
    const normalized = normalizeScope(scope);
    const resourceName = input.resourceName
      ? normalizeResourceName(input.resourceName)
      : undefined;
    const candidates = await this.interfaces.list({
      workspaceId: normalized.workspaceId,
      type: COMPATIBILITY_ROUTE_INTERFACE_TYPE,
      ownerKind: "Resource",
      ...(resourceName
        ? { ownerId: resourceId(normalized.workspaceId, resourceName) }
        : {}),
      includeRetired: false,
    });
    const records: CompatibilityRouteRecord[] = [];
    for (const iface of candidates) {
      const record = await this.readRecord(iface, normalized);
      if (record) records.push(record);
    }
    return records.sort((left, right) =>
      left.interfaceId.localeCompare(right.interfaceId),
    );
  }

  async get(
    scope: CompatibilityRouteControlScope,
    interfaceId: string,
  ): Promise<CompatibilityRouteRecord | undefined> {
    const normalized = normalizeScope(scope);
    const iface = await getInterfaceOrUndefined(this.interfaces, interfaceId);
    if (!iface || iface.status.phase === "Retired") return undefined;
    return await this.readRecord(iface, normalized);
  }

  async update(
    scope: CompatibilityRouteControlScope,
    input: {
      readonly interfaceId: string;
      readonly resourceName: string;
      readonly pathPattern: string;
      readonly expectedEndpoint?: string;
      readonly expectedEtag?: string;
    },
  ): Promise<CompatibilityRouteRecord> {
    const normalized = normalizeScopeAndDesired(scope, input);
    let current = await this.requireOwnedActiveInterface(
      normalized,
      input.interfaceId,
    );
    const ownership = ownedRoute(current, normalized)!;
    if (ownership.resourceName !== normalized.resourceName) {
      throw new CompatibilityRouteControlError(
        "failed_precondition",
        "compatibility route cannot be rebound to another EdgeWorker",
      );
    }
    const resource = await this.requireReadyOwnedResource(normalized);
    if (ownership.pathPattern === normalized.pathPattern) {
      current = await this.interfaces.reconcile(current.metadata.id, {
        allowSafetyRecovery: true,
      });
      if (
        ownedRoute(current, normalized)?.pathPattern !== normalized.pathPattern
      ) {
        throw new CompatibilityRouteControlError(
          "conflict",
          "compatibility route changed concurrently",
        );
      }
      const binding = await this.ensureBinding(
        current,
        normalized,
        ownership.routeKey,
      );
      return routeRecord(current, binding, resource.endpoint, normalized);
    }
    assertExpectedEtag(current, input.expectedEtag);
    await this.requireReadyOwnedResource(normalized);
    try {
      current = await this.interfaces.update(
        current.metadata.id,
        { spec: routeSpec(normalized, normalized.pathPattern) },
        current.metadata.generation,
        normalized.actor,
        current.status.resolvedRevision,
      );
    } catch (error) {
      if (!isInterfaceError(error, "conflict")) throw error;
      const winner = await this.requireOwnedActiveInterface(
        normalized,
        input.interfaceId,
      );
      if (
        ownedRoute(winner, normalized)?.pathPattern !== normalized.pathPattern
      ) {
        throw new CompatibilityRouteControlError(
          "conflict",
          "compatibility route changed concurrently",
        );
      }
      current = winner;
    }
    const binding = await this.ensureBinding(
      current,
      normalized,
      ownership.routeKey,
    );
    return routeRecord(current, binding, resource.endpoint, normalized);
  }

  async retire(
    scope: CompatibilityRouteControlScope,
    input: {
      readonly interfaceId: string;
      readonly expectedEtag?: string;
    },
  ): Promise<CompatibilityRouteRetireResult | undefined> {
    const normalized = normalizeScope(scope);
    let current = await getInterfaceOrUndefined(
      this.interfaces,
      input.interfaceId,
    );
    if (!current) return undefined;
    const ownership = ownedRoute(current, normalized);
    if (!ownership) return undefined;
    if (current.status.phase !== "Retired") {
      assertExpectedEtag(current, input.expectedEtag);
      try {
        current = await this.interfaces.retire(
          current.metadata.id,
          current.metadata.generation,
          normalized.actor,
          current.status.resolvedRevision,
        );
      } catch (error) {
        if (!isInterfaceError(error, "conflict")) throw error;
        current = await this.interfaces.get(input.interfaceId);
        if (current.status.phase !== "Retired") {
          throw new CompatibilityRouteControlError(
            "conflict",
            "compatibility route changed concurrently",
          );
        }
      }
    }
    // The Interface CAS is the authority commit. Only after it has retired can
    // cleanup revoke its exact Binding, so a stale DELETE can never disable a
    // concurrent successful UPDATE. InterfaceService normally performs this
    // refresh itself; the explicit cleanup also repairs a retry after a crash
    // between the canonical retirement and Binding refresh.
    await this.revokeOwnedBindings(current, normalized, ownership.routeKey);
    return { interfaceId: current.metadata.id, retired: true };
  }

  private async revokeOwnedBindings(
    iface: Interface,
    scope: Omit<
      NormalizedRouteScope,
      "resourceName" | "resourceId" | "pathPattern"
    >,
    routeKey: string,
  ): Promise<void> {
    for (const initial of await this.interfaces.listBindings(
      iface.metadata.id,
    )) {
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const current = (
          await this.interfaces.listBindings(iface.metadata.id)
        ).find((binding) => binding.metadata.id === initial.metadata.id);
        if (
          !current ||
          current.status.phase === "Revoked" ||
          !ownedBinding(current, iface, scope, routeKey)
        ) {
          break;
        }
        try {
          await this.interfaces.revokeBinding(
            iface.metadata.id,
            current.metadata.id,
            scope.actor,
          );
          break;
        } catch (error) {
          if (!isInterfaceError(error, "conflict") || attempt === 7) {
            throw error;
          }
        }
      }
    }
  }

  private async ownedInterfaces(
    scope: NormalizedRouteScope,
  ): Promise<readonly Interface[]> {
    return await this.interfaces.list({
      workspaceId: scope.workspaceId,
      type: COMPATIBILITY_ROUTE_INTERFACE_TYPE,
      ownerKind: "Resource",
      ownerId: scope.resourceId,
      includeRetired: false,
    });
  }

  private async requireOwnedActiveInterface(
    scope: NormalizedRouteScope,
    interfaceId: string,
  ): Promise<Interface> {
    const iface = await getInterfaceOrUndefined(this.interfaces, interfaceId);
    if (
      !iface ||
      iface.status.phase === "Retired" ||
      !ownedRoute(iface, scope)
    ) {
      throw new CompatibilityRouteControlError(
        "not_found",
        "compatibility route was not found",
      );
    }
    return iface;
  }

  private async requireReadyOwnedResource(
    scope: NormalizedRouteScope,
  ): Promise<{ readonly resource: ResourceObject; readonly endpoint: string }> {
    const resource = await this.resources.resolveReadyEdgeWorker({
      workspaceId: scope.workspaceId,
      resourceName: scope.resourceName,
    });
    const endpoint = resource ? readyOwnedEndpoint(resource, scope) : undefined;
    if (
      !resource ||
      !endpoint ||
      (scope.expectedEndpoint !== undefined &&
        endpoint !== scope.expectedEndpoint)
    ) {
      throw new CompatibilityRouteControlError(
        "failed_precondition",
        "route owner must be a Ready profile-owned EdgeWorker with a canonical HTTPS url output",
      );
    }
    return { resource, endpoint };
  }

  private async readRecord(
    iface: Interface,
    scope: Omit<
      NormalizedRouteScope,
      "resourceName" | "resourceId" | "pathPattern"
    >,
  ): Promise<CompatibilityRouteRecord | undefined> {
    const initialOwnership = ownedRoute(iface, scope);
    if (!initialOwnership) return undefined;
    const desired: NormalizedRouteScope = {
      ...scope,
      resourceName: initialOwnership.resourceName,
      resourceId: resourceId(scope.workspaceId, initialOwnership.resourceName),
      pathPattern: initialOwnership.pathPattern,
    };
    const reconciled = await this.interfaces.reconcile(iface.metadata.id, {
      allowSafetyRecovery: true,
    });
    const ownership = ownedRoute(reconciled, desired);
    if (!ownership || reconciled.status.phase !== "Resolved") return undefined;
    const resource = await this.resources.resolveReadyEdgeWorker({
      workspaceId: desired.workspaceId,
      resourceName: desired.resourceName,
    });
    const endpoint = resource
      ? readyOwnedEndpoint(resource, desired)
      : undefined;
    if (!endpoint) return undefined;
    const binding = await ownedActiveBinding(
      this.interfaces,
      reconciled,
      desired,
      ownership.routeKey,
    );
    if (!binding) return undefined;
    try {
      return routeRecord(reconciled, binding, endpoint, desired);
    } catch (error) {
      if (
        error instanceof CompatibilityRouteControlError &&
        error.code === "failed_precondition"
      ) {
        return undefined;
      }
      throw error;
    }
  }

  private async ensureBinding(
    iface: Interface,
    scope: NormalizedRouteScope,
    routeKey: string,
  ): Promise<InterfaceBinding> {
    const bindings = await this.interfaces.listBindings(iface.metadata.id);
    const active = bindings.filter(
      (binding) => binding.status.phase !== "Revoked",
    );
    const exact = active.find((binding) =>
      ownedBinding(binding, iface, scope, routeKey),
    );
    if (exact) return exact;
    if (active.some((binding) => sameRoutePrincipal(binding, scope))) {
      throw new CompatibilityRouteControlError(
        "conflict",
        "route Principal is already bound outside this compatibility profile",
      );
    }
    try {
      return await this.interfaces.createBinding(
        iface.metadata.id,
        {
          subjectRef: { kind: "Principal", id: scope.principalId },
          permissions: [COMPATIBILITY_ROUTE_PERMISSION],
          delivery: { type: "none" },
        },
        scope.actor,
        {
          compatibilityProfile: scope.profile,
          compatibilityKey: routeKey,
        },
      );
    } catch (error) {
      if (!isInterfaceError(error, "already_exists")) throw error;
      const winner = await ownedActiveBinding(
        this.interfaces,
        iface,
        scope,
        routeKey,
      );
      if (!winner) {
        throw new CompatibilityRouteControlError(
          "conflict",
          "compatibility route Binding lost an ownership race",
        );
      }
      return winner;
    }
  }
}

interface NormalizedRouteScope extends CompatibilityRouteControlScope {
  readonly profile: string;
  readonly workspaceId: string;
  readonly resourceName: string;
  readonly resourceId: string;
  readonly principalId: string;
  readonly pathPattern: string;
  readonly expectedEndpoint?: string;
}

function normalizeScope(
  scope: CompatibilityRouteControlScope,
): Omit<NormalizedRouteScope, "resourceName" | "resourceId" | "pathPattern"> {
  const profile = scope.profile.trim();
  const workspaceId = scope.workspaceId.trim();
  if (!isTakosumiCompatibilityProfileToken(profile)) {
    throw new CompatibilityRouteControlError(
      "invalid_argument",
      "compatibility profile token is invalid",
    );
  }
  if (!CONTEXT_ID_PATTERN.test(workspaceId)) {
    throw new CompatibilityRouteControlError(
      "invalid_argument",
      "Workspace id is invalid",
    );
  }
  return {
    profile,
    workspaceId,
    principalId: `compat-route:${profile}:${workspaceId}`,
    ...(scope.actor ? { actor: scope.actor } : {}),
  };
}

function normalizeScopeAndDesired(
  scope: CompatibilityRouteControlScope,
  input: {
    readonly resourceName: string;
    readonly pathPattern: string;
    readonly expectedEndpoint?: string;
  },
): NormalizedRouteScope {
  const normalized = normalizeScope(scope);
  const resourceName = normalizeResourceName(input.resourceName);
  const pathPattern = normalizePathPattern(input.pathPattern);
  const expectedEndpoint =
    input.expectedEndpoint === undefined
      ? undefined
      : canonicalEndpoint(input.expectedEndpoint);
  if (input.expectedEndpoint !== undefined && !expectedEndpoint) {
    throw new CompatibilityRouteControlError(
      "invalid_argument",
      "expected EdgeWorker endpoint is invalid",
    );
  }
  return {
    ...normalized,
    resourceName,
    resourceId: resourceId(normalized.workspaceId, resourceName),
    pathPattern,
    ...(expectedEndpoint ? { expectedEndpoint } : {}),
  };
}

function normalizeResourceName(value: string): string {
  const name = value.trim();
  if (!RESOURCE_NAME_PATTERN.test(name)) {
    throw new CompatibilityRouteControlError(
      "invalid_argument",
      "EdgeWorker resource name is invalid",
    );
  }
  return name;
}

function normalizePathPattern(value: string): string {
  const path = value.trim();
  const firstWildcard = path.indexOf("*");
  if (
    !path.startsWith("/") ||
    path.length > 512 ||
    path.includes("?") ||
    path.includes("#") ||
    /[\s\\]/u.test(path) ||
    (firstWildcard >= 0 &&
      (firstWildcard !== path.length - 1 ||
        path.lastIndexOf("*") !== firstWildcard))
  ) {
    throw new CompatibilityRouteControlError(
      "invalid_argument",
      "route path pattern is invalid",
    );
  }
  return path;
}

function resourceId(workspaceId: string, resourceName: string): string {
  return `tkrn:${workspaceId}:EdgeWorker:${resourceName}`;
}

async function compatibilityRouteKey(
  scope: NormalizedRouteScope,
): Promise<string> {
  return (
    await stableJsonDigest({
      profile: scope.profile,
      workspaceId: scope.workspaceId,
      resourceId: scope.resourceId,
      interfaceType: COMPATIBILITY_ROUTE_INTERFACE_TYPE,
      interfaceVersion: COMPATIBILITY_ROUTE_INTERFACE_VERSION,
    })
  ).replace(/^sha256:/u, "");
}

function routeInterfaceName(routeKey: string): string {
  return `compat-route-${routeKey.slice(0, 32)}`;
}

function routeLabels(
  profile: string,
  routeKey: string,
): Readonly<Record<string, string>> {
  return { [PROFILE_LABEL]: profile, [ROUTE_KEY_LABEL]: routeKey };
}

function routeSpec(
  scope: Pick<NormalizedRouteScope, "resourceId" | "principalId">,
  pathPattern: string,
): Interface["spec"] {
  return {
    type: COMPATIBILITY_ROUTE_INTERFACE_TYPE,
    version: COMPATIBILITY_ROUTE_INTERFACE_VERSION,
    document: {
      principalId: scope.principalId,
      permission: COMPATIBILITY_ROUTE_PERMISSION,
      pathPattern,
    },
    inputs: {
      [COMPATIBILITY_ROUTE_ENDPOINT_INPUT]: {
        source: "resource_output",
        resourceId: scope.resourceId,
        outputName: COMPATIBILITY_ROUTE_ENDPOINT_OUTPUT,
      },
    },
    access: {
      visibility: "public",
      resourceUriInput: COMPATIBILITY_ROUTE_ENDPOINT_INPUT,
    },
  };
}

function ownedRoute(
  iface: Interface,
  scope: Pick<
    NormalizedRouteScope,
    "profile" | "workspaceId" | "principalId"
  > & { readonly resourceId?: string },
):
  | {
      readonly routeKey: string;
      readonly resourceName: string;
      readonly pathPattern: string;
    }
  | undefined {
  const materialized = iface.metadata.materializedFrom;
  const routeKey = iface.metadata.labels?.[ROUTE_KEY_LABEL];
  const profile = iface.metadata.labels?.[PROFILE_LABEL];
  const ownerPrefix = `tkrn:${scope.workspaceId}:EdgeWorker:`;
  const resourceName = iface.metadata.ownerRef.id.startsWith(ownerPrefix)
    ? iface.metadata.ownerRef.id.slice(ownerPrefix.length)
    : "";
  const document = record(iface.spec.document);
  const inputs = iface.spec.inputs ?? {};
  const endpoint = inputs[COMPATIBILITY_ROUTE_ENDPOINT_INPUT];
  if (
    iface.metadata.workspaceId !== scope.workspaceId ||
    iface.metadata.ownerRef.kind !== "Resource" ||
    (scope.resourceId !== undefined &&
      iface.metadata.ownerRef.id !== scope.resourceId) ||
    !RESOURCE_NAME_PATTERN.test(resourceName) ||
    iface.spec.type !== COMPATIBILITY_ROUTE_INTERFACE_TYPE ||
    iface.spec.version !== COMPATIBILITY_ROUTE_INTERFACE_VERSION ||
    iface.spec.access.visibility !== "public" ||
    iface.spec.access.resourceUriInput !== COMPATIBILITY_ROUTE_ENDPOINT_INPUT ||
    iface.spec.access.policyRef !== undefined ||
    Object.keys(inputs).length !== 1 ||
    endpoint?.source !== "resource_output" ||
    endpoint.resourceId !== iface.metadata.ownerRef.id ||
    endpoint.outputName !== COMPATIBILITY_ROUTE_ENDPOINT_OUTPUT ||
    endpoint.pointer !== undefined ||
    materialized?.source !== "compatibility_profile" ||
    materialized.profile !== scope.profile ||
    materialized.key !== routeKey ||
    profile !== scope.profile ||
    !routeKey ||
    !ROUTE_KEY_PATTERN.test(routeKey) ||
    iface.metadata.name !== routeInterfaceName(routeKey) ||
    document.principalId !== scope.principalId ||
    document.permission !== COMPATIBILITY_ROUTE_PERMISSION ||
    Object.keys(document).some(
      (key) => !["principalId", "permission", "pathPattern"].includes(key),
    )
  ) {
    return undefined;
  }
  let pathPattern: string;
  try {
    pathPattern = normalizePathPattern(String(document.pathPattern ?? ""));
  } catch {
    return undefined;
  }
  return {
    routeKey,
    resourceName,
    pathPattern,
  };
}

function sameRoutePrincipal(
  binding: InterfaceBinding,
  scope: Pick<NormalizedRouteScope, "principalId">,
): boolean {
  return (
    binding.spec.subjectRef.kind === "Principal" &&
    binding.spec.subjectRef.id === scope.principalId
  );
}

function ownedBinding(
  binding: InterfaceBinding,
  iface: Interface,
  scope: Pick<NormalizedRouteScope, "profile" | "workspaceId" | "principalId">,
  routeKey: string,
): boolean {
  const materialized = binding.metadata.materializedFrom;
  return (
    binding.metadata.workspaceId === scope.workspaceId &&
    binding.spec.interfaceId === iface.metadata.id &&
    sameRoutePrincipal(binding, scope) &&
    binding.spec.permissions.length === 1 &&
    binding.spec.permissions[0] === COMPATIBILITY_ROUTE_PERMISSION &&
    binding.spec.delivery.type === "none" &&
    binding.spec.delivery.credentialRef === undefined &&
    binding.spec.delivery.options === undefined &&
    materialized?.source === "compatibility_profile" &&
    materialized.profile === scope.profile &&
    materialized.key === routeKey
  );
}

async function ownedActiveBinding(
  interfaces: InterfaceService,
  iface: Interface,
  scope: Pick<NormalizedRouteScope, "profile" | "workspaceId" | "principalId">,
  routeKey: string,
): Promise<InterfaceBinding | undefined> {
  const matches = (await interfaces.listBindings(iface.metadata.id)).filter(
    (binding) =>
      binding.status.phase !== "Revoked" &&
      ownedBinding(binding, iface, scope, routeKey),
  );
  return matches.length === 1 ? matches[0] : undefined;
}

function readyOwnedEndpoint(
  resource: ResourceObject,
  scope: NormalizedRouteScope,
): string | undefined {
  if (
    resource.kind !== "EdgeWorker" ||
    resource.metadata.space !== scope.workspaceId ||
    resource.metadata.name !== scope.resourceName ||
    resource.metadata.managedBy !== scope.profile ||
    resource.status?.phase !== "Ready" ||
    resource.status.observedGeneration < 1
  ) {
    return undefined;
  }
  return canonicalEndpoint(resource.status.outputs?.url);
}

function resolvedRouteEndpoint(iface: Interface): string | undefined {
  if (
    iface.status.phase !== "Resolved" ||
    iface.status.observedGeneration !== iface.metadata.generation ||
    iface.status.resolvedRevision < 1
  ) {
    return undefined;
  }
  return canonicalEndpoint(
    iface.status.resolvedInputs?.[COMPATIBILITY_ROUTE_ENDPOINT_INPUT],
  );
}

function canonicalEndpoint(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    return undefined;
  }
  if (
    endpoint.protocol !== "https:" ||
    endpoint.username ||
    endpoint.password ||
    endpoint.port ||
    endpoint.search ||
    endpoint.hash ||
    (endpoint.pathname !== "/" && endpoint.pathname !== "") ||
    endpoint.hostname.includes("*")
  ) {
    return undefined;
  }
  endpoint.pathname = "/";
  return endpoint.toString();
}

function routeRecord(
  iface: Interface,
  binding: InterfaceBinding,
  expectedEndpoint: string,
  scope: Pick<NormalizedRouteScope, "profile" | "workspaceId" | "principalId">,
): CompatibilityRouteRecord {
  const ownership = ownedRoute(iface, scope);
  const endpoint = resolvedRouteEndpoint(iface);
  if (
    !ownership ||
    !endpoint ||
    endpoint !== expectedEndpoint ||
    binding.status.phase !== "Ready" ||
    binding.status.observedInterfaceRevision !==
      iface.status.resolvedRevision ||
    !ownedBinding(binding, iface, scope, ownership.routeKey)
  ) {
    throw new CompatibilityRouteControlError(
      "failed_precondition",
      "canonical route Interface or Binding is not Ready",
    );
  }
  const hostname = new URL(endpoint).hostname.toLowerCase();
  return {
    interfaceId: iface.metadata.id,
    bindingId: binding.metadata.id,
    workspaceId: iface.metadata.workspaceId,
    profile: scope.profile,
    resourceName: ownership.resourceName,
    pathPattern: ownership.pathPattern,
    endpoint,
    pattern: `${hostname}${ownership.pathPattern}`,
    principalId: scope.principalId,
    permission: COMPATIBILITY_ROUTE_PERMISSION,
    interfaceGeneration: iface.metadata.generation,
    interfaceResolvedRevision: iface.status.resolvedRevision,
    bindingGeneration: binding.metadata.generation,
    etag: compatibilityRouteEtag(iface),
  };
}

function compatibilityRouteEtag(iface: Interface): string {
  return `"${iface.metadata.id}:${iface.metadata.generation}:${iface.status.resolvedRevision}"`;
}

function assertExpectedEtag(
  iface: Interface,
  expectedEtag: string | undefined,
): void {
  if (
    expectedEtag !== undefined &&
    expectedEtag !== compatibilityRouteEtag(iface)
  ) {
    throw new CompatibilityRouteControlError(
      "conflict",
      "compatibility route ETag changed",
    );
  }
}

async function getInterfaceOrUndefined(
  interfaces: InterfaceService,
  interfaceId: string,
): Promise<Interface | undefined> {
  const id = interfaceId.trim();
  if (!id) return undefined;
  try {
    return await interfaces.get(id);
  } catch (error) {
    if (isInterfaceError(error, "not_found")) return undefined;
    throw error;
  }
}

function isInterfaceError(
  error: unknown,
  code: InterfaceServiceError["code"],
): boolean {
  return error instanceof InterfaceServiceError && error.code === code;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
