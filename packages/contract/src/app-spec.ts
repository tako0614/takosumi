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

export const APP_SPEC_API_VERSION = "v1" as const;

/**
 * `true` iff `value` matches the kind-URI shape (= `http(s)://...`).
 * Permissive on purpose: component kind definitions live outside the
 * Takosumi AppSpec contract.
 */
export function isKindUri(value: string): boolean {
  if (typeof value !== "string" || value.length === 0) return false;
  return value.startsWith("https://") || value.startsWith("http://");
}

export interface AppSpec {
  readonly apiVersion: typeof APP_SPEC_API_VERSION;
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
 * Reference to a component kind. The AppSpec contract treats the value as an
 * opaque non-empty string. Operators may define short aliases (`worker`) or
 * use full URIs (`https://operator.example.com/kinds/lambda`), but alias
 * resolution is outside this package.
 */
export type ComponentKindRef = string;

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
