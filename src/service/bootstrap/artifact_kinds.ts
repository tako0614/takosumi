/**
 * Bundled DataAsset metadata kind registrations for the reference service.
 *
 * These are not component kinds. They describe upload metadata accepted by
 * `/v1/artifacts` so CLIs and operator tooling can discover supported
 * prepared-source adjuncts.
 */

import {
  registerArtifactKind,
  type RegisteredArtifactKind,
} from "takosumi-contract/reference/runtime-agent-lifecycle";

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

export function registerBundledArtifactKinds(): void {
  for (const kind of TAKOSUMI_BUNDLED_ARTIFACT_KINDS) {
    registerArtifactKind(kind);
  }
}
