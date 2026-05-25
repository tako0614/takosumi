# Build Service Example {#operator-build-service-profile}

This page is a non-normative operator configuration example. It shows one way for an operator build service to produce the prepared source handoff described in the [Build Service Boundary](../reference/build-spec.md).

Takosumi core receives only the prepared source URL and digest produced by the build service. Build recipe shape, command execution, cache metadata, provenance, and payload construction belong to the build service.

## Input Shape {#input-shape}

```yaml
apiVersion: v1
metadata:
  id: com.example.notes.build
  name: Example Notes build
nodes:
  web:
    kind: linux-container
    spec:
      image: ghcr.io/example/build-node@sha256:...
      command: npm ci && npm run build
      workingDir: .
    dependsOn: []
```

| Field        | Required | Meaning                                      |
| ------------ | -------- | -------------------------------------------- |
| `apiVersion` | yes      | Build-service profile version.               |
| `metadata`   | yes      | Metadata for this build-service input.       |
| `nodes`      | yes      | Build graph nodes understood by the profile. |

Build node fields are `kind`, `spec`, and `dependsOn`. This `kind` is local to the build-service profile. It is not a manifest component kind and not an official Takosumi Kind Catalog entry.

## Linux Container Node {#linux-container-node}

`linux-container` is an example build node kind. It runs a command inside a Linux container image.

| Field        | Required | Meaning                                                      |
| ------------ | -------- | ------------------------------------------------------------ |
| `image`      | yes      | Linux container image; immutable references are recommended. |
| `command`    | yes      | Command string or argv vector run inside the container.      |
| `workingDir` | no       | Source-root-relative working directory.                      |
| `env`        | no       | Non-secret env allowed by build-service policy.              |
| `network`    | no       | Network mode allowed by build-service policy.                |

`workingDir` uses build-service path grammar, not manifest source-file-reference grammar. Omit it or set it to `.` to run from the source root. Otherwise it is a POSIX relative directory path under the source root and must remain under that root after realpath resolution.

## Handoff Responsibility {#handoff-responsibility}

A build service using this profile:

- reads the source-root `.takosumi.yml` as immutable input
- runs build nodes in dependency order
- ensures the prepared source archive still contains the same `.takosumi.yml` bytes at the archive root
- includes runtime files referenced by manifest kind-specific `spec` fields
- computes the prepared archive payload digest
- calls the Installer API with `source.kind: "prepared"`

Installer apply still validates the manifest, source file paths referenced by the kind definition, prepared archive safety, and `source.digest` before resource creation.

## Example {#example}

```yaml
# .takosumi.yml
apiVersion: v1
metadata:
  id: com.example.notes
  name: Example Notes
components:
  web:
    kind: worker
    spec:
      entrypoint: src/worker.ts
```

```yaml
# .takosumi.build.yml
apiVersion: v1
metadata:
  id: com.example.notes.build
  name: Example Notes build
nodes:
  web:
    kind: linux-container
    spec:
      image: ghcr.io/example/build-node@sha256:...
      command: npm ci && npm run build
    dependsOn: []
```

The build service turns the resulting source tree into a pre-built archive and submits it to the Installer API.
