// Resource Shape Planner - PURE.
//
// The Planner validates one shape-specific spec and lowers a resolved
// implementation to a first-party OpenTofu module call. It deliberately keeps
// shape-specific resource types (ObjectBucket, EdgeWorker, ...) instead
// of accepting a catch-all `takosumi_resource { type, spec }` object, so
// OpenTofu plan diffs, validation, import, drift, and state upgrades can remain
// resource-aware.

import type {
  AIEndpointInterface,
  AIEndpointProfile,
  AIEndpointSpec,
  EdgeWorkerProfile,
  EdgeWorkerSpec,
  ObjectBucketInterface,
  ObjectBucketSpec,
  ResourceDeletePolicy,
  ResourceShapeKind,
  TargetPoolEntry,
} from "takosumi-contract";
import { firstPartyModuleFilesByTemplateId } from "../../../opentofu-modules/module-files.ts";

export interface ResourceShapePlan {
  readonly shape: ResourceShapeKind;
  readonly templateId: string;
  readonly moduleFiles: readonly {
    readonly path: string;
    readonly text: string;
  }[];
  readonly inputs: Record<string, unknown>;
  readonly publicOutputs: readonly string[];
}

export type ParsedResourceSpec =
  | {
      readonly kind: "ObjectBucket";
      readonly spec: ObjectBucketSpec;
      readonly interfaces: readonly string[];
      readonly lifecyclePolicy?: ObjectBucketSpec["lifecyclePolicy"];
    }
  | {
      readonly kind: "EdgeWorker";
      readonly spec: EdgeWorkerSpec;
      readonly interfaces: readonly string[];
      readonly lifecyclePolicy?: EdgeWorkerSpec["lifecyclePolicy"];
    }
  | {
      readonly kind: "AIEndpoint";
      readonly spec: AIEndpointSpec;
      readonly interfaces: readonly string[];
      readonly lifecyclePolicy?: AIEndpointSpec["lifecyclePolicy"];
    };

export type ParseResourceSpecResult =
  | { readonly ok: true; readonly parsed: ParsedResourceSpec }
  | {
      readonly ok: false;
      readonly error: { readonly code: string; readonly message: string };
    };

export type ParseObjectBucketSpecResult =
  | { readonly ok: true; readonly spec: ObjectBucketSpec }
  | {
      readonly ok: false;
      readonly error: { readonly code: string; readonly message: string };
    };

export type ParseEdgeWorkerSpecResult =
  | { readonly ok: true; readonly spec: EdgeWorkerSpec }
  | {
      readonly ok: false;
      readonly error: { readonly code: string; readonly message: string };
    };

export type ParseAIEndpointSpecResult =
  | { readonly ok: true; readonly spec: AIEndpointSpec }
  | {
      readonly ok: false;
      readonly error: { readonly code: string; readonly message: string };
    };

const OBJECT_BUCKET_INTERFACES: readonly ObjectBucketInterface[] = [
  "s3_api",
  "signed_url",
  "object_events",
];

const EDGE_WORKER_PROFILES: readonly EdgeWorkerProfile[] = [
  "workers_bindings",
  "node_compat",
  "service_bindings",
  "static_assets",
];

const RESOURCE_DELETE_POLICIES: readonly ResourceDeletePolicy[] = [
  "delete",
  "retain",
  "snapshot_then_delete",
  "block",
];

/** Map ObjectBucket implementation -> first-party Capsule module template id. */
export const OBJECT_BUCKET_IMPLEMENTATION_TEMPLATE: Readonly<
  Record<string, string>
> = Object.freeze({
  cloudflare_r2: "cloudflare-r2-storage",
  aws_s3: "aws-s3-storage",
});

/** Map EdgeWorker implementation -> first-party Capsule module template id. */
export const EDGE_WORKER_IMPLEMENTATION_TEMPLATE: Readonly<
  Record<string, string>
> = Object.freeze({
  cloudflare_workers: "cloudflare-worker-service",
});

/** Map AIEndpoint implementation -> first-party Capsule module template id. */
export const AI_ENDPOINT_GENERIC_TEMPLATE_ID = "takosumi-ai-endpoint";

export const AI_ENDPOINT_IMPLEMENTATION_TEMPLATE: Readonly<
  Record<string, string>
> = Object.freeze({
  cloudflare_ai_gateway: AI_ENDPOINT_GENERIC_TEMPLATE_ID,
  takosumi_ai_gateway: AI_ENDPOINT_GENERIC_TEMPLATE_ID,
  openai_compatible_ai_endpoint: AI_ENDPOINT_GENERIC_TEMPLATE_ID,
  aws_bedrock_openai_gateway: AI_ENDPOINT_GENERIC_TEMPLATE_ID,
  vertex_ai_openai_gateway: AI_ENDPOINT_GENERIC_TEMPLATE_ID,
});

export function parseResourceSpec(
  kind: ResourceShapeKind,
  spec: unknown,
): ParseResourceSpecResult {
  switch (kind) {
    case "ObjectBucket": {
      const r = parseObjectBucketSpec(spec);
      return r.ok
        ? {
            ok: true,
            parsed: {
              kind,
              spec: r.spec,
              interfaces: r.spec.interfaces,
              lifecyclePolicy: r.spec.lifecyclePolicy,
            },
          }
        : r;
    }
    case "EdgeWorker": {
      const r = parseEdgeWorkerSpec(spec);
      return r.ok
        ? {
            ok: true,
            parsed: {
              kind,
              spec: r.spec,
              interfaces: requiredEdgeWorkerInterfaces(r.spec),
              lifecyclePolicy: r.spec.lifecyclePolicy,
            },
          }
        : r;
    }
    case "AIEndpoint": {
      const r = parseAIEndpointSpec(spec);
      return r.ok
        ? {
            ok: true,
            parsed: {
              kind,
              spec: r.spec,
              interfaces: r.spec.interfaces,
              lifecyclePolicy: r.spec.lifecyclePolicy,
            },
          }
        : r;
    }
    default:
      return {
        ok: false,
        error: {
          code: "unsupported_shape",
          message: `planner does not implement shape ${kind}`,
        },
      };
  }
}

export function parseAIEndpointSpec(spec: unknown): ParseAIEndpointSpecResult {
  const base = objectCandidate(spec);
  if (!base.ok) return base;
  const candidate = base.value;

  const name = parseName(candidate);
  if (!name.ok) return name;

  const interfaces = parseExtensibleTokenList(
    candidate.interfaces,
    "interfaces",
    true,
  );
  if (!interfaces.ok) return interfaces;

  const profiles =
    candidate.profiles === undefined
      ? undefined
      : parseExtensibleTokenList(candidate.profiles, "profiles", false);
  if (profiles && !profiles.ok) return profiles;

  const providerPreferences =
    candidate.providerPreferences === undefined
      ? undefined
      : parseExtensibleTokenList(
          candidate.providerPreferences,
          "providerPreferences",
          false,
        );
  if (providerPreferences && !providerPreferences.ok)
    return providerPreferences;

  const routingPolicy = parseAIEndpointRoutingPolicy(candidate.routingPolicy);
  if (!routingPolicy.ok) return routingPolicy;

  const modelPolicy = parseAIEndpointModelPolicy(candidate.modelPolicy);
  if (!modelPolicy.ok) return modelPolicy;

  const lifecyclePolicy = parseLifecyclePolicy(candidate.lifecyclePolicy);
  if (!lifecyclePolicy.ok) return lifecyclePolicy;

  return {
    ok: true,
    spec: {
      name: name.value,
      interfaces: interfaces.value as readonly AIEndpointInterface[],
      ...(profiles?.value
        ? { profiles: profiles.value as readonly AIEndpointProfile[] }
        : {}),
      ...(providerPreferences?.value
        ? { providerPreferences: providerPreferences.value }
        : {}),
      ...(routingPolicy.value ? { routingPolicy: routingPolicy.value } : {}),
      ...(modelPolicy.value ? { modelPolicy: modelPolicy.value } : {}),
      ...(lifecyclePolicy.value
        ? { lifecyclePolicy: lifecyclePolicy.value }
        : {}),
    },
  };
}

/**
 * Validate untrusted input into an ObjectBucketSpec: `name` must be a non-empty
 * string and `interfaces` a non-empty array of valid interface tokens.
 */
export function parseObjectBucketSpec(
  spec: unknown,
): ParseObjectBucketSpecResult {
  const base = objectCandidate(spec);
  if (!base.ok) return base;
  const candidate = base.value;

  const name = parseName(candidate);
  if (!name.ok) return name;

  const interfaces = parseStringList(
    candidate.interfaces,
    "interfaces",
    OBJECT_BUCKET_INTERFACES,
    true,
  );
  if (!interfaces.ok) return interfaces;

  const lifecyclePolicy = parseLifecyclePolicy(candidate.lifecyclePolicy);
  if (!lifecyclePolicy.ok) return lifecyclePolicy;

  return {
    ok: true,
    spec: {
      name: name.value,
      interfaces: interfaces.value as readonly ObjectBucketInterface[],
      ...(lifecyclePolicy.value
        ? { lifecyclePolicy: lifecyclePolicy.value }
        : {}),
    },
  };
}

export function parseEdgeWorkerSpec(spec: unknown): ParseEdgeWorkerSpecResult {
  const base = objectCandidate(spec);
  if (!base.ok) return base;
  const candidate = base.value;

  const name = parseName(candidate);
  if (!name.ok) return name;

  const source = parseEdgeWorkerSource(candidate.source);
  if (!source.ok) return source;

  const profiles =
    candidate.profiles === undefined
      ? undefined
      : parseStringList(
          candidate.profiles,
          "profiles",
          EDGE_WORKER_PROFILES,
          false,
        );
  if (profiles && !profiles.ok) return profiles;

  const compatibilityFlags =
    candidate.compatibilityFlags === undefined
      ? undefined
      : parseExtensibleTokenList(
          candidate.compatibilityFlags,
          "compatibilityFlags",
          false,
        );
  if (compatibilityFlags && !compatibilityFlags.ok) return compatibilityFlags;

  const compatibilityDate = candidate.compatibilityDate;
  if (
    compatibilityDate !== undefined &&
    typeof compatibilityDate !== "string"
  ) {
    return {
      ok: false,
      error: {
        code: "invalid_compatibility_date",
        message: "spec.compatibilityDate must be a string",
      },
    };
  }

  if (candidate.connections !== undefined) {
    return {
      ok: false,
      error: {
        code: "invalid_connections",
        message:
          "spec.connections is not supported for EdgeWorker until grant/projection planning is implemented",
      },
    };
  }

  const lifecyclePolicy = parseLifecyclePolicy(candidate.lifecyclePolicy);
  if (!lifecyclePolicy.ok) return lifecyclePolicy;

  return {
    ok: true,
    spec: {
      name: name.value,
      source: source.value,
      ...(typeof compatibilityDate === "string" && compatibilityDate.length > 0
        ? { compatibilityDate }
        : {}),
      ...(compatibilityFlags?.value
        ? { compatibilityFlags: compatibilityFlags.value }
        : {}),
      ...(profiles?.value
        ? { profiles: profiles.value as readonly EdgeWorkerProfile[] }
        : {}),
      ...(lifecyclePolicy.value
        ? { lifecyclePolicy: lifecyclePolicy.value }
        : {}),
    },
  };
}

export function planResourceShape(
  implementation: string,
  parsed: ParsedResourceSpec,
  target: TargetPoolEntry,
): ResourceShapePlan {
  switch (parsed.kind) {
    case "ObjectBucket":
      return planObjectBucket(implementation, parsed.spec, target);
    case "EdgeWorker":
      return planEdgeWorker(implementation, parsed.spec, target);
    case "AIEndpoint":
      return planAIEndpoint(implementation, parsed.spec, target);
  }
}

/**
 * Plan the first-party module call for a resolved ObjectBucket implementation.
 * Inputs use the modules' real variable names:
 *  - cloudflare-r2-storage: bucketName, accountId, location
 *  - aws-s3-storage:        bucketName, region
 */
export function planObjectBucket(
  implementation: string,
  spec: ObjectBucketSpec,
  target: TargetPoolEntry,
): ResourceShapePlan {
  const templateId = OBJECT_BUCKET_IMPLEMENTATION_TEMPLATE[implementation];
  if (!templateId) {
    throw new Error(
      `planObjectBucket: no first-party module for implementation "${implementation}"`,
    );
  }
  const moduleFiles = moduleFilesFor(templateId, "planObjectBucket");

  if (implementation === "cloudflare_r2") {
    const inputs: Record<string, unknown> = {
      bucketName: spec.name,
      accountId: target.ref ?? "",
    };
    if (target.region !== undefined) inputs.location = target.region;
    return {
      shape: "ObjectBucket",
      templateId,
      moduleFiles,
      inputs,
      publicOutputs: ["bucket_name", "location"],
    };
  }

  const inputs: Record<string, unknown> = { bucketName: spec.name };
  if (target.region !== undefined) inputs.region = target.region;
  return {
    shape: "ObjectBucket",
    templateId,
    moduleFiles,
    inputs,
    publicOutputs: ["bucket_name", "bucket_arn", "region"],
  };
}

/**
 * Plan a Worker-compatible EdgeWorker. The module reads a prebuilt artifact
 * with OpenTofu `file(var.artifactPath)`, so Takosumi does not own the build or
 * artifact-fetch decision; the Git/OpenTofu module remains the source of truth.
 */
export function planEdgeWorker(
  implementation: string,
  spec: EdgeWorkerSpec,
  target: TargetPoolEntry,
): ResourceShapePlan {
  const templateId = EDGE_WORKER_IMPLEMENTATION_TEMPLATE[implementation];
  if (!templateId) {
    throw new Error(
      `planEdgeWorker: no first-party module for implementation "${implementation}"`,
    );
  }
  const moduleFiles = moduleFilesFor(templateId, "planEdgeWorker");
  const artifactPath = spec.source.artifactPath;
  if (!artifactPath) {
    throw new Error(
      "planEdgeWorker: cloudflare_workers requires source.artifactPath",
    );
  }
  const inputs: Record<string, unknown> = {
    appName: spec.name,
    accountId: target.ref ?? "",
    artifactPath,
  };
  return {
    shape: "EdgeWorker",
    templateId,
    moduleFiles,
    inputs,
    publicOutputs: ["worker_name"],
  };
}

/**
 * Plan an AIEndpoint as Takosumi control-plane configuration. The chosen
 * upstream/provider remains a Target/Adapter decision; this module carries only
 * OpenTofu-visible outputs so the Resource Shape can stay first-class without a
 * catch-all `takosumi_resource` escape hatch.
 */
export function planAIEndpoint(
  implementation: string,
  spec: AIEndpointSpec,
  target: TargetPoolEntry,
): ResourceShapePlan {
  const templateId =
    AI_ENDPOINT_IMPLEMENTATION_TEMPLATE[implementation] ??
    AI_ENDPOINT_GENERIC_TEMPLATE_ID;
  const moduleFiles = moduleFilesFor(templateId, "planAIEndpoint");
  const inputs: Record<string, unknown> = {
    endpointName: spec.name,
    implementation,
    targetName: target.name,
    targetType: target.type,
    interfaces: spec.interfaces,
    profiles: spec.profiles ?? [],
    providerPreferences: spec.providerPreferences ?? [],
    routingStrategy: spec.routingPolicy?.strategy ?? "",
    allowFallback: spec.routingPolicy?.allowFallback ?? false,
    preferredRegions: spec.routingPolicy?.preferredRegions ?? [],
    allowedModels: spec.modelPolicy?.allowedModels ?? [],
    defaultModel: spec.modelPolicy?.defaultModel ?? "",
    baseUrl: target.ref ?? "",
  };
  return {
    shape: "AIEndpoint",
    templateId,
    moduleFiles,
    inputs,
    publicOutputs: ["base_url", "default_model"],
  };
}

function requiredEdgeWorkerInterfaces(spec: EdgeWorkerSpec): readonly string[] {
  const interfaces: string[] = ["worker_fetch"];
  for (const profile of spec.profiles ?? []) interfaces.push(profile);
  return interfaces;
}

function moduleFilesFor(
  templateId: string,
  caller: string,
): ResourceShapePlan["moduleFiles"] {
  const moduleFiles = firstPartyModuleFilesByTemplateId[templateId];
  if (!moduleFiles) {
    throw new Error(
      `${caller}: missing module files for template "${templateId}"`,
    );
  }
  return moduleFiles;
}

type ObjectResult =
  | { readonly ok: true; readonly value: Record<string, unknown> }
  | {
      readonly ok: false;
      readonly error: { readonly code: string; readonly message: string };
    };

function objectCandidate(spec: unknown): ObjectResult {
  if (typeof spec !== "object" || spec === null || Array.isArray(spec)) {
    return {
      ok: false,
      error: { code: "invalid_spec", message: "spec must be an object" },
    };
  }
  return { ok: true, value: spec as Record<string, unknown> };
}

function parseName(
  candidate: Record<string, unknown>,
):
  | { readonly ok: true; readonly value: string }
  | {
      readonly ok: false;
      readonly error: { readonly code: string; readonly message: string };
    } {
  const name = candidate.name;
  if (typeof name !== "string" || name.trim().length === 0) {
    return {
      ok: false,
      error: {
        code: "invalid_name",
        message: "spec.name must be a non-empty string",
      },
    };
  }
  return { ok: true, value: name };
}

function parseStringList<T extends string>(
  value: unknown,
  field: string,
  allowed: readonly T[],
  requireNonEmpty: boolean,
):
  | { readonly ok: true; readonly value: readonly T[] }
  | {
      readonly ok: false;
      readonly error: { readonly code: string; readonly message: string };
    } {
  if (!Array.isArray(value) || (requireNonEmpty && value.length === 0)) {
    return {
      ok: false,
      error: {
        code: field === "interfaces" ? "invalid_interfaces" : "invalid_profile",
        message: `spec.${field} must be ${requireNonEmpty ? "a non-empty" : "an"} array`,
      },
    };
  }
  for (const item of value) {
    if (typeof item !== "string" || !allowed.includes(item as T)) {
      return {
        ok: false,
        error: {
          code:
            field === "interfaces" ? "invalid_interface" : "invalid_profile",
          message: `unknown ${field} value: ${String(item)}`,
        },
      };
    }
  }
  return { ok: true, value: value as readonly T[] };
}

function parseExtensibleTokenList(
  value: unknown,
  field: string,
  requireNonEmpty: boolean,
):
  | { readonly ok: true; readonly value: readonly string[] }
  | {
      readonly ok: false;
      readonly error: { readonly code: string; readonly message: string };
    } {
  if (!Array.isArray(value) || (requireNonEmpty && value.length === 0)) {
    return {
      ok: false,
      error: {
        code: field === "interfaces" ? "invalid_interfaces" : "invalid_profile",
        message: `spec.${field} must be ${requireNonEmpty ? "a non-empty" : "an"} array`,
      },
    };
  }
  for (const item of value) {
    if (typeof item !== "string" || item.trim().length === 0) {
      return {
        ok: false,
        error: {
          code:
            field === "interfaces" ? "invalid_interface" : "invalid_profile",
          message: `spec.${field} values must be non-empty strings`,
        },
      };
    }
    if (/\s/.test(item)) {
      return {
        ok: false,
        error: {
          code:
            field === "interfaces" ? "invalid_interface" : "invalid_profile",
          message: `spec.${field} values must be capability tokens without whitespace: ${item}`,
        },
      };
    }
  }
  return { ok: true, value: value as readonly string[] };
}

function parseAIEndpointModelPolicy(
  value: unknown,
):
  | {
      readonly ok: true;
      readonly value: AIEndpointSpec["modelPolicy"] | undefined;
    }
  | {
      readonly ok: false;
      readonly error: { readonly code: string; readonly message: string };
    } {
  if (value === undefined) return { ok: true, value: undefined };
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {
      ok: false,
      error: {
        code: "invalid_model_policy",
        message: "spec.modelPolicy must be an object",
      },
    };
  }
  const policy = value as Record<string, unknown>;
  const defaultModel = policy.defaultModel;
  if (defaultModel !== undefined && typeof defaultModel !== "string") {
    return {
      ok: false,
      error: {
        code: "invalid_model_policy",
        message: "spec.modelPolicy.defaultModel must be a string",
      },
    };
  }
  const allowedModels = policy.allowedModels;
  if (allowedModels !== undefined) {
    if (
      !Array.isArray(allowedModels) ||
      !allowedModels.every(
        (model) => typeof model === "string" && model.trim().length > 0,
      )
    ) {
      return {
        ok: false,
        error: {
          code: "invalid_model_policy",
          message:
            "spec.modelPolicy.allowedModels must be an array of non-empty strings",
        },
      };
    }
  }
  return {
    ok: true,
    value: {
      ...(typeof defaultModel === "string" && defaultModel.length > 0
        ? { defaultModel }
        : {}),
      ...(Array.isArray(allowedModels)
        ? { allowedModels: allowedModels as readonly string[] }
        : {}),
    },
  };
}

function parseAIEndpointRoutingPolicy(
  value: unknown,
):
  | {
      readonly ok: true;
      readonly value: AIEndpointSpec["routingPolicy"] | undefined;
    }
  | {
      readonly ok: false;
      readonly error: { readonly code: string; readonly message: string };
    } {
  if (value === undefined) return { ok: true, value: undefined };
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {
      ok: false,
      error: {
        code: "invalid_routing_policy",
        message: "spec.routingPolicy must be an object",
      },
    };
  }
  const policy = value as Record<string, unknown>;
  const strategy = policy.strategy;
  if (strategy !== undefined) {
    if (
      typeof strategy !== "string" ||
      strategy.trim().length === 0 ||
      /\s/.test(strategy)
    ) {
      return {
        ok: false,
        error: {
          code: "invalid_routing_policy",
          message:
            "spec.routingPolicy.strategy must be a non-empty token without whitespace",
        },
      };
    }
  }
  const allowFallback = policy.allowFallback;
  if (allowFallback !== undefined && typeof allowFallback !== "boolean") {
    return {
      ok: false,
      error: {
        code: "invalid_routing_policy",
        message: "spec.routingPolicy.allowFallback must be a boolean",
      },
    };
  }
  const preferredRegions = policy.preferredRegions;
  if (preferredRegions !== undefined) {
    const regions = parseExtensibleTokenList(
      preferredRegions,
      "preferredRegions",
      false,
    );
    if (!regions.ok) {
      return {
        ok: false,
        error: {
          code: "invalid_routing_policy",
          message: regions.error.message.replace(
            "spec.preferredRegions",
            "spec.routingPolicy.preferredRegions",
          ),
        },
      };
    }
    return {
      ok: true,
      value: {
        ...(typeof strategy === "string" ? { strategy } : {}),
        ...(typeof allowFallback === "boolean" ? { allowFallback } : {}),
        preferredRegions: regions.value,
      },
    };
  }
  return {
    ok: true,
    value: {
      ...(typeof strategy === "string" ? { strategy } : {}),
      ...(typeof allowFallback === "boolean" ? { allowFallback } : {}),
    },
  };
}

function parseLifecyclePolicy(
  value: unknown,
):
  | {
      readonly ok: true;
      readonly value: { readonly delete: ResourceDeletePolicy } | undefined;
    }
  | {
      readonly ok: false;
      readonly error: { readonly code: string; readonly message: string };
    } {
  if (value === undefined) return { ok: true, value: undefined };
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {
      ok: false,
      error: {
        code: "invalid_lifecycle_policy",
        message: "spec.lifecyclePolicy must be an object",
      },
    };
  }
  const del = (value as Record<string, unknown>).delete;
  if (
    typeof del !== "string" ||
    !RESOURCE_DELETE_POLICIES.includes(del as ResourceDeletePolicy)
  ) {
    return {
      ok: false,
      error: {
        code: "invalid_delete_policy",
        message: `spec.lifecyclePolicy.delete must be one of: ${RESOURCE_DELETE_POLICIES.join(", ")}`,
      },
    };
  }
  return { ok: true, value: { delete: del as ResourceDeletePolicy } };
}

function parseEdgeWorkerSource(
  value: unknown,
):
  | { readonly ok: true; readonly value: EdgeWorkerSpec["source"] }
  | {
      readonly ok: false;
      readonly error: { readonly code: string; readonly message: string };
    } {
  if (value === undefined) {
    return {
      ok: false,
      error: {
        code: "invalid_source",
        message: "spec.source.artifactPath is required for EdgeWorker",
      },
    };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {
      ok: false,
      error: {
        code: "invalid_source",
        message: "spec.runtime.source must be an object",
      },
    };
  }
  const source = value as Record<string, unknown>;
  if (source.artifactRef !== undefined || source.image !== undefined) {
    return {
      ok: false,
      error: {
        code: "invalid_source",
        message: "EdgeWorker currently supports source.artifactPath only",
      },
    };
  }
  if (
    typeof source.artifactPath === "string" &&
    source.artifactPath.length > 0
  ) {
    return { ok: true, value: { artifactPath: source.artifactPath } };
  }
  return {
    ok: false,
    error: {
      code: "invalid_source",
      message: "spec.source.artifactPath must be a non-empty string",
    },
  };
}
