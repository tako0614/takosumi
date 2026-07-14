import type {
  ActorContext,
  Condition,
  CreateInterfaceBindingRequest,
  CreateInterfaceRequest,
  CapsuleInterfaceBlueprint,
  CapsuleInterfaceBlueprintInput,
  Interface,
  InterfaceBinding,
  InterfaceInput,
  InterfaceInputProvenance,
  InterfaceProjectionSink,
  InterfacePhase,
  InterfaceSpec,
  IssueInterfaceTokenRequest,
  IssueInterfaceTokenResponse,
  JsonValue,
  UpdateInterfaceRequest,
} from "takosumi-contract";
import {
  isValidInterfaceName,
  isValidInterfacePermissionToken,
} from "takosumi-contract";
import { TAKOSUMI_API_VERSION } from "takosumi-contract/capabilities";
import { stableJsonDigest } from "../../adapters/source/digest.ts";
import { log } from "../../shared/log.ts";
import {
  NOOP_ACTIVITY_RECORDER,
  type ActivityRecorder,
} from "../activity/mod.ts";
import type {
  InterfaceListFilter,
  InterfaceStores,
  InterfaceWriteGuard,
} from "./stores.ts";

const INTERFACE_OAUTH2_MAX_TTL_MS = 60_000;

export type InterfaceServiceErrorCode =
  | "invalid_argument"
  | "not_found"
  | "already_exists"
  | "conflict"
  | "failed_precondition";

export class InterfaceServiceError extends Error {
  constructor(
    readonly code: InterfaceServiceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "InterfaceServiceError";
  }
}

export type InterfaceResolutionResult =
  | {
      readonly ok: true;
      readonly resolvedInputs: Readonly<Record<string, JsonValue>>;
      readonly provenance: Readonly<Record<string, InterfaceInputProvenance>>;
    }
  | {
      readonly ok: false;
      readonly phase: Extract<
        InterfacePhase,
        "NotReady" | "Unknown" | "Terminating"
      >;
      readonly reason: string;
      readonly message: string;
    };

export interface InterfaceInputResolver {
  resolve(input: {
    readonly workspaceId: string;
    readonly specGeneration: number;
    readonly inputs: Readonly<Record<string, InterfaceInput>>;
  }): Promise<InterfaceResolutionResult>;
}

export interface ResourceInterfaceLifecycleSnapshot {
  readonly resourceId: string;
  readonly phase: "ready" | "not_ready" | "unknown" | "terminating" | "retired";
  readonly message?: string;
}

export interface InterfaceProjectionRepairResult {
  readonly scanned: number;
  readonly projected: number;
  readonly failed: number;
  readonly nextCursor?: string;
}

export class LiteralInterfaceInputResolver implements InterfaceInputResolver {
  resolve(input: {
    readonly specGeneration: number;
    readonly inputs: Readonly<Record<string, InterfaceInput>>;
  }): Promise<InterfaceResolutionResult> {
    const resolvedInputs: Record<string, JsonValue> = {};
    const provenance: Record<string, InterfaceInputProvenance> = {};
    for (const [name, source] of Object.entries(input.inputs)) {
      if (source.source !== "literal") {
        return Promise.resolve({
          ok: false,
          phase: "NotReady",
          reason: "ResolverUnavailable",
          message: `${source.source} input ${name} has no configured resolver`,
        });
      }
      resolvedInputs[name] = source.value;
      provenance[name] = {
        source: "literal",
        specGeneration: input.specGeneration,
      };
    }
    return Promise.resolve({ ok: true, resolvedInputs, provenance });
  }
}

export interface InterfacePrincipalOAuth2IssueInput {
  readonly issuedAt: string;
  readonly workspaceId: string;
  readonly interfaceId: string;
  readonly interfaceGeneration: number;
  readonly interfaceResolvedRevision: number;
  readonly interfaceOwnerRef: Interface["metadata"]["ownerRef"];
  readonly bindingId: string;
  readonly bindingGeneration: number;
  readonly subjectId: string;
  readonly permission: string;
  readonly resource: string;
}

export interface InterfaceCredentialIssuer {
  issuePrincipalOAuth2Token(
    input: InterfacePrincipalOAuth2IssueInput,
  ): Promise<{
    readonly accessToken: string;
    readonly expiresAt: string;
  }>;
}

export type InterfaceOAuth2ResourceAuthorizer = (input: {
  readonly workspaceId: string;
  readonly interfaceId: string;
  readonly ownerRef: Interface["metadata"]["ownerRef"];
  readonly resource: string;
}) => boolean | Promise<boolean>;

export interface InterfaceBindingDeliveryReadinessInput {
  readonly iface: Interface;
  readonly subjectRef: InterfaceBinding["spec"]["subjectRef"];
  readonly delivery: InterfaceBinding["spec"]["delivery"];
}

export interface InterfaceBindingDeliveryReadiness {
  readonly ready: boolean;
  readonly reason: string;
}

/** Host-installed behavior for one open InterfaceBinding delivery token. */
export type InterfaceBindingDeliveryHandler = (
  input: InterfaceBindingDeliveryReadinessInput,
) =>
  | InterfaceBindingDeliveryReadiness
  | Promise<InterfaceBindingDeliveryReadiness>;

export type InterfaceBindingDeliveryHandlerRegistry = Readonly<
  Record<string, InterfaceBindingDeliveryHandler>
>;

export interface InterfaceServiceOptions {
  readonly stores: InterfaceStores;
  readonly resolver?: InterfaceInputResolver;
  readonly now?: () => string;
  readonly newId?: (prefix: "if" | "ifb") => string;
  readonly activity?: ActivityRecorder;
  /** Host-owned invocation credential issuer; Core never persists its token. */
  readonly credentialIssuer?: InterfaceCredentialIssuer;
  /**
   * Host proof that the Interface owner controls the resolved OAuth resource.
   * Without it, an arbitrary literal or Output URL is never token authority.
   */
  readonly oauth2ResourceAuthorizer?: InterfaceOAuth2ResourceAuthorizer;
  /**
   * Additional host delivery types. `none` and standards-based `oauth2` are
   * core. The exact v1alpha1 token `workload_token` is reserved by Core as a
   * fail-closed future contract and cannot be replaced by a host handler.
   */
  readonly bindingDeliveryHandlers?: InterfaceBindingDeliveryHandlerRegistry;
  readonly ownerExists?: (input: {
    readonly workspaceId: string;
    readonly ownerRef: Interface["metadata"]["ownerRef"];
  }) => Promise<boolean>;
  readonly ownerReady?: (input: {
    readonly workspaceId: string;
    readonly ownerRef: Interface["metadata"]["ownerRef"];
  }) => Promise<boolean>;
  /**
   * Authoritative lifecycle fence checked before every resolution. Returning a
   * value blocks output resolution with that fail-closed status.
   */
  readonly lifecycleGuard?: (input: {
    readonly workspaceId: string;
    readonly ownerRef: Interface["metadata"]["ownerRef"];
    readonly inputs: Readonly<Record<string, InterfaceInput>>;
  }) => Promise<
    Extract<InterfaceResolutionResult, { readonly ok: false }> | undefined
  >;
  readonly policyAllows?: (input: {
    readonly workspaceId: string;
    readonly policyRef: string;
    readonly iface: Interface;
  }) => Promise<boolean>;
  /** Workspace-scoped, idempotent declaration repair before runtime discovery. */
  readonly hydrateWorkspace?: (workspaceId: string) => Promise<void>;
  /**
   * Host-owned, recoverable runtime projection. Canonical Interface/Binding
   * writes complete first; sink failures are logged and repaired by a bounded
   * host scan rather than changing lifecycle authority.
   */
  readonly projectionSink?: InterfaceProjectionSink;
}

export class InterfaceService {
  readonly #stores: InterfaceStores;
  readonly #resolver: InterfaceInputResolver;
  readonly #now: () => string;
  readonly #newId: (prefix: "if" | "ifb") => string;
  readonly #activity: ActivityRecorder;
  readonly #credentialIssuer?: InterfaceCredentialIssuer;
  readonly #oauth2ResourceAuthorizer?: InterfaceOAuth2ResourceAuthorizer;
  readonly #bindingDeliveryHandlers: ReadonlyMap<
    string,
    InterfaceBindingDeliveryHandler
  >;
  readonly #ownerExists?: InterfaceServiceOptions["ownerExists"];
  readonly #ownerReady?: InterfaceServiceOptions["ownerReady"];
  readonly #lifecycleGuard?: InterfaceServiceOptions["lifecycleGuard"];
  readonly #policyAllows?: InterfaceServiceOptions["policyAllows"];
  readonly #hydrateWorkspace?: InterfaceServiceOptions["hydrateWorkspace"];
  readonly #projectionSink?: InterfaceProjectionSink;

  constructor(options: InterfaceServiceOptions) {
    this.#stores = options.stores;
    this.#resolver = options.resolver ?? new LiteralInterfaceInputResolver();
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#newId =
      options.newId ??
      ((prefix) =>
        `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`);
    this.#activity = options.activity ?? NOOP_ACTIVITY_RECORDER;
    this.#credentialIssuer = options.credentialIssuer;
    this.#oauth2ResourceAuthorizer = options.oauth2ResourceAuthorizer;
    this.#bindingDeliveryHandlers = createBindingDeliveryHandlerRegistry({
      credentialIssuerConfigured: options.credentialIssuer !== undefined,
      oauth2ResourceAuthorizer: options.oauth2ResourceAuthorizer,
      additional: options.bindingDeliveryHandlers,
    });
    this.#ownerExists = options.ownerExists;
    this.#ownerReady = options.ownerReady;
    this.#lifecycleGuard = options.lifecycleGuard;
    this.#policyAllows = options.policyAllows;
    this.#hydrateWorkspace = options.hydrateWorkspace;
    this.#projectionSink = options.projectionSink;
  }

  async create(
    request: CreateInterfaceRequest,
    actor?: ActorContext,
    materialization?: { readonly capsuleBlueprintKey: string },
  ): Promise<Interface> {
    validateCreate(request);
    const workspaceId = requireText(request.workspaceId, "workspaceId");
    const ownerRef = normalizedOwner(request.ownerRef);
    if (
      this.#ownerExists &&
      !(await this.#ownerExists({ workspaceId, ownerRef }))
    ) {
      throw new InterfaceServiceError(
        "failed_precondition",
        "Interface owner does not exist in the Workspace",
      );
    }
    const now = this.#now();
    const record: Interface = {
      apiVersion: TAKOSUMI_API_VERSION,
      kind: "Interface",
      metadata: {
        id: this.#newId("if"),
        workspaceId,
        name: request.name.trim(),
        ownerRef,
        generation: 1,
        ...(request.labels ? { labels: normalizeLabels(request.labels) } : {}),
        ...(materialization
          ? {
              materializedFrom: {
                source: "capsule_blueprint" as const,
                key: requireText(
                  materialization.capsuleBlueprintKey,
                  "capsuleBlueprintKey",
                ),
              },
            }
          : {}),
        createdAt: now,
        updatedAt: now,
      },
      spec: normalizeSpec(request.spec),
      status: {
        phase: "Pending",
        observedGeneration: 0,
        resolvedRevision: 0,
        conditions: [
          condition("Ready", "unknown", "PendingResolution", now, 0),
        ],
      },
    };
    if (!(await this.#stores.interfaces.create(record))) {
      throw new InterfaceServiceError(
        "already_exists",
        "an active Interface with this owner and name already exists",
      );
    }
    await this.#projectInterface(record);
    await this.#recordActivity({
      actor,
      workspaceId: record.metadata.workspaceId,
      action: "interface.created",
      targetType: "interface",
      targetId: record.metadata.id,
      metadata: {
        name: record.metadata.name,
        ownerKind: record.metadata.ownerRef.kind,
        ownerId: record.metadata.ownerRef.id,
        interfaceType: record.spec.type,
        interfaceVersion: record.spec.version,
      },
    });
    return await this.reconcile(record.metadata.id);
  }

  async ensureCapsuleBlueprints(input: {
    readonly workspaceId: string;
    readonly capsuleId: string;
    readonly blueprints: readonly CapsuleInterfaceBlueprint[];
  }): Promise<readonly Interface[]> {
    validateCapsuleInterfaceBlueprints(input.blueprints);
    const records: Interface[] = [];
    const history = await this.list({
      workspaceId: input.workspaceId,
      ownerKind: "Capsule",
      ownerId: input.capsuleId,
      includeRetired: true,
    });
    for (const blueprint of input.blueprints) {
      const name = requireText(blueprint.name, "blueprint.name");
      const key = requireText(blueprint.key, "blueprint.key");
      const existing = history.find(
        (record) =>
          record.metadata.materializedFrom?.source === "capsule_blueprint" &&
          record.metadata.materializedFrom.key === key,
      );
      let materialized: Interface;
      if (existing) {
        // Once accepted, the Interface is authoritative and independent from
        // later catalog/config edits. Never overwrite user/operator changes.
        materialized = existing;
      } else {
        const { inputs: blueprintInputs, ...blueprintSpec } = blueprint.spec;
        const inputs = materializeCapsuleBlueprintInputs(
          blueprintInputs,
          input.capsuleId,
        );
        materialized = await this.create(
          {
            workspaceId: input.workspaceId,
            name,
            ownerRef: { kind: "Capsule", id: input.capsuleId },
            ...(blueprint.labels ? { labels: blueprint.labels } : {}),
            spec: {
              ...blueprintSpec,
              ...(Object.keys(inputs).length > 0 ? { inputs } : {}),
            },
          },
          undefined,
          { capsuleBlueprintKey: key },
        );
      }
      records.push(materialized);
      if (materialized.status.phase !== "Retired") {
        await this.#ensureCapsuleBlueprintBindings(
          materialized,
          key,
          blueprint.bindings ?? [],
        );
      }
    }
    return records;
  }

  async #ensureCapsuleBlueprintBindings(
    iface: Interface,
    interfaceKey: string,
    proposals: NonNullable<CapsuleInterfaceBlueprint["bindings"]>,
  ): Promise<void> {
    const history = [
      ...(await this.#stores.bindings.listByInterface(iface.metadata.id)),
    ];
    for (const proposal of proposals) {
      const key = requireText(proposal.key, "binding blueprint key");
      if (!("subjectRef" in proposal) || !proposal.subjectRef) {
        throw new InterfaceServiceError(
          "failed_precondition",
          "installing Principal binding placeholders must be resolved before Capsule Interface materialization",
        );
      }
      const subjectRef = proposal.subjectRef;
      if (
        history.some(
          (binding) =>
            (binding.metadata.materializedFrom?.source ===
              "capsule_blueprint" &&
              binding.metadata.materializedFrom.interfaceKey === interfaceKey &&
              binding.metadata.materializedFrom.key === key) ||
            // A previous manual or pre-provenance grant for the same exact
            // subject is authoritative too. In particular, a revoked grant is
            // a durable deny and must never be silently recreated.
            (binding.spec.subjectRef.kind === subjectRef.kind &&
              binding.spec.subjectRef.id === subjectRef.id),
        )
      ) {
        continue;
      }
      try {
        const created = await this.createBinding(
          iface.metadata.id,
          {
            subjectRef,
            permissions: proposal.permissions,
            delivery: proposal.delivery,
          },
          undefined,
          {
            capsuleBlueprintKey: interfaceKey,
            bindingBlueprintKey: key,
          },
        );
        history.push(created);
      } catch (error) {
        if (
          !(error instanceof InterfaceServiceError) ||
          error.code !== "already_exists"
        ) {
          throw error;
        }
        // Concurrent hydration can win the active-subject uniqueness race.
        // Accept only an actually persisted exact-subject record.
        const refreshed = await this.#stores.bindings.listByInterface(
          iface.metadata.id,
        );
        const accepted = refreshed.find(
          (binding) =>
            binding.spec.subjectRef.kind === subjectRef.kind &&
            binding.spec.subjectRef.id === subjectRef.id,
        );
        if (!accepted) throw error;
        history.push(accepted);
      }
    }
  }

  async get(id: string): Promise<Interface> {
    const record = await this.#stores.interfaces.get(requireText(id, "id"));
    if (!record)
      throw new InterfaceServiceError("not_found", "Interface not found");
    return record;
  }

  list(filter: InterfaceListFilter): Promise<readonly Interface[]> {
    const workspaceId = requireText(filter.workspaceId, "workspaceId");
    if (filter.type !== undefined) validateToken(filter.type, "type");
    return this.#stores.interfaces.list({
      ...filter,
      workspaceId,
      ...(filter.type !== undefined ? { type: filter.type.trim() } : {}),
    });
  }

  /**
   * Bounded crash repair for a host projection sink. The canonical Interface
   * store is traversed by immutable-id keyset pages; the sink remains
   * idempotent and receives the current Bindings for each row.
   */
  async repairProjections(
    options: { readonly cursor?: string; readonly limit?: number } = {},
  ): Promise<InterfaceProjectionRepairResult> {
    if (!this.#projectionSink) {
      return { scanned: 0, projected: 0, failed: 0 };
    }
    const limit = Math.min(100, Math.max(1, options.limit ?? 25));
    const cursor = options.cursor?.trim();
    const candidates = await this.#stores.interfaces.listProjectionPage({
      ...(cursor ? { cursor } : {}),
      limit: limit + 1,
    });
    const page = candidates.slice(0, limit);
    let projected = 0;
    let failed = 0;
    for (const iface of page) {
      if (await this.#projectInterface(iface)) projected += 1;
      else failed += 1;
    }
    const last = page.at(-1)?.metadata.id;
    return {
      scanned: page.length,
      projected,
      failed,
      ...(last && candidates.length > page.length ? { nextCursor: last } : {}),
    };
  }

  async capsuleOutputNames(
    workspaceId: string,
    capsuleId: string,
  ): Promise<readonly string[]> {
    const interfaces = await this.list({
      workspaceId,
      includeRetired: false,
    });
    return [
      ...new Set(
        interfaces.flatMap((iface) =>
          Object.values(iface.spec.inputs ?? {})
            .filter(
              (
                input,
              ): input is Extract<
                InterfaceInput,
                {
                  readonly source: "capsule_output";
                }
              > =>
                input.source === "capsule_output" &&
                input.capsuleId === capsuleId,
            )
            .map((input) => input.outputName),
        ),
      ),
    ].sort((left, right) => left.localeCompare(right));
  }

  /**
   * Runtime discovery is capability based, not Workspace-membership based.
   * Control-plane callers use `list`; a workload/user OAuth principal only
   * receives Interfaces with a current Ready binding for the exact permission.
   */
  async listAuthorizedForPrincipal(
    filter: InterfaceListFilter,
    subjectId: string,
    permission: string,
  ): Promise<readonly Interface[]> {
    const normalizedSubject = requireText(subjectId, "subjectId");
    validatePermissionToken(permission, "permission");
    const normalizedPermission = permission.trim();
    await this.#hydrateWorkspace?.(
      requireText(filter.workspaceId, "workspaceId"),
    );
    const requestedPhase = filter.phase;
    const candidates = await this.list({
      ...filter,
      phase: undefined,
      includeRetired: false,
    });
    // Runtime reads are a fail-closed repair boundary. Re-resolve before
    // returning a capability so a lost observer or StateVersion restore can
    // never expose a stale endpoint. Recovery is allowed only because the
    // lifecycle guard rechecks the durable Run/owner state on this same path.
    const refreshed = await Promise.all(
      candidates.map(async (iface) => {
        try {
          return await this.reconcile(iface.metadata.id, {
            allowSafetyRecovery: true,
          });
        } catch {
          return undefined;
        }
      }),
    );
    const interfaces = refreshed.filter(
      (iface): iface is Interface =>
        iface !== undefined &&
        (requestedPhase === undefined || iface.status.phase === requestedPhase),
    );
    const authorized = await Promise.all(
      interfaces.map(async (iface) => ({
        iface,
        allowed: await this.#principalBindings(
          iface,
          normalizedSubject,
          normalizedPermission,
        ),
      })),
    );
    return authorized
      .filter((entry) => entry.allowed.length > 0)
      .map((entry) => entry.iface);
  }

  async getAuthorizedForPrincipal(
    interfaceId: string,
    subjectId: string,
    permission: string,
  ): Promise<Interface> {
    const iface = await this.reconcile(interfaceId, {
      allowSafetyRecovery: true,
    });
    validatePermissionToken(permission, "permission");
    const bindings = await this.#principalBindings(
      iface,
      requireText(subjectId, "subjectId"),
      permission.trim(),
    );
    if (bindings.length === 0) {
      // Do not turn this endpoint into an Interface id oracle.
      throw new InterfaceServiceError("not_found", "Interface not found");
    }
    return iface;
  }

  async listAuthorizedBindingsForPrincipal(
    interfaceId: string,
    subjectId: string,
    permission: string,
  ): Promise<readonly InterfaceBinding[]> {
    const iface = await this.getAuthorizedForPrincipal(
      interfaceId,
      subjectId,
      permission,
    );
    return await this.#principalBindings(
      iface,
      requireText(subjectId, "subjectId"),
      permission.trim(),
    );
  }

  async issueToken(
    interfaceId: string,
    request: IssueInterfaceTokenRequest,
    principal: {
      readonly workspaceId: string;
      readonly subjectId: string;
    },
    actor?: ActorContext,
  ): Promise<IssueInterfaceTokenResponse> {
    const permission = normalizeIssueTokenRequest(request);
    const workspaceId = requireText(principal.workspaceId, "workspaceId");
    const subjectId = requireText(principal.subjectId, "subjectId");
    if (!this.#credentialIssuer) {
      throw new InterfaceServiceError(
        "failed_precondition",
        "Interface OAuth2 credential issuer is not configured",
      );
    }

    // This is the invocation authority boundary: repair lifecycle state and
    // re-read the exact current Principal grant immediately before issuance.
    const iface = await this.reconcile(interfaceId, {
      allowSafetyRecovery: true,
    });
    if (iface.metadata.workspaceId !== workspaceId) {
      throw new InterfaceServiceError("not_found", "Interface not found");
    }
    const binding = (
      await this.#principalBindings(iface, subjectId, permission)
    ).find(
      (candidate) =>
        candidate.metadata.workspaceId === workspaceId &&
        candidate.spec.delivery.type === "oauth2" &&
        candidate.spec.delivery.credentialRef === undefined &&
        candidate.spec.delivery.options === undefined,
    );
    if (!binding) {
      throw new InterfaceServiceError(
        "not_found",
        "Interface token grant not found",
      );
    }
    const resource = resolvedOAuth2Resource(iface);
    if (!resource) {
      throw new InterfaceServiceError(
        "failed_precondition",
        "Interface OAuth2 resource URI is unavailable",
      );
    }
    if (
      !this.#oauth2ResourceAuthorizer ||
      !(await oauth2ResourceAuthorized(this.#oauth2ResourceAuthorizer, {
        workspaceId,
        interfaceId: iface.metadata.id,
        ownerRef: iface.metadata.ownerRef,
        resource,
      }))
    ) {
      throw new InterfaceServiceError(
        "failed_precondition",
        "Interface owner is not authoritative for the OAuth2 resource",
      );
    }

    const issuedAt = this.#now();
    const issuedAtMillis = Date.parse(issuedAt);
    if (!Number.isFinite(issuedAtMillis)) {
      throw new InterfaceServiceError(
        "failed_precondition",
        "Interface credential issuer clock is invalid",
      );
    }
    const issued = await this.#credentialIssuer.issuePrincipalOAuth2Token({
      issuedAt,
      workspaceId,
      interfaceId: iface.metadata.id,
      interfaceGeneration: iface.metadata.generation,
      interfaceResolvedRevision: iface.status.resolvedRevision,
      interfaceOwnerRef: iface.metadata.ownerRef,
      bindingId: binding.metadata.id,
      bindingGeneration: binding.metadata.generation,
      subjectId,
      permission,
      resource,
    });
    if (
      typeof issued.accessToken !== "string" ||
      issued.accessToken.length === 0 ||
      issued.accessToken !== issued.accessToken.trim() ||
      issued.accessToken.length > 8_192 ||
      /\s/u.test(issued.accessToken)
    ) {
      throw new InterfaceServiceError(
        "failed_precondition",
        "Interface credential issuer returned an invalid Bearer token",
      );
    }
    const accessToken = issued.accessToken;
    const expiresAtMillis = Date.parse(issued.expiresAt);
    if (
      !Number.isFinite(expiresAtMillis) ||
      expiresAtMillis <= issuedAtMillis ||
      expiresAtMillis - issuedAtMillis > INTERFACE_OAUTH2_MAX_TTL_MS
    ) {
      throw new InterfaceServiceError(
        "failed_precondition",
        "Interface credential issuer returned an invalid token lifetime",
      );
    }
    const expiresAt = new Date(expiresAtMillis).toISOString();

    // The issuer is an asynchronous host boundary. An Interface update,
    // lifecycle transition, or Binding revoke may win while it is minting the
    // credential. Reconcile and compare the exact authority once more before
    // exposing the raw token. A token minted for a losing race remains
    // unreachable (and expires within 60 seconds) instead of being returned
    // under stale authorization evidence.
    const currentInterface = await this.reconcile(iface.metadata.id, {
      allowSafetyRecovery: true,
    });
    const currentBinding = await this.#stores.bindings.get(binding.metadata.id);
    const resourceStillAuthorized =
      this.#oauth2ResourceAuthorizer !== undefined &&
      (await oauth2ResourceAuthorized(this.#oauth2ResourceAuthorizer, {
        workspaceId,
        interfaceId: currentInterface.metadata.id,
        ownerRef: currentInterface.metadata.ownerRef,
        resource,
      }));
    if (
      currentInterface.metadata.workspaceId !== workspaceId ||
      currentInterface.metadata.generation !== iface.metadata.generation ||
      currentInterface.status.phase !== "Resolved" ||
      currentInterface.status.resolvedRevision !==
        iface.status.resolvedRevision ||
      resolvedOAuth2Resource(currentInterface) !== resource ||
      !resourceStillAuthorized ||
      !currentBinding ||
      currentBinding.metadata.workspaceId !== workspaceId ||
      currentBinding.metadata.generation !== binding.metadata.generation ||
      currentBinding.status.phase !== "Ready" ||
      currentBinding.status.observedInterfaceRevision !==
        currentInterface.status.resolvedRevision ||
      currentBinding.spec.interfaceId !== currentInterface.metadata.id ||
      currentBinding.spec.subjectRef.kind !== "Principal" ||
      currentBinding.spec.subjectRef.id !== subjectId ||
      !currentBinding.spec.permissions.includes(permission) ||
      currentBinding.spec.delivery.type !== "oauth2" ||
      currentBinding.spec.delivery.credentialRef !== undefined ||
      currentBinding.spec.delivery.options !== undefined
    ) {
      throw new InterfaceServiceError(
        "conflict",
        "Interface authorization changed during credential issuance",
      );
    }
    await this.#recordActivity({
      actor,
      workspaceId,
      action: "interface_token.issued",
      targetType: "interface_binding",
      targetId: binding.metadata.id,
      metadata: {
        interfaceId: iface.metadata.id,
        bindingId: binding.metadata.id,
        permission,
        interfaceResolvedRevision: iface.status.resolvedRevision,
        expiresAt,
      },
    });
    return {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: Math.ceil((expiresAtMillis - issuedAtMillis) / 1_000),
      expires_at: expiresAt,
      scope: permission,
      resource,
    };
  }

  async update(
    id: string,
    request: UpdateInterfaceRequest,
    expectedGeneration: number,
    actor?: ActorContext,
    expectedResolvedRevision?: number,
  ): Promise<Interface> {
    const rawRequest = requireRecord(request, "update request");
    assertOnlyKeys(rawRequest, ["name", "labels", "spec"], "update request");
    if (Object.keys(rawRequest).length === 0) {
      throw new InterfaceServiceError(
        "invalid_argument",
        "update request must change name, labels, or spec",
      );
    }
    const current = await this.get(id);
    if (current.status.phase === "Retired") {
      throw new InterfaceServiceError(
        "failed_precondition",
        "retired Interface cannot be updated",
      );
    }
    if (
      current.status.phase === "Unknown" ||
      current.status.phase === "Terminating"
    ) {
      throw new InterfaceServiceError(
        "failed_precondition",
        "Unknown or Terminating Interface cannot be changed until owner recovery",
      );
    }
    if (current.metadata.generation !== expectedGeneration) {
      throw new InterfaceServiceError(
        "conflict",
        "Interface generation changed",
      );
    }
    if (
      expectedResolvedRevision !== undefined &&
      current.status.resolvedRevision !== expectedResolvedRevision
    ) {
      throw new InterfaceServiceError(
        "conflict",
        "Interface resolved revision changed",
      );
    }
    const now = this.#now();
    const next: Interface = {
      ...current,
      metadata: {
        ...current.metadata,
        name:
          request.name === undefined
            ? current.metadata.name
            : requireText(request.name, "name"),
        ownerRef: current.metadata.ownerRef,
        ...(request.labels === undefined
          ? {
              ...(current.metadata.labels
                ? { labels: current.metadata.labels }
                : {}),
            }
          : { labels: normalizeLabels(request.labels) }),
        generation: current.metadata.generation + 1,
        updatedAt: now,
      },
      spec:
        request.spec === undefined ? current.spec : normalizeSpec(request.spec),
      status: {
        ...current.status,
        phase: "Pending",
        conditions: [
          condition(
            "Ready",
            "unknown",
            "PendingResolution",
            now,
            current.metadata.generation + 1,
          ),
        ],
      },
    };
    const expected = guard(current);
    if (!(await this.#stores.interfaces.compareAndSet(next, expected))) {
      throw new InterfaceServiceError(
        "conflict",
        "Interface changed concurrently",
      );
    }
    await this.#projectInterface(next);
    await this.#recordActivity({
      actor,
      workspaceId: next.metadata.workspaceId,
      action: "interface.updated",
      targetType: "interface",
      targetId: next.metadata.id,
      metadata: {
        name: next.metadata.name,
        generation: next.metadata.generation,
        interfaceType: next.spec.type,
        interfaceVersion: next.spec.version,
      },
    });
    return await this.reconcile(id);
  }

  async reconcile(
    id: string,
    options: { readonly allowSafetyRecovery?: boolean } = {},
  ): Promise<Interface> {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const current = await this.get(id);
      if (current.status.phase === "Retired") return current;
      if (
        !options.allowSafetyRecovery &&
        (current.status.phase === "Unknown" ||
          current.status.phase === "Terminating")
      ) {
        return current;
      }
      let resolution: InterfaceResolutionResult;
      const lifecycleBlock = await this.#lifecycleGuard?.({
        workspaceId: current.metadata.workspaceId,
        ownerRef: current.metadata.ownerRef,
        inputs: current.spec.inputs ?? {},
      });
      if (lifecycleBlock) {
        resolution = lifecycleBlock;
      } else if (current.spec.access.policyRef && !this.#policyAllows) {
        resolution = {
          ok: false,
          phase: "NotReady",
          reason: "UnsupportedPolicy",
          message: "Interface policyRef has no configured Policy evaluator",
        };
      } else if (
        current.spec.access.policyRef &&
        !(await this.#policyAllows!({
          workspaceId: current.metadata.workspaceId,
          policyRef: current.spec.access.policyRef,
          iface: current,
        }))
      ) {
        resolution = {
          ok: false,
          phase: "NotReady",
          reason: "PolicyDenied",
          message: "Interface policy did not allow resolution",
        };
      } else if (
        this.#ownerReady &&
        !(await this.#ownerReady({
          workspaceId: current.metadata.workspaceId,
          ownerRef: current.metadata.ownerRef,
        }))
      ) {
        resolution = {
          ok: false,
          phase: "NotReady",
          reason: "OwnerNotReady",
          message: "Interface owner is not Ready in the Workspace",
        };
      } else {
        resolution = await this.#resolver.resolve({
          workspaceId: current.metadata.workspaceId,
          specGeneration: current.metadata.generation,
          inputs: current.spec.inputs ?? {},
        });
      }
      if (resolution.ok) {
        const resourceUriInput = current.spec.access.resourceUriInput;
        if (resourceUriInput !== undefined) {
          try {
            validateResolvedResourceUri(
              resolution.resolvedInputs[resourceUriInput],
              resourceUriInput,
            );
          } catch (error) {
            resolution = {
              ok: false,
              phase: "NotReady",
              reason: "InvalidResourceUri",
              message:
                error instanceof Error
                  ? error.message
                  : "resolved resource URI is invalid",
            };
          }
        }
      }
      if (resolution.ok) {
        try {
          validateJsonDocument(
            resolution.resolvedInputs,
            "resolved Interface inputs",
            262_144,
          );
          if (jsonByteLength(resolution.resolvedInputs) > 262_144) {
            throw new InterfaceServiceError(
              "invalid_argument",
              "resolved Interface inputs exceed 256 KiB",
            );
          }
        } catch (error) {
          resolution = {
            ok: false,
            phase: "NotReady",
            reason: "InvalidResolvedInputs",
            message:
              error instanceof Error
                ? error.message
                : "resolved Interface inputs are invalid",
          };
        }
      }
      const now = this.#now();
      const nextStatus = resolution.ok
        ? await resolvedStatus(current, resolution, now)
        : unresolvedStatus(current, resolution, now);
      if (await statusSemanticallyEqual(current.status, nextStatus)) {
        await this.#refreshBindings(current.metadata.id);
        await this.#projectInterface(current);
        return current;
      }
      const next: Interface = {
        ...current,
        metadata: { ...current.metadata, updatedAt: now },
        status: nextStatus,
      };
      if (await this.#stores.interfaces.compareAndSet(next, guard(current))) {
        await this.#refreshBindings(next.metadata.id);
        await this.#projectInterface(next);
        return next;
      }
    }
    throw new InterfaceServiceError(
      "conflict",
      "Interface resolution did not converge",
    );
  }

  async reconcileCapsule(
    workspaceId: string,
    capsuleId: string,
  ): Promise<readonly Interface[]> {
    const interfaces = await this.list({ workspaceId, includeRetired: false });
    const affected = interfaces.filter(
      (item) =>
        (item.metadata.ownerRef.kind === "Capsule" &&
          item.metadata.ownerRef.id === capsuleId) ||
        Object.values(item.spec.inputs ?? {}).some(
          (input) =>
            input.source === "capsule_output" && input.capsuleId === capsuleId,
        ),
    );
    return await Promise.all(
      affected.map((item) =>
        this.reconcile(item.metadata.id, { allowSafetyRecovery: true }),
      ),
    );
  }

  /**
   * Records that a Capsule plan is observing desired/provider state without
   * replacing the currently pinned runtime revision. Existing delivery stays
   * Ready; the condition is lifecycle evidence, not a new endpoint revision.
   */
  async markCapsulePlanPending(
    workspaceId: string,
    capsuleId: string,
    runId: string,
  ): Promise<void> {
    const pendingMessage = planObservationMessage(runId);
    const interfaces = await this.list({ workspaceId, includeRetired: false });
    for (const item of interfaces.filter((current) =>
      interfaceReferencesCapsule(current, capsuleId),
    )) {
      await this.#updateStatusConditions(item.metadata.id, (current, now) => {
        if (
          current.status.phase === "Unknown" ||
          current.status.phase === "Terminating" ||
          current.status.phase === "Retired"
        ) {
          return current.status.conditions ?? [];
        }
        return [
          ...(current.status.conditions ?? []).filter(
            (item) => item.type !== "ObservationPending",
          ),
          condition(
            "ObservationPending",
            "true",
            "PlanObservationPending",
            now,
            current.metadata.generation,
            pendingMessage,
          ),
        ];
      });
    }
  }

  /**
   * Completes the matching plan observation. Drift checks can atomically add
   * or clear the Drifted condition while retaining resolved inputs and the
   * resolvedRevision. Failed/cancelled observations remove only their pending
   * marker and never erase previously observed drift.
   */
  async completeCapsulePlanObservation(
    workspaceId: string,
    capsuleId: string,
    runId: string,
    outcome: { readonly drift?: "detected" | "clear" } = {},
  ): Promise<void> {
    const pendingMessage = planObservationMessage(runId);
    const interfaces = await this.list({ workspaceId, includeRetired: false });
    for (const item of interfaces.filter((current) =>
      interfaceReferencesCapsule(current, capsuleId),
    )) {
      await this.#updateStatusConditions(item.metadata.id, (current, now) => {
        let conditions = (current.status.conditions ?? []).filter(
          (item) =>
            !(
              item.type === "ObservationPending" &&
              item.reason === "PlanObservationPending" &&
              item.message === pendingMessage
            ),
        );
        if (outcome.drift === "clear") {
          conditions = conditions.filter((item) => item.type !== "Drifted");
        } else if (
          outcome.drift === "detected" &&
          current.status.phase === "Resolved"
        ) {
          conditions = [
            ...conditions.filter((item) => item.type !== "Drifted"),
            condition(
              "Drifted",
              "true",
              "DriftDetected",
              now,
              current.metadata.generation,
              `OpenTofu drift check ${runId} observed provider changes`,
            ),
          ];
        }
        return conditions;
      });
    }
  }

  async reconcileResource(
    workspaceId: string,
    resourceId: string,
  ): Promise<readonly Interface[]> {
    const interfaces = await this.list({ workspaceId, includeRetired: false });
    const affected = interfaces.filter(
      (item) =>
        (item.metadata.ownerRef.kind === "Resource" &&
          item.metadata.ownerRef.id === resourceId) ||
        Object.values(item.spec.inputs ?? {}).some(
          (input) =>
            input.source === "resource_output" &&
            input.resourceId === resourceId,
        ),
    );
    return await Promise.all(
      affected.map((item) =>
        this.reconcile(item.metadata.id, { allowSafetyRecovery: true }),
      ),
    );
  }

  /**
   * Replays Resource lifecycle state from its durable ledger for one Workspace.
   * This is the crash-repair path for a best-effort observer failure; callers
   * provide a Workspace-bounded snapshot instead of triggering a global scan.
   */
  async repairResourceLifecycles(
    workspaceId: string,
    snapshots: readonly ResourceInterfaceLifecycleSnapshot[],
  ): Promise<void> {
    const byResourceId = new Map(
      snapshots.map((snapshot) => [snapshot.resourceId, snapshot]),
    );
    if (byResourceId.size === 0) return;

    const interfaces = await this.list({ workspaceId, includeRetired: false });
    for (const current of interfaces) {
      const ownerSnapshot =
        current.metadata.ownerRef.kind === "Resource"
          ? byResourceId.get(current.metadata.ownerRef.id)
          : undefined;
      const referencedSnapshots = Object.values(current.spec.inputs ?? {})
        .filter(
          (
            input,
          ): input is Extract<
            InterfaceInput,
            { readonly source: "resource_output" }
          > => input.source === "resource_output",
        )
        .map((input) => byResourceId.get(input.resourceId))
        .filter(
          (snapshot): snapshot is ResourceInterfaceLifecycleSnapshot =>
            snapshot !== undefined,
        );
      if (!ownerSnapshot && referencedSnapshots.length === 0) continue;

      if (ownerSnapshot?.phase === "retired") {
        await this.#retireForLifecycleRepair(current.metadata.id);
        continue;
      }
      if (ownerSnapshot?.phase === "terminating") {
        await this.#markTerminating(current.metadata.id);
        continue;
      }
      const unknown = [ownerSnapshot, ...referencedSnapshots].find(
        (snapshot) => snapshot?.phase === "unknown",
      );
      if (unknown) {
        await this.#markUnknown(
          current.metadata.id,
          unknown.message ?? "Resource lifecycle requires recovery",
          "ResourceFailed",
        );
        continue;
      }

      // Ready recovers a missed success observer. not_ready, terminating, and
      // retired references are resolved fail-closed by the durable resolver.
      await this.reconcile(current.metadata.id, { allowSafetyRecovery: true });
    }
  }

  async markCapsuleUnknown(
    workspaceId: string,
    capsuleId: string,
    message: string,
  ): Promise<void> {
    const interfaces = await this.list({ workspaceId, includeRetired: false });
    for (const current of interfaces.filter(
      (item) =>
        (item.metadata.ownerRef.kind === "Capsule" &&
          item.metadata.ownerRef.id === capsuleId) ||
        Object.values(item.spec.inputs ?? {}).some(
          (input) =>
            input.source === "capsule_output" && input.capsuleId === capsuleId,
        ),
    )) {
      await this.#markUnknown(current.metadata.id, message);
    }
  }

  async #retireForLifecycleRepair(interfaceId: string): Promise<void> {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const current = await this.get(interfaceId);
      if (current.status.phase === "Retired") return;
      try {
        await this.retire(current.metadata.id, current.metadata.generation);
        return;
      } catch (error) {
        if (
          !(error instanceof InterfaceServiceError) ||
          error.code !== "conflict" ||
          attempt === 7
        ) {
          throw error;
        }
      }
    }
  }

  async markResourceUnknown(
    workspaceId: string,
    resourceId: string,
    message: string,
  ): Promise<void> {
    const interfaces = await this.list({ workspaceId, includeRetired: false });
    for (const current of interfaces.filter(
      (item) =>
        (item.metadata.ownerRef.kind === "Resource" &&
          item.metadata.ownerRef.id === resourceId) ||
        Object.values(item.spec.inputs ?? {}).some(
          (input) =>
            input.source === "resource_output" &&
            input.resourceId === resourceId,
        ),
    )) {
      await this.#markUnknown(current.metadata.id, message, "ResourceFailed");
    }
  }

  async retire(
    id: string,
    expectedGeneration: number,
    actor?: ActorContext,
    expectedResolvedRevision?: number,
  ): Promise<Interface> {
    const current = await this.get(id);
    if (current.status.phase === "Retired") return current;
    if (current.metadata.generation !== expectedGeneration) {
      throw new InterfaceServiceError(
        "conflict",
        "Interface generation changed",
      );
    }
    if (
      expectedResolvedRevision !== undefined &&
      current.status.resolvedRevision !== expectedResolvedRevision
    ) {
      throw new InterfaceServiceError(
        "conflict",
        "Interface resolved revision changed",
      );
    }
    const now = this.#now();
    const next: Interface = {
      ...current,
      metadata: {
        ...current.metadata,
        generation: current.metadata.generation + 1,
        updatedAt: now,
      },
      status: {
        phase: "Retired",
        observedGeneration: current.metadata.generation + 1,
        resolvedRevision: current.status.resolvedRevision + 1,
        conditions: [
          condition(
            "Ready",
            "false",
            "Retired",
            now,
            current.metadata.generation + 1,
          ),
        ],
      },
    };
    if (!(await this.#stores.interfaces.compareAndSet(next, guard(current)))) {
      throw new InterfaceServiceError(
        "conflict",
        "Interface changed concurrently",
      );
    }
    await this.#recordActivity({
      actor,
      workspaceId: next.metadata.workspaceId,
      action: "interface.retired",
      targetType: "interface",
      targetId: next.metadata.id,
      metadata: {
        name: next.metadata.name,
        generation: next.metadata.generation,
      },
    });
    await this.#refreshBindings(next.metadata.id);
    await this.#projectInterface(next);
    return next;
  }

  async markCapsuleTerminating(
    workspaceId: string,
    capsuleId: string,
  ): Promise<void> {
    const interfaces = await this.list({
      workspaceId,
      ownerKind: "Capsule",
      ownerId: capsuleId,
      includeRetired: false,
    });
    for (const current of interfaces) {
      await this.#markTerminating(current.metadata.id);
    }
    const references = await this.list({ workspaceId, includeRetired: false });
    for (const item of references) {
      if (
        item.metadata.ownerRef.kind === "Capsule" &&
        item.metadata.ownerRef.id === capsuleId
      ) {
        continue;
      }
      if (
        Object.values(item.spec.inputs ?? {}).some(
          (input) =>
            input.source === "capsule_output" && input.capsuleId === capsuleId,
        )
      ) {
        await this.#markUnknown(
          item.metadata.id,
          "referenced Capsule destroy has started",
          "OwnerTerminating",
        );
      }
    }
  }

  async markResourceTerminating(
    workspaceId: string,
    resourceId: string,
  ): Promise<void> {
    const interfaces = await this.list({
      workspaceId,
      ownerKind: "Resource",
      ownerId: resourceId,
      includeRetired: false,
    });
    for (const current of interfaces) {
      await this.#markTerminating(current.metadata.id);
    }

    // A delete claim makes resource_output unavailable. Re-resolve explicit
    // dependants so they fail closed without retiring an Interface owned by a
    // different object.
    const references = await this.list({ workspaceId, includeRetired: false });
    for (const item of references) {
      if (
        item.metadata.ownerRef.kind === "Resource" &&
        item.metadata.ownerRef.id === resourceId
      ) {
        continue;
      }
      if (
        Object.values(item.spec.inputs ?? {}).some(
          (input) =>
            input.source === "resource_output" &&
            input.resourceId === resourceId,
        )
      ) {
        await this.reconcile(item.metadata.id);
      }
    }
  }

  async retireCapsule(workspaceId: string, capsuleId: string): Promise<void> {
    const interfaces = await this.list({
      workspaceId,
      ownerKind: "Capsule",
      ownerId: capsuleId,
      includeRetired: false,
    });
    for (const item of interfaces) {
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const current = await this.get(item.metadata.id);
        if (current.status.phase === "Retired") break;
        try {
          await this.retire(current.metadata.id, current.metadata.generation);
          break;
        } catch (error) {
          if (
            !(error instanceof InterfaceServiceError) ||
            error.code !== "conflict" ||
            attempt === 7
          )
            throw error;
        }
      }
    }
    const references = await this.list({ workspaceId, includeRetired: false });
    for (const item of references) {
      if (
        Object.values(item.spec.inputs ?? {}).some(
          (input) =>
            input.source === "capsule_output" && input.capsuleId === capsuleId,
        )
      )
        await this.reconcile(item.metadata.id);
    }
  }

  async retireResource(workspaceId: string, resourceId: string): Promise<void> {
    const interfaces = await this.list({
      workspaceId,
      ownerKind: "Resource",
      ownerId: resourceId,
      includeRetired: false,
    });
    for (const item of interfaces) {
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const current = await this.get(item.metadata.id);
        if (current.status.phase === "Retired") break;
        try {
          await this.retire(current.metadata.id, current.metadata.generation);
          break;
        } catch (error) {
          if (
            !(error instanceof InterfaceServiceError) ||
            error.code !== "conflict" ||
            attempt === 7
          )
            throw error;
        }
      }
    }
    const references = await this.list({ workspaceId, includeRetired: false });
    for (const item of references) {
      if (
        Object.values(item.spec.inputs ?? {}).some(
          (input) =>
            input.source === "resource_output" &&
            input.resourceId === resourceId,
        )
      ) {
        await this.reconcile(item.metadata.id);
      }
    }
  }

  async createBinding(
    interfaceId: string,
    request: CreateInterfaceBindingRequest,
    actor?: ActorContext,
    materialization?: {
      readonly capsuleBlueprintKey: string;
      readonly bindingBlueprintKey: string;
    },
  ): Promise<InterfaceBinding> {
    validateBindingRequest(request);
    // Binding issuance is a runtime authority boundary too. Reconcile against
    // the durable lifecycle guard so a missed terminal observer cannot turn an
    // old Resolved row into a newly Ready grant.
    const iface = await this.reconcile(interfaceId, {
      allowSafetyRecovery: true,
    });
    if (iface.status.phase === "Retired") {
      throw new InterfaceServiceError(
        "failed_precondition",
        "Interface is retired",
      );
    }
    const now = this.#now();
    const readiness = await bindingReadiness(
      iface,
      request.delivery,
      request.subjectRef,
      this.#bindingDeliveryHandlers,
    );
    const record: InterfaceBinding = {
      apiVersion: TAKOSUMI_API_VERSION,
      kind: "InterfaceBinding",
      metadata: {
        id: this.#newId("ifb"),
        workspaceId: iface.metadata.workspaceId,
        generation: 1,
        ...(materialization
          ? {
              materializedFrom: {
                source: "capsule_blueprint" as const,
                interfaceKey: requireText(
                  materialization.capsuleBlueprintKey,
                  "capsuleBlueprintKey",
                ),
                key: requireText(
                  materialization.bindingBlueprintKey,
                  "bindingBlueprintKey",
                ),
              },
            }
          : {}),
        createdAt: now,
        updatedAt: now,
      },
      spec: {
        interfaceId,
        subjectRef: {
          kind: request.subjectRef.kind,
          id: requireText(request.subjectRef.id, "subjectRef.id"),
        },
        permissions: normalizeTokens(request.permissions, "permissions"),
        delivery: {
          type: requireText(request.delivery.type, "delivery.type"),
          ...(request.delivery.credentialRef
            ? {
                credentialRef: normalizeCredentialReference(
                  request.delivery.credentialRef,
                ),
              }
            : {}),
          ...(request.delivery.options
            ? { options: request.delivery.options }
            : {}),
        },
      },
      status: {
        phase: readiness.ready ? "Ready" : "NotReady",
        observedInterfaceRevision: iface.status.resolvedRevision,
        conditions: [
          condition(
            "Ready",
            readiness.ready ? "true" : "false",
            readiness.reason,
            now,
            1,
          ),
        ],
      },
    };
    if (!(await this.#stores.bindings.create(record))) {
      throw new InterfaceServiceError(
        "already_exists",
        "an active binding already exists for this subject",
      );
    }
    await this.#recordActivity({
      actor,
      workspaceId: record.metadata.workspaceId,
      action: "interface_binding.created",
      targetType: "interface_binding",
      targetId: record.metadata.id,
      metadata: {
        interfaceId,
        subjectKind: record.spec.subjectRef.kind,
        subjectId: record.spec.subjectRef.id,
        permissions: [...record.spec.permissions],
        deliveryType: record.spec.delivery.type,
      },
    });
    await this.#refreshBinding(record.metadata.id);
    await this.#projectInterface(await this.get(interfaceId));
    return await this.getBinding(interfaceId, record.metadata.id);
  }

  async listBindings(
    interfaceId: string,
  ): Promise<readonly InterfaceBinding[]> {
    await this.get(interfaceId);
    return this.#stores.bindings.listByInterface(interfaceId);
  }

  async getBinding(
    interfaceId: string,
    bindingId: string,
  ): Promise<InterfaceBinding> {
    await this.get(interfaceId);
    const binding = await this.#stores.bindings.get(bindingId);
    if (!binding || binding.spec.interfaceId !== interfaceId) {
      throw new InterfaceServiceError(
        "not_found",
        "InterfaceBinding not found",
      );
    }
    return binding;
  }

  async revokeBinding(
    interfaceId: string,
    bindingId: string,
    actor?: ActorContext,
  ): Promise<InterfaceBinding> {
    const current = await this.#stores.bindings.get(bindingId);
    if (!current || current.spec.interfaceId !== interfaceId) {
      throw new InterfaceServiceError(
        "not_found",
        "InterfaceBinding not found",
      );
    }
    if (current.status.phase === "Revoked") return current;
    const now = this.#now();
    const next: InterfaceBinding = {
      ...current,
      metadata: {
        ...current.metadata,
        generation: current.metadata.generation + 1,
        updatedAt: now,
      },
      status: {
        ...current.status,
        phase: "Revoked",
        conditions: [
          condition(
            "Ready",
            "false",
            "Revoked",
            now,
            current.metadata.generation + 1,
          ),
        ],
      },
    };
    if (
      !(await this.#stores.bindings.compareAndSet(
        next,
        current.metadata.generation,
      ))
    ) {
      throw new InterfaceServiceError(
        "conflict",
        "InterfaceBinding changed concurrently",
      );
    }
    await this.#recordActivity({
      actor,
      workspaceId: next.metadata.workspaceId,
      action: "interface_binding.revoked",
      targetType: "interface_binding",
      targetId: next.metadata.id,
      metadata: {
        interfaceId,
        subjectKind: next.spec.subjectRef.kind,
        subjectId: next.spec.subjectRef.id,
      },
    });
    await this.#projectInterface(await this.get(interfaceId));
    return next;
  }

  async #recordActivity(input: {
    readonly actor?: ActorContext;
    readonly workspaceId: string;
    readonly action: string;
    readonly targetType: string;
    readonly targetId: string;
    readonly metadata: Record<string, unknown>;
  }): Promise<void> {
    await this.#activity.record({
      workspaceId: input.workspaceId,
      ...(input.actor?.actorAccountId
        ? { actorId: input.actor.actorAccountId }
        : {}),
      action: input.action,
      targetType: input.targetType,
      targetId: input.targetId,
      metadata: input.metadata,
    });
  }

  async #updateStatusConditions(
    id: string,
    update: (current: Interface, now: string) => readonly Condition[],
  ): Promise<void> {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const current = await this.get(id);
      if (current.status.phase === "Retired") return;
      const now = this.#now();
      const nextStatus: Interface["status"] = {
        ...current.status,
        conditions: update(current, now),
      };
      if (await statusSemanticallyEqual(current.status, nextStatus)) return;
      const next: Interface = {
        ...current,
        metadata: { ...current.metadata, updatedAt: now },
        status: nextStatus,
      };
      if (await this.#stores.interfaces.compareAndSet(next, guard(current))) {
        await this.#projectInterface(next);
        return;
      }
    }
    throw new InterfaceServiceError(
      "conflict",
      "Interface observation condition transition did not converge",
    );
  }

  async #markUnknown(
    id: string,
    message: string,
    reason = "RunFailed",
  ): Promise<void> {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const current = await this.get(id);
      if (current.status.phase === "Retired") return;
      if (
        current.status.phase === "Unknown" &&
        current.status.resolvedInputs === undefined &&
        current.status.conditions?.[0]?.reason === reason &&
        current.status.conditions[0].message === message
      )
        return;
      const now = this.#now();
      const next: Interface = {
        ...current,
        metadata: { ...current.metadata, updatedAt: now },
        status: {
          phase: "Unknown",
          observedGeneration: current.metadata.generation,
          resolvedRevision: current.status.resolvedRevision + 1,
          conditions: [
            condition(
              "Ready",
              "unknown",
              reason,
              now,
              current.metadata.generation,
              message,
            ),
          ],
        },
      };
      if (await this.#stores.interfaces.compareAndSet(next, guard(current))) {
        await this.#refreshBindings(id);
        await this.#projectInterface(next);
        return;
      }
    }
    throw new InterfaceServiceError(
      "conflict",
      "Interface Unknown transition did not converge",
    );
  }

  async #markTerminating(id: string): Promise<void> {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const current = await this.get(id);
      if (
        current.status.phase === "Retired" ||
        current.status.phase === "Terminating"
      )
        return;
      const now = this.#now();
      const next: Interface = {
        ...current,
        metadata: { ...current.metadata, updatedAt: now },
        status: {
          phase: "Terminating",
          observedGeneration: current.metadata.generation,
          resolvedRevision: current.status.resolvedRevision + 1,
          conditions: [
            condition(
              "Ready",
              "false",
              "OwnerDestroyQueued",
              now,
              current.metadata.generation,
            ),
          ],
        },
      };
      if (await this.#stores.interfaces.compareAndSet(next, guard(current))) {
        await this.#refreshBindings(id);
        await this.#projectInterface(next);
        return;
      }
    }
    throw new InterfaceServiceError(
      "conflict",
      "Interface Terminating transition did not converge",
    );
  }

  async #refreshBindings(interfaceId: string): Promise<void> {
    const bindings = await this.#stores.bindings.listByInterface(interfaceId);
    for (const binding of bindings) {
      await this.#refreshBinding(binding.metadata.id);
    }
  }

  async #projectInterface(iface: Interface): Promise<boolean> {
    if (!this.#projectionSink) return true;
    try {
      await this.#projectionSink.project({
        interface: iface,
        bindings: await this.#stores.bindings.listByInterface(
          iface.metadata.id,
        ),
      });
      return true;
    } catch (error) {
      // The canonical row is already durable. A projection is an idempotent
      // cache/materialization and is repaired from the Interface list; it can
      // never roll back or become authority for this transition.
      log.warn("service.interface.projection_failed", {
        workspaceId: iface.metadata.workspaceId,
        interfaceId: iface.metadata.id,
        interfaceGeneration: iface.metadata.generation,
        interfaceResolvedRevision: iface.status.resolvedRevision,
        interfacePhase: iface.status.phase,
        errorName: error instanceof Error ? error.name : "UnknownError",
        failure: "projection_failed",
      });
      return false;
    }
  }

  async #refreshBinding(bindingId: string): Promise<void> {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const current = await this.#stores.bindings.get(bindingId);
      if (!current || current.status.phase === "Revoked") return;
      const iface = await this.get(current.spec.interfaceId);
      const readiness = await bindingReadiness(
        iface,
        current.spec.delivery,
        current.spec.subjectRef,
        this.#bindingDeliveryHandlers,
      );
      const retired = iface.status.phase === "Retired";
      const ready = readiness.ready;
      const desiredPhase = retired ? "Revoked" : ready ? "Ready" : "NotReady";
      if (
        current.status.phase === desiredPhase &&
        current.status.observedInterfaceRevision ===
          iface.status.resolvedRevision
      )
        return;
      const now = this.#now();
      const next: InterfaceBinding = {
        ...current,
        metadata: {
          ...current.metadata,
          generation: current.metadata.generation + 1,
          updatedAt: now,
        },
        status: {
          phase: desiredPhase,
          observedInterfaceRevision: iface.status.resolvedRevision,
          conditions: retired
            ? [
                condition(
                  "Ready",
                  "false",
                  "InterfaceRetired",
                  now,
                  current.metadata.generation + 1,
                ),
              ]
            : ready
              ? [
                  condition(
                    "Ready",
                    "true",
                    "Resolved",
                    now,
                    current.metadata.generation + 1,
                  ),
                ]
              : [
                  condition(
                    "Ready",
                    "false",
                    readiness.reason,
                    now,
                    current.metadata.generation + 1,
                  ),
                ],
        },
      };
      if (
        await this.#stores.bindings.compareAndSet(
          next,
          current.metadata.generation,
        )
      )
        return;
    }
    throw new InterfaceServiceError(
      "conflict",
      "InterfaceBinding refresh did not converge",
    );
  }

  async #principalBindings(
    iface: Interface,
    subjectId: string,
    permission: string,
  ): Promise<readonly InterfaceBinding[]> {
    if (iface.status.phase !== "Resolved") return [];
    return (
      await this.#stores.bindings.listByInterface(iface.metadata.id)
    ).filter(
      (binding) =>
        binding.spec.subjectRef.kind === "Principal" &&
        binding.spec.subjectRef.id === subjectId &&
        binding.spec.permissions.includes(permission) &&
        binding.status.phase === "Ready" &&
        binding.status.observedInterfaceRevision ===
          iface.status.resolvedRevision,
    );
  }
}

async function resolvedStatus(
  current: Interface,
  resolution: Extract<InterfaceResolutionResult, { readonly ok: true }>,
  now: string,
): Promise<Interface["status"]> {
  const before = await stableJsonDigest({
    phase: current.status.phase,
    observedGeneration: current.status.observedGeneration,
    resolvedInputs: current.status.resolvedInputs ?? {},
    provenance: current.status.provenance ?? {},
  });
  const after = await stableJsonDigest({
    phase: "Resolved",
    observedGeneration: current.metadata.generation,
    resolvedInputs: resolution.resolvedInputs,
    provenance: resolution.provenance,
  });
  return {
    phase: "Resolved",
    observedGeneration: current.metadata.generation,
    resolvedRevision:
      current.status.resolvedRevision + (before === after ? 0 : 1),
    resolvedInputs: resolution.resolvedInputs,
    provenance: resolution.provenance,
    conditions: [
      condition("Ready", "true", "Resolved", now, current.metadata.generation),
    ],
  };
}

async function statusSemanticallyEqual(
  left: Interface["status"],
  right: Interface["status"],
): Promise<boolean> {
  const withoutTransitionClock = (status: Interface["status"]) => ({
    ...status,
    ...(status.conditions
      ? {
          conditions: status.conditions.map(
            ({ lastTransitionAt: _, ...item }) => item,
          ),
        }
      : {}),
  });
  return (
    (await stableJsonDigest(withoutTransitionClock(left))) ===
    (await stableJsonDigest(withoutTransitionClock(right)))
  );
}

function unresolvedStatus(
  current: Interface,
  resolution: Extract<InterfaceResolutionResult, { readonly ok: false }>,
  now: string,
): Interface["status"] {
  const changed =
    current.status.phase !== resolution.phase ||
    current.status.observedGeneration !== current.metadata.generation ||
    current.status.resolvedInputs !== undefined;
  return {
    phase: resolution.phase,
    observedGeneration: current.metadata.generation,
    resolvedRevision: current.status.resolvedRevision + (changed ? 1 : 0),
    conditions: [
      condition(
        "Ready",
        resolution.phase === "Unknown" ? "unknown" : "false",
        resolution.reason,
        now,
        current.metadata.generation,
        resolution.message,
      ),
    ],
  };
}

function guard(record: Interface): InterfaceWriteGuard {
  return {
    generation: record.metadata.generation,
    resolvedRevision: record.status.resolvedRevision,
    record,
  };
}

function interfaceReferencesCapsule(
  iface: Interface,
  capsuleId: string,
): boolean {
  return (
    (iface.metadata.ownerRef.kind === "Capsule" &&
      iface.metadata.ownerRef.id === capsuleId) ||
    Object.values(iface.spec.inputs ?? {}).some(
      (input) =>
        input.source === "capsule_output" && input.capsuleId === capsuleId,
    )
  );
}

function planObservationMessage(runId: string): string {
  return `OpenTofu plan ${runId} is observing desired and provider state`;
}

function validateCreate(request: CreateInterfaceRequest): void {
  const raw = requireRecord(request, "request");
  assertOnlyKeys(
    raw,
    ["workspaceId", "name", "ownerRef", "labels", "spec"],
    "request",
  );
  const workspaceId = requireText(raw.workspaceId, "workspaceId");
  validateInterfaceName(raw.name, "name");
  const owner = normalizedOwner(raw.ownerRef);
  if (owner.kind === "Workspace" && owner.id !== workspaceId) {
    throw new InterfaceServiceError(
      "invalid_argument",
      "Workspace ownerRef.id must equal workspaceId",
    );
  }
  normalizeSpec(raw.spec as InterfaceSpec);
}

export function validateCapsuleInterfaceBlueprints(
  blueprints: readonly CapsuleInterfaceBlueprint[],
): void {
  if (!Array.isArray(blueprints)) {
    throw new InterfaceServiceError(
      "invalid_argument",
      "interfaceBlueprints must be an array",
    );
  }
  if (blueprints.length > 64) {
    throw new InterfaceServiceError(
      "invalid_argument",
      "interfaceBlueprints exceeds 64 entries",
    );
  }
  const names = new Set<string>();
  const keys = new Set<string>();
  for (const blueprint of blueprints) {
    const blueprintRecord = requireRecord(blueprint, "Interface blueprint");
    assertOnlyKeys(
      blueprintRecord,
      ["key", "name", "labels", "spec", "bindings"],
      "Interface blueprint",
    );
    const name = validateInterfaceName(blueprint.name, "blueprint.name");
    if (names.has(name)) {
      throw new InterfaceServiceError(
        "invalid_argument",
        `duplicate Interface blueprint name: ${name}`,
      );
    }
    names.add(name);
    const key = requireText(blueprint.key, "blueprint.key");
    validateToken(key, "blueprint.key");
    if (keys.has(key)) {
      throw new InterfaceServiceError(
        "invalid_argument",
        `duplicate Interface blueprint key: ${key}`,
      );
    }
    keys.add(key);
    const blueprintSpecRecord = requireRecord(
      blueprint.spec,
      "blueprint.spec",
    ) as unknown as CapsuleInterfaceBlueprint["spec"];
    assertOnlyKeys(
      blueprintSpecRecord as unknown as Record<string, unknown>,
      ["type", "version", "document", "inputs", "access"],
      "blueprint.spec",
    );
    const { inputs: blueprintInputs, ...blueprintSpec } = blueprintSpecRecord;
    const inputs = materializeCapsuleBlueprintInputs(
      blueprintInputs,
      "capsule_blueprint_validation",
    );
    normalizeLabels(blueprint.labels ?? {});
    normalizeSpec({
      ...blueprintSpec,
      ...(Object.keys(inputs).length > 0 ? { inputs } : {}),
    });
    validateCapsuleInterfaceBindingProposals(blueprint.bindings);
  }
}

function validateCapsuleInterfaceBindingProposals(
  proposals: CapsuleInterfaceBlueprint["bindings"],
): void {
  if (proposals === undefined) return;
  if (!Array.isArray(proposals)) {
    throw new InterfaceServiceError(
      "invalid_argument",
      "Interface blueprint bindings must be an array",
    );
  }
  if (proposals.length > 64) {
    throw new InterfaceServiceError(
      "invalid_argument",
      "Interface blueprint bindings exceeds 64 entries",
    );
  }
  const keys = new Set<string>();
  const subjects = new Set<string>();
  for (const proposal of proposals) {
    const raw = requireRecord(proposal, "Interface binding proposal");
    assertOnlyKeys(
      raw,
      ["key", "subjectRef", "subject", "permissions", "delivery"],
      "Interface binding proposal",
    );
    const key = requireText(raw.key, "Interface binding proposal key");
    validateToken(key, "Interface binding proposal key");
    if (keys.has(key)) {
      throw new InterfaceServiceError(
        "invalid_argument",
        `duplicate Interface binding proposal key: ${key}`,
      );
    }
    keys.add(key);
    const hasSubjectRef = raw.subjectRef !== undefined;
    const hasSubjectTemplate = raw.subject !== undefined;
    if (hasSubjectRef === hasSubjectTemplate) {
      throw new InterfaceServiceError(
        "invalid_argument",
        "Interface binding proposal must contain exactly one of subjectRef or subject",
      );
    }
    let subjectIdentity: string;
    if (hasSubjectRef) {
      validateBindingRequest({
        subjectRef: raw.subjectRef,
        permissions: raw.permissions,
        delivery: raw.delivery,
      } as CreateInterfaceBindingRequest);
      const subject = requireRecord(raw.subjectRef, "subjectRef");
      subjectIdentity = `${String(subject.kind)}\u0000${String(subject.id)}`;
    } else {
      const subject = requireRecord(raw.subject, "subject");
      assertOnlyKeys(subject, ["source"], "Interface binding proposal subject");
      if (subject.source !== "installing_principal") {
        throw new InterfaceServiceError(
          "invalid_argument",
          "Interface binding proposal subject.source must be installing_principal",
        );
      }
      validateBindingRequest({
        subjectRef: { kind: "Principal", id: "installing-principal" },
        permissions: raw.permissions,
        delivery: raw.delivery,
      } as CreateInterfaceBindingRequest);
      subjectIdentity = "installing_principal";
    }
    if (subjects.has(subjectIdentity)) {
      throw new InterfaceServiceError(
        "invalid_argument",
        "Interface binding proposals must use distinct subjects",
      );
    }
    subjects.add(subjectIdentity);
  }
}

function materializeCapsuleBlueprintInputs(
  inputs: Readonly<Record<string, CapsuleInterfaceBlueprintInput>> | undefined,
  capsuleId: string,
): Readonly<Record<string, InterfaceInput>> {
  if (inputs !== undefined && !isRecord(inputs)) {
    throw new InterfaceServiceError(
      "invalid_argument",
      "blueprint.spec.inputs must be an object",
    );
  }
  const materialized: Record<string, InterfaceInput> = {};
  for (const [name, source] of Object.entries(inputs ?? {})) {
    const raw = requireRecord(source, `blueprint input ${name}`);
    if (raw.source === "literal") {
      assertOnlyKeys(raw, ["source", "value"], `blueprint input ${name}`);
      validateJsonDocument(raw.value, `blueprint input ${name}.value`);
      materialized[name] = {
        source: "literal",
        value: raw.value as JsonValue,
      };
      continue;
    }
    if (raw.source === "capsule_output") {
      assertOnlyKeys(
        raw,
        ["source", "outputName", "pointer"],
        `blueprint input ${name}`,
      );
      materialized[name] = {
        source: "capsule_output",
        capsuleId,
        outputName: requireText(raw.outputName, `${name}.outputName`),
        ...(raw.pointer !== undefined
          ? { pointer: validatePointer(raw.pointer, name) }
          : {}),
      };
      continue;
    }
    if (raw.source !== "resource_output") {
      throw new InterfaceServiceError(
        "invalid_argument",
        `unsupported Interface blueprint input source for ${name}`,
      );
    }
    assertOnlyKeys(
      raw,
      ["source", "resourceId", "outputName", "pointer"],
      `blueprint input ${name}`,
    );
    materialized[name] = {
      source: "resource_output",
      resourceId: requireText(raw.resourceId, `${name}.resourceId`),
      outputName: requireText(raw.outputName, `${name}.outputName`),
      ...(raw.pointer !== undefined
        ? { pointer: validatePointer(raw.pointer, name) }
        : {}),
    };
  }
  return materialized;
}

function normalizeSpec(spec: InterfaceSpec): InterfaceSpec {
  const raw = requireRecord(spec, "spec");
  assertOnlyKeys(
    raw,
    ["type", "version", "document", "inputs", "access"],
    "spec",
  );
  const access = requireRecord(raw.access, "spec.access");
  assertOnlyKeys(
    access,
    ["visibility", "policyRef", "resourceUriInput"],
    "spec.access",
  );
  validateToken(raw.type, "spec.type");
  validateToken(raw.version, "spec.version");
  validateJsonDocument(raw.document, "spec.document");
  const inputs = normalizeInputs(raw.inputs ?? {});
  if (
    access.resourceUriInput !== undefined &&
    !Object.prototype.hasOwnProperty.call(
      inputs,
      requireText(access.resourceUriInput, "spec.access.resourceUriInput"),
    )
  ) {
    throw new InterfaceServiceError(
      "invalid_argument",
      "spec.access.resourceUriInput must name an Interface input",
    );
  }
  if (access.policyRef !== undefined) {
    requireText(access.policyRef, "spec.access.policyRef");
  }
  if (!["private", "workspace", "public"].includes(String(access.visibility))) {
    throw new InterfaceServiceError(
      "invalid_argument",
      "spec.access.visibility must be private, workspace, or public",
    );
  }
  const normalized: InterfaceSpec = {
    type: requireText(raw.type, "spec.type"),
    version: requireText(raw.version, "spec.version"),
    document: raw.document as JsonValue,
    ...(Object.keys(inputs).length > 0 ? { inputs } : {}),
    access: {
      visibility: access.visibility as InterfaceSpec["access"]["visibility"],
      ...(access.policyRef
        ? { policyRef: requireText(access.policyRef, "spec.access.policyRef") }
        : {}),
      ...(access.resourceUriInput
        ? {
            resourceUriInput: requireText(
              access.resourceUriInput,
              "spec.access.resourceUriInput",
            ),
          }
        : {}),
    },
  };
  if (jsonByteLength(normalized) > 262_144) {
    throw new InterfaceServiceError(
      "invalid_argument",
      "Interface spec exceeds 256 KiB",
    );
  }
  return normalized;
}

function normalizeInputs(
  inputs: unknown,
): Readonly<Record<string, InterfaceInput>> {
  const inputRecord = requireRecord(inputs, "spec.inputs");
  const entries = Object.entries(inputRecord);
  if (entries.length > 64) {
    throw new InterfaceServiceError(
      "invalid_argument",
      "spec.inputs exceeds 64 entries",
    );
  }
  const normalized: Record<string, InterfaceInput> = {};
  for (const [name, input] of entries) {
    validateInputName(name);
    const raw = requireRecord(input, `spec.inputs.${name}`);
    if (raw.source === "literal") {
      assertOnlyKeys(raw, ["source", "value"], `spec.inputs.${name}`);
      validateJsonDocument(raw.value, `spec.inputs.${name}.value`);
      normalized[name] = { source: "literal", value: raw.value as JsonValue };
      continue;
    }
    if (raw.source === "capsule_output") {
      assertOnlyKeys(
        raw,
        ["source", "capsuleId", "outputName", "pointer"],
        `spec.inputs.${name}`,
      );
      normalized[name] = {
        source: "capsule_output",
        capsuleId: requireText(raw.capsuleId, `${name}.capsuleId`),
        outputName: requireText(raw.outputName, `${name}.outputName`),
        ...(raw.pointer !== undefined
          ? { pointer: validatePointer(raw.pointer, name) }
          : {}),
      };
      continue;
    }
    if (raw.source === "resource_output") {
      assertOnlyKeys(
        raw,
        ["source", "resourceId", "outputName", "pointer"],
        `spec.inputs.${name}`,
      );
      normalized[name] = {
        source: "resource_output",
        resourceId: requireText(raw.resourceId, `${name}.resourceId`),
        outputName: requireText(raw.outputName, `${name}.outputName`),
        ...(raw.pointer !== undefined
          ? { pointer: validatePointer(raw.pointer, name) }
          : {}),
      };
      continue;
    }
    throw new InterfaceServiceError(
      "invalid_argument",
      `unsupported Interface input source for ${name}`,
    );
  }
  return normalized;
}

function validateBindingRequest(request: CreateInterfaceBindingRequest): void {
  const raw = requireRecord(request, "binding request");
  assertOnlyKeys(
    raw,
    ["subjectRef", "permissions", "delivery"],
    "binding request",
  );
  const subjectRef = requireRecord(raw.subjectRef, "subjectRef");
  const delivery = requireRecord(raw.delivery, "delivery");
  assertOnlyKeys(subjectRef, ["kind", "id"], "subjectRef");
  assertOnlyKeys(delivery, ["type", "credentialRef", "options"], "delivery");
  if (
    !["Principal", "ServiceAccount", "Capsule", "Resource"].includes(
      String(subjectRef.kind),
    )
  ) {
    throw new InterfaceServiceError(
      "invalid_argument",
      "subjectRef.kind is not supported",
    );
  }
  requireText(subjectRef.id, "subjectRef.id");
  normalizeTokens(raw.permissions, "permissions");
  validateToken(delivery.type, "delivery.type");
  if (delivery.credentialRef !== undefined) {
    normalizeCredentialReference(delivery.credentialRef);
  }
  if (delivery.options !== undefined) {
    requireRecord(delivery.options, "delivery.options");
    validateJsonDocument(delivery.options, "delivery.options");
  }
}

function normalizeIssueTokenRequest(
  request: IssueInterfaceTokenRequest,
): string {
  const raw = requireRecord(request, "Interface token request");
  assertOnlyKeys(raw, ["permission"], "Interface token request");
  validatePermissionToken(raw.permission, "permission");
  return requireText(raw.permission, "permission");
}

function normalizeCredentialReference(value: unknown): string {
  const reference = requireText(value, "delivery.credentialRef");
  if (
    reference.length > 256 ||
    !/^(?:secret|credential)[/:][A-Za-z0-9][A-Za-z0-9._:/-]*$/u.test(reference)
  ) {
    throw new InterfaceServiceError(
      "invalid_argument",
      "delivery.credentialRef must be a secret/... or credential/... reference identifier",
    );
  }
  return reference;
}

async function bindingReadiness(
  iface: Interface,
  delivery: InterfaceBinding["spec"]["delivery"],
  subjectRef: InterfaceBinding["spec"]["subjectRef"],
  handlers: ReadonlyMap<string, InterfaceBindingDeliveryHandler>,
): Promise<InterfaceBindingDeliveryReadiness> {
  if (iface.status.phase !== "Resolved") {
    return { ready: false, reason: "InterfaceNotReady" };
  }
  const handler = handlers.get(delivery.type);
  if (!handler) return { ready: false, reason: "UnsupportedDelivery" };
  try {
    return await handler({ iface, delivery, subjectRef });
  } catch {
    // A host adapter is outside the durable state machine. Never let a plugin
    // exception accidentally preserve or create a Ready grant.
    return { ready: false, reason: "DeliveryHandlerFailed" };
  }
}

function createBindingDeliveryHandlerRegistry(input: {
  readonly credentialIssuerConfigured: boolean;
  readonly oauth2ResourceAuthorizer?: InterfaceOAuth2ResourceAuthorizer;
  readonly additional?: InterfaceBindingDeliveryHandlerRegistry;
}): ReadonlyMap<string, InterfaceBindingDeliveryHandler> {
  const handlers = new Map<string, InterfaceBindingDeliveryHandler>();
  handlers.set("none", ({ delivery }) =>
    delivery.credentialRef === undefined && delivery.options === undefined
      ? { ready: true, reason: "Resolved" }
      : { ready: false, reason: "UnsupportedDeliveryConfiguration" },
  );
  handlers.set("oauth2", async ({ iface, delivery, subjectRef }) => {
    if (
      subjectRef.kind !== "Principal" ||
      delivery.credentialRef !== undefined ||
      delivery.options !== undefined ||
      !input.credentialIssuerConfigured
    ) {
      return { ready: false, reason: "UnsupportedDelivery" };
    }
    const resource = resolvedOAuth2Resource(iface);
    if (!resource) {
      return { ready: false, reason: "OAuthResourceUnavailable" };
    }
    if (!input.oauth2ResourceAuthorizer) {
      return { ready: false, reason: "OAuthResourceAuthorityUnavailable" };
    }
    if (
      !(await oauth2ResourceAuthorized(input.oauth2ResourceAuthorizer, {
        workspaceId: iface.metadata.workspaceId,
        interfaceId: iface.metadata.id,
        ownerRef: iface.metadata.ownerRef,
        resource,
      }))
    ) {
      return { ready: false, reason: "OAuthResourceUnauthorized" };
    }
    return { ready: true, reason: "Resolved" };
  });
  // Final Plan v1alpha1 deliberately reserves this exact public token for a
  // future ServiceAccount workload identity implementation. A generic host
  // handler may add another namespaced delivery token, but it must not make
  // `workload_token` Ready before the standard issuer/materializer contract
  // exists.
  handlers.set("workload_token", () => ({
    ready: false,
    reason: "UnsupportedDelivery",
  }));
  for (const [type, handler] of Object.entries(input.additional ?? {})) {
    validateToken(type, "bindingDeliveryHandlers key");
    if (handlers.has(type)) {
      throw new InterfaceServiceError(
        "invalid_argument",
        `InterfaceBinding delivery handler ${type} is already registered`,
      );
    }
    if (typeof handler !== "function") {
      throw new InterfaceServiceError(
        "invalid_argument",
        `InterfaceBinding delivery handler ${type} must be a function`,
      );
    }
    handlers.set(type, handler);
  }
  return handlers;
}

async function oauth2ResourceAuthorized(
  authorizer: InterfaceOAuth2ResourceAuthorizer,
  input: Parameters<InterfaceOAuth2ResourceAuthorizer>[0],
): Promise<boolean> {
  try {
    return (await authorizer(input)) === true;
  } catch {
    return false;
  }
}

function resolvedOAuth2Resource(iface: Interface): string | undefined {
  if (iface.status.phase !== "Resolved") return undefined;
  const inputName = iface.spec.access.resourceUriInput;
  if (!inputName) return undefined;
  try {
    return validateResolvedResourceUri(
      iface.status.resolvedInputs?.[inputName],
      inputName,
    );
  } catch {
    return undefined;
  }
}

function normalizedOwner(owner: unknown): Interface["metadata"]["ownerRef"] {
  const raw = requireRecord(owner, "ownerRef");
  assertOnlyKeys(raw, ["kind", "id"], "ownerRef");
  if (!["Workspace", "Capsule", "Resource"].includes(String(raw.kind))) {
    throw new InterfaceServiceError(
      "invalid_argument",
      "ownerRef.kind is not supported",
    );
  }
  return {
    kind: raw.kind as Interface["metadata"]["ownerRef"]["kind"],
    id: requireText(raw.id, "ownerRef.id"),
  };
}

function normalizeLabels(labels: unknown): Readonly<Record<string, string>> {
  const entries = Object.entries(requireRecord(labels, "labels"));
  if (entries.length > 64) {
    throw new InterfaceServiceError(
      "invalid_argument",
      "labels exceeds 64 entries",
    );
  }
  return Object.fromEntries(
    entries.map(([key, value]) => [
      requireBoundedText(key, "label key", 128),
      requireBoundedText(value, `label ${key}`, 1024),
    ]),
  );
}

function normalizeTokens(values: unknown, field: string): readonly string[] {
  if (!Array.isArray(values)) {
    throw new InterfaceServiceError(
      "invalid_argument",
      `${field} must be an array`,
    );
  }
  if (values.length === 0) {
    throw new InterfaceServiceError(
      "invalid_argument",
      `${field} must not be empty`,
    );
  }
  if (values.length > 64) {
    throw new InterfaceServiceError(
      "invalid_argument",
      `${field} exceeds 64 entries`,
    );
  }
  return [
    ...new Set(
      values.map((value) => {
        validatePermissionToken(value, field);
        return value.trim();
      }),
    ),
  ];
}

function validateToken(value: unknown, field: string): void {
  const normalized = requireText(value, field);
  if (normalized.length > 256 || /\s/u.test(normalized)) {
    throw new InterfaceServiceError(
      "invalid_argument",
      `${field} must be a non-whitespace token no longer than 256 characters`,
    );
  }
}

function validatePermissionToken(value: unknown, field: string): void {
  const normalized = requireText(value, field);
  if (!isValidInterfacePermissionToken(normalized)) {
    throw new InterfaceServiceError(
      "invalid_argument",
      `${field} must be one RFC 6749 scope token no longer than 256 characters`,
    );
  }
}

function validateInputName(name: string): void {
  if (!isValidInterfaceName(name)) {
    throw new InterfaceServiceError(
      "invalid_argument",
      `invalid Interface input name: ${name}`,
    );
  }
}

function validateInterfaceName(value: unknown, field: string): string {
  const name = requireText(value, field);
  if (!isValidInterfaceName(name)) {
    throw new InterfaceServiceError(
      "invalid_argument",
      `${field} must start with a letter and contain only letters, digits, dot, underscore, or hyphen`,
    );
  }
  return name;
}

function validatePointer(pointer: unknown, inputName: string): string {
  if (typeof pointer !== "string") {
    throw new InterfaceServiceError(
      "invalid_argument",
      `input ${inputName} pointer must be a string`,
    );
  }
  if (pointer.length > 1024 || (pointer !== "" && !pointer.startsWith("/"))) {
    throw new InterfaceServiceError(
      "invalid_argument",
      `input ${inputName} pointer must be an RFC 6901 JSON Pointer`,
    );
  }
  if (/~(?:[^01]|$)/u.test(pointer)) {
    throw new InterfaceServiceError(
      "invalid_argument",
      `input ${inputName} pointer contains an invalid escape`,
    );
  }
  return pointer;
}

function validateJsonDocument(
  value: unknown,
  field = "spec.document",
  maxBytes = 65_536,
): void {
  const stack: Array<{ readonly entry: unknown; readonly depth: number }> = [
    { entry: value, depth: 0 },
  ];
  const seen = new WeakSet<object>();
  while (stack.length > 0) {
    const { entry, depth } = stack.pop()!;
    if (depth > 32) {
      throw new InterfaceServiceError(
        "invalid_argument",
        `${field} exceeds depth 32`,
      );
    }
    if (Array.isArray(entry)) {
      if (seen.has(entry)) {
        throw new InterfaceServiceError(
          "invalid_argument",
          `${field} must be acyclic JSON`,
        );
      }
      seen.add(entry);
      for (const child of entry) {
        stack.push({ entry: child, depth: depth + 1 });
      }
      continue;
    }
    if (isRecord(entry)) {
      if (seen.has(entry)) {
        throw new InterfaceServiceError(
          "invalid_argument",
          `${field} must be acyclic JSON`,
        );
      }
      seen.add(entry);
      for (const child of Object.values(entry)) {
        stack.push({ entry: child, depth: depth + 1 });
      }
      continue;
    }
    if (
      entry !== null &&
      typeof entry !== "string" &&
      typeof entry !== "boolean" &&
      !(typeof entry === "number" && Number.isFinite(entry))
    ) {
      throw new InterfaceServiceError(
        "invalid_argument",
        `${field} must be valid JSON`,
      );
    }
  }
  if (jsonByteLength(value) > maxBytes) {
    throw new InterfaceServiceError(
      "invalid_argument",
      `${field} exceeds ${Math.floor(maxBytes / 1024)} KiB`,
    );
  }
}

function jsonByteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

const SECRET_URL_PARAMETER_NAMES = new Set([
  "authorization",
  "proxyauthorization",
  "cookie",
  "setcookie",
  "password",
  "passwd",
  "secret",
  "token",
  "clientsecret",
  "privatekey",
  "signingkey",
  "apikey",
  "accesstoken",
  "refreshtoken",
  "sessiontoken",
  "bearertoken",
  "credential",
  "credentials",
  "credentialvalue",
  "xapikey",
  "auth",
  "jwt",
  "session",
  "sessionid",
  "sig",
  "signature",
  "xamzcredential",
  "xamzsecuritytoken",
  "xamzsignature",
  "xgoogcredential",
  "xgoogsignature",
]);

function urlParametersContainCredential(parameters: URLSearchParams): boolean {
  for (const [name, value] of parameters) {
    const normalizedName = name.toLowerCase().replace(/[^a-z0-9]/gu, "");
    if (value.trim() !== "" && SECRET_URL_PARAMETER_NAMES.has(normalizedName)) {
      return true;
    }
  }
  return false;
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new InterfaceServiceError(
      "invalid_argument",
      `${field} must be an object`,
    );
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireText(value: unknown, field: string): string {
  return requireBoundedText(value, field, 1024);
}

function requireBoundedText(
  value: unknown,
  field: string,
  maxLength: number,
): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new InterfaceServiceError("invalid_argument", `${field} is required`);
  }
  const normalized = value.trim();
  if (normalized.length > maxLength) {
    throw new InterfaceServiceError(
      "invalid_argument",
      `${field} exceeds ${maxLength} characters`,
    );
  }
  return normalized;
}

function assertOnlyKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
  field: string,
): void {
  const accepted = new Set(allowed);
  const unknown = Object.keys(record).filter((key) => !accepted.has(key));
  if (unknown.length > 0) {
    throw new InterfaceServiceError(
      "invalid_argument",
      `${field} contains unknown field ${unknown.sort()[0]}`,
    );
  }
}

function validateResolvedResourceUri(
  value: unknown,
  inputName: string,
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim()
  ) {
    throw new InterfaceServiceError(
      "invalid_argument",
      `resolved input ${inputName} must be a non-empty absolute URI`,
    );
  }
  if (value.length > 2048) {
    throw new InterfaceServiceError(
      "invalid_argument",
      `resolved input ${inputName} URI exceeds 2048 characters`,
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new InterfaceServiceError(
      "invalid_argument",
      `resolved input ${inputName} must be an absolute URI`,
    );
  }
  if (
    parsed.username !== "" ||
    parsed.password !== "" ||
    urlParametersContainCredential(parsed.searchParams) ||
    (parsed.hash.length > 1 &&
      urlParametersContainCredential(
        new URLSearchParams(parsed.hash.slice(1)),
      )) ||
    parsed.protocol !== "https:"
  ) {
    throw new InterfaceServiceError(
      "invalid_argument",
      `resolved input ${inputName} must be a credential-free HTTPS resource URI`,
    );
  }
  // OAuth resource identity is the canonical HTTPS resource endpoint, not a
  // particular request query or client-side fragment. Consumers perform the
  // same query/hash-free exact comparison at invocation.
  parsed.search = "";
  parsed.hash = "";
  return parsed.href;
}

function condition(
  type: string,
  status: Condition["status"],
  reason: string,
  now: string,
  observedGeneration: number,
  message?: string,
): Condition {
  return {
    type,
    status,
    reason,
    ...(message ? { message } : {}),
    observedGeneration,
    lastTransitionAt: now,
  };
}
