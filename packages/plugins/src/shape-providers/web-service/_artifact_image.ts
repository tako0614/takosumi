import type { WebServiceSpec } from "../../shapes/web-service.ts";

/**
 * Resolves the OCI image URI from either the legacy `spec.image` field or the
 * new `spec.artifact: { kind: "oci-image", uri }` discriminated union.
 *
 * `validateSpec` guarantees one of the two forms is present, but the
 * inferred type is `string | undefined` so call sites still need a runtime
 * narrow. Throws if neither is set (would mean validateSpec was bypassed).
 */
export function resolveOciImage(spec: WebServiceSpec): string {
  if (spec.image) return spec.image;
  if (spec.artifact?.uri) return spec.artifact.uri;
  throw new Error(
    "web-service spec is missing OCI image source: set `image` or `artifact.uri`",
  );
}
