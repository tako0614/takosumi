import {
  capabilitySubsetIssues,
  getProvider,
  getShapeByRef,
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
 * Bare provider id → namespaced provider id.
 *
 * Manifests generated before Takosumi 0.10 used bare ids (e.g. `aws-fargate`).
 * Two operator plugins could both register the same bare id, last-write-wins.
 * From 0.10 every shipped provider is namespaced under `@takos/`. The kernel
 * still accepts bare ids for one minor cycle, emitting a deprecation warning;
 * 0.12 will remove this fallback.
 */
const LEGACY_PROVIDER_ALIASES: Readonly<Record<string, string>> = {
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

/**
 * Resolve a provider id, transparently accepting legacy bare ids and emitting
 * a one-shot deprecation warning per (rawId, newId) pair so noisy manifests
 * don't drown the operator's logs.
 */
const warnedAliases = new Set<string>();
function resolveProviderWithAlias(
  rawId: string,
): ProviderPlugin | undefined {
  const direct = getProvider(rawId);
  if (direct) return direct;
  if (rawId.startsWith("@")) return undefined;
  const aliased = LEGACY_PROVIDER_ALIASES[rawId];
  if (!aliased) return undefined;
  const provider = getProvider(aliased);
  if (!provider) return undefined;
  const key = `${rawId}->${aliased}`;
  if (!warnedAliases.has(key)) {
    warnedAliases.add(key);
    console.warn(
      `[takosumi-resolver] provider id "${rawId}" is deprecated; use "${aliased}" — bare ids will be rejected in 0.12.`,
    );
  }
  return provider;
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

    const provider = resolveProviderWithAlias(resource.provider);
    if (!provider) {
      issues.push({
        path: `${path}.provider`,
        message: `provider not registered: ${resource.provider}`,
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
