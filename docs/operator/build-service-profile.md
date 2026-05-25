# Operator Build-Service Profile Example {#operator-build-service-profile}

This page is a non-normative operator profile example. It shows one way for an
operator build service to produce the prepared source handoff described in
[Prepared Source Handoff](../reference/build-spec.md).

Operators can use this profile when they want a shared, source-level build
service that feels similar to Takosumi AppSpec authoring. Takosumi core receives
the prepared source URL and digest produced by the build service.

## Example Input Shape

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

Build node fields are `kind`, `spec`, and `dependsOn`. This `kind` is
build-service-local vocabulary, not an AppSpec component kind and not a Takosumi
official type catalog descriptor.

## Linux Container Node Example

`linux-container` is an example build node kind. It runs a command inside a
Linux container image.

| Field        | Required | Meaning                                                      |
| ------------ | -------- | ------------------------------------------------------------ |
| `image`      | yes      | Linux container image; immutable references are recommended. |
| `command`    | yes      | Command string or argv vector run inside the container.      |
| `workingDir` | no       | Source-root-relative working directory.                      |
| `env`        | no       | Non-secret env allowed by build-service policy.              |
| `network`    | no       | Network mode allowed by build-service policy.                |

`workingDir` uses build-service path grammar, not AppSpec source-file-reference
grammar. Omit it or set it to `.` to run from the source root. Otherwise it is a
POSIX relative directory path under the source root: it must not start with `/`,
must not contain NUL, empty segments, `.`, or `..`, and its resolved realpath
must stay under the source root.

The profile can define whether command strings are shell commands, argv vectors,
or both; which environment variables are allowed; whether network is available;
how cache mounts work; and what provenance is retained.

## Handoff Responsibility

A build service using this profile:

- reads the source-root `.takosumi.yml` as immutable input
- runs build nodes in dependency order
- ensures the prepared source archive still contains the same `.takosumi.yml`
  bytes at the archive root
- includes runtime files referenced by AppSpec kind-specific `spec` fields
- computes the prepared archive payload digest
- calls the Installer API with `source.kind: "prepared"`

Build failure, cache invalidation, container image verification, secret mounts,
network policy, and provenance records are build-service responsibilities.
Installer apply still validates AppSpec, descriptor-selected source file paths,
prepared archive safety, and `source.digest` before provider side effects.

## Example

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

The build service turns the resulting source tree into a prepared source payload
and submits it to the Installer API as described in
[Prepared Source Handoff](../reference/build-spec.md).
