// Resource Shape Resolver — PURE, deterministic.
//
// The Resolver turns a desired Resource shape + interface set into a concrete
// implementation on a concrete Target, scored against a TargetCapabilityMatrix
// (`docs/final-plan.md` §8). The decision is frozen as a ResolutionLock (§3.5):
// once a resource is locked, Takosumi must not silently re-target it — migration
// is an explicit operation. This module performs NO I/O and never reads the
// clock or RNG; the service layer stamps `lockedAt`.

import type {
  CapabilityLevel,
  ImplementationCapability,
  InterfaceCapabilityScore,
  NativeResourceRef,
  ResolutionLock,
  ResolverInput,
  ResolverOutput,
  ResourceObject,
  ResourcePortability,
  SpacePolicy,
  TargetCapabilityMatrix,
  TargetPoolEntry,
  TargetType,
} from "takosumi-contract";

/** Result of {@link resolve}: a typed success/failure outcome (no throws). */
export type ResolveOutcome =
  | { readonly ok: true; readonly output: ResolverOutput }
  | {
      readonly ok: false;
      readonly error: { readonly code: string; readonly message: string };
    };

/**
 * Which interfaces a resource shape must have (`required`) versus may have
 * (`preferred`). Eligibility filtering uses `required`; requested interfaces
 * contribute to capability scoring / risk notes. Exported so the table is
 * directly testable.
 */
export const SHAPE_INTERFACE_REQUIREMENTS: Readonly<
  Record<
    string,
    {
      readonly required: readonly string[];
      readonly preferred: readonly string[];
    }
  >
> = Object.freeze({
  ObjectBucket: Object.freeze({
    required: Object.freeze(["s3_api"]) as readonly string[],
    preferred: Object.freeze([
      "signed_url",
      "object_events",
    ]) as readonly string[],
  }),
  EdgeWorker: Object.freeze({
    required: Object.freeze(["worker_fetch"]) as readonly string[],
    preferred: Object.freeze([
      "workers_bindings",
      "node_compat",
      "service_bindings",
      "static_assets",
    ]) as readonly string[],
  }),
  AIEndpoint: Object.freeze({
    required: Object.freeze([]) as readonly string[],
    preferred: Object.freeze([
      "openai_chat_completions",
      "openai_responses",
      "openai_embeddings",
    ]) as readonly string[],
  }),
});

/**
 * Map a Target backend type to the ObjectBucket implementation it hosts
 * (`docs/final-plan.md` §14: ObjectBucket -> AWS S3 / Cloudflare R2 / MinIO /
 * Takosumi Object Store). `kubernetes`/`vm` host an s3-compatible MinIO.
 */
export const OBJECT_BUCKET_TARGET_IMPLEMENTATION: Readonly<
  Partial<Record<TargetType, string>>
> = Object.freeze({
  cloudflare: "cloudflare_r2",
  aws: "aws_s3",
  takosumi_native: "takosumi_object_bucket",
  kubernetes: "minio",
  vm: "minio",
});

/**
 * Map Target backend type to implementation for each shape. This table is the
 * resolver's pluggable target-adapter registry seed; operators can still pass
 * a custom capability matrix, but Takosumi never collapses shapes into one
 * generic `takosumi_resource` path.
 */
export const SHAPE_TARGET_IMPLEMENTATION: Readonly<
  Record<string, Partial<Record<TargetType, string>>>
> = Object.freeze({
  ObjectBucket: OBJECT_BUCKET_TARGET_IMPLEMENTATION,
  EdgeWorker: Object.freeze({
    cloudflare: "cloudflare_workers",
    takosumi_native: "takosumi_edge_runtime",
  }),
  AIEndpoint: Object.freeze({
    cloudflare: "cloudflare_ai_gateway",
    takosumi_native: "takosumi_ai_gateway",
    ai_provider: "openai_compatible_ai_endpoint",
    aws: "aws_bedrock_openai_gateway",
    gcp: "vertex_ai_openai_gateway",
  }),
});

/**
 * Default per-implementation capability matrix. ObjectBucket is currently
 * materializable through first-party modules; EdgeWorker is enabled for the
 * Cloudflare Worker-compatible path. Future shapes are added here only when the
 * planner can materialize them.
 */
export const DEFAULT_RESOURCE_SHAPE_CAPABILITIES: TargetCapabilityMatrix =
  Object.freeze([
    Object.freeze({
      implementation: "aws_s3",
      targetType: "aws",
      shape: "ObjectBucket",
      interfaces: Object.freeze({
        s3_api: "native",
        signed_url: "native",
        object_events: "native",
      }),
    }),
    Object.freeze({
      implementation: "cloudflare_r2",
      targetType: "cloudflare",
      shape: "ObjectBucket",
      interfaces: Object.freeze({
        s3_api: "native",
        signed_url: "native",
        object_events: "shim",
      }),
    }),
    Object.freeze({
      implementation: "minio",
      targetType: "kubernetes",
      shape: "ObjectBucket",
      interfaces: Object.freeze({
        s3_api: "native",
        signed_url: "native",
        object_events: "emulated",
      }),
    }),
    Object.freeze({
      implementation: "takosumi_object_bucket",
      targetType: "takosumi_native",
      shape: "ObjectBucket",
      interfaces: Object.freeze({
        s3_api: "native",
        signed_url: "native",
        object_events: "native",
      }),
    }),
    Object.freeze({
      implementation: "cloudflare_workers",
      targetType: "cloudflare",
      shape: "EdgeWorker",
      interfaces: Object.freeze({
        worker_fetch: "native",
        workers_bindings: "native",
        node_compat: "shim",
        service_bindings: "native",
        static_assets: "native",
      }),
    }),
    Object.freeze({
      implementation: "takosumi_edge_runtime",
      targetType: "takosumi_native",
      shape: "EdgeWorker",
      interfaces: Object.freeze({
        worker_fetch: "native",
        workers_bindings: "shim",
        node_compat: "native",
        service_bindings: "shim",
        static_assets: "shim",
      }),
    }),
    Object.freeze({
      implementation: "cloudflare_ai_gateway",
      targetType: "cloudflare",
      shape: "AIEndpoint",
      interfaces: Object.freeze({
        openai_chat_completions: "native",
        openai_responses: "shim",
        openai_embeddings: "native",
      }),
    }),
    Object.freeze({
      implementation: "takosumi_ai_gateway",
      targetType: "takosumi_native",
      shape: "AIEndpoint",
      interfaces: Object.freeze({
        openai_chat_completions: "native",
        openai_responses: "native",
        openai_embeddings: "native",
      }),
    }),
    Object.freeze({
      implementation: "openai_compatible_ai_endpoint",
      targetType: "ai_provider",
      shape: "AIEndpoint",
      interfaces: Object.freeze({
        openai_chat_completions: "native",
        openai_responses: "shim",
        openai_embeddings: "shim",
      }),
    }),
  ]) as TargetCapabilityMatrix;

// --- internals ---------------------------------------------------------------

function fail(code: string, message: string): ResolveOutcome {
  return { ok: false, error: { code, message } };
}

/** Resource name used for native-resource ids: prefer `spec.name`, else metadata. */
function resourceName(resource: ResourceObject): string {
  const specName = (resource.spec as { readonly name?: unknown }).name;
  if (typeof specName === "string" && specName.length > 0) return specName;
  return resource.metadata.name;
}

/** `tkrn:{space}:{kind}:{name}` resource id (cf. §3.5 example). */
function resourceId(resource: ResourceObject): string {
  return `tkrn:${resource.metadata.space}:${resource.kind}:${resource.metadata.name}`;
}

function findCapability(
  matrix: TargetCapabilityMatrix,
  implementation: string,
  targetType?: TargetType,
  shape?: string,
): ImplementationCapability | undefined {
  return matrix.find(
    (c) =>
      c.implementation === implementation &&
      (targetType === undefined || c.targetType === targetType) &&
      (shape === undefined || c.shape === shape),
  );
}

function levelOf(
  cap: ImplementationCapability | undefined,
  iface: string,
): CapabilityLevel {
  return (
    (cap?.interfaces[iface] as CapabilityLevel | undefined) ?? "unsupported"
  );
}

/** Deterministic string compare (no locale dependence). */
function byName(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/** Native resource graph for the selected implementation (`docs/final-plan.md` §8/§16). */
function nativeResourcesFor(
  shape: string,
  implementation: string,
  name: string,
  nativeResourceType?: string,
): readonly NativeResourceRef[] {
  if (nativeResourceType) {
    return [{ type: nativeResourceType, id: name }];
  }
  if (shape === "EdgeWorker") {
    switch (implementation) {
      case "cloudflare_workers":
        return [{ type: "cloudflare.workers_script", id: name }];
      case "takosumi_edge_runtime":
        return [{ type: "takosumi.edge_worker", id: name }];
      default:
        return [];
    }
  }
  if (shape === "AIEndpoint") {
    switch (implementation) {
      case "cloudflare_ai_gateway":
        return [{ type: "cloudflare.ai_gateway", id: name }];
      case "takosumi_ai_gateway":
        return [{ type: "takosumi.ai_endpoint", id: name }];
      case "openai_compatible_ai_endpoint":
        return [{ type: "ai.openai_compatible_endpoint", id: name }];
      case "aws_bedrock_openai_gateway":
        return [{ type: "aws.bedrock_inference_profile", id: name }];
      case "vertex_ai_openai_gateway":
        return [{ type: "gcp.vertex_ai_endpoint", id: name }];
      default:
        return [];
    }
  }
  switch (implementation) {
    case "cloudflare_r2":
      return [{ type: "cloudflare.r2_bucket", id: name }];
    case "aws_s3":
      return [{ type: "aws.s3_bucket", id: name }];
    case "minio":
      return [{ type: "minio.s3_bucket", id: name }];
    case "takosumi_object_bucket":
      return [{ type: "takosumi.object_bucket", id: name }];
    default:
      return [];
  }
}

function computePortability(
  scores: readonly InterfaceCapabilityScore[],
): ResourcePortability {
  const levels = scores.map((s) => s.level);
  if (levels.every((l) => l === "native")) return "portable";
  if (levels.some((l) => l === "emulated" || l === "unsupported"))
    return "partial";
  if (levels.some((l) => l === "shim")) return "mostly_portable";
  return "portable";
}

function capabilityScoresFor(
  cap: ImplementationCapability | undefined,
  interfaces: readonly string[],
): readonly InterfaceCapabilityScore[] {
  return interfaces.map((iface) => ({
    interface: iface,
    level: levelOf(cap, iface),
  }));
}

function riskNotesFor(
  implementation: string,
  scores: readonly InterfaceCapabilityScore[],
): string[] {
  const notes: string[] = [];
  for (const s of scores) {
    if (s.level === "shim") {
      notes.push(
        `${s.interface} is provided via an adapter shim on ${implementation}`,
      );
    } else if (s.level === "emulated") {
      notes.push(`${s.interface} is emulated by Takosumi on ${implementation}`);
    } else if (s.level === "unsupported") {
      notes.push(`${s.interface} is unsupported on ${implementation}`);
    }
  }
  return notes;
}

interface Selection {
  readonly entry: TargetPoolEntry;
  readonly implementation: string;
  readonly nativeResourceType?: string;
}

interface ImplementationCandidate {
  readonly implementation: string;
  readonly nativeResourceType?: string;
}

function targetImplementationsFor(
  shape: string,
  entry: TargetPoolEntry,
): readonly ImplementationCandidate[] {
  const explicit = (entry.implementations ?? [])
    .filter((impl) => impl.shape === shape)
    .map((impl) => ({
      implementation: impl.implementation,
      nativeResourceType: impl.nativeResourceType,
    }));
  if (explicit.length > 0) return explicit;
  const seeded = SHAPE_TARGET_IMPLEMENTATION[shape]?.[entry.type];
  return seeded ? [{ implementation: seeded }] : [];
}

function targetPoolCapabilityMatrix(
  matrix: TargetCapabilityMatrix,
  entries: readonly TargetPoolEntry[],
): TargetCapabilityMatrix {
  const configured: ImplementationCapability[] = [];
  for (const entry of entries) {
    for (const impl of entry.implementations ?? []) {
      configured.push({
        implementation: impl.implementation,
        targetType: entry.type,
        shape: impl.shape,
        interfaces: impl.interfaces,
      });
    }
  }
  return configured.length === 0 ? matrix : [...configured, ...matrix];
}

function capabilityRank(
  cap: ImplementationCapability | undefined,
  interfaces: readonly string[],
): number {
  const weights: Readonly<Record<CapabilityLevel, number>> = {
    native: 3,
    shim: 2,
    emulated: 1,
    unsupported: 0,
  };
  return interfaces.reduce(
    (sum, iface) => sum + weights[levelOf(cap, iface)],
    0,
  );
}

type SelectResult =
  | { readonly ok: true; readonly selection: Selection }
  | {
      readonly ok: false;
      readonly error: { readonly code: string; readonly message: string };
    };

/** Apply SpacePolicy allow/deny, required-interface eligibility, then rank. */
function selectTarget(
  input: ResolverInput,
  matrix: TargetCapabilityMatrix,
  requestedInterfaces: readonly string[],
): SelectResult {
  const policy: SpacePolicy["spec"] | undefined = input.spacePolicy?.spec;
  const denied = policy?.deniedTargets;
  const allowed = policy?.allowedTargets;

  const eligible: Selection[] = [];
  for (const entry of input.targetPool.spec.targets) {
    // Deny wins; an entry matches a policy token by BOTH its type and name.
    if (
      denied &&
      (denied.includes(entry.type) || denied.includes(entry.name))
    ) {
      continue;
    }
    if (
      allowed &&
      allowed.length > 0 &&
      !(allowed.includes(entry.type) || allowed.includes(entry.name))
    ) {
      continue;
    }
    for (const candidate of targetImplementationsFor(
      input.resource.kind,
      entry,
    )) {
      const cap = findCapability(
        matrix,
        candidate.implementation,
        entry.type,
        input.resource.kind,
      );
      if (!cap || cap.shape !== input.resource.kind) continue;
      if (
        requestedInterfaces.every(
          (iface) => levelOf(cap, iface) !== "unsupported",
        )
      ) {
        eligible.push({
          entry,
          implementation: candidate.implementation,
          nativeResourceType: candidate.nativeResourceType,
        });
      }
    }
  }

  if (eligible.length === 0) {
    return {
      ok: false,
      error: {
        code: "no_eligible_target",
        message: `no Target in the pool is allowed by policy and supports the required ${input.resource.kind} interfaces`,
      },
    };
  }

  // Highest Target priority wins; when one Target exposes multiple
  // implementations, prefer the better interface fit, then deterministic names.
  const ranked = [...eligible].sort(
    (a, b) =>
      b.entry.priority - a.entry.priority ||
      capabilityRank(
        findCapability(
          matrix,
          b.implementation,
          b.entry.type,
          input.resource.kind,
        ),
        requestedInterfaces,
      ) -
        capabilityRank(
          findCapability(
            matrix,
            a.implementation,
            a.entry.type,
            input.resource.kind,
          ),
          requestedInterfaces,
        ) ||
      byName(a.entry.name, b.entry.name) ||
      byName(a.implementation, b.implementation),
  );
  return { ok: true, selection: ranked[0]! };
}

function buildFreshOutput(
  input: ResolverInput,
  matrix: TargetCapabilityMatrix,
  selection: Selection,
): ResolverOutput {
  const { entry, implementation } = selection;
  const cap = findCapability(
    matrix,
    implementation,
    entry.type,
    input.resource.kind,
  );
  const name = resourceName(input.resource);

  const capabilityScores = capabilityScoresFor(cap, input.interfaces);
  const portability = computePortability(capabilityScores);
  const nativeResourcePlan = nativeResourcesFor(
    input.resource.kind,
    implementation,
    name,
    selection.nativeResourceType,
  );
  const riskNotes = riskNotesFor(implementation, capabilityScores);

  const lockAfterCreate =
    input.spacePolicy?.spec.resolution.lockAfterCreate ?? false;

  const reason: string[] = [
    `${implementation} selected for ${input.resource.kind} on target ${entry.name} (priority ${entry.priority})`,
    ...capabilityScores.map((s) => `${s.interface} ${s.level}`),
  ];

  const resolutionLock: ResolutionLock = {
    resourceId: resourceId(input.resource),
    selectedImplementation: implementation,
    target: entry.name,
    locked: lockAfterCreate,
    reason,
    portability,
    nativeResources: nativeResourcePlan,
    // lockedAt is intentionally omitted: the service stamps the timestamp.
  };

  return {
    selectedImplementation: implementation,
    selectedTarget: entry.name,
    nativeResourcePlan,
    capabilityScores,
    portability,
    riskNotes,
    resolutionLock,
  };
}

/**
 * Re-derive the resolver output for an already-locked resolution WITHOUT
 * re-targeting it (`docs/final-plan.md` §3.5). If the current request would have
 * picked a different Target, append a risk note recording the divergence but
 * keep the locked decision intact.
 */
function buildLockedOutput(
  input: ResolverInput,
  matrix: TargetCapabilityMatrix,
  lock: ResolutionLock,
  freshSelection: SelectResult,
): ResolverOutput {
  const cap = findCapability(matrix, lock.selectedImplementation);
  const name = resourceName(input.resource);

  const capabilityScores = capabilityScoresFor(cap, input.interfaces);
  const portability = lock.portability ?? computePortability(capabilityScores);
  const nativeResourcePlan =
    lock.nativeResources ??
    nativeResourcesFor(input.resource.kind, lock.selectedImplementation, name);

  const riskNotes = riskNotesFor(lock.selectedImplementation, capabilityScores);
  if (
    freshSelection.ok &&
    freshSelection.selection.entry.name !== lock.target
  ) {
    riskNotes.push(
      `resolution is locked to target ${lock.target}; the current request would prefer ${freshSelection.selection.entry.name}, but migration is an explicit operation (no silent re-target)`,
    );
  }

  return {
    selectedImplementation: lock.selectedImplementation,
    selectedTarget: lock.target,
    nativeResourcePlan,
    capabilityScores,
    portability,
    riskNotes,
    resolutionLock: lock,
  };
}

/**
 * Resolve a desired Resource shape to an implementation + Target. Pure and
 * deterministic: no clock, no RNG, no I/O.
 */
export function resolve(input: ResolverInput): ResolveOutcome {
  const requirements = SHAPE_INTERFACE_REQUIREMENTS[input.resource.kind];
  if (!requirements) {
    return fail(
      "unsupported_shape",
      `resolver does not implement shape ${input.resource.kind}`,
    );
  }

  const matrix = targetPoolCapabilityMatrix(
    input.targetCapabilities ?? DEFAULT_RESOURCE_SHAPE_CAPABILITIES,
    input.targetPool.spec.targets,
  );
  const freshSelection = selectTarget(input, matrix, input.interfaces);

  // §3.5: a locked resolution is never silently re-targeted unless policy opts
  // into auto-migration. Return the existing decision unchanged.
  const lock = input.existingLock;
  if (lock?.locked) {
    const allowAutoMigration =
      input.spacePolicy?.spec.resolution.allowAutoMigration ?? false;
    if (!allowAutoMigration) {
      return {
        ok: true,
        output: buildLockedOutput(input, matrix, lock, freshSelection),
      };
    }
  }

  if (!freshSelection.ok) {
    return { ok: false, error: freshSelection.error };
  }
  return {
    ok: true,
    output: buildFreshOutput(input, matrix, freshSelection.selection),
  };
}
