import type { JsonObject, JsonValue } from "takosumi-contract/reference/compat";
import {
  extractRefs,
  extractRefsFromValue,
  type ManifestResource,
  parseRef,
  type ResolvedRef,
} from "./_internal_manifest_types.ts";

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

/**
 * Binary min-heap over strings ordered by default (lexicographic) `<`
 * comparison. Used as the ready frontier of the topological sort so the
 * globally-smallest ready node is popped each step in O(log n), reproducing
 * the deterministic order of a fully-sorted frontier without O(n) insertion.
 */
class StringMinHeap {
  readonly #items: string[] = [];

  get size(): number {
    return this.#items.length;
  }

  push(value: string): void {
    const items = this.#items;
    items.push(value);
    let i = items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (items[parent] <= items[i]) break;
      [items[parent], items[i]] = [items[i], items[parent]];
      i = parent;
    }
  }

  pop(): string | undefined {
    const items = this.#items;
    if (items.length === 0) return undefined;
    const top = items[0];
    const last = items.pop()!;
    if (items.length === 0) return top;
    items[0] = last;
    let i = 0;
    const n = items.length;
    for (;;) {
      const left = 2 * i + 1;
      const right = 2 * i + 2;
      let smallest = i;
      if (left < n && items[left] < items[smallest]) smallest = left;
      if (right < n && items[right] < items[smallest]) smallest = right;
      if (smallest === i) break;
      [items[smallest], items[i]] = [items[i], items[smallest]];
      i = smallest;
    }
    return top;
  }
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

  // Kahn topological sort using a lexicographic string min-heap as the ready
  // frontier. This pops the globally-smallest ready node each step — the exact
  // same deterministic order the previous sorted-array implementation produced
  // — but at O(log n) per push/pop instead of the old O(n) findIndex+splice
  // insertion (which was O(n²) across a wide DAG).
  const order: string[] = [];
  const ready = new StringMinHeap();
  for (const [name, sources] of incoming) {
    if (sources.size === 0) ready.push(name);
  }

  while (ready.size > 0) {
    const name = ready.pop()!;
    order.push(name);
    for (const child of adjacency.get(name) ?? new Set()) {
      const childIncoming = incoming.get(child)!;
      childIncoming.delete(name);
      if (childIncoming.size === 0) ready.push(child);
    }
  }

  if (order.length < resources.length) {
    // O(n): membership-test against a Set rather than `order.includes` inside
    // a filter (which would be O(n²)).
    const ordered = new Set(order);
    const remaining = resources
      .map((r) => r.name)
      .filter((name) => !ordered.has(name));
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
