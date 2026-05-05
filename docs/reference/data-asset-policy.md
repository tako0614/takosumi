# DataAsset Policy

> Stability: stable Audience: operator, kernel-implementer See also:
> [DataAsset Kinds](/reference/artifact-kinds),
> [Connector Contract](/reference/connector-contract),
> [Kernel HTTP API](/reference/kernel-http-api),
> [Environment Variables](/reference/env-vars),
> [Audit Events](/reference/audit-events)

This reference records the policy Takosumi enforces for DataAsset uploads and
runtime-agent consumption in the current v1 implementation.

## Current Enforcement Points

Takosumi v1 enforces DataAsset policy in three places:

| Layer               | Enforcement                                                                                                            |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Artifact upload     | `POST /v1/artifacts` requires the deploy bearer, computes `sha256`, verifies `expectedDigest`, and enforces size caps. |
| Artifact fetch      | `GET` / `HEAD /v1/artifacts/:hash` accepts either deploy bearer or read-only artifact-fetch bearer.                    |
| Runtime-agent apply | The lifecycle dispatcher checks `spec.artifact.kind` against the connector's `acceptedArtifactKinds`.                  |

The kernel does not run user build steps and does not execute transforms in the
current public deploy path. Source transforms, artifact signing policy, cache
policy, and approval-gated build pipelines are spec-reserved surfaces; they must
not be documented as active CLI or HTTP behavior until the matching operator
APIs and tests exist.

## Size Policy

The global upload cap is `TAKOSUMI_ARTIFACT_MAX_BYTES`; the default is
`52428800` bytes. Operators can set the env var or pass `maxBytes` when mounting
artifact routes.

Registered artifact kinds may carry `maxSize`. When present, `maxSize` overrides
the route default for that kind:

```ts
registerArtifactKind({
  kind: "js-bundle",
  description: "ESM JavaScript bundle",
  contentTypeHint: "application/javascript",
  maxSize: 50 * 1024 * 1024,
});
```

Unknown or unregistered kinds use the global cap. The content-length preflight
uses the largest known cap, then the post-parse body check enforces the exact
cap for the submitted kind.

Failure mode:

| Condition                    | HTTP / code                                                     | Recovery                                                                                                                  |
| ---------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Upload exceeds effective cap | `413 resource_exhausted`                                        | raise `TAKOSUMI_ARTIFACT_MAX_BYTES`, register a larger `maxSize`, compress the artifact, or move storage to R2 / S3 / GCS |
| Digest mismatch              | `400 invalid_argument`                                          | re-upload with the computed digest or fix the expected digest                                                             |
| Missing deploy bearer        | `401 unauthenticated` or route `404` when public token is unset | configure `TAKOSUMI_DEPLOY_TOKEN`                                                                                         |

## Accepted-Kind Policy

`Artifact.kind` is open at the protocol layer, but each connector declares what
it accepts. For example:

| Connector family                     | Accepted kinds                                        |
| ------------------------------------ | ----------------------------------------------------- |
| OCI-backed web-service connectors    | `oci-image`                                           |
| Cloudflare Workers / Deno Deploy     | `js-bundle`                                           |
| Operator-installed custom connectors | any registered or custom kind they explicitly declare |

The runtime-agent rejects mismatches before connector code runs. Shape-level
validation may be stricter: `worker@v1` accepts only `js-bundle` with a `hash`.

## Auth Policy

The artifact surface deliberately separates write and read credentials:

| Credential                      | Scope                                                                |
| ------------------------------- | -------------------------------------------------------------------- |
| `TAKOSUMI_DEPLOY_TOKEN`         | upload, list, delete, GC, and read                                   |
| `TAKOSUMI_ARTIFACT_FETCH_TOKEN` | read-only `GET` / `HEAD /v1/artifacts/:hash` for runtime-agent hosts |

The runtime-agent should receive the read-only token when it only needs to fetch
uploaded bytes for an apply. It should not need the deploy bearer.

## Operator Surface

Current operator controls are:

- `TAKOSUMI_ARTIFACT_MAX_BYTES` for the global upload cap.
- `registerArtifactKind(..., { allowOverride })` during operator-controlled
  bootstrap/plugin loading for discovery metadata and optional per-kind size.
- `takosumi artifact kinds` for read-only discovery.
- `takosumi artifact gc` for mark-and-sweep cleanup of unreferenced blobs.

There is no current `takosumi policy artifact ...` command. Adding a policy
reload command, transform approval workflow, or signature-verification backend
requires a matching implementation, tests, and updates to this reference.
