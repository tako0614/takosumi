/**
 * AppSpec — the canonical Takosumi manifest (`.takosumi.yml`).
 *
 * v1 contract per the namespace pub/sub model (Wave B / Phase B). Components
 * declare what materials they publish to a hierarchical namespace registry
 * and which namespace paths they listen to; the installer wires materials
 * across components without per-edge naming. Public concepts remain limited
 * to:
 *   1. AppSpec       (= `.takosumi.yml`)
 *   2. Installation  (= a Space-scoped App)
 *   3. Deployment    (= one apply result)
 *
 * The prior `use:` edge model (`UseEdge` / `${ref:...}` / `${secret-ref:...}`
 * / `${bindings.*}` / `${secrets.*}` / `${installation.*}` /
 * `${artifacts.*}` / `${params.*}`) is removed. No migration path — the
 * earlier contract was never frozen.
 */

import type { JsonObject } from "./types.ts";

export const APP_SPEC_API_VERSION = "takosumi.dev/v1" as const;
export const APP_SPEC_KIND = "App" as const;

/**
 * The 4 built-in component kinds. `oidc` moved to Takosumi Accounts and is
 * no longer a built-in kernel kind. New built-in kinds require an RFC.
 * Provider plugins materialize each kind on the target runtime.
 *
 * Operator-defined kinds are accepted as full HTTPS URIs (e.g.
 * `https://operator.example.com/kinds/lambda`) — see `KIND_URI_BY_NAME`
 * for the canonical URI of each built-in name and `resolveKindUri()` for
 * short-name → URI resolution.
 *
 * @generated-from spec/contexts/kinds/v1/*.jsonld aliases[0]
 *   Each entry mirrors the primary alias (= `aliases[0]`) of a JSON-LD
 *   kind document. Kept hand-written rather than generated to preserve
 *   the dependency direction: the contract package is the root of the
 *   package graph and must not depend on spec tooling. Drift is enforced
 *   by `scripts/check-kind-uri-sync.ts`, which is invoked from
 *   `deno task spec:check-drift`.
 */
export const COMPONENT_KINDS = [
  "worker",
  "postgres",
  "object-store",
  "custom-domain",
] as const;

export type ComponentKind = (typeof COMPONENT_KINDS)[number];

/**
 * Canonical Takosumi kind URI base. Built-in kinds resolve to
 * `${TAKOSUMI_KIND_URI_BASE}<name>`.
 */
export const TAKOSUMI_KIND_URI_BASE = "https://takosumi.com/kinds/v1/" as const;

/**
 * Built-in short name → canonical URI mapping. Authoring `.takosumi.yml`
 * may use either the short name (`worker`) or the full URI
 * (`https://takosumi.com/kinds/v1/worker`).
 *
 * @generated-from spec/contexts/kinds/v1/*.jsonld (@id + aliases[0])
 *   Each entry mirrors the JSON-LD `@id` (= full canonical URI) keyed by
 *   the JSON-LD `aliases[0]` (= short name) of a kind document. Kept
 *   hand-written rather than generated; see `COMPONENT_KINDS` JSDoc for
 *   the rationale. Drift is enforced by `scripts/check-kind-uri-sync.ts`
 *   via `deno task spec:check-drift`.
 */
export const KIND_URI_BY_NAME: Readonly<Record<ComponentKind, string>> = {
  worker: `${TAKOSUMI_KIND_URI_BASE}worker`,
  postgres: `${TAKOSUMI_KIND_URI_BASE}postgres`,
  "object-store": `${TAKOSUMI_KIND_URI_BASE}object-store`,
  "custom-domain": `${TAKOSUMI_KIND_URI_BASE}custom-domain`,
};

/** Canonical URI → built-in short name reverse map. */
export const KIND_NAME_BY_URI: Readonly<Record<string, ComponentKind>> = Object
  .freeze(
    Object.fromEntries(
      Object.entries(KIND_URI_BY_NAME).map(([name, uri]) => [uri, name]),
    ) as Record<string, ComponentKind>,
  );

/**
 * Resolve a built-in short name to its canonical URI. Throws for unknown
 * names; use `isComponentKind()` to guard.
 */
export function resolveKindUri(name: ComponentKind): string {
  return KIND_URI_BY_NAME[name];
}

/**
 * If `value` is a canonical built-in kind URI, return the short name;
 * otherwise return `undefined`. Operator-defined kind URIs (= not in the
 * `KIND_NAME_BY_URI` map) return `undefined`.
 */
export function kindNameFromUri(value: string): ComponentKind | undefined {
  return KIND_NAME_BY_URI[value];
}

/**
 * `true` iff `value` matches the kind-URI shape (= `http(s)://...`).
 * Permissive on purpose: operator-defined kinds use arbitrary HTTPS URIs
 * and the AppSpec parser only checks URI syntax.
 */
export function isKindUri(value: string): boolean {
  if (typeof value !== "string" || value.length === 0) return false;
  return value.startsWith("https://") || value.startsWith("http://");
}

export interface AppSpec {
  readonly apiVersion: typeof APP_SPEC_API_VERSION;
  readonly kind: typeof APP_SPEC_KIND;
  readonly metadata: AppSpecMetadata;
  readonly components: Readonly<Record<string, Component>>;
}

export interface AppSpecMetadata {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly publisher?: string;
  readonly homepage?: string;
}

/**
 * Reference to a component kind. Either:
 *  - a built-in short name (`ComponentKind`, e.g. `"worker"`); or
 *  - a full HTTPS URI naming an operator-defined kind
 *    (e.g. `"https://operator.example.com/kinds/lambda"`).
 *
 * The AppSpec parser normalizes short names to their canonical URI via
 * `KIND_URI_BY_NAME` before downstream consumption is recommended, but the
 * stored value preserves the operator's authoring choice.
 */
export type ComponentKindRef = ComponentKind | string;

/**
 * Hierarchical namespace path used by the pub/sub material registry. A
 * path is a dot-separated string of non-empty segments (e.g.
 * `com.example.notes.db` or `<app-id>.<component-name>`). The parser
 * accepts arbitrary non-empty strings — the installer is responsible for
 * resolving placeholders like `<component-name>` against the AppSpec
 * graph.
 */
export type NamespacePath = string;

/**
 * Listen shapes recognized by the kernel surface. A `KernelPlugin` may
 * surface a listened material as one of:
 *
 *   - `"env"`  — expand the material into env vars prefixed by `prefix`
 *               (so `{ url, id }` becomes `${PREFIX}_URL`, `${PREFIX}_ID`);
 *   - `"mount"` — mount the material at the declared filesystem path
 *               (used for secret bundles, etc.);
 *   - `"target"` — pass the material to the plugin as an upstream target
 *               descriptor (used by `custom-domain`-style routers).
 *
 * Materializer authors may publish additional shapes in their JSON-LD; the
 * parser accepts any non-empty string here so operator-defined shapes are
 * forward-compatible.
 */
// `string & {}` is the canonical TypeScript trick for "string literal
// union with autocomplete plus open-ended string fallback". `ban-types`
// flags it but the intent here is exactly that idiom.
// deno-lint-ignore ban-types
export type MaterialShape = "env" | "mount" | "target" | (string & {});

/**
 * Per-listen options declared on `Component.listen[<namespacePath>]`.
 *
 *   - `as`     — the shape the material should take in this component's
 *                runtime (env / mount / target / operator-defined).
 *   - `prefix` — for `as: env`, the prefix used to derive env var names
 *                (e.g. `prefix: DB` + `{ url }` → `DB_URL`).
 *   - `mount`  — for `as: mount`, the filesystem path inside the
 *                component runtime where the material is mounted.
 */
export interface ListenOptions {
  readonly as: MaterialShape;
  readonly prefix?: string;
  readonly mount?: string;
}

export interface Component {
  readonly kind: ComponentKindRef;
  readonly build?: ComponentBuild;
  /**
   * Namespace paths this component publishes materials to. Each path
   * names a key in the global pub/sub registry; the publisher's
   * KernelPlugin chooses the material payload at apply time (see
   * `KernelPlugin.publishMaterial`).
   */
  readonly publish?: readonly NamespacePath[];
  /**
   * Namespace paths this component listens to, with per-path options
   * controlling how the listened material is surfaced to this component's
   * runtime (env / mount / target / operator-defined).
   */
  readonly listen?: Readonly<Record<NamespacePath, ListenOptions>>;
  readonly spec?: JsonObject;
}

/**
 * Minimum build recipe — explicitly NOT a CI workflow. No `jobs:`,
 * `steps:`, `matrix:`, `triggers:`, or pipeline DSL. Just the smallest
 * recipe required to produce an artifact.
 */
export interface ComponentBuild {
  readonly command: string;
  readonly output: string;
}

/**
 * Accept either a built-in short name or the canonical URI of a built-in
 * kind. Operator-defined kind URIs (= URIs not in `KIND_NAME_BY_URI`) are
 * NOT recognized by this predicate — use `isKindUri()` for the wider check.
 */
export function isComponentKind(value: string): value is ComponentKind {
  if ((COMPONENT_KINDS as readonly string[]).includes(value)) return true;
  return value in KIND_NAME_BY_URI;
}

/**
 * Normalize either a short name or a built-in canonical URI to the short
 * name. Returns `undefined` for operator-defined URIs.
 */
export function normalizeComponentKind(
  value: string,
): ComponentKind | undefined {
  if ((COMPONENT_KINDS as readonly string[]).includes(value)) {
    return value as ComponentKind;
  }
  return KIND_NAME_BY_URI[value];
}
