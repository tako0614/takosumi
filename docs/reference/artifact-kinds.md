# DataAsset Kinds

> Stability: stable
> Audience: operator, integrator
> See also: [Connector Contract](/reference/connector-contract), [DataAsset Policy](/reference/data-asset-policy), [Closed Enums](/reference/closed-enums)

A Takosumi artifact is the content-addressed byte-or-pointer record that
backs a DataAsset. Every `Artifact` referenced by a Manifest resource has
two identifying fields: a `kind` (the closed v1 enum below) and either a
`hash` (`sha256:<hex>`, returned by `POST /v1/artifacts`) or a `uri` (an
external pointer such as an OCI registry URL). DataAsset visibility is
Space-scoped per the [Connector Contract](/reference/connector-contract); an
Artifact stored against the kernel artifact partition is not globally
visible until operator artifact policy makes it so.

## Closed kind enum

The v1 DataAsset kind enum is closed:

```text
oci-image | js-module | wasm-module | static-archive | source-archive
```

Adding a new kind is governed by `CONVENTIONS.md` §6 RFC. No connector,
plugin, or third-party package may extend the enum unilaterally.

| Kind | Description | Required metadata | Size cap (kernel default) | Signature requirement | Cache policy |
| --- | --- | --- | --- | --- | --- |
| `oci-image` | OCI / Docker container image referenced by registry URI. Bytes are not stored in the artifact partition; the connector pulls from the registry at apply. | `metadata.uri` (registry URL); optional `metadata.digest` for pinning | not applicable (pointer kind) | required when operator artifact policy mandates registry signing (cosign / notation); plan rejects unsigned references when so configured | external; cache lives in the connector's image runtime, not in the kernel |
| `js-module` | ESM JavaScript module bundle for serverless runtimes (Workers, Deno Deploy, etc.). | `metadata.entrypoint` (relative path inside the bundle); `metadata.runtime` recommended | 50 MiB; raise per-key with `artifactPolicy.perKey` | required when operator policy demands signed JS modules; plan rejects unsigned modules in regulated profiles | content-addressed; cached by the connector by hash |
| `wasm-module` | A single `.wasm` module loaded by the connector's WebAssembly runtime. | `metadata.entrypoint` recommended; `metadata.compatibilityDate` for runtimes that require it | 50 MiB; per-key override allowed | required for any reserved-prefix Space (`takos`, `operator`, `system`) | content-addressed; runtime usually compiles once per host |
| `static-archive` | A tarball or zip of static files served verbatim by a Pages / static-host connector. | `metadata.contentType` recommended (`application/x-tar`, `application/zip`) | 50 MiB; per-key override allowed | required when operator policy demands signed bundles | content-addressed; CDN cache lives at the host |
| `source-archive` | An opaque source archive consumed by an operator-approved Transform. The digest is the digest of the archive bytes; canonical source-tree packaging is out of v1 scope. | none required by the kernel; the Transform validates its own inputs | 50 MiB; raise per-key for monorepo source bundles | required for any Transform that runs in `pre-commit`; the approval is bound to the source-archive digest | content-addressed; the resulting Transform output (a `js-module` or `static-archive`) is cached separately |

`oci-image` is the only pointer kind in v1. Every other kind references
bytes stored under `<bucket>/artifacts/<sha256-hex>` in the kernel object
storage adapter; the digest is computed and verified server-side
regardless of any client-side `expectedDigest` field.

## Connector identity

A Connector is operator-installed and addressed as `connector:<id>`. The
identity is operator-controlled and never appears in user manifests; users
select an Implementation, and the resolver picks the Connector bound to
the Implementation's accepted-kind vector. Each Connector declares an
`acceptedKinds` vector drawn from the kind enum above; `Plan` must reject
a Link / DataAsset binding whose `kind` is not in that vector. See the
[Connector Contract](/reference/connector-contract) for the
canonical Connector record.

## Registration API

The contract package exposes a small process-global registry that backs
the `GET /v1/artifacts/kinds` discovery endpoint and `takosumi artifact
kinds` CLI subcommand.

```ts
import {
  registerArtifactKind,
  listArtifactKinds,
  getArtifactKind,
  isArtifactKindRegistered,
  unregisterArtifactKind,
} from "takosumi-contract";

registerArtifactKind(
  {
    kind: "js-module",
    description: "ESM JavaScript module bundle for serverless runtimes",
    contentTypeHint: "application/javascript",
    maxSize: 50 * 1024 * 1024,
  },
  // optional second argument
  // { allowOverride: false }
);
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

- The first registration for a `kind` always succeeds and returns
  `undefined`.
- A second registration for the same `kind` with identical metadata is a
  silent no-op.
- A second registration with different metadata and `allowOverride: false`
  (the default) prints a single `console.warn` and keeps the original
  record.
- A second registration with different metadata and `allowOverride: true`
  replaces the record and returns the previous one. This path is reserved
  for operator-only contexts (operator-installed plugin loaders, kernel
  bootstrap factories); consumer plugins and connectors must not pass
  `allowOverride: true`.

Adding a new kind always requires the `CONVENTIONS.md` §6 RFC; the
registry exists to surface the closed enum for discovery, not to widen it.

## Per-key artifact policy

Operators may raise size caps and tighten signature requirements per
kind. The kernel reads the closed schema below from the operator
configuration loaded at boot:

```yaml
artifactPolicy:
  perKey:
    <kind>:                           # one of the v1 kinds above
      sizeCapBytes: <integer>         # overrides TAKOSUMI_ARTIFACT_MAX_BYTES for this kind only
      signatureRequired: <boolean>    # when true, plan rejects unsigned references for this kind
```

Both fields are optional inside each per-key block; absent fields fall
back to the global kernel defaults. The schema is closed: unknown keys
under `perKey.<kind>` cause boot to fail.

## Upload flow

```text
takosumi artifact push <file> --kind <kind>
  POST /v1/artifacts (multipart: kind, body, metadata)
    -> kernel validates kind against the closed enum and per-key policy
    -> kernel computes sha256, enforces sizeCapBytes
    -> kernel writes bucket/artifacts/<hex> via objectStorage
    -> kernel returns { hash, kind, size, uploadedAt, metadata }

manifest.spec.artifact:
  kind: js-module
  hash: sha256:abc123...

kernel apply
  -> POST /v1/lifecycle/apply { spec, artifactStore: { baseUrl, token } }
  -> connector reads acceptedKinds, fetches bytes by hash via artifactStore
  -> connector materializes the Implementation and returns a handle
```

Auth boundaries:

- Write endpoints (`POST /v1/artifacts`, `DELETE /v1/artifacts/:hash`,
  `POST /v1/artifacts/gc`) require the deploy bearer.
- Read endpoints (`GET /v1/artifacts/:hash`, `HEAD /v1/artifacts/:hash`)
  also accept `TAKOSUMI_ARTIFACT_FETCH_TOKEN` so the runtime-agent can
  fetch bytes without holding the deploy bearer.

## Discovery and CLI

```bash
takosumi artifact push ./bundle.tar --kind static-archive --metadata contentType=application/x-tar
takosumi artifact list
takosumi artifact kinds --table
takosumi artifact gc --dry-run
takosumi artifact rm sha256:abc123...
```

`takosumi artifact kinds` reflects the registry snapshot exposed by the
kernel at the moment of the call; it does not extend the v1 enum.

## Related

- Reference: [Connector Contract](/reference/connector-contract),
  [CLI](/reference/cli),
  [Kernel HTTP API](/reference/kernel-http-api),
  [Runtime-Agent API](/reference/runtime-agent-api),
  [Manifest](/manifest)

## Related design notes

- `design/data-asset-model` — DataAsset rationale and connector
  contract derivation.
- `design/operator-boundaries` — operator-installed artifact policy
  and credential trust boundary.
