# Build Service Boundary {#build-service-boundary}

Takosumi core does not run builds. A build service, CI system, or operator
automation can prepare source before calling the Installer API.

The core Installer API defines the source handoff contract and Deployment source
identity. The build service handles build recipes, command execution, cache
metadata, provenance, and how the source handoff payload is produced.

```text
source root
  -> build service / CI prepares source
  -> build service creates a prepared source payload
  -> build service computes the payload digest
  -> caller invokes the Installer API with prepared source URL + digest
  -> Installer verifies the payload and reads .takosumi.yml
  -> Installer records Deployment source identity
```

`source.digest` is the sha256 of the payload bytes fetched by the Installer. It
is not a build graph digest, package manager lock digest, cache key, or
provenance digest.

Portable Installer API v1 prepared source payloads are uncompressed POSIX tar
archives. The digest covers the fetched tar payload bytes. If an operator-local
profile accepts another archive encoding, that encoding is outside the portable
v1 compatibility profile.

Runtime file paths stay in kind-specific `spec` fields. Build commands,
container images, dependency caches, generated intermediate outputs, and
provenance records stay outside the manifest.

## Core Handoff Rules {#core-handoff-rules}

Prepared source is a source handoff payload produced by an operator build
service, CI system, or automation. Takosumi core sees the source input passed to
the Installer API.

- The payload represents a resolved source root and includes `.takosumi.yml`.
- Runtime file paths in the manifest are relative to the resolved source root.
- The Installer validates payload digest, path safety, size caps, and manifest
  parsing before resource creation.
- Deployment source identity records the verified source input, not the build
  recipe or cache key.

Component kind definition metadata can mark fields as source path fields. Those paths
must exist inside the resolved source root, must not escape that root, and must
not violate projection policy.

## Manifest Relationship {#appspec-relationship}

The manifest carries runtime and install intent. A runtime file path belongs in a
kind-specific `spec` field, such as `worker.spec.entrypoint`. Build command,
build node, container image, dependency cache, intermediate output, and
provenance record belong outside the manifest.

| Data                            | Surface                                      |
| ------------------------------- | -------------------------------------------- |
| runtime / install intent        | manifest                                     |
| runtime file path               | kind-specific `spec`                         |
| build recipe / build graph      | build-service profile / CI                   |
| prepared source URL             | Installer API source input                   |
| resolved prepared source digest | dry-run / apply response and Deployment      |
| workflow / trigger / approval   | operator automation / account management workflow |

## Related Pages {#related-pages}

- [Manifest](./manifest.md)
- [Installer API](./installer-api.md)
- [Build Service Example](../operator/build-service-profile.md)
