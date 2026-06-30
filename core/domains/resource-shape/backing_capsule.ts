// Backing Capsule resolver for the real Resource Shape opentofu-adapter.
//
// Resource Shapes lower to generated OpenTofu roots, but the current Flow A run
// engine still needs a durable Capsule identity for state, outputs, policy, and
// provider binding resolution. This module creates that internal Capsule
// idempotently and stores the selected Target's ProviderConnection binding.

import type { InstallConfig } from "takosumi-contract/install-configs";
import type {
  OpentofuDestroyRequest,
  OpentofuRunRequest,
  ResourceCapsuleBinding,
} from "./opentofu_adapter.ts";
import type { CapsulesService } from "../capsules/mod.ts";
import { OpenTofuControllerError } from "../deploy-control/errors.ts";

export const RESOURCE_SHAPE_BACKING_INSTALL_CONFIG_ID =
  "cfg-internal-resource-shape-backing-capsule";
export const RESOURCE_SHAPE_BACKING_ENVIRONMENT = "resource-shape";

export interface ResourceShapeBackingCapsuleResolverDeps {
  readonly installations: CapsulesService;
  readonly now?: () => Date;
}

export function createResourceShapeBackingCapsuleResolver(
  deps: ResourceShapeBackingCapsuleResolverDeps,
): (
  request: OpentofuRunRequest | OpentofuDestroyRequest,
) => Promise<ResourceCapsuleBinding> {
  const now = deps.now ?? (() => new Date());
  return async (request) => {
    const parsed = parseResourceId(request.resourceId);
    await ensureBackingInstallConfig(deps.installations, now);
    const capsuleName = backingCapsuleName(request.resourceId, parsed);
    let capsule = await findBackingCapsule(
      deps.installations,
      parsed.space,
      capsuleName,
    );
    if (!capsule) {
      try {
        capsule = await deps.installations.createCapsule({
          workspaceId: parsed.space,
          name: capsuleName,
          environment: RESOURCE_SHAPE_BACKING_ENVIRONMENT,
          installConfigId: RESOURCE_SHAPE_BACKING_INSTALL_CONFIG_ID,
        });
      } catch (error) {
        if (!isDuplicateCapsuleError(error)) throw error;
        capsule = await findBackingCapsule(
          deps.installations,
          parsed.space,
          capsuleName,
        );
        if (!capsule) throw error;
      }
    }
    if ("templateId" in request) {
      await deps.installations.putCapsuleProviderEnvBindingSet({
        id: `rscpb_${stableHash(`${request.resourceId}:${capsule.id}`)}`,
        workspaceId: parsed.space,
        spaceId: parsed.space,
        capsuleId: capsule.id,
        installationId: capsule.id,
        environment: RESOURCE_SHAPE_BACKING_ENVIRONMENT,
        bindings: request.providerBinding.connectionId
          ? [
              {
                provider: request.providerBinding.provider,
                ...(request.providerBinding.alias
                  ? { alias: request.providerBinding.alias }
                  : {}),
                connectionId: request.providerBinding.connectionId,
              },
            ]
          : [],
        createdAt: capsule.createdAt,
        updatedAt: now().toISOString(),
      });
    }
    return {
      workspaceId: parsed.space,
      capsuleId: capsule.id,
      source: {
        kind: "local",
        path:
          "templateId" in request
            ? `/resource-shape/${request.templateId}`
            : `/resource-shape/${parsed.kind}/${parsed.name}`,
      },
      currentStateVersionId: capsule.currentStateVersionId ?? null,
    };
  };
}

async function ensureBackingInstallConfig(
  installations: CapsulesService,
  now: () => Date,
): Promise<void> {
  try {
    await installations.getInstallConfig(
      RESOURCE_SHAPE_BACKING_INSTALL_CONFIG_ID,
    );
    return;
  } catch (error) {
    if (!isNotFoundError(error)) throw error;
  }
  const timestamp = now().toISOString();
  const config: InstallConfig = {
    id: RESOURCE_SHAPE_BACKING_INSTALL_CONFIG_ID,
    name: "resource-shape-backing-capsule",
    sourceKind: "first_party_capsule",
    installType: "opentofu_module",
    trustLevel: "official",
    internal: { reason: "resource_shape_backing_capsule" },
    variableMapping: {},
    outputAllowlist: {},
    policy: {},
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  await installations.putInstallConfig(config);
}

async function findBackingCapsule(
  installations: CapsulesService,
  workspaceId: string,
  name: string,
) {
  const capsules = await installations.listCapsules(workspaceId);
  return capsules.find(
    (capsule) =>
      capsule.name === name &&
      capsule.environment === RESOURCE_SHAPE_BACKING_ENVIRONMENT,
  );
}

function parseResourceId(resourceId: string): {
  readonly space: string;
  readonly kind: string;
  readonly name: string;
} {
  const parts = resourceId.split(":");
  if (parts.length < 4 || parts[0] !== "tkrn") {
    throw new OpenTofuControllerError(
      "invalid_argument",
      `resourceId ${resourceId} must be a tkrn resource id`,
    );
  }
  const [, space, kind, ...nameParts] = parts;
  const name = nameParts.join(":");
  if (!space || !kind || !name) {
    throw new OpenTofuControllerError(
      "invalid_argument",
      `resourceId ${resourceId} must include space, kind, and name`,
    );
  }
  return { space, kind, name };
}

function backingCapsuleName(
  resourceId: string,
  parsed: { readonly kind: string; readonly name: string },
): string {
  const prefix = slugPart(`rs-${parsed.kind}-${parsed.name}`);
  const suffix = stableHash(resourceId);
  return `${prefix.slice(0, 44).replace(/-+$/u, "")}-${suffix}`;
}

function slugPart(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .replace(/-+/gu, "-");
  return slug.length > 0 ? slug : "rs-resource";
}

function stableHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36).padStart(7, "0");
}

function isNotFoundError(error: unknown): boolean {
  return error instanceof OpenTofuControllerError && error.code === "not_found";
}

function isDuplicateCapsuleError(error: unknown): boolean {
  return (
    error instanceof OpenTofuControllerError &&
    error.code === "failed_precondition" &&
    isRecord(error.details) &&
    error.details.reason === "duplicate_capsule"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
