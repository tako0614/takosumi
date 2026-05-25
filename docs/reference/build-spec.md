# Prepared Source Handoff {#build-service-handoff}

Takosumi core does not run builds. A build service, CI system, or operator
automation can prepare a source tree before calling the Installer API by
submitting `source.kind: "prepared"`.

The core Installer API owns the handoff contract: source URL, declared digest,
resolved digest, archive-root `.takosumi.yml`, size limits, path-safety rules,
and Deployment source identity. The build service owns build recipes, command
execution, cache metadata, provenance, package format, and concrete parser
choice.

## Handoff Flow

```text
source root
  -> build service / CI prepares source tree
  -> build service creates a prepared source archive payload
  -> build service computes archive payload sha256
  -> caller invokes Installer API with source.kind: "prepared" + source.digest
  -> Installer fetches the payload, verifies digest and archive safety
  -> Installer reads archive-root .takosumi.yml and records Deployment source identity
```

```json
{
  "spaceId": "space_personal",
  "source": {
    "kind": "prepared",
    "url": "https://build.example.com/snapshots/app-123.archive",
    "digest": "sha256:..."
  }
}
```

`source.digest` is the sha256 of the payload bytes fetched by the Installer. It
is not a build graph digest, tree canonicality digest, package manager lock
digest, or provenance digest.

## Prepared source archive contract {#prepared-source-archive-contract}

prepared source archive は operator build service が作る handoff payload です。
Installer API core は URL、payload digest、archive root、portable POSIX tar
payload profile、size cap、path-safety requirements を定義します。compatible
operators must accept the portable tar profile. Operator build-service profiles
can publish additional accepted media types or parser profiles as distribution
extensions. Portable handoff requirements:

- `.takosumi.yml` は archive root に置く。
- AppSpec 内の runtime file path は archive root からの POSIX relative path。
- path は `/` で始まらず、NUL、空 segment、`.`、`..` を含めない。
- symlink / hardlink が archive root の外へ escape する場合は reject。
- 同じ normalized path を複数 entry が指す archive は duplicate ambiguity として
  reject。
- Installer API が response / Deployment record に残す `source.digest` は実際に
  fetch した archive payload bytes の `sha256:<hex>`。portable tar/profile
  parser、digest、entry safety policy で検証する。

Operator build-service profiles publish additional supported media types,
parser extensions, size limits, path-safety behavior, and error behavior for
their prepared source payloads. Takosumi core remains the Installer API contract
around URL, digest, portable tar payload profile, archive root, and path safety;
build recipe, cache metadata, and provenance stay in the build-service profile.

component kind descriptor metadata が source path field として扱う値は、prepared
archive 内に存在し、archive root から escape せず、projection policy に反しない
必要があります。dry-run は side effect なしで決定できる schema / descriptor /
source path validation を返し、apply は provider side effect 前に selected
implementation binding で同じ validation を繰り返します。build service が path
を preflight しても、Installer API apply 前の validation を省略しません。

## AppSpec Relationship

AppSpec keeps runtime/install intent. Runtime file paths stay in kind-specific
`spec` fields, such as `worker.spec.entrypoint`. Build commands, build nodes,
container images, dependency caches, generated intermediate artifacts, and
provenance records stay outside AppSpec.

`.takosumi.build.yml` is not a Takosumi core manifest. A build-service
distribution can define that file, another filename, a hosted CI workflow, or no
file at all. Takosumi core only receives the resulting prepared source input.

## Placement

| Content                         | Surface                                        |
| ------------------------------- | ---------------------------------------------- |
| runtime/install intent          | AppSpec                                        |
| runtime file paths              | kind-specific `spec`                           |
| build recipe / build graph      | build-service profile / CI                     |
| prepared source URL             | Installer API source input                     |
| resolved prepared source digest | dry-run / apply response and Deployment record |
| workflow / trigger / approval   | operator automation / account-plane workflow   |

## Related Pages

- [AppSpec](./app-spec.md)
- [Installer API](./installer-api.md)
- [Operator build-service profile example](../operator/build-service-profile.md)
- [Takosumi Official Type Catalog Specification](./type-catalog.md)
