/**
 * AppSpec — the canonical Takosumi manifest (`.takosumi.yml`).
 *
 * v1 contract per user-confirmed clean-cut design. The previous
 * `Manifest` / `ManifestResource` is being retired from the public contract
 * alongside this introduction; AppSpec is the single public
 * manifest shape going forward. Public concepts are limited to:
 *   1. AppSpec       (= `.takosumi.yml`)
 *   2. Installation  (= a Space-scoped App)
 *   3. Deployment    (= one apply result)
 *
 * No migration path — the prior contract was never frozen.
 */

import type { JsonObject } from "./types.ts";

export const APP_SPEC_API_VERSION = "takosumi.dev/v1" as const;
export const APP_SPEC_KIND = "App" as const;

/**
 * The 5 built-in component kinds. New built-in kinds require an RFC.
 * Provider plugins materialize each kind on the target runtime.
 *
 * Operator-defined kinds are accepted as full HTTPS URIs (e.g.
 * `https://operator.example.com/kinds/lambda`) — see `KIND_URI_BY_NAME`
 * for the canonical URI of each built-in name and `resolveKindUri()` for
 * short-name → URI resolution.
 */
export const COMPONENT_KINDS = [
  "worker",
  "postgres",
  "object-store",
  "oidc",
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
 */
export const KIND_URI_BY_NAME: Readonly<Record<ComponentKind, string>> = {
  worker: `${TAKOSUMI_KIND_URI_BASE}worker`,
  postgres: `${TAKOSUMI_KIND_URI_BASE}postgres`,
  "object-store": `${TAKOSUMI_KIND_URI_BASE}object-store`,
  oidc: `${TAKOSUMI_KIND_URI_BASE}oidc`,
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
  readonly interfaces?: AppSpecInterfaces;
  readonly permissions?: AppSpecPermissions;
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

export interface Component {
  readonly kind: ComponentKindRef;
  readonly build?: ComponentBuild;
  readonly use?: Readonly<Record<string, UseEdge>>;
  readonly routes?: readonly string[];
  readonly spec?: JsonObject;
  readonly redirectPaths?: readonly string[];
  readonly scopes?: readonly string[];
  readonly name?: string;
  readonly target?: string;
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
 * Structural dependency edge between components. Replaces the
 * `${ref:...}` / `${secret-ref:...}` / `${bindings.*}` / `${secrets.*}` /
 * `${installation.*}` / `${artifacts.*}` / `${params.*}` placeholder
 * families from the prior contract.
 */
export interface UseEdge {
  readonly env?: string;
  readonly envPrefix?: string;
  readonly mount?: ReservedMount;
  readonly target?: string;
}

export const RESERVED_MOUNTS = ["oidc"] as const;
export type ReservedMount = (typeof RESERVED_MOUNTS)[number];

export interface AppSpecInterfaces {
  readonly launch?: InterfaceEntry;
  readonly mcp?: InterfaceEntry;
  readonly health?: InterfaceEntry;
}

export interface InterfaceEntry {
  readonly target: string;
  readonly path: string;
  readonly required?: boolean;
}

export interface AppSpecPermissions {
  readonly requested: readonly string[];
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

export function isReservedMount(value: string): value is ReservedMount {
  return (RESERVED_MOUNTS as readonly string[]).includes(value);
}
