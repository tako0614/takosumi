import {
  capabilitySubsetIssues,
  getProvider,
  getShapeByRef,
  listProvidersForShape,
  type ManifestResource,
  parseShapeRef,
  type ProviderPlugin,
  type Shape,
} from "takosumi-contract";

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
  "aws-s3": "@takos/aws-s3",
  "aws-fargate": "@takos/aws-fargate",
  "aws-rds": "@takos/aws-rds",
  "route53": "@takos/aws-route53",
  "gcp-gcs": "@takos/gcp-gcs",
  "cloud-run": "@takos/gcp-cloud-run",
  "cloud-sql": "@takos/gcp-cloud-sql",
  "cloud-dns": "@takos/gcp-cloud-dns",
  "cloudflare-r2": "@takos/cloudflare-r2",
  "cloudflare-container": "@takos/cloudflare-container",
  "cloudflare-workers": "@takos/cloudflare-workers",
  "cloudflare-dns": "@takos/cloudflare-dns",
  "azure-container-apps": "@takos/azure-container-apps",
  "k3s-deployment": "@takos/kubernetes-deployment",
  "deno-deploy": "@takos/deno-deploy",
  "filesystem": "@takos/selfhost-filesystem",
  "minio": "@takos/selfhost-minio",
  "docker-compose": "@takos/selfhost-docker-compose",
  "systemd-unit": "@takos/selfhost-systemd",
  "local-docker": "@takos/selfhost-postgres",
  "coredns-local": "@takos/selfhost-coredns",
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
