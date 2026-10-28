import type { InstallConfig } from "takosumi-contract/install-configs";
import type {
  ActorContext,
  Condition,
  CreateInterfaceBindingRequest,
  CreateInterfaceRequest,
  CapsuleInterfaceBlueprint,
  CapsuleInterfaceBlueprintInput,
  CapsuleRequiredInterface,
  Capsule,
  Interface,
  InterfaceBinding,
  InterfaceLink,
  InterfaceInput,
  InterfaceInputProvenance,
  InterfaceProjectionSink,
  InterfacePhase,
  InterfaceSpec,
  IssueInterfaceTokenRequest,
  IssueInterfaceTokenResponse,
  JsonObject,
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
import type { InterfaceMaterializationWriteAuthority } from "../deploy-control/interface_materialization_intent.ts";
import { OpenTofuControllerError } from "../deploy-control/errors.ts";
import { WorkspaceManagementAdmissionConflictError, type WorkspaceManagementAuthority } from "../deploy-control/store.ts";
import type {
  InterfaceListFilter,
  InterfaceStores,
  InterfaceWriteGuard,
} from "./stores.ts";
import type { Page, PageParams } from "takosumi-contract/pagination";
import {
  canonicalInterfaceOAuth2ResourceUri,
  interfaceOAuth2ResourceUri,
} from "./oauth_resource.ts";

const INTERFACE_OAUTH2_MAX_TTL_MS = 60_000;

export type InterfaceServiceErrorCode =
  | "permission_denied"
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

/** Non-secret evidence persisted by a host OAuth issuer for active checks. */
export interface InterfacePrincipalOAuth2ActivityEvidence {
  readonly workspaceId: string;
  readonly capsuleId?: string;
  readonly interfaceId: string;
  readonly bindingId: string;
  readonly interfaceResolvedRevision: number;
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

export interface InterfaceLinkWriteFence {
  assertCurrent(): Promise<WorkspaceManagementAuthority | undefined>;
}

export interface InterfaceLinkApprovalPolicy {
  evaluate(input: {
    readonly consumerWorkspaceId: string;
    readonly providerWorkspaceId: string;
    readonly requestedBy: string;
  }): Promise<{ readonly kind: "requester_manages_provider" } | undefined>;
}

/** Phase 4 authority: management admission is scoped to one Workspace. */
export class SameWorkspaceInterfaceLinkApprovalPolicy implements InterfaceLinkApprovalPolicy {
  evaluate(input: { readonly consumerWorkspaceId: string; readonly providerWorkspaceId: string }): Promise<{ readonly kind: "requester_manages_provider" } | undefined> {
    return Promise.resolve(input.consumerWorkspaceId === input.providerWorkspaceId
      ? { kind: "requester_manages_provider" } : undefined);
  }
}

export interface InterfaceServiceOptions {
  readonly stores: InterfaceStores;
  readonly capsules?: {
    getCapsule(id: string): Promise<Capsule>;
    getInstallConfig(id: string): Promise<InstallConfig>;
  };
  readonly linkApprovalPolicy?: InterfaceLinkApprovalPolicy;
  readonly captureLinkWriteAuthority?: (workspaceId: string) => Promise<WorkspaceManagementAuthority>;
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
  /**
   * Host-owned, recoverable runtime projection. Canonical Interface/Binding
   * writes complete first; sink failures are logged and repaired by a bounded
   * host scan rather than changing lifecycle authority.
   */
  readonly projectionSink?: InterfaceProjectionSink;
}

type InterfaceObserverWriteOptions = {
  readonly requireActiveWorkspace?: true;
};

/** Internal cooperative fence checked immediately before canonical writes. */
export interface InterfaceAuthorityWriteFence {
  readonly signal: AbortSignal;
  assertCurrent(): Promise<InterfaceMaterializationWriteAuthority>;
}

export type InterfaceServiceMaterialization =
  | {
      readonly capsuleBlueprintKey: string;
      /** Internal deterministic record identity for replay-safe hydration. */
      readonly recordId?: string;
    }
  | {
      readonly portableIac: true;
      readonly descriptorName: string;
      readonly descriptorVersion: string;
    };

export type InterfaceBindingServiceMaterialization =
  | {
      readonly capsuleBlueprintKey: string;
      readonly bindingBlueprintKey: string;
      /** Internal deterministic record identity for replay-safe hydration. */
      readonly recordId?: string;
    }
  | {
      readonly requiredInterfaceLinkId: string;
      readonly requiredInterfaceCapsuleId: string;
      readonly requiredInterfaceKey: string;
      readonly requiredInterfaceType: string;
      readonly requiredInterfaceVersion: string;
    };

export class InterfaceService {
  readonly #stores: InterfaceStores;
  readonly #capsules?: InterfaceServiceOptions["capsules"];
  readonly #linkApprovalPolicy: InterfaceLinkApprovalPolicy;
  readonly #captureLinkWriteAuthority?: InterfaceServiceOptions["captureLinkWriteAuthority"];
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
  readonly #projectionSink?: InterfaceProjectionSink;

  constructor(options: InterfaceServiceOptions) {
    this.#stores = options.stores;
    this.#capsules = options.capsules;
    this.#captureLinkWriteAuthority = options.captureLinkWriteAuthority;
    this.#linkApprovalPolicy = options.linkApprovalPolicy ?? new SameWorkspaceInterfaceLinkApprovalPolicy();
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
    this.#projectionSink = options.projectionSink;
  }

  async create(
    request: CreateInterfaceRequest,
    actor?: ActorContext,
    materialization?: InterfaceServiceMaterialization,
    authorityFence?: InterfaceAuthorityWriteFence,
  ): Promise<Interface> {
    validateCreate(request);
    const workspaceId = requireText(request.workspaceId, "workspaceId");
    const ownerRef = normalizedOwner(request.ownerRef);
    assertOwnedCapsuleOutputs(ownerRef, request.spec);
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
        id: materializationRecordId(materialization) ?? this.#newId("if"),
        workspaceId,
        name: request.name.trim(),
        ownerRef,
        generation: 1,
        ...(request.labels ? { labels: normalizeLabels(request.labels) } : {}),
        ...(materialization
          ? { materializedFrom: interfaceMaterialization(materialization) }
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
    const authority = await assertInterfaceAuthorityWriteFence(authorityFence);
    if (!(await this.#stores.interfaces.create(record, authority))) {
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
    return await this.reconcile(record.metadata.id, { authorityFence });
  }

  async ensureCapsuleBlueprints(input: {
    readonly workspaceId: string;
    readonly capsuleId: string;
    readonly blueprints: readonly CapsuleInterfaceBlueprint[];
  }, authorityFence?: InterfaceAuthorityWriteFence): Promise<readonly Interface[]> {
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
        const recordId = await capsuleBlueprintRecordId("if", {
          workspaceId: input.workspaceId,
          capsuleId: input.capsuleId,
          interfaceKey: key,
        });
        try {
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
            { capsuleBlueprintKey: key, recordId },
            authorityFence,
          );
        } catch (error) {
          if (
            !(error instanceof InterfaceServiceError) ||
            error.code !== "already_exists"
          ) {
            throw error;
          }
          const concurrentlyCreated = await this.#stores.interfaces.get(
            recordId,
          );
          if (
            !concurrentlyCreated ||
            concurrentlyCreated.metadata.workspaceId !== input.workspaceId ||
            concurrentlyCreated.metadata.ownerRef.kind !== "Capsule" ||
            concurrentlyCreated.metadata.ownerRef.id !== input.capsuleId ||
            concurrentlyCreated.metadata.materializedFrom?.source !==
              "capsule_blueprint" ||
            concurrentlyCreated.metadata.materializedFrom.key !== key
          ) {
            throw error;
          }
          materialized = concurrentlyCreated;
        }
      }
      records.push(materialized);
      if (materialized.status.phase !== "Retired") {
        await this.#ensureCapsuleBlueprintBindings(
          materialized,
          key,
          blueprint.bindings ?? [],
          authorityFence,
        );
      }
    }
    return records;
  }

  async #ensureCapsuleBlueprintBindings(
    iface: Interface,
    interfaceKey: string,
    proposals: NonNullable<CapsuleInterfaceBlueprint["bindings"]>,
    authorityFence?: InterfaceAuthorityWriteFence,
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
      if (iface.metadata.ownerRef.kind !== "Capsule") {
        throw new InterfaceServiceError(
          "failed_precondition",
          "Capsule blueprint Interface owner is invalid",
        );
      }
      const recordId = await capsuleBlueprintRecordId("ifb", {
        workspaceId: iface.metadata.workspaceId,
        capsuleId: iface.metadata.ownerRef.id,
        interfaceKey,
        bindingKey: key,
      });
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
            recordId,
          },
          authorityFence,
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

  /** Only an explicitly persisted active link can authorize a runtime grant. */
  async ensureCapsuleRequiredInterfaces(input: {
    readonly workspaceId: string;
    readonly capsuleId: string;
    readonly principalId: string;
    readonly requirements: readonly CapsuleRequiredInterface[];
  }): Promise<void> {
    validateCapsuleRequiredInterfaces(input.requirements);
    const workspaceId = requireText(input.workspaceId, "workspaceId");
    const capsuleId = requireText(input.capsuleId, "capsuleId");
    const principalId = requireText(input.principalId, "principalId");
    for (const requirement of input.requirements) {
      try {
        for (let attempt = 0; attempt < 4; attempt += 1) {
          const link = await this.#stores.links.getCurrent({ consumerCapsuleId: capsuleId, requirementKey: requirement.key });
          if (!link || link.state !== "active" || !linkMatchesRequirement(link, requirement)) break;
          let iface: Interface;
          try {
            iface = await this.reconcile(link.providerInterfaceId, { allowSafetyRecovery: true });
          } catch (error) {
            if (isMissingInterfaceOwner(error)) break;
            throw error;
          }
          if (!(await this.#linkProviderAvailable(link, iface, workspaceId))) break;
          const permissions = requirement.permissions.filter((permission) => link.requestedPermissions.includes(permission) && link.approvedPermissions.includes(permission));
          try {
            await this.#ensureLinkedPrincipalBinding(link, iface, principalId, permissions, requirement.delivery);
          } catch (error) {
            if (!(error instanceof InterfaceServiceError) || !["failed_precondition", "not_found", "conflict"].includes(error.code)) throw error;
          }
          const latest = await this.#stores.links.getCurrent({ consumerCapsuleId: capsuleId, requirementKey: requirement.key });
          if (!latest || latest.id === link.id) break;
        }
      } catch (error) {
        // Expected per-requirement absence (including a v75 link table) must
        // not skip sibling requirements or make OIDC sign-in fail. Unexpected
        // infrastructure errors still propagate to the host diagnostic path.
        if (!(error instanceof InterfaceServiceError) || !["not_found", "failed_precondition", "conflict"].includes(error.code)) throw error;
        log.warn("service.interface.required_reconcile_failed", { capsuleId, requirementKey: requirement.key, code: error.code });
      }
    }
  }

  listCapsuleInterfaceLinks(capsuleId: string): Promise<readonly InterfaceLink[]> {
    return this.#stores.links.listByConsumerCapsule(requireText(capsuleId, "capsuleId"));
  }

  async listProviderCapsuleInterfaceLinks(capsuleId: string): Promise<readonly InterfaceLink[]> {
    const links = await this.#stores.links.listByProviderCapsule(requireText(capsuleId, "capsuleId"));
    if (!this.#capsules) return links;
    const consumers = new Map<string, boolean>();
    const visible: InterfaceLink[] = [];
    for (const link of links) {
      let exists = consumers.get(link.consumerCapsuleId);
      if (exists === undefined) {
        try { exists = (await this.#capsules.getCapsule(link.consumerCapsuleId)).status !== "destroyed"; }
        catch (error) { if (!isMissingInterfaceOwner(error)) throw error; exists = false; }
        consumers.set(link.consumerCapsuleId, exists);
      }
      if (exists) visible.push(link);
    }
    return visible;
  }

  captureInterfaceLinkWriteAuthority(workspaceId: string): Promise<WorkspaceManagementAuthority | undefined> {
    return (async () => {
      try { return await this.#captureLinkWriteAuthority?.(workspaceId); }
      catch (error) {
        if (error instanceof WorkspaceManagementAdmissionConflictError) throw new InterfaceServiceError("conflict", "Workspace is not accepting Interface link writes");
        throw error;
      }
    })();
  }

  async #linkWriteFence(workspaceId: string, supplied?: InterfaceLinkWriteFence): Promise<InterfaceLinkWriteFence> {
    const initial = await this.captureInterfaceLinkWriteAuthority(workspaceId);
    return { assertCurrent: async () => {
      const caller = await supplied?.assertCurrent();
      const current = await this.captureInterfaceLinkWriteAuthority(workspaceId);
      if (initial && (!current || current.workspaceId !== initial.workspaceId || current.managementEpoch !== initial.managementEpoch)) throw new InterfaceServiceError("conflict", "Workspace management authority changed");
      return caller ?? current;
    } };
  }

  async getLatestCapsuleInterfaceLink(capsuleId: string, requirementKey: string): Promise<InterfaceLink | undefined> {
    return this.#stores.links.getLatest({ consumerCapsuleId: capsuleId, requirementKey });
  }

  async getInterfaceLinkConsumer(capsuleId: string): Promise<Capsule> {
    if (!this.#capsules) throw new InterfaceServiceError("failed_precondition", "Capsule Interface link authority is unavailable");
    return this.#capsules.getCapsule(requireText(capsuleId, "capsuleId"));
  }

  async getInterfaceLinkRequirement(capsuleId: string, key: string): Promise<{ readonly capsule: Capsule; readonly requirement: CapsuleRequiredInterface }> {
    if (!this.#capsules) throw new InterfaceServiceError("failed_precondition", "Capsule Interface link authority is unavailable");
    const capsule = await this.getInterfaceLinkConsumer(capsuleId);
    if (capsule.status === "destroyed") throw new InterfaceServiceError("failed_precondition", "consumer Capsule is destroyed");
    const config = await this.#capsules.getInstallConfig(capsule.installConfigId);
    const requirement = config.requiredInterfaces?.find((item) => item.key === key);
    if (!requirement) throw new InterfaceServiceError("not_found", "Capsule Interface requirement not found");
    return { capsule, requirement };
  }

  async listInterfaceLinkCandidates(input: {
    readonly workspaceId: string;
    readonly capsuleId: string;
    readonly requirement: CapsuleRequiredInterface;
  }): Promise<readonly Interface[]> {
    validateCapsuleRequiredInterfaces([input.requirement]);
    const candidates = await this.list({ workspaceId: input.workspaceId, type: input.requirement.interface.type, phase: "Resolved", ownerKind: "Capsule", limit: 1000 });
    if (candidates.length === 1000) throw new InterfaceServiceError("failed_precondition", "Interface candidate inventory exceeds bounded resolution");
    const accepted: Interface[] = [];
    for (const iface of candidates) {
      if (iface.spec.version !== input.requirement.interface.version || iface.metadata.ownerRef.id === input.capsuleId) continue;
      if (this.#capsules) {
        let provider: Capsule;
        try { provider = await this.#capsules.getCapsule(iface.metadata.ownerRef.id); }
        catch (error) { if (isMissingInterfaceOwner(error)) continue; throw error; }
        if (provider.workspaceId !== input.workspaceId || !["active", "stale"].includes(provider.status) || (provider.uninstall && provider.uninstall.phase !== "cancelled")) continue;
      }
      accepted.push(iface);
    }
    return accepted;
  }

  async listInterfaceLinkCandidateView(input: { readonly workspaceId: string; readonly capsuleId: string; readonly requirement: CapsuleRequiredInterface }): Promise<{ readonly candidates: readonly { readonly interfaceId: string; readonly providerCapsuleId: string; readonly providerCapsuleName: string; readonly interfaceName: string }[]; readonly generation: number; readonly requirementFingerprint: string }> {
    const interfaces = await this.listInterfaceLinkCandidates(input);
    const candidates = await Promise.all(interfaces.map(async (iface) => ({ interfaceId: iface.metadata.id, providerCapsuleId: iface.metadata.ownerRef.id, providerCapsuleName: this.#capsules ? (await this.#capsules.getCapsule(iface.metadata.ownerRef.id)).name : iface.metadata.ownerRef.id, interfaceName: iface.metadata.name })));
    const latest = await this.getLatestCapsuleInterfaceLink(input.capsuleId, input.requirement.key);
    return { candidates, generation: latest?.generation ?? 0, requirementFingerprint: await stableJsonDigest({ permissions: input.requirement.permissions, delivery: input.requirement.delivery }) };
  }

  async ensureCapsuleInterfaceLinks(input: {
    readonly workspaceId: string;
    readonly capsuleId: string;
    readonly requirements: readonly CapsuleRequiredInterface[];
    readonly selections: readonly { readonly requirementKey: string; readonly interfaceId: string; readonly selection: "explicit" | "auto_single" }[];
  }, actor?: ActorContext, writeFence?: InterfaceLinkWriteFence): Promise<readonly InterfaceLink[]> {
    validateCapsuleRequiredInterfaces(input.requirements);
    const result: InterfaceLink[] = [];
    for (const selection of input.selections) {
      const requirement = input.requirements.find((item) => item.key === selection.requirementKey);
      if (!requirement) throw new InterfaceServiceError("invalid_argument", "unknown Interface requirement selection");
      const current = await this.#stores.links.getLatest({ consumerCapsuleId: input.capsuleId, requirementKey: requirement.key });
      if (current) {
        if (current.providerInterfaceId !== selection.interfaceId || !linkMatchesRequirementExactly(current, requirement) || (current.state !== "active" && current.state !== "pending_approval")) {
          throw new InterfaceServiceError("conflict", "Interface link selection changed");
        }
        result.push(current);
        continue;
      }
      result.push(await this.#replaceInterfaceLink({ ...input, requirement, interfaceId: selection.interfaceId, expectedGeneration: 0, selection: selection.selection }, actor, writeFence));
    }
    return result;
  }

  async putCapsuleInterfaceLink(input: {
    readonly capsuleId: string;
    readonly requirementKey: string;
    readonly interfaceId: string;
    readonly expectedGeneration: number;
    readonly expectedRequirementFingerprint?: string;
  }, actor?: ActorContext, writeFence?: InterfaceLinkWriteFence): Promise<InterfaceLink> {
    const { capsule, requirement } = await this.getInterfaceLinkRequirement(input.capsuleId, input.requirementKey);
    return this.#replaceInterfaceLink({ ...input, workspaceId: capsule.workspaceId, requirement, selection: "explicit" }, actor, writeFence);
  }

  async #replaceInterfaceLink(input: {
    readonly workspaceId: string;
    readonly capsuleId: string;
    readonly requirement: CapsuleRequiredInterface;
    readonly interfaceId: string;
    readonly expectedGeneration: number;
    readonly selection: "explicit" | "auto_single";
    readonly expectedRequirementFingerprint?: string;
  }, actor?: ActorContext, suppliedFence?: InterfaceLinkWriteFence): Promise<InterfaceLink> {
    const writeFence = await this.#linkWriteFence(input.workspaceId, suppliedFence);
    await writeFence.assertCurrent();
    if (!Number.isSafeInteger(input.expectedGeneration) || input.expectedGeneration < 0) throw new InterfaceServiceError("invalid_argument", "expectedGeneration must be a non-negative integer");
    const scope = { consumerCapsuleId: input.capsuleId, requirementKey: input.requirement.key };
    const current = await this.#stores.links.getLatest(scope);
    if ((current?.generation ?? 0) !== input.expectedGeneration) throw new InterfaceServiceError("conflict", "Interface link generation changed");
    if (this.#capsules) {
      const { capsule, requirement } = await this.getInterfaceLinkRequirement(input.capsuleId, input.requirement.key);
      if (capsule.workspaceId !== input.workspaceId || JSON.stringify(requirement) !== JSON.stringify(input.requirement)) throw new InterfaceServiceError("failed_precondition", "consumer Interface requirement changed");
    }
    if (input.expectedRequirementFingerprint !== undefined && input.expectedRequirementFingerprint !== await stableJsonDigest({ permissions: input.requirement.permissions, delivery: input.requirement.delivery })) throw new InterfaceServiceError("conflict", "Interface requirement changed since review");
    const candidates = await this.listInterfaceLinkCandidates({ workspaceId: input.workspaceId, capsuleId: input.capsuleId, requirement: input.requirement });
    const iface = candidates.find((item) => item.metadata.id === input.interfaceId);
    if (!iface || iface.metadata.ownerRef.kind !== "Capsule") throw new InterfaceServiceError("failed_precondition", "selected Interface provider is unavailable");
    if (input.selection === "auto_single" && iface.spec.access.visibility === "private") throw new InterfaceServiceError("failed_precondition", "private Interface requires explicit selection");
    const siblingLinks = await this.#stores.links.listByConsumerCapsule(input.capsuleId);
    if (siblingLinks.some((link) => link.requirementKey !== input.requirement.key && link.providerInterfaceId === iface.metadata.id && (link.state === "active" || link.state === "pending_approval"))) throw new InterfaceServiceError("conflict", "selected provider conflicts with another consumer requirement");
    if (current?.providerInterfaceId === iface.metadata.id && (current.state === "active" || current.state === "pending_approval") && linkMatchesRequirementExactly(current, input.requirement)) return current;
    const requestedBy = actor?.actorAccountId ?? "system";
    const approval = await this.#linkApprovalPolicy.evaluate({ consumerWorkspaceId: input.workspaceId, providerWorkspaceId: iface.metadata.workspaceId, requestedBy });
    const now = this.#now();
    const liveCurrent = current && (current.state === "active" || current.state === "pending_approval");
    const next: InterfaceLink = {
      id: `ifl_${crypto.randomUUID().replaceAll("-", "")}`,
      ...scope,
      interface: input.requirement.interface,
      requestedPermissions: [...input.requirement.permissions],
      approvedPermissions: approval ? [...input.requirement.permissions] : [],
      providerInterfaceId: iface.metadata.id,
      providerCapsuleId: iface.metadata.ownerRef.id,
      deliveryType: input.requirement.delivery.type,
      state: approval ? "active" : "pending_approval",
      selection: input.selection,
      generation: (current?.generation ?? 0) + (liveCurrent ? 2 : 1),
      requestedBy,
      ...(approval ? { approval: { kind: approval.kind, approvedBy: requestedBy, approvedAt: now } } : {}),
      createdAt: now,
      updatedAt: now,
    };
    // Prepare all known subjects before changing canonical link authority.
    // Preparatory bindings cannot authorize tokens until their link is active.
    const preparedSubjects: string[] = [];
    if (current && next.state === "active" && current.providerInterfaceId !== next.providerInterfaceId) {
      const history = await this.#stores.bindings.listByInterface(current.providerInterfaceId);
      try {
        for (const binding of history) {
          if (!bindingBelongsToLink(binding, current) || binding.status.phase === "Revoked" || binding.spec.subjectRef.kind !== "Principal") continue;
          preparedSubjects.push(binding.spec.subjectRef.id);
          await writeFence.assertCurrent();
          await this.#ensureLinkedPrincipalBinding(next, iface, binding.spec.subjectRef.id, next.requestedPermissions.filter((p) => next.approvedPermissions.includes(p)), input.requirement.delivery, true);
          await writeFence.assertCurrent();
        }
      } catch (error) {
        if (!(await this.#stores.links.get(next.id))) await this.#revokeLinkBindings(next);
        throw error;
      }
    }
    const revoked = liveCurrent ? this.#revokedLink(current, "consumer_repointed", requestedBy) : undefined;
    let wrote: boolean;
    try {
      const authority = await writeFence.assertCurrent();
      wrote = current
        ? await this.#stores.links.replace({ record: next, expected: current, ...(revoked ? { revoked } : {}) }, authority)
        : await this.#stores.links.create(next, authority);
    } catch (error) {
      if (!(await this.#stores.links.get(next.id))) await this.#revokeLinkBindings(next);
      throw error;
    }
    if (!wrote) {
      if (!(await this.#stores.links.get(next.id))) await this.#revokeLinkBindings(next);
      throw new InterfaceServiceError("conflict", "Interface link changed concurrently");
    }
    if (current) {
      const previousSubjects = current.providerInterfaceId === next.providerInterfaceId && next.state === "active"
        ? (await this.#stores.bindings.listByInterface(current.providerInterfaceId))
          .filter((binding) => bindingBelongsToLink(binding, current) && binding.status.phase !== "Revoked" && binding.spec.subjectRef.kind === "Principal")
          .map((binding) => binding.spec.subjectRef.id)
        : [];
      await this.#revokeLinkBindings(current);
      for (const subjectId of previousSubjects) await this.#ensureLinkedPrincipalBinding(next, iface, subjectId, next.requestedPermissions.filter((permission) => next.approvedPermissions.includes(permission)), input.requirement.delivery);
      for (const subjectId of preparedSubjects) await this.#ensureLinkedPrincipalBinding(next, iface, subjectId, next.requestedPermissions.filter((permission) => next.approvedPermissions.includes(permission)), input.requirement.delivery);
    }
    if (this.#capsules && (await this.#capsules.getCapsule(input.capsuleId)).status === "destroyed") {
      await this.revokeCapsuleInterfaceLinks(input.workspaceId, input.capsuleId);
      throw new InterfaceServiceError("failed_precondition", "consumer Capsule is destroyed");
    }
    return next;
  }

  async revokeCapsuleInterfaceLink(capsuleId: string, requirementKey: string, expectedGeneration: number, actor?: ActorContext, suppliedFence?: InterfaceLinkWriteFence, authorizedProvider?: { readonly linkId: string; readonly providerInterfaceId: string; readonly providerCapsuleId: string }): Promise<InterfaceLink> {
    const writeFence = suppliedFence ?? await this.#linkWriteFence((await this.getInterfaceLinkConsumer(capsuleId)).workspaceId);
    await writeFence.assertCurrent();
    const current = await this.#stores.links.getLatest({ consumerCapsuleId: capsuleId, requirementKey });
    if (!current) throw new InterfaceServiceError("not_found", "Interface link not found");
    if (authorizedProvider && (current.id !== authorizedProvider.linkId || current.providerInterfaceId !== authorizedProvider.providerInterfaceId || current.providerCapsuleId !== authorizedProvider.providerCapsuleId)) throw new InterfaceServiceError("permission_denied", "authorized Interface provider changed");
    if (current.generation !== expectedGeneration) throw new InterfaceServiceError("conflict", "Interface link generation changed");
    if (current.state === "revoked" || current.state === "declined") return current;
    const next = this.#revokedLink(current, "link_unlinked", actor?.actorAccountId ?? "system");
    if (!(await this.#stores.links.compareAndSet(next, current.generation, await writeFence.assertCurrent()))) throw new InterfaceServiceError("conflict", "Interface link changed concurrently");
    await this.#revokeLinkBindings(current);
    return next;
  }

  async revokeCapsuleInterfaceLinks(workspaceId: string, capsuleId: string, reason: "consumer_destroyed" | "install_discarded" = "consumer_destroyed"): Promise<void> {
    if (this.#capsules) {
      const capsule = await this.#capsules.getCapsule(capsuleId);
      if (capsule.workspaceId !== workspaceId) throw new InterfaceServiceError("not_found", "Capsule not found");
    }
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const links = await this.#stores.links.listByConsumerCapsule(capsuleId);
      for (const link of links) {
        if (link.state === "active" || link.state === "pending_approval") {
          const next = this.#revokedLink(link, reason, "system");
          if (!(await this.#stores.links.compareAndSet(next, link.generation))) continue;
        }
        await this.#revokeLinkBindings(link);
      }
      const remaining = await this.#stores.links.listByConsumerCapsule(capsuleId);
      if (!remaining.some((link) => link.state === "active" || link.state === "pending_approval")) return;
    }
    throw new InterfaceServiceError("conflict", "consumer Interface link revocation did not converge");
  }

  #revokedLink(link: InterfaceLink, reason: string, revokedBy: string): InterfaceLink {
    const now = this.#now();
    return { ...link, state: "revoked", generation: link.generation + 1, updatedAt: now, revoked: { revokedBy, revokedAt: now, reason } };
  }

  async #revokeLinkBindings(link: InterfaceLink): Promise<void> {
    for (const binding of await this.#stores.bindings.listByInterface(link.providerInterfaceId)) {
      if (bindingBelongsToLink(binding, link) && binding.status.phase !== "Revoked") await this.revokeBinding(link.providerInterfaceId, binding.metadata.id);
    }
  }

  async #linkProviderAvailable(link: InterfaceLink, iface: Interface, workspaceId: string, capsuleCache?: Map<string, Capsule | undefined>): Promise<boolean> {
    if (iface.metadata.workspaceId !== workspaceId || iface.metadata.id !== link.providerInterfaceId || iface.metadata.ownerRef.kind !== "Capsule" || iface.metadata.ownerRef.id !== link.providerCapsuleId || iface.status.phase !== "Resolved" || iface.status.observedGeneration !== iface.metadata.generation || iface.status.resolvedRevision < 1 || iface.spec.type !== link.interface.type || iface.spec.version !== link.interface.version) return false;
    if (this.#capsules) {
      let consumer: Capsule;
      let provider: Capsule;
      try {
        const getCapsule = async (id: string): Promise<Capsule> => {
          if (capsuleCache?.has(id)) {
            const cached = capsuleCache.get(id);
            if (!cached) throw new InterfaceServiceError("not_found", "Capsule not found");
            return cached;
          }
          const capsule = await this.#capsules!.getCapsule(id);
          capsuleCache?.set(id, capsule);
          return capsule;
        };
        [consumer, provider] = await Promise.all([getCapsule(link.consumerCapsuleId), getCapsule(link.providerCapsuleId)]);
      }
      catch (error) { if (isMissingInterfaceOwner(error)) return false; throw error; }
      if (consumer.workspaceId !== workspaceId || provider.workspaceId !== workspaceId || !["active", "stale"].includes(consumer.status) || !["active", "stale"].includes(provider.status)) return false;
    }
    return true;
  }

  async #ensureLinkedPrincipalBinding(link: InterfaceLink, iface: Interface, principalId: string, permissions: readonly string[], delivery: CreateInterfaceBindingRequest["delivery"], preparing = false): Promise<void> {
    const history = await this.#stores.bindings.listByInterface(iface.metadata.id);
    const sameLink = history.filter((binding) => binding.spec.subjectRef.kind === "Principal" && binding.spec.subjectRef.id === principalId && binding.metadata.materializedFrom?.source === "capsule_required_interface" && binding.metadata.materializedFrom.linkId === link.id);
    const existing = sameLink.find((binding) => binding.status.phase !== "Revoked");
    const desired = { permissions: [...permissions], delivery };
    const bindingMatches = (binding: InterfaceBinding) => samePermissionSet(binding.spec.permissions, desired.permissions) && JSON.stringify(binding.spec.delivery) === JSON.stringify(desired.delivery);
    const linkless = history.filter((binding) => binding.spec.subjectRef.kind === "Principal" && binding.spec.subjectRef.id === principalId && binding.metadata.materializedFrom?.source === "capsule_required_interface" && !binding.metadata.materializedFrom.linkId && binding.metadata.materializedFrom.capsuleId === link.consumerCapsuleId && binding.metadata.materializedFrom.requirementKey === link.requirementKey && binding.metadata.materializedFrom.interfaceType === link.interface.type && binding.metadata.materializedFrom.interfaceVersion === link.interface.version);
    const hasOtherGeneration = linkless.length > 0 && (await this.#stores.links.listByConsumerCapsule(link.consumerCapsuleId)).some((candidate) => candidate.requirementKey === link.requirementKey && candidate.id !== link.id);
    const explicitDeny = !existing && (sameLink.some((binding) => binding.status.phase === "Revoked" && binding.status.conditions?.[0]?.reason !== "Superseded") || (!hasOtherGeneration && linkless.some((binding) => binding.status.phase === "Revoked" && binding.status.conditions?.[0]?.reason !== "Superseded")));
    const legacyCandidate = !existing ? history.find((binding) => binding.spec.subjectRef.kind === "Principal" && binding.spec.subjectRef.id === principalId && binding.status.phase !== "Revoked" && binding.metadata.materializedFrom?.source === "capsule_required_interface" && !binding.metadata.materializedFrom.linkId && binding.metadata.materializedFrom.capsuleId === link.consumerCapsuleId && binding.metadata.materializedFrom.requirementKey === link.requirementKey && binding.metadata.materializedFrom.interfaceType === link.interface.type && binding.metadata.materializedFrom.interfaceVersion === link.interface.version && bindingMatches(binding)) : undefined;
    // A linkId-less grant is adoptable only while this is the sole known link
    // generation. After a repoint its origin cannot be proven, even if its
    // permissions happen to match the new selection.
    const legacy = legacyCandidate && !preparing && !hasOtherGeneration ? legacyCandidate : undefined;
    const scope = { consumerCapsuleId: link.consumerCapsuleId, requirementKey: link.requirementKey };
    if (!preparing && (await this.#stores.links.getCurrent(scope))?.id !== link.id) throw new InterfaceServiceError("conflict", "Interface link changed during grant materialization");
    // A failed replacement or an evicted preparation can leave a grant whose
    // link is no longer current. Reclaim only this consumer requirement's
    // grants; unrelated manual and other-consumer grants remain authoritative.
    for (const binding of history) {
      const source = binding.metadata.materializedFrom;
      if (binding === legacy || binding.status.phase === "Revoked" || binding.spec.subjectRef.kind !== "Principal" || binding.spec.subjectRef.id !== principalId || source?.source !== "capsule_required_interface" || source.capsuleId !== link.consumerCapsuleId || source.requirementKey !== link.requirementKey || source.linkId === link.id) continue;
      const current = await this.#stores.links.getCurrent(scope);
      if ((!preparing && current?.id !== link.id) || (preparing && source.linkId === current?.id)) throw new InterfaceServiceError("conflict", "Interface link changed during grant materialization");
      await this.revokeBinding(iface.metadata.id, binding.metadata.id, undefined, "Superseded");
      const activated = await this.#stores.links.getCurrent(scope);
      if (source.linkId && activated?.id === source.linkId && activated.state === "active" && activated.providerInterfaceId === iface.metadata.id) {
        await this.#ensureLinkedPrincipalBinding(activated, iface, principalId, binding.spec.permissions.filter((permission) => activated.requestedPermissions.includes(permission) && activated.approvedPermissions.includes(permission)), binding.spec.delivery);
      }
    }
    if (explicitDeny) {
      return; // Explicit revocation remains a durable deny.
    }
    if (permissions.length === 0) {
      if (existing) await this.revokeBinding(iface.metadata.id, existing.metadata.id, undefined, "Superseded");
      return;
    }
    if (existing) {
      if (bindingMatches(existing)) return;
      await this.revokeBinding(iface.metadata.id, existing.metadata.id, undefined, "Superseded");
    }
    if (legacy) {
      const adopted: InterfaceBinding = { ...legacy, metadata: { ...legacy.metadata, generation: legacy.metadata.generation + 1, updatedAt: this.#now(), materializedFrom: { source: "capsule_required_interface", capsuleId: link.consumerCapsuleId, requirementKey: link.requirementKey, interfaceType: link.interface.type, interfaceVersion: link.interface.version, linkId: link.id } } };
      if (!(await this.#stores.bindings.compareAndSet(adopted, legacy.metadata.generation))) throw new InterfaceServiceError("conflict", "legacy Interface grant changed concurrently");
      await this.#projectInterface(iface);
      return;
    }
    if ((await this.#stores.bindings.listByInterface(iface.metadata.id)).some((binding) => binding.spec.subjectRef.kind === "Principal" && binding.spec.subjectRef.id === principalId && binding.status.phase !== "Revoked")) {
      if (preparing) throw new InterfaceServiceError("conflict", "selected provider has a conflicting Principal grant");
      return;
    }
    try {
      const binding = await this.createBinding(iface.metadata.id, { subjectRef: { kind: "Principal", id: principalId }, permissions, delivery }, undefined, { requiredInterfaceLinkId: link.id, requiredInterfaceCapsuleId: link.consumerCapsuleId, requiredInterfaceKey: link.requirementKey, requiredInterfaceType: link.interface.type, requiredInterfaceVersion: link.interface.version });
      if (!preparing && !(await this.#bindingLinkActive(binding, iface))) await this.revokeBinding(iface.metadata.id, binding.metadata.id);
    } catch (error) {
      if (!(error instanceof InterfaceServiceError) || error.code !== "already_exists") throw error;
      if (preparing) throw new InterfaceServiceError("conflict", "selected provider Principal grant changed concurrently");
    }
  }

  async #bindingLinkActive(binding: InterfaceBinding, iface: Interface, permission?: string, cache?: { links: Map<string, InterfaceLink | undefined>; capsules: Map<string, Capsule | undefined> }): Promise<boolean> {
    const source = binding.metadata.materializedFrom;
    if (source?.source !== "capsule_required_interface") return true;
    const lookupKey = source.linkId ?? `legacy:${source.capsuleId}:${source.requirementKey}`;
    let link = cache?.links.get(lookupKey);
    if (!cache?.links.has(lookupKey)) {
      link = source.linkId
        ? await this.#stores.links.get(source.linkId)
        : await this.#stores.links.getCurrent({ consumerCapsuleId: source.capsuleId, requirementKey: source.requirementKey });
      cache?.links.set(lookupKey, link);
    }
    return !!link && link.state === "active" && link.providerInterfaceId === iface.metadata.id && link.providerCapsuleId === iface.metadata.ownerRef.id && link.consumerCapsuleId === source.capsuleId && link.requirementKey === source.requirementKey && link.interface.type === source.interfaceType && link.interface.version === source.interfaceVersion && link.deliveryType === binding.spec.delivery.type && (permission ? (link.requestedPermissions.includes(permission) && link.approvedPermissions.includes(permission)) : binding.spec.permissions.every((granted) => link.requestedPermissions.includes(granted) && link.approvedPermissions.includes(granted))) && await this.#linkProviderAvailable(link, iface, binding.metadata.workspaceId, cache?.capsules);
  }

  async get(id: string): Promise<Interface> {
    const record = await this.#stores.interfaces.get(requireText(id, "id"));
    if (!record)
      throw new InterfaceServiceError("not_found", "Interface not found");
    return record;
  }

  list(filter: InterfaceListFilter): Promise<readonly Interface[]> {
    return this.#stores.interfaces.list(this.#normalizeListFilter(filter));
  }

  #normalizeListFilter(filter: InterfaceListFilter): InterfaceListFilter {
    const workspaceId = requireText(filter.workspaceId, "workspaceId");
    if (filter.type !== undefined) validateToken(filter.type, "type");
    if (filter.ownerId !== undefined && filter.ownerIds !== undefined) {
      throw new InterfaceServiceError(
        "invalid_argument",
        "ownerId and ownerIds are mutually exclusive",
      );
    }
    if (filter.ownerIds !== undefined) {
      if (filter.ownerIds.length > 50) {
        throw new InterfaceServiceError(
          "invalid_argument",
          "ownerIds cannot contain more than 50 entries",
        );
      }
      for (const ownerId of filter.ownerIds) requireText(ownerId, "ownerId");
    }
    if (
      filter.limit !== undefined &&
      (!Number.isSafeInteger(filter.limit) ||
        filter.limit < 1 ||
        filter.limit > 1000)
    ) {
      throw new InterfaceServiceError(
        "invalid_argument",
        "limit must be an integer between 1 and 1000",
      );
    }
    return {
      ...filter,
      workspaceId,
      ...(filter.type !== undefined ? { type: filter.type.trim() } : {}),
    };
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
      try {
        const current = hasUnownedCapsuleOutput(
          iface.metadata.ownerRef,
          iface.spec,
        )
          ? await this.reconcile(iface.metadata.id, {
              allowSafetyRecovery: true,
            })
          : iface;
        if (await this.#projectInterface(current)) projected += 1;
        else failed += 1;
      } catch {
        failed += 1;
      }
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
                iface.metadata.ownerRef.kind === "Capsule" &&
                iface.metadata.ownerRef.id === capsuleId &&
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
    return (
      await this.listAuthorizedForPrincipalPage(filter, subjectId, permission, {
        ...(filter.limit !== undefined ? { limit: filter.limit } : {}),
      })
    ).items;
  }

  /**
   * Bounded, read-only capability projection. Listing never repairs lifecycle,
   * refreshes Bindings, or writes a projection; invocation and token issuance
   * still revalidate one exact Interface immediately before use.
   */
  async listAuthorizedForPrincipalPage(
    filter: InterfaceListFilter,
    subjectId: string,
    permission: string,
    params: PageParams,
  ): Promise<Page<Interface>> {
    return await this.#listAuthorizedPage(
      filter,
      subjectId,
      permission,
      params,
      false,
    );
  }

  /**
   * Read model used by the account-plane launcher list. The query performs the
   * exact current Principal Binding join and only returns broad launcher
   * candidates; the dashboard remains the type-specific document validator.
   */
  async listAuthorizedUiSurfaceCandidatesForPrincipalPage(
    filter: InterfaceListFilter,
    subjectId: string,
    permission: string,
    params: PageParams,
    capsuleId?: string,
  ): Promise<Page<Interface>> {
    return await this.#listAuthorizedPage(
      filter,
      subjectId,
      permission,
      params,
      true,
      capsuleId,
    );
  }

  async #listAuthorizedPage(
    filter: InterfaceListFilter,
    subjectId: string,
    permission: string,
    params: PageParams,
    uiSurfaceCandidates: boolean,
    capsuleId?: string,
  ): Promise<Page<Interface>> {
    const normalizedFilter = this.#normalizeListFilter({
      ...filter,
      limit: undefined,
    });
    const normalizedSubject = requireText(subjectId, "subjectId");
    validatePermissionToken(permission, "permission");
    const normalizedPermission = permission.trim();
    const normalizedCapsuleId =
      capsuleId === undefined ? undefined : requireText(capsuleId, "capsuleId");
    const page = await this.#stores.authorized.listPage({
      filter: normalizedFilter,
      subjectId: normalizedSubject,
      permission: normalizedPermission,
      params,
      ...(uiSurfaceCandidates ? { uiSurfaceCandidates: true } : {}),
      ...(normalizedCapsuleId ? { capsuleId: normalizedCapsuleId } : {}),
    });
    return {
      ...page,
      items: page.items.filter(
        (iface) =>
          !hasUnownedCapsuleOutput(iface.metadata.ownerRef, iface.spec),
      ),
    };
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
    const iface = await this.reconcile(interfaceId, { allowSafetyRecovery: true });
    validatePermissionToken(permission, "permission");
    const bindings = await this.#principalBindings(
      iface,
      requireText(subjectId, "subjectId"),
      permission.trim(),
    );
    if (bindings.length === 0) throw new InterfaceServiceError("not_found", "Interface not found");
    return bindings;
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
    if ((await this.#claimOAuth2Resource(iface, resource)) !== "claimed") {
      throw new InterfaceServiceError(
        "failed_precondition",
        "Interface OAuth2 resource is already claimed by another Interface",
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
    const resourceClaimStillCurrent =
      (await this.#claimOAuth2Resource(currentInterface, resource)) ===
      "claimed";
    if (
      currentInterface.metadata.workspaceId !== workspaceId ||
      currentInterface.metadata.generation !== iface.metadata.generation ||
      currentInterface.status.phase !== "Resolved" ||
      currentInterface.status.resolvedRevision !==
        iface.status.resolvedRevision ||
      resolvedOAuth2Resource(currentInterface) !== resource ||
      !resourceStillAuthorized ||
      !resourceClaimStillCurrent ||
      !currentBinding ||
      !(await this.#bindingLinkActive(currentBinding, currentInterface, permission)) ||
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

  /**
   * Revalidates opaque Accounts token evidence against canonical current Core
   * state. Hosts call this at UserInfo/introspection time; a false result never
   * reveals which lifecycle, Binding, ownership, or uniqueness fence failed.
   */
  async validatePrincipalOAuth2TokenEvidence(
    input: InterfacePrincipalOAuth2ActivityEvidence,
  ): Promise<boolean> {
    try {
      const workspaceId = requireText(input.workspaceId, "workspaceId");
      const interfaceId = requireText(input.interfaceId, "interfaceId");
      const bindingId = requireText(input.bindingId, "bindingId");
      const subjectId = requireText(input.subjectId, "subjectId");
      validatePermissionToken(input.permission, "permission");
      if (
        !Number.isSafeInteger(input.interfaceResolvedRevision) ||
        input.interfaceResolvedRevision <= 0
      ) {
        return false;
      }
      const resource = canonicalInterfaceOAuth2ResourceUri(input.resource);
      if (!resource || resource !== input.resource) return false;

      const iface = await this.reconcile(interfaceId, {
        allowSafetyRecovery: true,
      });
      const ownerCapsuleId =
        iface.metadata.ownerRef.kind === "Capsule"
          ? iface.metadata.ownerRef.id
          : undefined;
      if (
        iface.metadata.workspaceId !== workspaceId ||
        iface.status.phase !== "Resolved" ||
        iface.status.resolvedRevision !== input.interfaceResolvedRevision ||
        resolvedOAuth2Resource(iface) !== resource ||
        ownerCapsuleId !== input.capsuleId ||
        !this.#oauth2ResourceAuthorizer ||
        !(await oauth2ResourceAuthorized(this.#oauth2ResourceAuthorizer, {
          workspaceId,
          interfaceId,
          ownerRef: iface.metadata.ownerRef,
          resource,
        }))
      ) {
        return false;
      }
      const binding = await this.#stores.bindings.get(bindingId);
      const bindingCurrent =
        binding !== undefined &&
        binding.metadata.workspaceId === workspaceId &&
        binding.spec.interfaceId === interfaceId &&
        binding.status.phase === "Ready" &&
        binding.status.observedInterfaceRevision ===
          iface.status.resolvedRevision &&
        binding.spec.subjectRef.kind === "Principal" &&
        binding.spec.subjectRef.id === subjectId &&
        binding.spec.permissions.includes(input.permission) &&
        binding.spec.delivery.type === "oauth2" &&
        binding.spec.delivery.credentialRef === undefined &&
        binding.spec.delivery.options === undefined;
      return (
        bindingCurrent &&
        binding !== undefined && await this.#bindingLinkActive(binding, iface, input.permission) &&
        (await this.#claimOAuth2Resource(iface, resource)) === "claimed"
      );
    } catch {
      return false;
    }
  }

  async update(
    id: string,
    request: UpdateInterfaceRequest,
    expectedGeneration: number,
    actor?: ActorContext,
    expectedResolvedRevision?: number,
    materializationAuthority?: "portable_iac",
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
    const declarationSource = current.metadata.materializedFrom?.source;
    if (
      actor !== undefined &&
      declarationSource === "portable_iac" &&
      materializationAuthority !== "portable_iac"
    ) {
      throw new InterfaceServiceError(
        "failed_precondition",
        "portable IaC Interface desired state is owned by its exact declaration",
      );
    }
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
    assertOwnedCapsuleOutputs(current.metadata.ownerRef, next.spec);
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
    options: {
      readonly allowSafetyRecovery?: boolean;
      readonly authorityFence?: InterfaceAuthorityWriteFence;
    } = {},
  ): Promise<Interface> {
    return await this.#reconcile(id, options);
  }

  async #reconcile(
    id: string,
    options: {
      readonly allowSafetyRecovery?: boolean;
      readonly authorityFence?: InterfaceAuthorityWriteFence;
    } = {},
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
      if (hasUnownedCapsuleOutput(current.metadata.ownerRef, current.spec)) {
        resolution = {
          ok: false,
          phase: "NotReady",
          reason: "InvalidCapsuleOutputOwner",
          message:
            "capsule_output inputs must belong to the Interface's owning Capsule",
        };
      } else {
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
      const observedResourceUri =
        resolution.ok && current.spec.access.resourceUriInput
          ? canonicalInterfaceOAuth2ResourceUri(
              resolution.resolvedInputs[current.spec.access.resourceUriInput],
            )
          : undefined;
      const nextStatus = resolution.ok
        ? await resolvedStatus(current, resolution, now, observedResourceUri)
        : unresolvedStatus(current, resolution, now);
      if (await statusSemanticallyEqual(current.status, nextStatus)) {
        await this.#refreshBindings(
          current.metadata.id,
          options.authorityFence,
        );
        await this.#projectInterface(current);
        return current;
      }
      const next: Interface = {
        ...current,
        metadata: { ...current.metadata, updatedAt: now },
        status: nextStatus,
      };
      const authority = await assertInterfaceAuthorityWriteFence(
        options.authorityFence,
      );
      if (
        await this.#stores.interfaces.compareAndSet(
          next,
          guard(current),
          authority,
        )
      ) {
        await this.#refreshBindings(next.metadata.id, options.authorityFence);
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
      await this.#updateStatusConditions(
        item.metadata.id,
        (current, now) => {
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
        },
        { requireActiveWorkspace: true },
      );
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

  /**
   * Status-plane self-report: merge workload/probe conditions without
   * changing desired spec, lifecycle phase, resolved inputs, provenance, or
   * the pinned resolved revision. Observer-owned condition types are fenced.
   */
  async reportStatusConditions(
    id: string,
    reported: readonly Condition[],
    actor?: ActorContext,
  ): Promise<Interface> {
    validateReportedConditions(reported);
    const wrote = await this.#updateStatusConditions(id, (current, now) => {
      const reportedTypes = new Set(
        reported.map((item) => item.type.toLowerCase()),
      );
      return [
        ...(current.status.conditions ?? []).filter(
          (item) => !reportedTypes.has(item.type.toLowerCase()),
        ),
        ...reported.map((item) => ({
          type: item.type,
          status: item.status,
          ...(item.reason ? { reason: item.reason } : {}),
          ...(item.message ? { message: item.message } : {}),
          observedGeneration: current.metadata.generation,
          lastTransitionAt: item.lastTransitionAt ?? now,
        })),
      ];
    });
    const record = await this.get(id);
    if (wrote) {
      await this.#recordActivity({
        actor,
        workspaceId: record.metadata.workspaceId,
        action: "interface.status_reported",
        targetType: "interface",
        targetId: record.metadata.id,
        metadata: { conditionTypes: reported.map((item) => item.type) },
      });
    }
    return record;
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

  async retire(
    id: string,
    expectedGeneration: number,
    actor?: ActorContext,
    expectedResolvedRevision?: number,
    materializationAuthority?: "portable_iac",
  ): Promise<Interface> {
    const current = await this.get(id);
    const declarationSource = current.metadata.materializedFrom?.source;
    if (
      actor !== undefined &&
      declarationSource === "portable_iac" &&
      materializationAuthority !== "portable_iac"
    ) {
      throw new InterfaceServiceError(
        "failed_precondition",
        "portable IaC Interface lifecycle is owned by its exact declaration",
      );
    }
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
      await this.#markTerminating(current.metadata.id, {
        requireActiveWorkspace: true,
      });
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
          { requireActiveWorkspace: true },
        );
      }
    }
  }

  async retireCapsule(workspaceId: string, capsuleId: string): Promise<void> {
    try { await this.revokeCapsuleInterfaceLinks(workspaceId, capsuleId); }
    catch (error) {
      if (!(error instanceof InterfaceServiceError) || error.code !== "failed_precondition") throw error;
      // v75 has no Interface-link ledger. Interface retirement still proceeds.
    }
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

  async createBinding(
    interfaceId: string,
    request: CreateInterfaceBindingRequest,
    actor?: ActorContext,
    materialization?: InterfaceBindingServiceMaterialization,
    authorityFence?: InterfaceAuthorityWriteFence,
  ): Promise<InterfaceBinding> {
    validateBindingRequest(request);
    // Binding issuance is a runtime authority boundary too. Reconcile against
    // the durable lifecycle guard so a missed terminal observer cannot turn an
    // old Resolved row into a newly Ready grant.
    const iface = await this.reconcile(interfaceId, {
      allowSafetyRecovery: true,
      authorityFence,
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
    // The durable owner/resource claim is written only after the Binding row
    // exists. Until #refreshBinding wins that CAS, OAuth delivery is not Ready.
    const initialReadiness =
      request.delivery.type === "oauth2" && readiness.ready
        ? { ready: false, reason: "OAuthResourceClaimPending" }
        : readiness;
    const record: InterfaceBinding = {
      apiVersion: TAKOSUMI_API_VERSION,
      kind: "InterfaceBinding",
      metadata: {
        id: materializationRecordId(materialization) ?? this.#newId("ifb"),
        workspaceId: iface.metadata.workspaceId,
        generation: 1,
        ...(materialization
          ? {
              materializedFrom:
                interfaceBindingMaterialization(materialization),
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
        phase: initialReadiness.ready ? "Ready" : "NotReady",
        observedInterfaceRevision: iface.status.resolvedRevision,
        conditions: [
          condition(
            "Ready",
            initialReadiness.ready ? "true" : "false",
            initialReadiness.reason,
            now,
            1,
          ),
        ],
      },
    };
    const authority = await assertInterfaceAuthorityWriteFence(authorityFence);
    if (!(await this.#stores.bindings.create(record, authority))) {
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
    await this.#refreshBinding(record.metadata.id, authorityFence);
    await this.#projectInterface(await this.get(interfaceId));
    return await this.getBinding(interfaceId, record.metadata.id);
  }

  async listBindings(
    interfaceId: string,
  ): Promise<readonly InterfaceBinding[]> {
    await this.get(interfaceId);
    return this.#stores.bindings.listByInterface(interfaceId);
  }

  /**
   * Bounded host-only canonical inventory. This is used by in-process runtime
   * composition after Resource Ready and is not mounted as a public listing.
   */
  async listForHost(
    filter: InterfaceListFilter,
  ): Promise<readonly Interface[]> {
    const normalized = this.#normalizeListFilter(filter);
    return await this.#stores.interfaces.list(normalized);
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
    reason: "Revoked" | "Superseded" = "Revoked",
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
            reason,
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

  /** Returns whether a durable status write occurred (false for a no-op). */
  async #updateStatusConditions(
    id: string,
    update: (current: Interface, now: string) => readonly Condition[],
    options: InterfaceObserverWriteOptions = {},
  ): Promise<boolean> {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const current = await this.get(id);
      if (current.status.phase === "Retired") return false;
      const now = this.#now();
      const nextStatus: Interface["status"] = {
        ...current.status,
        conditions: update(current, now),
      };
      if (await statusSemanticallyEqual(current.status, nextStatus)) {
        return false;
      }
      const next: Interface = {
        ...current,
        metadata: { ...current.metadata, updatedAt: now },
        status: nextStatus,
      };
      let wrote = false;
      try {
        wrote = await this.#stores.interfaces.compareAndSet(
          next,
          guard(current, options.requireActiveWorkspace),
        );
      } catch (error) {
        if (
          options.requireActiveWorkspace === true &&
          error instanceof WorkspaceManagementAdmissionConflictError
        ) {
          return false;
        }
        throw error;
      }
      if (wrote) {
        await this.#projectInterface(next);
        return true;
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
    options: InterfaceObserverWriteOptions = {},
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
      let wrote = false;
      try {
        wrote = await this.#stores.interfaces.compareAndSet(
          next,
          guard(current, options.requireActiveWorkspace),
        );
      } catch (error) {
        if (
          options.requireActiveWorkspace === true &&
          error instanceof WorkspaceManagementAdmissionConflictError
        ) {
          return;
        }
        throw error;
      }
      if (wrote) {
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

  async #markTerminating(
    id: string,
    options: InterfaceObserverWriteOptions = {},
  ): Promise<void> {
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
      let wrote = false;
      try {
        wrote = await this.#stores.interfaces.compareAndSet(
          next,
          guard(current, options.requireActiveWorkspace),
        );
      } catch (error) {
        if (
          options.requireActiveWorkspace === true &&
          error instanceof WorkspaceManagementAdmissionConflictError
        ) {
          return;
        }
        throw error;
      }
      if (wrote) {
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

  async #refreshBindings(
    interfaceId: string,
    authorityFence?: InterfaceAuthorityWriteFence,
  ): Promise<void> {
    const bindings = await this.#stores.bindings.listByInterface(interfaceId);
    for (const binding of bindings) {
      await this.#refreshBinding(binding.metadata.id, authorityFence);
    }
  }

  async #projectInterface(iface: Interface): Promise<boolean> {
    if (!this.#projectionSink) return true;
    try {
      const bindings = await this.#stores.bindings.listByInterface(
        iface.metadata.id,
      );
      if (
        hasUnownedCapsuleOutput(iface.metadata.ownerRef, iface.spec) &&
        (iface.status.phase === "Resolved" ||
          iface.status.resolvedInputs !== undefined ||
          iface.status.resourceUri !== undefined ||
          bindings.some((binding) => binding.status.phase === "Ready"))
      ) {
        return false;
      }
      await this.#projectionSink.project({
        interface: iface,
        bindings,
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

  async #refreshBinding(
    bindingId: string,
    authorityFence?: InterfaceAuthorityWriteFence,
  ): Promise<void> {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const current = await this.#stores.bindings.get(bindingId);
      if (!current || current.status.phase === "Revoked") return;
      const iface = await this.get(current.spec.interfaceId);
      let readiness = await bindingReadiness(
        iface,
        current.spec.delivery,
        current.spec.subjectRef,
        this.#bindingDeliveryHandlers,
      );
      if (readiness.ready && current.spec.delivery.type === "oauth2") {
        const resource = resolvedOAuth2Resource(iface);
        const claim = resource
          ? await this.#claimOAuth2Resource(
              iface,
              resource,
              authorityFence,
            )
          : "changed";
        if (claim === "changed") continue;
        if (claim === "conflict") {
          readiness = { ready: false, reason: "OAuthResourceConflict" };
        }
      }
      const retired = iface.status.phase === "Retired";
      const ready = readiness.ready;
      const desiredPhase = retired ? "Revoked" : ready ? "Ready" : "NotReady";
      const desiredReason = retired ? "InterfaceRetired" : readiness.reason;
      const desiredConditionStatus = ready ? "true" : "false";
      if (
        current.status.phase === desiredPhase &&
        current.status.observedInterfaceRevision ===
          iface.status.resolvedRevision &&
        current.status.conditions?.some(
          (item) =>
            item.type === "Ready" &&
            item.status === desiredConditionStatus &&
            item.reason === desiredReason,
        )
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
                  desiredReason,
                  now,
                  current.metadata.generation + 1,
                ),
              ]
            : ready
              ? [
                  condition(
                    "Ready",
                    "true",
                    desiredReason,
                    now,
                    current.metadata.generation + 1,
                  ),
                ]
              : [
                  condition(
                    "Ready",
                    "false",
                    desiredReason,
                    now,
                    current.metadata.generation + 1,
                  ),
                ],
        },
      };
      const authority = await assertInterfaceAuthorityWriteFence(
        authorityFence,
      );
      if (
        await this.#stores.bindings.compareAndSet(
          next,
          current.metadata.generation,
          authority,
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
    const bindings = (
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
    const accepted: InterfaceBinding[] = [];
    // This cache lives only for this read. The post-issuer authority check uses
    // fresh storage reads, so revocations during credential issuance still win.
    const cache = { links: new Map<string, InterfaceLink | undefined>(), capsules: new Map<string, Capsule | undefined>() };
    for (const binding of bindings) if (await this.#bindingLinkActive(binding, iface, permission, cache)) accepted.push(binding);
    return accepted;
  }

  async #claimOAuth2Resource(
    iface: Interface,
    resource: string,
    authorityFence?: InterfaceAuthorityWriteFence,
  ): Promise<"claimed" | "conflict" | "changed"> {
    if (interfaceOAuth2ResourceUri(iface) !== resource) return "changed";
    const authority = await assertInterfaceAuthorityWriteFence(authorityFence);
    if (
      await this.#stores.interfaces.claimOAuth2Resource(
        {
          record: iface,
          resource,
        },
        authority,
      )
    ) {
      return "claimed";
    }
    const claimedBy = await this.#stores.interfaces.findOAuth2ResourceClaim({
      workspaceId: iface.metadata.workspaceId,
      ownerKind: iface.metadata.ownerRef.kind,
      ownerId: iface.metadata.ownerRef.id,
      resource,
    });
    return claimedBy && claimedBy !== iface.metadata.id
      ? "conflict"
      : "changed";
  }
}

async function assertInterfaceAuthorityWriteFence(
  fence: InterfaceAuthorityWriteFence | undefined,
): Promise<InterfaceMaterializationWriteAuthority | undefined> {
  if (!fence) return undefined;
  if (fence.signal.aborted) {
    throw fence.signal.reason ?? new Error("Interface authority fence lost");
  }
  const authority = await fence.assertCurrent();
  if (fence.signal.aborted) {
    throw fence.signal.reason ?? new Error("Interface authority fence lost");
  }
  return authority;
}

async function resolvedStatus(
  current: Interface,
  resolution: Extract<InterfaceResolutionResult, { readonly ok: true }>,
  now: string,
  resourceUri: string | undefined,
): Promise<Interface["status"]> {
  const before = await stableJsonDigest({
    phase: current.status.phase,
    observedGeneration: current.status.observedGeneration,
    resolvedInputs: current.status.resolvedInputs ?? {},
    resourceUri: current.status.resourceUri ?? null,
    provenance: current.status.provenance ?? {},
  });
  const after = await stableJsonDigest({
    phase: "Resolved",
    observedGeneration: current.metadata.generation,
    resolvedInputs: resolution.resolvedInputs,
    resourceUri: resourceUri ?? null,
    provenance: resolution.provenance,
  });
  return {
    phase: "Resolved",
    observedGeneration: current.metadata.generation,
    resolvedRevision:
      current.status.resolvedRevision + (before === after ? 0 : 1),
    resolvedInputs: resolution.resolvedInputs,
    ...(resourceUri ? { resourceUri } : {}),
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
    current.status.resolvedInputs !== undefined ||
    current.status.resourceUri !== undefined;
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

function guard(
  record: Interface,
  requireActiveWorkspace?: true,
): InterfaceWriteGuard {
  return {
    generation: record.metadata.generation,
    resolvedRevision: record.status.resolvedRevision,
    record,
    ...(requireActiveWorkspace === true
      ? { requireActiveWorkspace: true as const }
      : {}),
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

const RESERVED_REPORTED_CONDITION_TYPES = new Set([
  "ready",
  "drifted",
  "observationpending",
  "unsupportedpolicy",
]);
const REPORTED_CONDITION_TYPE_PATTERN = /^[A-Za-z][A-Za-z0-9]{0,63}$/u;

function validateReportedConditions(conditions: readonly Condition[]): void {
  if (
    !Array.isArray(conditions) ||
    conditions.length === 0 ||
    conditions.length > 16
  ) {
    throw new InterfaceServiceError(
      "invalid_argument",
      "conditions must be a non-empty array of at most 16 entries",
    );
  }
  const seen = new Set<string>();
  for (const item of conditions) {
    const raw = requireRecord(item, "condition");
    assertOnlyKeys(
      raw,
      ["type", "status", "reason", "message", "lastTransitionAt"],
      "condition",
    );
    const type = requireText(raw.type, "condition.type");
    if (!REPORTED_CONDITION_TYPE_PATTERN.test(type)) {
      throw new InterfaceServiceError(
        "invalid_argument",
        "condition.type must be an alphanumeric token",
      );
    }
    const normalizedType = type.toLowerCase();
    if (RESERVED_REPORTED_CONDITION_TYPES.has(normalizedType)) {
      throw new InterfaceServiceError(
        "invalid_argument",
        `condition type ${type} is observer-owned and cannot be self-reported`,
      );
    }
    if (seen.has(normalizedType)) {
      throw new InterfaceServiceError(
        "invalid_argument",
        "condition types must be distinct (case-insensitive)",
      );
    }
    seen.add(normalizedType);
    if (
      raw.status !== "true" &&
      raw.status !== "false" &&
      raw.status !== "unknown"
    ) {
      throw new InterfaceServiceError(
        "invalid_argument",
        "condition.status must be true, false, or unknown",
      );
    }
    if (
      raw.reason !== undefined &&
      requireText(raw.reason, "condition.reason").length > 128
    ) {
      throw new InterfaceServiceError(
        "invalid_argument",
        "condition.reason must be at most 128 characters",
      );
    }
    if (
      raw.message !== undefined &&
      requireText(raw.message, "condition.message").length > 1024
    ) {
      throw new InterfaceServiceError(
        "invalid_argument",
        "condition.message must be at most 1024 characters",
      );
    }
  }
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

export function validateCapsuleRequiredInterfaces(
  requirements: readonly CapsuleRequiredInterface[],
): void {
  if (!Array.isArray(requirements) || requirements.length > 64) {
    throw new InterfaceServiceError(
      "invalid_argument",
      "requiredInterfaces must be an array with at most 64 entries",
    );
  }
  const keys = new Set<string>();
  const selectors = new Set<string>();
  for (const requirement of requirements) {
    const raw = requireRecord(requirement, "required Interface");
    assertOnlyKeys(
      raw,
      ["key", "interface", "permissions", "delivery"],
      "required Interface",
    );
    const key = requireText(raw.key, "required Interface key");
    validateToken(key, "required Interface key");
    if (keys.has(key)) {
      throw new InterfaceServiceError(
        "invalid_argument",
        `duplicate required Interface key: ${key}`,
      );
    }
    keys.add(key);
    const selector = requireRecord(raw.interface, "required Interface selector");
    assertOnlyKeys(selector, ["type", "version"], "required Interface selector");
    validateToken(requireText(selector.type, "required Interface type"), "required Interface type");
    validateToken(
      requireText(selector.version, "required Interface version"),
      "required Interface version",
    );
    const selectorIdentity = `${String(selector.type)}\u0000${String(selector.version)}`;
    if (selectors.has(selectorIdentity)) {
      throw new InterfaceServiceError(
        "invalid_argument",
        "required Interfaces must use distinct type/version selectors",
      );
    }
    selectors.add(selectorIdentity);
    validateBindingRequest({
      subjectRef: { kind: "Principal", id: "pairwise-principal" },
      permissions: raw.permissions,
      delivery: raw.delivery,
    } as CreateInterfaceBindingRequest);
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
    throw new InterfaceServiceError(
      "invalid_argument",
      `unsupported Interface blueprint input source for ${name}`,
    );
  }
  return materialized;
}

function assertOwnedCapsuleOutputs(
  ownerRef: Interface["metadata"]["ownerRef"],
  spec: InterfaceSpec,
): void {
  if (hasUnownedCapsuleOutput(ownerRef, spec)) {
    throw new InterfaceServiceError(
      "failed_precondition",
      "capsule_output inputs must belong to the Interface's owning Capsule",
    );
  }
}

function hasUnownedCapsuleOutput(
  ownerRef: Interface["metadata"]["ownerRef"],
  spec: InterfaceSpec,
): boolean {
  return Object.values(spec.inputs ?? {}).some(
    (input) =>
      input.source === "capsule_output" &&
      (ownerRef.kind !== "Capsule" || input.capsuleId !== ownerRef.id),
  );
}

function normalizeSpec(spec: InterfaceSpec): InterfaceSpec {
  const raw = requireRecord(spec, "spec");
  assertOnlyKeys(
    raw,
    ["type", "version", "document", "documentSchema", "inputs", "access"],
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
  if (raw.documentSchema !== undefined) {
    validateJsonDocument(raw.documentSchema, "spec.documentSchema");
  }
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
    ...(raw.documentSchema !== undefined
      ? { documentSchema: raw.documentSchema as JsonObject }
      : {}),
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
    !["Principal", "ServiceAccount", "Capsule"].includes(
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
    // `capability:` is the host-runtime materialization vocabulary for the
    // same thing: an opaque host reference, never credential material.
    !/^(?:secret|credential|capability)[/:][A-Za-z0-9][A-Za-z0-9._:/-]*$/u.test(
      reference,
    )
  ) {
    throw new InterfaceServiceError(
      "invalid_argument",
      "delivery.credentialRef must be a secret/..., credential/..., or capability/... reference identifier",
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
  // `none` delivers nothing to the subject. A `capability:` reference is
  // therefore still valid here: the host resolves it internally when it
  // materializes the subject's runtime, and the subject never receives it.
  handlers.set("none", ({ delivery }) =>
    delivery.options === undefined &&
    (delivery.credentialRef === undefined ||
      delivery.credentialRef.startsWith("capability:"))
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
  return interfaceOAuth2ResourceUri(iface);
}

function normalizedOwner(owner: unknown): Interface["metadata"]["ownerRef"] {
  const raw = requireRecord(owner, "ownerRef");
  assertOnlyKeys(raw, ["kind", "id"], "ownerRef");
  if (!["Workspace", "Capsule"].includes(String(raw.kind))) {
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

function interfaceMaterialization(
  materialization: InterfaceServiceMaterialization,
): NonNullable<Interface["metadata"]["materializedFrom"]> {
  if ("capsuleBlueprintKey" in materialization) {
    return {
      source: "capsule_blueprint",
      key: requireText(
        materialization.capsuleBlueprintKey,
        "capsuleBlueprintKey",
      ),
    };
  }
  if ("portableIac" in materialization) {
    return {
      source: "portable_iac",
      descriptorName: requireText(
        materialization.descriptorName,
        "descriptorName",
      ),
      descriptorVersion: requireText(
        materialization.descriptorVersion,
        "descriptorVersion",
      ),
    };
  }
  throw new InterfaceServiceError(
    "invalid_argument",
    "unsupported Interface materialization",
  );
}

function materializationRecordId(
  materialization:
    | InterfaceServiceMaterialization
    | InterfaceBindingServiceMaterialization
    | undefined,
): string | undefined {
  if (
    !materialization ||
    !("recordId" in materialization) ||
    materialization.recordId === undefined
  ) {
    return undefined;
  }
  return requireText(materialization.recordId, "materialization.recordId");
}

async function capsuleBlueprintRecordId(
  prefix: "if" | "ifb",
  input: {
    readonly workspaceId: string;
    readonly capsuleId: string;
    readonly interfaceKey: string;
    readonly bindingKey?: string;
  },
): Promise<string> {
  const digest = await stableJsonDigest({
    source: "capsule_blueprint",
    recordKind: prefix === "if" ? "Interface" : "InterfaceBinding",
    workspaceId: requireText(input.workspaceId, "workspaceId"),
    capsuleId: requireText(input.capsuleId, "capsuleId"),
    interfaceKey: requireText(input.interfaceKey, "interfaceKey"),
    ...(input.bindingKey === undefined
      ? {}
      : { bindingKey: requireText(input.bindingKey, "bindingKey") }),
  });
  return `${prefix}_${digest.slice("sha256:".length, "sha256:".length + 32)}`;
}

function interfaceBindingMaterialization(
  materialization: InterfaceBindingServiceMaterialization,
): NonNullable<InterfaceBinding["metadata"]["materializedFrom"]> {
  if ("capsuleBlueprintKey" in materialization) {
    return {
      source: "capsule_blueprint",
      interfaceKey: requireText(
        materialization.capsuleBlueprintKey,
        "capsuleBlueprintKey",
      ),
      key: requireText(
        materialization.bindingBlueprintKey,
        "bindingBlueprintKey",
      ),
    };
  }
  if ("requiredInterfaceKey" in materialization) {
    return {
      source: "capsule_required_interface",
      linkId: requireText(materialization.requiredInterfaceLinkId, "requiredInterfaceLinkId"),
      capsuleId: requireText(
        materialization.requiredInterfaceCapsuleId,
        "requiredInterfaceCapsuleId",
      ),
      requirementKey: requireText(
        materialization.requiredInterfaceKey,
        "requiredInterfaceKey",
      ),
      interfaceType: requireText(
        materialization.requiredInterfaceType,
        "requiredInterfaceType",
      ),
      interfaceVersion: requireText(
        materialization.requiredInterfaceVersion,
        "requiredInterfaceVersion",
      ),
    };
  }
  throw new InterfaceServiceError(
    "invalid_argument",
    "unsupported InterfaceBinding materialization",
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
  const canonical = canonicalInterfaceOAuth2ResourceUri(value);
  if (!canonical) {
    throw new InterfaceServiceError(
      "invalid_argument",
      `resolved input ${inputName} must be a credential-free HTTPS resource URI`,
    );
  }
  return canonical;
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

function linkMatchesRequirement(link: InterfaceLink, requirement: CapsuleRequiredInterface): boolean {
  return link.interface.type === requirement.interface.type && link.interface.version === requirement.interface.version && link.deliveryType === requirement.delivery.type;
}

function linkMatchesRequirementExactly(link: InterfaceLink, requirement: CapsuleRequiredInterface): boolean {
  return linkMatchesRequirement(link, requirement) && samePermissionSet(link.requestedPermissions, requirement.permissions);
}

function samePermissionSet(left: readonly string[], right: readonly string[]): boolean {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  return leftSet.size === rightSet.size && [...leftSet].every((permission) => rightSet.has(permission));
}

function bindingBelongsToLink(binding: InterfaceBinding, link: InterfaceLink): boolean {
  const source = binding.metadata.materializedFrom;
  return source?.source === "capsule_required_interface" && binding.spec.interfaceId === link.providerInterfaceId &&
    (source.linkId === link.id || (!source.linkId && source.capsuleId === link.consumerCapsuleId && source.requirementKey === link.requirementKey && source.interfaceType === link.interface.type && source.interfaceVersion === link.interface.version && binding.spec.delivery.type === link.deliveryType));
}

function isMissingInterfaceOwner(error: unknown): boolean {
  return (error instanceof InterfaceServiceError || error instanceof OpenTofuControllerError) && error.code === "not_found";
}
