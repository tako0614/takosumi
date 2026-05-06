# DataAsset Kinds

> Stability: stable Audience: operator, integrator See also:
> [Connector Contract](/reference/connector-contract),
> [DataAsset Policy](/reference/data-asset-policy),
> [Closed Enums](/reference/closed-enums)

A Takosumi artifact is the content-addressed byte-or-pointer record that backs a
DataAsset. Every `Artifact` referenced by a Manifest resource has a `kind` and
either a `hash` (`sha256:<hex>`, returned by `POST /v1/artifacts`) or a `uri`
(an external pointer such as an OCI registry URL).

`Artifact.kind` is an **open string at the protocol level**. The bundled kernel
registers the kinds below so `GET /v1/artifacts/kinds` and
`takosumi artifact kinds` can show operators what the deployed kernel and
runtime-agent connector set understands. Third-party connectors may register
additional kinds through `registerArtifactKind`; the registry is the discovery
surface, not a hard-coded public enum.

## Bundled Kinds

The bundled Takosumi plugins register these five kinds:

```text
oci-image | js-bundle | lambda-zip | static-bundle | wasm
```

| Kind            | Description                                                                               | Typical reference                                         | Kernel storage                       |
| --------------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------ |
| `oci-image`     | OCI / Docker container image referenced by registry URI.                                  | `artifact: { kind: "oci-image", uri: "ghcr.io/..." }`     | pointer only; bytes stay in registry |
| `js-bundle`     | ESM JavaScript bundle for serverless runtimes such as Cloudflare Workers and Deno Deploy. | `artifact: { kind: "js-bundle", hash: "sha256:..." }`     | content-addressed upload             |
| `lambda-zip`    | AWS Lambda deployment zip for connectors that consume zipped function packages.           | `artifact: { kind: "lambda-zip", hash: "sha256:..." }`    | content-addressed upload             |
| `static-bundle` | Static site archive for Pages-style hosts.                                                | `artifact: { kind: "static-bundle", hash: "sha256:..." }` | content-addressed upload             |
| `wasm`          | WebAssembly module bytes for connectors that execute or attach WASM artifacts.            | `artifact: { kind: "wasm", hash: "sha256:..." }`          | content-addressed upload             |

`worker@v1` is intentionally stricter than the protocol: its shape validation
requires `artifact.kind: "js-bundle"` and a non-empty `hash`. `web-service@v1`
accepts `image` as the backwards-compatible shorthand for
`artifact: { kind: "oci-image", uri: image }`; other artifact kinds are valid
only when the selected connector declares them in `acceptedArtifactKinds`.

## Connector Enforcement

A runtime-agent connector declares an `acceptedArtifactKinds` vector. The
runtime-agent lifecycle dispatcher rejects an apply request when the artifact
kind in `spec.artifact.kind` is not in that vector. This keeps protocol
extension open while still failing closed at the concrete connector boundary.

Examples:

- Cloudflare Workers and Deno Deploy worker connectors accept `js-bundle`.
- OCI-backed web-service connectors accept `oci-image`.
- Future or operator-installed connectors can accept `lambda-zip`,
  `static-bundle`, `wasm`, or a custom registered kind.

## Registration API

The contract package exposes a process-global registry that backs
`GET /v1/artifacts/kinds`.

```ts
import {
  getArtifactKind,
  isArtifactKindRegistered,
  listArtifactKinds,
  registerArtifactKind,
  unregisterArtifactKind,
} from "takosumi-contract";

registerArtifactKind({
  kind: "js-bundle",
  description: "ESM JavaScript bundle for serverless runtimes",
  contentTypeHint: "application/javascript",
  maxSize: 50 * 1024 * 1024,
});
```

Signatures:

```ts
registerArtifactKind(
  kind: RegisteredArtifactKind,
  options?: { allowOverride?: boolean },
): RegisteredArtifactKind | undefined;

listArtifactKinds(): readonly RegisteredArtifactKind[];
getArtifactKind(kind: string): RegisteredArtifactKind | undefined;
isArtifactKindRegistered(kind: string): boolean;
unregisterArtifactKind(kind: string): boolean;
```

Collision behaviour:

- The first registration for a `kind` succeeds and returns `undefined`.
- A second registration with identical metadata is a silent no-op.
- A second registration with different metadata and `allowOverride: false`
  prints a warning and keeps the original record.
- A second registration with `allowOverride: true` replaces the record and
  returns the previous one. This path is reserved for operator-controlled
  bootstrap and plugin-loader contexts.

## Size Limits

The artifact route enforces `TAKOSUMI_ARTIFACT_MAX_BYTES` globally. If a
registered kind carries `maxSize`, that per-kind value overrides the route
default for uploads of that kind. Unknown or unregistered kinds fall back to the
global cap.

The deploy route also enforces manifest-declared artifact sizes before plan /
apply side effects. When a resource contains `spec.artifact.size`, the value is
interpreted as a byte count and must be a non-negative integer no larger than
the registered kind's `maxSize` (or the global cap for unknown kinds). This is a
pre-provider quota gate for external pointers such as OCI image URIs; content
uploaded through `POST /v1/artifacts` is still checked again by the artifact
upload route.

`oci-image` normally uses `uri`, so it does not need `takosumi artifact push`.
Every uploaded kind is stored under `<bucket>/artifacts/<sha256-hex>` through
the kernel object-storage adapter; the digest is computed and verified
server-side regardless of any client-side `expectedDigest` field.

## Upload Flow

```text
takosumi artifact push <file> --kind <kind>
  POST /v1/artifacts (multipart: kind, body, metadata, expectedDigest?)
    -> kernel computes sha256 and enforces the global / registered size cap
    -> kernel writes bucket/artifacts/<hex> via ObjectStoragePort
    -> kernel returns { hash, kind, size, uploadedAt, metadata }

manifest.spec.artifact:
  kind: js-bundle
  hash: sha256:abc123...

kernel apply
  -> POST /v1/lifecycle/apply { spec, artifactStore: { baseUrl, token } }
  -> connector verifies acceptedArtifactKinds
  -> connector fetches bytes by hash via artifactStore
  -> connector materializes the resource and returns a handle
```

Auth boundaries:

- Write endpoints (`POST /v1/artifacts`, `DELETE /v1/artifacts/:hash`,
  `POST /v1/artifacts/gc`) require the deploy bearer.
- Read endpoints (`GET /v1/artifacts/:hash`, `HEAD /v1/artifacts/:hash`) also
  accept `TAKOSUMI_ARTIFACT_FETCH_TOKEN` so the runtime-agent can fetch bytes
  without holding the deploy bearer.

## Discovery and CLI

```bash
takosumi artifact push ./worker.js --kind js-bundle --metadata entrypoint=index.js
takosumi artifact list
takosumi artifact kinds --table
takosumi artifact gc --dry-run
takosumi artifact rm sha256:abc123...
```

`takosumi artifact kinds` reflects the registry snapshot exposed by the kernel
at the moment of the call. It does not mutate the registry.
