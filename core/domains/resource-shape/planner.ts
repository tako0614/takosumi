// Resource Shape Planner - PURE.
//
// The Planner validates one shape-specific spec and lowers a resolved
// implementation to a first-party OpenTofu module call. It deliberately keeps
// shape-specific resource types (ObjectStore, HttpService, ...) instead
// of accepting a catch-all `takosumi_resource { type, spec }` object, so
// OpenTofu plan diffs, validation, import, drift, and state upgrades can remain
// resource-aware.

import type {
  AIEndpointInterface,
  AIEndpointProfile,
  AIEndpointSpec,
  HttpServiceProfile,
  HttpServiceRuntimeInterface,
  HttpServiceSpec,
  ObjectStoreInterface,
  ObjectStoreSpec,
  ResourceDeletePolicy,
  ResourceShapeKind,
  TargetPoolEntry,
} from "takosumi-contract";
import { firstPartyModuleFilesByTemplateId } from "../../../opentofu-modules/module-files.ts";

export interface ResourceShapePlan {
  readonly shape: ResourceShapeKind;
  readonly templateId: string;
  readonly moduleFiles: readonly { readonly path: string; readonly text: string }[];
  readonly inputs: Record<string, unknown>;
  readonly publicOutputs: readonly string[];
}

export type ParsedResourceSpec =
  | {
    readonly kind: "ObjectStore";
    readonly spec: ObjectStoreSpec;
    readonly interfaces: readonly string[];
    readonly lifecyclePolicy?: ObjectStoreSpec["lifecyclePolicy"];
  }
  | {
    readonly kind: "HttpService";
    readonly spec: HttpServiceSpec;
    readonly interfaces: readonly string[];
    readonly lifecyclePolicy?: HttpServiceSpec["lifecyclePolicy"];
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

export type ParseObjectStoreSpecResult =
  | { readonly ok: true; readonly spec: ObjectStoreSpec }
  | {
    readonly ok: false;
    readonly error: { readonly code: string; readonly message: string };
  };

export type ParseHttpServiceSpecResult =
  | { readonly ok: true; readonly spec: HttpServiceSpec }
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

const OBJECT_STORE_INTERFACES: readonly ObjectStoreInterface[] = [
  "s3_api",
  "signed_url",
  "object_events",
];

const HTTP_SERVICE_RUNTIME_INTERFACES: readonly HttpServiceRuntimeInterface[] = [
  "web_fetch",
  "node_http",
  "container_http",
];

const HTTP_SERVICE_PROFILES: readonly HttpServiceProfile[] = [
  "workers_bindings",
  "node_compat",
  "lambda_handler",
  "python_asgi",
];

const AI_ENDPOINT_INTERFACES: readonly AIEndpointInterface[] = [
  "openai_chat_completions",
  "openai_responses",
  "openai_embeddings",
];

const AI_ENDPOINT_PROFILES: readonly AIEndpointProfile[] = [
  "openai_compatible",
  "workers_ai",
  "anthropic_messages",
  "gemini_compat",
];

const RESOURCE_DELETE_POLICIES: readonly ResourceDeletePolicy[] = [
  "delete",
  "retain",
  "snapshot_then_delete",
  "block",
];

/** Map ObjectStore implementation -> first-party Capsule module template id. */
export const OBJECT_STORE_IMPLEMENTATION_TEMPLATE: Readonly<Record<string, string>> =
  Object.freeze({
    cloudflare_r2: "cloudflare-r2-storage",
    aws_s3: "aws-s3-storage",
  });

/** Map HttpService implementation -> first-party Capsule module template id. */
export const HTTP_SERVICE_IMPLEMENTATION_TEMPLATE: Readonly<Record<string, string>> =
  Object.freeze({
    cloudflare_workers: "cloudflare-worker-service",
  });

/** Map AIEndpoint implementation -> first-party Capsule module template id. */
export const AI_ENDPOINT_IMPLEMENTATION_TEMPLATE: Readonly<Record<string, string>> =
  Object.freeze({
    cloudflare_ai_gateway: "takosumi-ai-endpoint",
    takosumi_ai_gateway: "takosumi-ai-endpoint",
    openai_compatible_ai_endpoint: "takosumi-ai-endpoint",
    aws_bedrock_openai_gateway: "takosumi-ai-endpoint",
    vertex_ai_openai_gateway: "takosumi-ai-endpoint",
  });

export function parseResourceSpec(
  kind: ResourceShapeKind,
  spec: unknown,
): ParseResourceSpecResult {
  switch (kind) {
    case "ObjectStore": {
      const r = parseObjectStoreSpec(spec);
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
    case "HttpService": {
      const r = parseHttpServiceSpec(spec);
      return r.ok
        ? {
          ok: true,
          parsed: {
            kind,
            spec: r.spec,
            interfaces: requiredHttpServiceInterfaces(r.spec),
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

  const interfaces = parseStringList(
    candidate.interfaces,
    "interfaces",
    AI_ENDPOINT_INTERFACES,
    true,
  );
  if (!interfaces.ok) return interfaces;

  const profiles = candidate.profiles === undefined
    ? undefined
    : parseStringList(candidate.profiles, "profiles", AI_ENDPOINT_PROFILES, false);
  if (profiles && !profiles.ok) return profiles;

  const modelPolicy = parseAIEndpointModelPolicy(candidate.modelPolicy);
  if (!modelPolicy.ok) return modelPolicy;

  const lifecyclePolicy = parseLifecyclePolicy(candidate.lifecyclePolicy);
  if (!lifecyclePolicy.ok) return lifecyclePolicy;

  return {
    ok: true,
    spec: {
      name: name.value,
      interfaces: interfaces.value as readonly AIEndpointInterface[],
      ...(profiles?.value ? { profiles: profiles.value as readonly AIEndpointProfile[] } : {}),
      ...(modelPolicy.value ? { modelPolicy: modelPolicy.value } : {}),
      ...(lifecyclePolicy.value ? { lifecyclePolicy: lifecyclePolicy.value } : {}),
    },
  };
}

/**
 * Validate untrusted input into an ObjectStoreSpec: `name` must be a non-empty
 * string and `interfaces` a non-empty array of valid interface tokens.
 */
export function parseObjectStoreSpec(spec: unknown): ParseObjectStoreSpecResult {
  const base = objectCandidate(spec);
  if (!base.ok) return base;
  const candidate = base.value;

  const name = parseName(candidate);
  if (!name.ok) return name;

  const interfaces = parseStringList(
    candidate.interfaces,
    "interfaces",
    OBJECT_STORE_INTERFACES,
    true,
  );
  if (!interfaces.ok) return interfaces;

  const lifecyclePolicy = parseLifecyclePolicy(candidate.lifecyclePolicy);
  if (!lifecyclePolicy.ok) return lifecyclePolicy;

  return {
    ok: true,
    spec: {
      name: name.value,
      interfaces: interfaces.value as readonly ObjectStoreInterface[],
      ...(lifecyclePolicy.value ? { lifecyclePolicy: lifecyclePolicy.value } : {}),
    },
  };
}

export function parseHttpServiceSpec(spec: unknown): ParseHttpServiceSpecResult {
  const base = objectCandidate(spec);
  if (!base.ok) return base;
  const candidate = base.value;

  const name = parseName(candidate);
  if (!name.ok) return name;

  const runtimeValue = candidate.runtime;
  if (
    typeof runtimeValue !== "object" ||
    runtimeValue === null ||
    Array.isArray(runtimeValue)
  ) {
    return {
      ok: false,
      error: { code: "invalid_runtime", message: "spec.runtime must be an object" },
    };
  }
  const runtime = runtimeValue as Record<string, unknown>;
  const runtimeInterface = runtime.interface;
  if (
    typeof runtimeInterface !== "string" ||
    !HTTP_SERVICE_RUNTIME_INTERFACES.includes(runtimeInterface as HttpServiceRuntimeInterface)
  ) {
    return {
      ok: false,
      error: {
        code: "invalid_runtime_interface",
        message: `spec.runtime.interface must be one of: ${HTTP_SERVICE_RUNTIME_INTERFACES.join(", ")}`,
      },
    };
  }

  const profiles = runtime.profiles === undefined
    ? undefined
    : parseStringList(runtime.profiles, "runtime.profiles", HTTP_SERVICE_PROFILES, false);
  if (profiles && !profiles.ok) return profiles;

  const source = parseHttpServiceSource(runtime.source);
  if (!source.ok) return source;

  const exposure = parseHttpServiceExposure(candidate.exposure);
  if (!exposure.ok) return exposure;

  if (candidate.connections !== undefined) {
    return {
      ok: false,
      error: {
        code: "invalid_connections",
        message: "spec.connections is not supported for HttpService until grant/projection planning is implemented",
      },
    };
  }

  const lifecyclePolicy = parseLifecyclePolicy(candidate.lifecyclePolicy);
  if (!lifecyclePolicy.ok) return lifecyclePolicy;

  return {
    ok: true,
    spec: {
      name: name.value,
      runtime: {
        interface: runtimeInterface as HttpServiceRuntimeInterface,
        ...(typeof runtime.language === "string" && runtime.language.length > 0
          ? { language: runtime.language }
          : {}),
        ...(profiles?.value ? { profiles: profiles.value as readonly HttpServiceProfile[] } : {}),
        ...(source.value ? { source: source.value } : {}),
      },
      ...(exposure.value ? { exposure: exposure.value } : {}),
      ...(lifecyclePolicy.value ? { lifecyclePolicy: lifecyclePolicy.value } : {}),
    },
  };
}

export function planResourceShape(
  implementation: string,
  parsed: ParsedResourceSpec,
  target: TargetPoolEntry,
): ResourceShapePlan {
  switch (parsed.kind) {
    case "ObjectStore":
      return planObjectStore(implementation, parsed.spec, target);
    case "HttpService":
      return planHttpService(implementation, parsed.spec, target);
    case "AIEndpoint":
      return planAIEndpoint(implementation, parsed.spec, target);
  }
}

/**
 * Plan the first-party module call for a resolved ObjectStore implementation.
 * Inputs use the modules' real variable names:
 *  - cloudflare-r2-storage: bucketName, accountId, location
 *  - aws-s3-storage:        bucketName, region
 */
export function planObjectStore(
  implementation: string,
  spec: ObjectStoreSpec,
  target: TargetPoolEntry,
): ResourceShapePlan {
  const templateId = OBJECT_STORE_IMPLEMENTATION_TEMPLATE[implementation];
  if (!templateId) {
    throw new Error(
      `planObjectStore: no first-party module for implementation "${implementation}"`,
    );
  }
  const moduleFiles = moduleFilesFor(templateId, "planObjectStore");

  if (implementation === "cloudflare_r2") {
    const inputs: Record<string, unknown> = {
      bucketName: spec.name,
      accountId: target.ref ?? "",
    };
    if (target.region !== undefined) inputs.location = target.region;
    return {
      shape: "ObjectStore",
      templateId,
      moduleFiles,
      inputs,
      publicOutputs: ["bucket_name", "location"],
    };
  }

  const inputs: Record<string, unknown> = { bucketName: spec.name };
  if (target.region !== undefined) inputs.region = target.region;
  return {
    shape: "ObjectStore",
    templateId,
    moduleFiles,
    inputs,
    publicOutputs: ["bucket_name", "bucket_arn", "region"],
  };
}

/**
 * Plan a Worker-compatible HttpService. The module reads a prebuilt artifact
 * with OpenTofu `file(var.artifactPath)`, so Takosumi does not own the build or
 * artifact-fetch decision; the Git/OpenTofu module remains the source of truth.
 */
export function planHttpService(
  implementation: string,
  spec: HttpServiceSpec,
  target: TargetPoolEntry,
): ResourceShapePlan {
  const templateId = HTTP_SERVICE_IMPLEMENTATION_TEMPLATE[implementation];
  if (!templateId) {
    throw new Error(
      `planHttpService: no first-party module for implementation "${implementation}"`,
    );
  }
  const moduleFiles = moduleFilesFor(templateId, "planHttpService");
  const artifactPath = spec.runtime.source?.artifactPath;
  if (!artifactPath) {
    throw new Error("planHttpService: cloudflare_workers requires runtime.source.artifactPath");
  }
  const inputs: Record<string, unknown> = {
    appName: spec.name,
    accountId: target.ref ?? "",
    artifactPath,
  };
  if (spec.exposure?.publicHttp) {
    inputs.publicUrl = "";
  }
  return {
    shape: "HttpService",
    templateId,
    moduleFiles,
    inputs,
    publicOutputs: ["worker_name", "url"],
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
  const templateId = AI_ENDPOINT_IMPLEMENTATION_TEMPLATE[implementation];
  if (!templateId) {
    throw new Error(
      `planAIEndpoint: no first-party module for implementation "${implementation}"`,
    );
  }
  const moduleFiles = moduleFilesFor(templateId, "planAIEndpoint");
  const inputs: Record<string, unknown> = {
    endpointName: spec.name,
    implementation,
    targetName: target.name,
    targetType: target.type,
    interfaces: spec.interfaces,
    profiles: spec.profiles ?? [],
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

function requiredHttpServiceInterfaces(spec: HttpServiceSpec): readonly string[] {
  const interfaces: string[] = [spec.runtime.interface];
  if (spec.exposure?.publicHttp) interfaces.push("public_http");
  for (const profile of spec.runtime.profiles ?? []) interfaces.push(profile);
  return interfaces;
}

function moduleFilesFor(templateId: string, caller: string): ResourceShapePlan["moduleFiles"] {
  const moduleFiles = firstPartyModuleFilesByTemplateId[templateId];
  if (!moduleFiles) {
    throw new Error(`${caller}: missing module files for template "${templateId}"`);
  }
  return moduleFiles;
}

type ObjectResult =
  | { readonly ok: true; readonly value: Record<string, unknown> }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } };

function objectCandidate(spec: unknown): ObjectResult {
  if (typeof spec !== "object" || spec === null || Array.isArray(spec)) {
    return { ok: false, error: { code: "invalid_spec", message: "spec must be an object" } };
  }
  return { ok: true, value: spec as Record<string, unknown> };
}

function parseName(candidate: Record<string, unknown>):
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } } {
  const name = candidate.name;
  if (typeof name !== "string" || name.trim().length === 0) {
    return {
      ok: false,
      error: { code: "invalid_name", message: "spec.name must be a non-empty string" },
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
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } } {
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
          code: field === "interfaces" ? "invalid_interface" : "invalid_profile",
          message: `unknown ${field} value: ${String(item)}`,
        },
      };
    }
  }
  return { ok: true, value: value as readonly T[] };
}

function parseAIEndpointModelPolicy(value: unknown):
  | { readonly ok: true; readonly value: AIEndpointSpec["modelPolicy"] | undefined }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } } {
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
      !allowedModels.every((model) =>
        typeof model === "string" && model.trim().length > 0
      )
    ) {
      return {
        ok: false,
        error: {
          code: "invalid_model_policy",
          message: "spec.modelPolicy.allowedModels must be an array of non-empty strings",
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

function parseLifecyclePolicy(value: unknown):
  | { readonly ok: true; readonly value: { readonly delete: ResourceDeletePolicy } | undefined }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } } {
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

function parseHttpServiceSource(value: unknown):
  | { readonly ok: true; readonly value: HttpServiceSpec["runtime"]["source"] | undefined }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } } {
  if (value === undefined) {
    return {
      ok: false,
      error: {
        code: "invalid_source",
        message: "spec.runtime.source.artifactPath is required for HttpService",
      },
    };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {
      ok: false,
      error: { code: "invalid_source", message: "spec.runtime.source must be an object" },
    };
  }
  const source = value as Record<string, unknown>;
  if (source.artifactRef !== undefined || source.image !== undefined) {
    return {
      ok: false,
      error: {
        code: "invalid_source",
        message: "HttpService currently supports runtime.source.artifactPath only",
      },
    };
  }
  if (typeof source.artifactPath === "string" && source.artifactPath.length > 0) {
    return { ok: true, value: { artifactPath: source.artifactPath } };
  }
  return {
    ok: false,
    error: {
      code: "invalid_source",
      message: "spec.runtime.source.artifactPath must be a non-empty string",
    },
  };
}

function parseHttpServiceExposure(value: unknown):
  | { readonly ok: true; readonly value: HttpServiceSpec["exposure"] | undefined }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } } {
  if (value === undefined) return { ok: true, value: undefined };
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {
      ok: false,
      error: { code: "invalid_exposure", message: "spec.exposure must be an object" },
    };
  }
  const publicHttp = (value as Record<string, unknown>).publicHttp;
  if (publicHttp !== undefined && typeof publicHttp !== "boolean") {
    return {
      ok: false,
      error: {
        code: "invalid_exposure",
        message: "spec.exposure.publicHttp must be a boolean",
      },
    };
  }
  return {
    ok: true,
    value: publicHttp === undefined ? undefined : { publicHttp },
  };
}
