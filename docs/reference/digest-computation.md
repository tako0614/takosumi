# ダイジェスト計算 {#digest-computation}

Takosumi v1 の public guard は source identity と `planSnapshotDigest` です。

| Digest / pin | 対象 | 使う場所 |
| --- | --- | --- |
| `commit` | git source の resolved commit | git source dry-run/apply guard |
| `sourceDigest` | prepared source archive payload bytes | prepared source integrity guard |
| `planSnapshotDigest` | dry-run で review した InstallPlan snapshot | dry-run から apply への TOCTOU guard |
| `artifactDigest` | operator extension artifact | operator / runtime-agent extension evidence |

## `planSnapshotDigest`

`planSnapshotDigest` は dry-run response の `InstallPlan` snapshot から計算します。snapshot には resolved source summary、generic repo
metadata、requested binding selection、operator PlatformService resolution、publication plan、changes、warnings が含まれます。

`InstallPlan` は persisted public entity ではありません。apply は reviewed snapshot の digest を expected guard として受け取り、
Deployment に `planSnapshotDigest`、`planSnapshot`、`bindingsSnapshot` を保存します。

## Prepared source digest

`source.kind: "prepared"` は build service / CI が用意した source archive の handoff です。digest は fetched payload bytes 全体に
対して計算します。gzip 圧縮されている場合は圧縮後 bytes が対象です。

```text
sourceDigest = "sha256:" + lowercase_hex(sha256(fetched_archive_bytes))
```

`source.digest` と fetched digest が一致しなければ 409 `failed_precondition` です。

## Git source pin

`source.kind: "git"` は `url` と `ref` を解決し、resolved commit を `expected.commit` と Deployment source summary に記録します。

## Local source

`source.kind: "local"` は dev / operator-local 用です。portable source byte digest は持ちません。review drift を強く防ぎたい
workflow では `git` または `prepared` を使います。
