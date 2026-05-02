import {
  extractRefs,
  extractRefsFromValue,
  type JsonObject,
  type JsonValue,
  type ManifestResource,
  parseRef,
  type ResolvedRef,
} from "takosumi-contract";

export interface RefResolutionIssue {
  readonly path: string;
  readonly message: string;
}

export interface DependencyEdge {
  readonly source: string;
  readonly target: string;
}

export interface RefDagResult {
  readonly order: readonly string[];
  readonly edges: readonly DependencyEdge[];
  readonly issues: readonly RefResolutionIssue[];
}

export function buildRefDag(
  resources: readonly ManifestResource[],
): RefDagResult {
  const issues: RefResolutionIssue[] = [];
  const nameSet = new Set<string>();
  for (const r of resources) nameSet.add(r.name);

  const adjacency = new Map<string, Set<string>>();
  const incoming = new Map<string, Set<string>>();
  const edges: DependencyEdge[] = [];

  for (const resource of resources) {
    if (!adjacency.has(resource.name)) adjacency.set(resource.name, new Set());
    if (!incoming.has(resource.name)) incoming.set(resource.name, new Set());
  }

  for (const resource of resources) {
    const refs = extractRefsFromValue(resource.spec);
    for (const ref of refs) {
      if (ref.source === resource.name) {
        issues.push({
          path: `$.resources[${resource.name}]`,
          message: `resource references itself: ${ref.source}.${ref.field}`,
        });
        continue;
      }
      if (!nameSet.has(ref.source)) {
        issues.push({
          path: `$.resources[${resource.name}]`,
          message: `unknown ref source: ${ref.source}`,
        });
        continue;
      }
      adjacency.get(ref.source)!.add(resource.name);
      incoming.get(resource.name)!.add(ref.source);
      edges.push({ source: ref.source, target: resource.name });
    }
  }

  const order: string[] = [];
  const ready: string[] = [];
  for (const [name, sources] of incoming) {
    if (sources.size === 0) ready.push(name);
  }
  ready.sort();

  while (ready.length > 0) {
    const name = ready.shift()!;
    order.push(name);
    for (const child of adjacency.get(name) ?? new Set()) {
      const childIncoming = incoming.get(child)!;
      childIncoming.delete(name);
      if (childIncoming.size === 0) {
        const insertAt = ready.findIndex((entry) => entry > child);
        if (insertAt < 0) ready.push(child);
        else ready.splice(insertAt, 0, child);
      }
    }
  }

  if (order.length < resources.length) {
    const remaining = resources
      .map((r) => r.name)
      .filter((name) => !order.includes(name));
    issues.push({
      path: "$.resources",
      message: `cycle detected involving: ${remaining.join(", ")}`,
    });
  }

  return { order, edges, issues };
}

export interface RefResolutionContext {
  readonly outputs: ReadonlyMap<string, JsonObject>;
  readonly secretResolver?: (sourceName: string, field: string) => string;
}

export function resolveSpecRefs(
  spec: JsonValue,
  ctx: RefResolutionContext,
): JsonValue {
  return walkValue(spec, ctx);
}

function walkValue(value: JsonValue, ctx: RefResolutionContext): JsonValue {
  if (typeof value === "string") {
    return resolveStringRefs(value, ctx);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => walkValue(entry, ctx));
  }
  if (value !== null && typeof value === "object") {
    const next: Record<string, JsonValue> = {};
    for (const [key, entry] of Object.entries(value)) {
      next[key] = walkValue(entry, ctx);
    }
    return next;
  }
  return value;
}

function resolveStringRefs(value: string, ctx: RefResolutionContext): string {
  const fullMatch = parseRef(value);
  if (fullMatch) return resolveSingleRef(fullMatch, ctx, value);
  const refs = extractRefs(value);
  if (refs.length === 0) return value;
  return value.replace(
    /\$\{(ref|secret-ref):([A-Za-z_][\w-]*)\.([A-Za-z_][\w-]*)\}/g,
    (raw, kind, source, field) => {
      const ref: ResolvedRef = {
        kind: kind === "secret-ref" ? "secret-ref" : "ref",
        source,
        field,
      };
      const resolved = resolveSingleRef(ref, ctx, raw);
      if (typeof resolved !== "string") return JSON.stringify(resolved);
      return resolved;
    },
  );
}

function resolveSingleRef(
  ref: ResolvedRef,
  ctx: RefResolutionContext,
  original: string,
): string {
  if (ref.kind === "secret-ref") {
    if (ctx.secretResolver) {
      return ctx.secretResolver(ref.source, ref.field);
    }
    return original;
  }
  const outputs = ctx.outputs.get(ref.source);
  if (!outputs) return original;
  const value = outputs[ref.field];
  if (value === undefined) return original;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value);
}
