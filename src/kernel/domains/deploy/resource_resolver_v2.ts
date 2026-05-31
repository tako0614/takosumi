import {
  capabilitySubsetIssues,
  getProvider,
  listProvidersForShape,
  type ProviderPlugin,
} from "takosumi-contract/internal/provider-plugin";
import {
  getShapeByRef,
  parseShapeRef,
  type Shape,
} from "takosumi-contract/reference/shape";
import type { ManifestResource } from "./_internal_manifest_types.ts";

export interface ResolvedResourceV2 {
  readonly resource: ManifestResource;
  readonly shape: Shape;
  readonly provider: ProviderPlugin;
}

export interface ResourceResolutionIssue {
  readonly path: string;
  readonly message: string;
}

export interface ResourceResolutionResult {
  readonly resolved: readonly ResolvedResourceV2[];
  readonly issues: readonly ResourceResolutionIssue[];
}

/**
 * Bare provider id → namespaced provider id suggestions. Bare provider ids are
 * rejected; this map keeps the resolution issue actionable.
 */
const BARE_PROVIDER_SUGGESTIONS: Readonly<Record<string, string>> = {
  "aws-s3": "@takosjp/takosumi-plugins/kind/aws-s3-object-store",
  "aws-fargate": "@takosjp/takosumi-plugins/kind/aws-fargate-web-service",
  "aws-rds": "@takosjp/takosumi-plugins/kind/aws-rds-postgres",
  "route53": "@takosjp/takosumi-plugins/kind/aws-route53-gateway",
  "gcp-gcs": "@takosjp/takosumi-plugins/kind/gcp-gcs-object-store",
  "cloud-run": "@takosjp/takosumi-plugins/kind/gcp-cloud-run-web-service",
  "cloud-sql": "@takosjp/takosumi-plugins/kind/gcp-cloud-sql-postgres",
  "cloud-dns": "@takosjp/takosumi-plugins/kind/gcp-cloud-dns-gateway",
  "cloudflare-r2": "@takosjp/takosumi-plugins/kind/cloudflare-r2-object-store",
  "cloudflare-container":
    "@takosjp/takosumi-plugins/kind/cloudflare-container-web-service",
  "cloudflare-workers": "@takosjp/takosumi-plugins/kind/cloudflare-worker",
  "cloudflare-dns": "@takosjp/takosumi-plugins/kind/cloudflare-dns-gateway",
  "azure-container-apps":
    "@takosjp/takosumi-plugins/kind/azure-container-apps-web-service",
  "k3s-deployment": "@takosjp/takosumi-plugins/kind/kubernetes-web-service",
  "deno-deploy": "@takosjp/takosumi-plugins/kind/deno-deploy-worker",
  "filesystem": "@takosjp/takosumi-plugins/kind/filesystem-object-store",
  "minio": "@takosjp/takosumi-plugins/kind/minio-object-store",
  "docker-compose": "@takosjp/takosumi-plugins/kind/docker-compose-web-service",
  "systemd-unit": "@takosjp/takosumi-plugins/kind/systemd-web-service",
  "local-docker": "@takosjp/takosumi-plugins/kind/docker-postgres",
  "coredns-local": "@takosjp/takosumi-plugins/kind/coredns-gateway",
};

type ProviderSelection = {
  readonly provider?: ProviderPlugin;
  readonly suggested?: string;
  readonly issue?: string;
};

/**
 * Look up a provider by id. For known bare ids, return a namespaced suggestion
 * so the caller can emit a helpful resolution issue.
 */
function lookupProvider(
  rawId: string,
): ProviderSelection {
  const direct = getProvider(rawId);
  if (direct) return { provider: direct };
  if (rawId.startsWith("@")) return {};
  const suggested = BARE_PROVIDER_SUGGESTIONS[rawId];
  return suggested ? { suggested } : {};
}

function selectProviderForShape(
  shapeId: string,
  shapeVersion: string,
  requires: readonly string[] | undefined,
): ProviderSelection {
  const candidates = listProvidersForShape(shapeId, shapeVersion);
  if (candidates.length === 0) {
    return {
      issue: `no provider registered for shape: ${shapeId}@${shapeVersion}`,
    };
  }
  const capable = requires && requires.length > 0
    ? candidates.filter((candidate) =>
      capabilitySubsetIssues(requires, candidate.capabilities, "$").length === 0
    )
    : candidates;
  if (capable.length === 0) {
    return {
      issue:
        `no provider for ${shapeId}@${shapeVersion} satisfies required capabilities: ${
          requires?.join(", ") ?? "(none)"
        }`,
    };
  }
  if (capable.length > 1) {
    return {
      issue:
        `provider selection for ${shapeId}@${shapeVersion} is ambiguous; ` +
        `pin resource.provider or configure an operator provider policy`,
    };
  }
  return { provider: capable[0] };
}

export function resolveResourcesV2(
  resources: readonly ManifestResource[],
): ResourceResolutionResult {
  const issues: ResourceResolutionIssue[] = [];
  const resolved: ResolvedResourceV2[] = [];
  const seenNames = new Set<string>();

  for (const [index, resource] of resources.entries()) {
    const path = `$.resources[${index}]`;
    if (!resource.name || seenNames.has(resource.name)) {
      issues.push({
        path: `${path}.name`,
        message: resource.name
          ? `duplicate resource name: ${resource.name}`
          : "resource name is required",
      });
      continue;
    }
    seenNames.add(resource.name);

    const shape = getShapeByRef(resource.shape);
    if (!shape) {
      issues.push({
        path: `${path}.shape`,
        message: `shape not registered: ${resource.shape}`,
      });
      continue;
    }
    const ref = parseShapeRef(resource.shape);
    if (!ref) {
      issues.push({
        path: `${path}.shape`,
        message: `malformed shape ref: ${resource.shape}`,
      });
      continue;
    }

    const providerSelection = resource.provider
      ? lookupProvider(resource.provider)
      : selectProviderForShape(ref.id, ref.version, resource.requires);
    const provider = providerSelection.provider;
    if (!provider) {
      issues.push({
        path: `${path}.provider`,
        message: resource.provider
          ? providerSelection.suggested
            ? `provider id "${resource.provider}" must be namespaced; ` +
              `use "${providerSelection.suggested}"`
            : `provider not registered: ${resource.provider}`
          : providerSelection.issue ?? "provider selection failed",
      });
      continue;
    }
    if (
      provider.implements.id !== ref.id ||
      provider.implements.version !== ref.version
    ) {
      issues.push({
        path: `${path}.provider`,
        message:
          `provider ${provider.id} implements ${provider.implements.id}@${provider.implements.version}, not ${resource.shape}`,
      });
      continue;
    }

    const specIssues: ResourceResolutionIssue[] = [];
    shape.validateSpec(resource.spec, specIssues);
    for (const issue of specIssues) {
      issues.push({
        path: `${path}.spec${issue.path === "$" ? "" : issue.path.slice(1)}`,
        message: issue.message,
      });
    }

    if (resource.requires && resource.requires.length > 0) {
      const capIssues = capabilitySubsetIssues(
        resource.requires,
        provider.capabilities,
        `${path}.requires`,
      );
      for (const issue of capIssues) issues.push(issue);
    }

    if (specIssues.length === 0) {
      resolved.push({ resource, shape, provider });
    }
  }

  return { resolved, issues };
}
