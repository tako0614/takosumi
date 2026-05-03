/**
 * Bundled `Artifact.kind` registrations.
 *
 * The kernel's artifact endpoint accepts an open `kind: string`; this
 * module enumerates the kinds the bundled connector set understands so
 * `GET /v1/artifacts/kinds` can surface them to CLIs and operators. Third-
 * party connectors that introduce new kinds register them through
 * `registerArtifactKind` directly — they do NOT have to extend this list.
 */

import {
  registerArtifactKind,
  type RegisteredArtifactKind,
} from "takosumi-contract";

export const TAKOSUMI_BUNDLED_ARTIFACT_KINDS:
  readonly RegisteredArtifactKind[] = [
    {
      kind: "oci-image",
      description: "OCI / Docker container image referenced by URI (no upload)",
    },
    {
      kind: "js-bundle",
      description: "ESM JavaScript bundle for serverless runtimes " +
        "(Cloudflare Workers / Deno Deploy)",
      contentTypeHint: "application/javascript",
    },
    {
      kind: "lambda-zip",
      description: "AWS Lambda deployment zip",
      contentTypeHint: "application/zip",
    },
    {
      kind: "static-bundle",
      description: "Static site tarball for Pages-style hosts",
      contentTypeHint: "application/x-tar",
    },
    {
      kind: "wasm",
      description: "WebAssembly module",
      contentTypeHint: "application/wasm",
    },
  ];

/**
 * Register the bundled artifact kinds into the contract registry. Safe
 * to call repeatedly (idempotent — the underlying registry compares the
 * payload and only warns on actual collisions).
 */
export function registerBundledArtifactKinds(): void {
  for (const kind of TAKOSUMI_BUNDLED_ARTIFACT_KINDS) {
    registerArtifactKind(kind);
  }
}
