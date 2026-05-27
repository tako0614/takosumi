/**
 * AppSpec — the canonical Takosumi manifest (`.takosumi.yml`).
 *
 * v1 contract per the connect / platform-listen model. Components use
 * `connect.<name>` for same-AppSpec component output wiring and
 * `listen.<name>` only for Space-visible platform service paths such as
 * `identity.primary.oidc`. Root `publish` records Installation output service
 * path declarations for selected component outputs. Public concepts remain limited
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
  readonly publish?: Readonly<Record<ExternalServiceName, PublishOptions>>;
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
 * use full URIs (`https://example.com/kinds/lambda`), but alias
 * resolution is outside this package.
 */
export type ComponentKindRef = string;

/**
 * Dotted path used by Space-visible platform services. A path has three
 * or more dot-separated segments, e.g. `identity.primary.oidc`.
 */
export type PlatformServicePath = string;

/**
 * Local names used inside one AppSpec. The parser keeps the runtime type as a
 * string but validates names as single path segments, so `component.output`
 * references are unambiguous.
 */
export type OutputSlotName = string;
export type ExternalServiceName = string;
export type BindingName = string;

/**
 * Same-AppSpec component output reference, formatted as `<component>.<output>`.
 */
export type ComponentOutputRef = string;

/**
 * Space-visible platform service path, formatted as a dotted path with
 * three or more segments.
 */
export type PlatformServiceRef = PlatformServicePath;
export type ListenSourceRef = ComponentOutputRef | PlatformServiceRef;

const LOCAL_NAME_SEGMENT_RE = /^[a-z][a-z0-9-]{0,62}$/;

export function isAppSpecLocalNameSegment(value: string): boolean {
  return LOCAL_NAME_SEGMENT_RE.test(value);
}

export function isComponentOutputRef(
  value: string,
): value is ComponentOutputRef {
  const segments = value.split(".");
  return segments.length === 2 && segments.every(isAppSpecLocalNameSegment);
}

/**
 * `true` iff `value` is a Space-visible platform service path. `default`
 * is an ordinary segment; Takosumi v1 performs no hidden default-path
 * expansion.
 */
export function isPlatformServicePath(
  value: string,
): value is PlatformServicePath {
  if (typeof value !== "string" || value.length === 0) return false;
  if (value.length > 255) return false;
  const segments = value.split(".");
  if (segments.length < 3 || segments.length > 8) return false;
  return segments.every(isAppSpecLocalNameSegment);
}

export function isPlatformServiceRef(
  value: ListenSourceRef | string,
): value is PlatformServiceRef {
  return isPlatformServicePath(value);
}

/**
 * Consumer-side projection family selected by `connect.<binding>.inject` or
 * `listen.<binding>.inject`.
 * Common projection families are:
 *
 *   - `"env"`  — expand the material into env vars prefixed by `prefix`
 *               (so `{ url, id }` becomes `${PREFIX}_URL`, `${PREFIX}_ID`);
 *   - `"secret-env"` — expand the material into env vars whose sensitive
 *               values remain secretRef-mediated;
 *   - `"config-mount"` — mount the material at the declared filesystem path
 *               or expose it as a config object;
 *   - `"upstream"` — pass HTTP endpoint material as an upstream target
 *               descriptor.
 *
 * Operators may publish additional projection families in descriptor metadata;
 * the parser accepts any non-empty string here so operator-defined shapes are
 * forward-compatible.
 */
// `string & Record<never, never>` keeps literal autocomplete while allowing
// operator-defined string values.
export type MaterialShape =
  | "env"
  | "secret-env"
  | "config-mount"
  | "upstream"
  | (string & Record<never, never>);

export type InjectionModeRef = MaterialShape;

/**
 * Per-connect options declared on `Component.connect[<bindingName>]`.
 *
 *   - `output` — same-AppSpec component output (`component.outputSlot`).
 *   - `inject` — the shape the material should take in this component's
 *                runtime (env / secret-env / config-mount / upstream /
 *                operator-defined).
 *   - `prefix` — for env-like projections, the prefix used to derive env var
 *                names.
 *   - `mount`  — for path-based projections such as config-mount.
 */
export interface ConnectOptions {
  readonly output: ComponentOutputRef;
  readonly inject: InjectionModeRef;
  readonly prefix?: string;
  readonly mount?: string;
}

/**
 * Per-listen options declared on `Component.listen[<bindingName>]`.
 *
 *   - `path`   — Space-visible platform service path
 *                (`identity.primary.oidc`). Same-AppSpec component outputs use
 *                `connect`, not `listen`.
 *   - `inject` — the shape the material should take in this component's
 *                runtime (env / secret-env / config-mount / upstream /
 *                operator-defined).
 *   - `prefix` — for env-like projections, the prefix used to derive env var
 *                names.
 *   - `mount`  — for path-based projections such as `inject: config-mount`, the
 *                filesystem path inside the component runtime where the material
 *                is mounted.
 *   - `required` — fail apply when the platform service path is absent.
 */
export interface ListenOptions {
  readonly path: PlatformServiceRef;
  readonly inject: InjectionModeRef;
  readonly prefix?: string;
  readonly mount?: string;
  readonly required?: boolean;
}

export type BindingOptions = ConnectOptions | ListenOptions;

/**
 * Root-level Installation output service path declaration. This does not create
 * a component-local connection. It records an already materialized component
 * output in Deployment outputs; operator / product distributions can project
 * that declaration into a Space-visible platform service inventory.
 */
export interface PublishOptions {
  readonly output: ComponentOutputRef;
  readonly path: PlatformServicePath;
}

export interface Component {
  readonly kind: ComponentKindRef;
  /**
   * Deterministic same-AppSpec component output connections. Each entry names a
   * source output (`component.outputSlot`) and how the material is injected into
   * this component.
   */
  readonly connect?: Readonly<Record<BindingName, ConnectOptions>>;
  /**
   * Platform service bindings. These are resolved by the operator / Space
   * context and are intentionally separate from deterministic same-AppSpec
   * `connect` wiring.
   */
  readonly listen?: Readonly<Record<BindingName, ListenOptions>>;
  readonly spec?: JsonObject;
}
