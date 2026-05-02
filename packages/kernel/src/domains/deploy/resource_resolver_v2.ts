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

    const provider = getProvider(resource.provider);
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
