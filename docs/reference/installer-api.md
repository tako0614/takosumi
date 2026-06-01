# Installer API (5 endpoint) {#installer-api}

Takosumi public Installer API は manifestless な Source / Installation / Deployment lifecycle です。

```text
POST /v1/installations/dry-run
POST /v1/installations
POST /v1/installations/{id}/deployments/dry-run
POST /v1/installations/{id}/deployments
POST /v1/installations/{id}/rollback
```

dry-run は response に `InstallPlan` snapshot を返します。apply は `Installation` / `Deployment` record を保存します。
list / get / poll / history route は operator-owned read model です。

## 認証 {#authentication}

| Credential | Header | 適用範囲 |
| --- | --- | --- |
| Installer bearer | `Authorization: Bearer <token>` | 上記 5 endpoint |

token は operator が actor 単位に発行する scoped credential です。

## Source {#source}

```json
{ "kind": "git", "url": "https://github.com/example/notes", "ref": "v1.2.3" }
```

```json
{ "kind": "prepared", "url": "https://source.example/notes.tar.gz", "digest": "sha256:..." }
```

```json
{ "kind": "local", "url": "/workspace/notes" }
```

| field | required | 説明 |
| --- | --- | --- |
| `kind` | yes | `git` / `prepared` / dev・operator-local の `local` |
| `url` | yes | git URL、prepared archive URL、または kernel-local path |
| `ref` | conditional | `git` 時に必須 |
| `digest` | conditional | `prepared` 時に必須。archive payload digest guard |

Remote source URL は SSRF guard の対象です。single-host loopback dev は `source.kind: "local"` を使います。

## `POST /v1/installations/dry-run` {#post-v1-installations-dry-run}

新規 Installation を作らず、Source と requested bindings を検証して plan を返します。

### Request

```json
{
  "spaceId": "space_personal",
  "source": {
    "kind": "git",
    "url": "https://github.com/example/notes",
    "ref": "v1.2.3"
  },
  "bindings": [
    {
      "name": "db",
      "serviceKind": "postgres",
      "labels": { "tier": "primary" },
      "required": true
    }
  ]
}
```

### Response

```json
{
  "source": {
    "kind": "git",
    "url": "https://github.com/example/notes",
    "ref": "v1.2.3",
    "commit": "abc123"
  },
  "planSnapshotDigest": "sha256:...",
  "installPlan": {
    "source": { "kind": "git", "commit": "abc123" },
    "repo": {
      "id": "notes",
      "name": "notes",
      "version": "1.2.3",
      "repositoryUrl": "https://github.com/example/notes"
    },
    "requestedBindings": [
      { "name": "db", "serviceKind": "postgres", "labels": { "tier": "primary" }, "required": true }
    ],
    "resolvedBindings": [
      {
        "name": "db",
        "selection": { "name": "db", "serviceKind": "postgres", "labels": { "tier": "primary" }, "required": true },
        "services": [
          { "kind": "postgres", "path": "data.primary.postgres", "name": "primary-postgres" }
        ]
      }
    ],
    "publications": [],
    "changes": [{ "op": "create", "subject": "notes", "kind": "source" }],
    "warnings": []
  },
  "changes": [{ "op": "create", "subject": "notes", "kind": "source" }],
  "expected": {
    "commit": "abc123",
    "planSnapshotDigest": "sha256:..."
  }
}
```

`expected` は reviewed-source / reviewed-binding guard です。public idempotency key ではありません。

## `POST /v1/installations` {#post-v1-installations}

Installation の最初の apply を実行し、最初の Deployment を記録します。

### Request

```json
{
  "spaceId": "space_personal",
  "source": {
    "kind": "git",
    "url": "https://github.com/example/notes",
    "ref": "v1.2.3"
  },
  "expected": {
    "commit": "abc123",
    "planSnapshotDigest": "sha256:..."
  }
}
```

`expected` を omit すると、apply attempt の resolved source と binding resolution で実行します。dry-run から apply に進む
automation は dry-run response の `expected` を渡します。

### Response

```json
{
  "installation": {
    "id": "inst_01HM9N7XK4QY8RT2P5JZF6V3W9",
    "spaceId": "space_personal",
    "appId": "notes",
    "currentDeploymentId": "dep_01HM9N7XK4QY8RT2P5JZF6V3WA",
    "status": "ready",
    "createdAt": 1716000000000
  },
  "deployment": {
    "id": "dep_01HM9N7XK4QY8RT2P5JZF6V3WA",
    "installationId": "inst_01HM9N7XK4QY8RT2P5JZF6V3W9",
    "status": "succeeded",
    "planSnapshotDigest": "sha256:...",
    "planSnapshot": {},
    "bindingsSnapshot": [],
    "outputs": {}
  }
}
```

## `POST /v1/installations/{id}/deployments/dry-run` {#post-v1-installations-id-deployments-dry-run}

既存 Installation に対する次回 Deployment を dry-run します。`source` を省略すると current Deployment の source を再利用します。

Response の `expected` には `currentDeploymentId` も入ります。apply 時に current pointer が変わっていれば 409 です。

```json
{
  "expected": {
    "currentDeploymentId": "dep_current",
    "commit": "def456",
    "planSnapshotDigest": "sha256:..."
  }
}
```

## `POST /v1/installations/{id}/deployments` {#post-v1-installations-id-deployments}

既存 Installation に Deployment を追加します。

```json
{
  "source": {
    "kind": "git",
    "url": "https://github.com/example/notes",
    "ref": "v1.2.4"
  },
  "expected": {
    "currentDeploymentId": "dep_current",
    "commit": "def456",
    "planSnapshotDigest": "sha256:..."
  }
}
```

## `POST /v1/installations/{id}/rollback` {#post-v1-installations-id-rollback}

Installation の current Deployment pointer を過去の Deployment に戻します。新しい Deployment は作りません。

```json
{ "deploymentId": "dep_rollback_target" }
```

Response は pointer rollback scope を返します。

```json
{
  "rollback": {
    "rolledBackFrom": "dep_current",
    "rolledBackTo": "dep_rollback_target",
    "scope": {
      "pointer": "reverted",
      "resourceMaterialization": "not-reapplied",
      "workloadState": "not-reverted"
    }
  }
}
```

## Error Envelope {#error-envelope}

```json
{
  "error": {
    "code": "failed_precondition",
    "message": "expected planSnapshotDigest does not match reviewed plan"
  }
}
```

| HTTP | code | 代表例 |
| --- | --- | --- |
| 400 | `invalid_argument` | source shape、binding selection、JSON body が不正 |
| 401 | `unauthenticated` | token missing / invalid |
| 403 | `permission_denied` | Space scope / capability 不足 |
| 404 | `not_found` | Installation / rollback target が見つからない |
| 409 | `failed_precondition` | source pin、prepared digest、current pointer、`planSnapshotDigest` mismatch |
| 413 | `resource_exhausted` | source payload / request size 超過 |
| 500 | `internal` | operator implementation error |
