import type { WebServiceSpec } from "../../kinds/web-service.ts";

/**
 * Resolves the OCI image URI from `spec.image`.
 *
 * `validateSpec` guarantees it is present, but the inferred type is
 * `string | undefined` so call sites still need a runtime narrow.
 */
export function resolveOciImage(spec: WebServiceSpec): string {
  if (spec.image) return spec.image;
  throw new Error("web-service spec is missing OCI image source: set `image`");
}
