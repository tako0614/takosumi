/**
 * AppSpec — the canonical Takosumi manifest (`.takosumi.yml`).
 *
 * v1 contract per user-confirmed clean-cut design. The previous
 * `Manifest` / `ManifestResource` (see `manifest-resource.ts`) is being
 * retired alongside this introduction; AppSpec is the single public
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
 * The 5 frozen component kinds. New kinds require an RFC.
 * Provider plugins materialize each kind on the target runtime.
 */
export const COMPONENT_KINDS = [
  "worker",
  "postgres",
  "object-store",
  "oidc",
  "custom-domain",
] as const;

export type ComponentKind = (typeof COMPONENT_KINDS)[number];

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

export interface Component {
  readonly kind: ComponentKind;
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

export function isComponentKind(value: string): value is ComponentKind {
  return (COMPONENT_KINDS as readonly string[]).includes(value);
}

export function isReservedMount(value: string): value is ReservedMount {
  return (RESERVED_MOUNTS as readonly string[]).includes(value);
}
