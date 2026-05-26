/**
 * AppSpec — the canonical Takosumi manifest (`.takosumi.yml`).
 *
 * v1 contract per the publication/listen model. Components declare local
 * publications (`publish.<name>`) and local bindings (`listen.<name>`). A
 * binding refers to a same-AppSpec publication with `component.publication`
 * or to a Space-visible external publication path such as
 * `publisher.area.name`. Public concepts remain limited to:
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
 * Dotted path used by Space-visible external publications. A path has three
 * or more dot-separated segments, e.g. `publisher.identity.primary`.
 */
export type ExternalPublicationPath = string;

/**
 * Local names used inside one AppSpec. The parser keeps the runtime type as a
 * string but validates names as single path segments, so
 * `component.publication` references are unambiguous.
 */
export type PublicationName = string;
export type BindingName = string;

/**
 * Material contract alias or URI selected by `publish.<name>.as`.
 * Examples include `http-endpoint` and `service-binding`. Operators may use
 * full descriptor URIs.
 */
export type MaterialContractRef = string;

/**
 * Same-AppSpec source reference, formatted as `<component>.<publication>`.
 */
export type ComponentPublicationRef = string;

/**
 * Space-visible external publication path, formatted as a dotted path with
 * three or more segments.
 */
export type ExternalPublicationRef = ExternalPublicationPath;
export type ListenSourceRef = ComponentPublicationRef | ExternalPublicationRef;

/**
 * Consumer-side projection family selected by `listen.<binding>.as`.
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

/**
 * Per-publish options declared on `Component.publish[<publicationName>]`.
 *
 *   - `as` — material contract alias or URI for this publication.
 *
 * Output-to-material projection is defined by the component kind descriptor
 * and materializer. AppSpec authors name the publication and its contract;
 * they do not select backend output paths here.
 */
export interface PublishOptions {
  readonly as: MaterialContractRef;
}

/**
 * Per-listen options declared on `Component.listen[<bindingName>]`.
 *
 *   - `from`   — source publication (`component.publication`) or
 *                Space-visible external publication path
 *                (`publisher.area.name`).
 *   - `as`     — the shape the material should take in this component's
 *                runtime (env / secret-env / config-mount / upstream /
 *                operator-defined).
 *   - `prefix` — for `as: env`, the prefix used to derive env var names
 *                (e.g. `prefix: DB` + `{ url }` → `DB_URL`).
 *   - `mount`  — for path-based projections such as `as: config-mount`, the
 *                filesystem path inside the component runtime where the material
 *                is mounted.
 *   - `required` — for external publication refs, fail apply when the
 *                  publication path is absent. Same-AppSpec refs are always
 *                  required by parser/topology validation.
 */
export interface ListenOptions {
  readonly from: ListenSourceRef;
  readonly as: MaterialShape;
  readonly prefix?: string;
  readonly mount?: string;
  readonly required?: boolean;
}

export interface Component {
  readonly kind: ComponentKindRef;
  /**
   * Local publications this component offers to other components in the same
   * AppSpec. Each publication is referenced as
   * `<componentName>.<publicationName>`.
   */
  readonly publish?: Readonly<Record<PublicationName, PublishOptions>>;
  /**
   * Local bindings this component consumes. Each binding names its source
   * with `from` and controls how the material is surfaced to this component's
   * runtime (env / secret-env / config-mount / upstream / operator-defined).
   */
  readonly listen?: Readonly<Record<BindingName, ListenOptions>>;
  readonly spec?: JsonObject;
}
