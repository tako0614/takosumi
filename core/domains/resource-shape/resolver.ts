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
  Record<string, { readonly required: readonly string[]; readonly preferred: readonly string[] }>
> = Object.freeze({
  ObjectStore: Object.freeze({
    required: Object.freeze(["s3_api"]) as readonly string[],
    preferred: Object.freeze(["signed_url", "object_events"]) as readonly string[],
  }),
  HttpService: Object.freeze({
    required: Object.freeze(["web_fetch"]) as readonly string[],
    preferred: Object.freeze(["public_http", "workers_bindings", "node_compat"]) as readonly string[],
  }),
});

/**
 * Map a Target backend type to the ObjectStore implementation it hosts
 * (`docs/final-plan.md` §14: ObjectStore -> AWS S3 / Cloudflare R2 / MinIO /
 * Takosumi Object Store). `kubernetes`/`vm` host an s3-compatible MinIO.
 */
export const OBJECT_STORE_TARGET_IMPLEMENTATION: Readonly<
  Partial<Record<TargetType, string>>
> = Object.freeze({
  cloudflare: "cloudflare_r2",
  aws: "aws_s3",
  takosumi_native: "takosumi_object_store",
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
  ObjectStore: OBJECT_STORE_TARGET_IMPLEMENTATION,
  HttpService: Object.freeze({
    cloudflare: "cloudflare_workers",
    takosumi_native: "takosumi_http_runtime",
    kubernetes: "kubernetes_http_service",
    aws: "aws_lambda_url",
  }),
});

/**
 * Default per-implementation capability matrix. ObjectStore is currently
 * materializable through first-party modules; HttpService is enabled for the
 * Cloudflare Worker-compatible path. Future shapes are added here only when the
 * planner can materialize them.
 */
export const DEFAULT_RESOURCE_SHAPE_CAPABILITIES: TargetCapabilityMatrix =
  Object.freeze([
    Object.freeze({
      implementation: "aws_s3",
      targetType: "aws",
      shape: "ObjectStore",
      interfaces: Object.freeze({
        s3_api: "native",
        signed_url: "native",
        object_events: "native",
      }),
    }),
    Object.freeze({
      implementation: "cloudflare_r2",
      targetType: "cloudflare",
      shape: "ObjectStore",
      interfaces: Object.freeze({
        s3_api: "native",
        signed_url: "native",
        object_events: "shim",
      }),
    }),
    Object.freeze({
      implementation: "minio",
      targetType: "kubernetes",
      shape: "ObjectStore",
      interfaces: Object.freeze({
        s3_api: "native",
        signed_url: "native",
        object_events: "emulated",
      }),
    }),
    Object.freeze({
      implementation: "takosumi_object_store",
      targetType: "takosumi_native",
      shape: "ObjectStore",
      interfaces: Object.freeze({
        s3_api: "native",
        signed_url: "native",
        object_events: "native",
      }),
    }),
    Object.freeze({
      implementation: "cloudflare_workers",
      targetType: "cloudflare",
      shape: "HttpService",
      interfaces: Object.freeze({
        web_fetch: "native",
        public_http: "native",
        workers_bindings: "native",
        node_compat: "shim",
      }),
    }),
    Object.freeze({
      implementation: "takosumi_http_runtime",
      targetType: "takosumi_native",
      shape: "HttpService",
      interfaces: Object.freeze({
        web_fetch: "native",
        public_http: "native",
        workers_bindings: "shim",
        node_compat: "native",
      }),
    }),
    Object.freeze({
      implementation: "kubernetes_http_service",
      targetType: "kubernetes",
      shape: "HttpService",
      interfaces: Object.freeze({
        web_fetch: "shim",
        public_http: "shim",
        workers_bindings: "emulated",
        node_compat: "native",
      }),
    }),
    Object.freeze({
      implementation: "aws_lambda_url",
      targetType: "aws",
      shape: "HttpService",
      interfaces: Object.freeze({
        web_fetch: "shim",
        public_http: "native",
        workers_bindings: "emulated",
        node_compat: "shim",
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
): ImplementationCapability | undefined {
  return matrix.find((c) => c.implementation === implementation);
}

function levelOf(
  cap: ImplementationCapability | undefined,
  iface: string,
): CapabilityLevel {
  return (cap?.interfaces[iface] as CapabilityLevel | undefined) ?? "unsupported";
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
): readonly NativeResourceRef[] {
  if (shape === "HttpService") {
    switch (implementation) {
      case "cloudflare_workers":
        return [{ type: "cloudflare.workers_script", id: name }];
      case "takosumi_http_runtime":
        return [{ type: "takosumi.http_service", id: name }];
      case "kubernetes_http_service":
        return [{ type: "kubernetes.deployment", id: name }];
      case "aws_lambda_url":
        return [{ type: "aws.lambda_function", id: name }];
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
    case "takosumi_object_store":
      return [{ type: "takosumi.object_store", id: name }];
    default:
      return [];
  }
}

function computePortability(
  scores: readonly InterfaceCapabilityScore[],
): ResourcePortability {
  const levels = scores.map((s) => s.level);
  if (levels.every((l) => l === "native")) return "portable";
  if (levels.some((l) => l === "emulated" || l === "unsupported")) return "partial";
  if (levels.some((l) => l === "shim")) return "mostly_portable";
  return "portable";
}

function capabilityScoresFor(
  cap: ImplementationCapability | undefined,
  interfaces: readonly string[],
): readonly InterfaceCapabilityScore[] {
  return interfaces.map((iface) => ({ interface: iface, level: levelOf(cap, iface) }));
}

function riskNotesFor(
  implementation: string,
  scores: readonly InterfaceCapabilityScore[],
): string[] {
  const notes: string[] = [];
  for (const s of scores) {
    if (s.level === "shim") {
      notes.push(`${s.interface} is provided via an adapter shim on ${implementation}`);
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

  const eligible = input.targetPool.spec.targets.filter((entry) => {
    // Deny wins; an entry matches a policy token by BOTH its type and name.
    if (denied && (denied.includes(entry.type) || denied.includes(entry.name))) {
      return false;
    }
    if (
      allowed &&
      allowed.length > 0 &&
      !(allowed.includes(entry.type) || allowed.includes(entry.name))
    ) {
      return false;
    }
    const implementation = SHAPE_TARGET_IMPLEMENTATION[input.resource.kind]?.[entry.type];
    if (!implementation) return false;
    const cap = findCapability(matrix, implementation);
    if (!cap || cap.shape !== input.resource.kind) return false;
    return requestedInterfaces.every((iface) => levelOf(cap, iface) !== "unsupported");
  });

  if (eligible.length === 0) {
    return {
      ok: false,
      error: {
        code: "no_eligible_target",
        message:
          `no Target in the pool is allowed by policy and supports the required ${input.resource.kind} interfaces`,
      },
    };
  }

  // Highest priority wins; tie-break by name ascending (deterministic).
  const ranked = [...eligible].sort(
    (a, b) => b.priority - a.priority || byName(a.name, b.name),
  );
  const entry = ranked[0]!;
  return {
    ok: true,
    selection: {
      entry,
      implementation: SHAPE_TARGET_IMPLEMENTATION[input.resource.kind]![entry.type]!,
    },
  };
}

function buildFreshOutput(
  input: ResolverInput,
  matrix: TargetCapabilityMatrix,
  selection: Selection,
): ResolverOutput {
  const { entry, implementation } = selection;
  const cap = findCapability(matrix, implementation);
  const name = resourceName(input.resource);

  const capabilityScores = capabilityScoresFor(cap, input.interfaces);
  const portability = computePortability(capabilityScores);
  const nativeResourcePlan = nativeResourcesFor(input.resource.kind, implementation, name);
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
    lock.nativeResources ?? nativeResourcesFor(
      input.resource.kind,
      lock.selectedImplementation,
      name,
    );

  const riskNotes = riskNotesFor(lock.selectedImplementation, capabilityScores);
  if (freshSelection.ok && freshSelection.selection.entry.name !== lock.target) {
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
      `resolver does not implement shape ${input.resource.kind} (Phase 2 ships ObjectStore only)`,
    );
  }

  const matrix = input.targetCapabilities ?? DEFAULT_RESOURCE_SHAPE_CAPABILITIES;
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
  return { ok: true, output: buildFreshOutput(input, matrix, freshSelection.selection) };
}
