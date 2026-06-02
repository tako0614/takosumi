import {
  capabilitySubsetIssues,
  getProvider,
  listProvidersForShape,
  type ProviderAdapter,
} from "takosumi-contract/internal/provider-adapter";
import {
  getShapeByRef,
  parseShapeRef,
  type Shape,
} from "takosumi-contract/reference/shape";
import type { ManifestResource } from "./_internal_manifest_types.ts";

export interface ResolvedResourceV2 {
  readonly resource: ManifestResource;
  readonly shape: Shape;
  readonly provider: ProviderAdapter;
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
  "aws-s3": "operator.takosumi.provider.aws-s3-object-store",
  "aws-fargate": "operator.takosumi.provider.aws-fargate-web-service",
  "aws-rds": "operator.takosumi.provider.aws-rds-postgres",
  "route53": "operator.takosumi.provider.aws-route53-gateway",
  "gcp-gcs": "operator.takosumi.provider.gcp-gcs-object-store",
  "cloud-run": "operator.takosumi.provider.gcp-cloud-run-web-service",
  "cloud-sql": "operator.takosumi.provider.gcp-cloud-sql-postgres",
  "cloud-dns": "operator.takosumi.provider.gcp-cloud-dns-gateway",
  "cloudflare-r2": "operator.takosumi.provider.cloudflare-r2-object-store",
  "cloudflare-container":
    "operator.takosumi.provider.cloudflare-container-web-service",
  "cloudflare-workers": "operator.takosumi.provider.cloudflare-worker",
  "cloudflare-dns": "operator.takosumi.provider.cloudflare-dns-gateway",
  "azure-container-apps":
    "operator.takosumi.provider.azure-container-apps-web-service",
  "k3s-deployment": "operator.takosumi.provider.kubernetes-web-service",
  "deno-deploy": "operator.takosumi.provider.deno-deploy-worker",
  "filesystem": "operator.takosumi.provider.filesystem-object-store",
  "minio": "operator.takosumi.provider.minio-object-store",
  "docker-compose": "operator.takosumi.provider.docker-compose-web-service",
  "systemd-unit": "operator.takosumi.provider.systemd-web-service",
  "local-docker": "operator.takosumi.provider.docker-postgres",
  "coredns-local": "operator.takosumi.provider.coredns-gateway",
};

type ProviderSelection = {
  readonly provider?: ProviderAdapter;
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
