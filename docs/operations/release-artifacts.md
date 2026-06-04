# Release Artifact Pipelines

> このページでわかること: semver tag から Takos service OCI image を
> build / publish する所有境界と gate。

| Field         | Value                              |
| ------------- | ---------------------------------- |
| Last reviewed | 2026-05-17                         |
| Owner         | Release owner / product owners     |
| Scope         | Takos / Takosumi release artifacts |

## Artifact Matrix

| Artifact                        | Owning repo                    | Workflow                                  | Trigger      | Publish target                                                          |
| ------------------------------- | ------------------------------ | ----------------------------------------- | ------------ | ----------------------------------------------------------------------- |
| Takosumi source intake          | `takosumi/`                    | (no publish workflow; tsconfig alias)     | n/a          | consumed in-process by `takos/` via source path alias                   |
| Takos service OCI images        | `takos/`                       | `.github/workflows/release-artifacts.yml` | `v*.*.*` tag | `ghcr.io/<owner>/takos-worker`, `takos-git`, `takos-agent`              |

Takosumi (accounts plane + deploy control) は separate artifact を publish せず、
`takos/` が tsconfig alias で source を in-process 参照する。

semver tags は先頭 `v` 付き (例: `v1.2.3`)。 手動の `workflow_dispatch` 実行は
default で dry-run。手動 run から publish するには `publish` 入力を
明示する必要があります。

## Required Gates

publish step 前に必要な gate:

- takosumi source は `bun run check` / `bun run test` を gate に通し、
  takos からは tsconfig alias で source path を参照する (publish workflow なし)。
  in-process consume するため、Accounts schema の migration compatibility は
  takos worker の deploy gate で確認する。
- Takos OCI pipeline は `bun run check` を実行する。
- OCI image は semver version と immutable な `sha-*` tag を付ける。
- OCI image は BuildKit SBOM と provenance attestation
  (`sbom: true`、`provenance: mode=max`) を付けて publish する。
- Takos workflow は service image ごとに image digest metadata を記録し、 commit
  pin / digest-pinned image reference / SBOM flag / provenance flag を 含む
  release artifact manifest を生成する。
- release owner は image digest metadata artifact を取得した状態で
  `cd takos && bun run release-manifest:check-artifacts` を実行し、 clean git
  / submodule state、semver tag、`sha-*` tag、SBOM / provenance flag、 commit
  pin をまとめて検証する。

## Takos Boundary

Takos の customer-facing Web / API が primary surface です。Takos product
release pipeline は Takos distribution に必要な service image のみを build
します:

- `takos-worker` (`deploy/docker/takos-worker.Dockerfile` から build)
- `takos-git` (`containers/git/Dockerfile` から build)
- `takos-agent` (`containers/agent/Dockerfile` から build)

`takosumi` (accounts plane + deploy control) は separate artifact を publish
せず、`takos-worker` が tsconfig alias で source を in-process 取り込む。
account-plane ownership は worker 内に in-process で同居し、Takos product shell
の外に separate service として切り出されることはありません。

## Release Evidence

release sign-off record には以下の artifact を添付します:

- tag 名、commit SHA、workflow run URL
- `takos-release-manifest` の release artifact manifest
- Takosumi source path を取り込む worker の Accounts schema migration transcript
  (変わる場合)
- service image ごとの OCI image digest metadata
- `takos-worker` / `takos-git` / `takos-agent` の digest-pinned image reference
- 各 Takos service image の SBOM / provenance attestation status
- release gate の JSON summary
- rollback target の image digest

## Takos Image Digest Metadata

Takos release workflow は `takos-image-digest-*` artifact family の下に、
service image ごとに JSON ファイルを 1 件 upload します。release manifest build
はこれらを `--require-image-digests` で読み取り、digest 欠落、SBOM / provenance
flag 欠落、不正な commit、`sha256:` 以外の digest があると publish sign-off を
block します。

各 image record の shape:

```json
{
  "name": "takos-worker",
  "image": "ghcr.io/<owner>/takos-worker",
  "digest": "sha256:<64 hex chars>",
  "digestRef": "ghcr.io/<owner>/takos-worker@sha256:<64 hex chars>",
  "tags": [
    "ghcr.io/<owner>/takos-worker:1.2.3",
    "ghcr.io/<owner>/takos-worker:sha-abcdef0"
  ],
  "commit": "<git commit sha>",
  "workflowRun": "https://github.com/<owner>/takos/actions/runs/<id>",
  "sbom": true,
  "provenance": true
}
```
