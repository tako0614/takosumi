# Installer API (`/v1/installations/*`)

> このページでわかること: Takosumi の public 5 endpoint の wire spec (= dry-run
> / apply / rollback)。

Takosumi の public HTTP surface は **5 endpoint だけ** です。 entity は AppSpec
/ Installation / Deployment の 3 つだけ、 API もそれに対応します。

```
POST /v1/installations/dry-run
POST /v1/installations
POST /v1/installations/{id}/deployments/dry-run
POST /v1/installations/{id}/deployments
POST /v1/installations/{id}/rollback
```

すべて Installation 中心。 Plan / Snapshot のような別 entity は 存在しません —
dry-run の結果は response でその場で返り、 apply の結果は Deployment record
として保存されます。

## Authentication

| Credential       | Header                          | 適用範囲                   |
| ---------------- | ------------------------------- | -------------------------- |
| Installer bearer | `Authorization: Bearer <token>` | `/v1/installations/*` 全体 |

token は Takosumi Accounts が actor 単位に発行する scoped credential です。
Space scope, capability scope は token claims に含まれます。

## `POST /v1/installations/dry-run`

新規 Installation を **作らず** に AppSpec を検証し、 推定変更と費用を返します。

### Request

```json
{
  "spaceId": "space_personal",
  "source": {
    "kind": "git",
    "url": "https://github.com/example/notes",
    "ref": "main"
  }
}
```

| field         | required    | 説明                                   |
| ------------- | ----------- | -------------------------------------- |
| `spaceId`     | yes         | 対象 Space                             |
| `source.kind` | yes         | `git` / `local` / `catalog` / `bundle` |
| `source.url`  | conditional | `git` 時に required                    |
| `source.ref`  | conditional | `git` 時に branch / tag / commit       |

### Response

```json
{
  "source": {
    "commit": "abc123"
  },
  "manifestDigest": "sha256:...",
  "changes": [
    { "op": "create", "component": "web", "kind": "worker" },
    { "op": "create", "component": "db", "kind": "postgres" }
  ],
  "estimatedCost": {
    "currency": "JPY",
    "monthly": 500
  },
  "expected": {
    "commit": "abc123",
    "manifestDigest": "sha256:..."
  }
}
```

`expected.commit` / `expected.manifestDigest` を次の apply に渡せば、 source が
変わっていたら 409 で reject されます (= TOCTOU 防止)。

## `POST /v1/installations`

Installation を作成し、 最初の Deployment を実行します。

### Request

```json
{
  "spaceId": "space_personal",
  "source": {
    "kind": "git",
    "url": "https://github.com/example/notes",
    "ref": "main"
  },
  "expected": {
    "commit": "abc123",
    "manifestDigest": "sha256:..."
  }
}
```

`expected` を omit すると、 apply 時に source を再 fetch して digest を再計算
し、 そのまま実行します (= 弱保証)。 `expected` を渡すと、 source が変わって
いれば 409 `failed_precondition`。

### Response

```json
{
  "installation": {
    "id": "ins_abc123",
    "spaceId": "space_personal",
    "appId": "com.example.notes",
    "status": "running"
  },
  "deployment": {
    "id": "dep_first",
    "installationId": "ins_abc123",
    "source": {
      "kind": "git",
      "url": "https://github.com/example/notes",
      "ref": "main",
      "commit": "abc123"
    },
    "manifestDigest": "sha256:...",
    "status": "succeeded",
    "outputs": {
      "builds": [
        { "component": "web", "digest": "sha256:...", "uri": "..." }
      ],
      "resources": [
        {
          "component": "web",
          "kind": "worker",
          "provider": "@takos/cloudflare-workers",
          "providerResourceId": "..."
        },
        {
          "component": "db",
          "kind": "postgres",
          "provider": "@takos/aws-rds",
          "providerResourceId": "..."
        }
      ]
    },
    "createdAt": 1716000000000
  }
}
```

## `POST /v1/installations/{id}/deployments/dry-run`

既存 Installation に新 source を当てた場合の変更差分を返します。 新 Deployment
は **作りません**。

### Request

```json
{
  "source": {
    "kind": "git",
    "url": "https://github.com/example/notes",
    "ref": "main"
  }
}
```

source omit 時は Installation に紐づく前回 source を再 fetch します。

### Response

`POST /v1/installations/dry-run` と同じ shape。 加えて `changes[]` に
`op: update` / `op: delete` も登場します。

## `POST /v1/installations/{id}/deployments`

既存 Installation に対して新 Deployment を実行します。 build artifact 再生成、
resource update / create / delete を伴います。

### Request

```json
{
  "source": {
    "kind": "git",
    "url": "https://github.com/example/notes",
    "ref": "main"
  },
  "expected": {
    "commit": "abc456",
    "manifestDigest": "sha256:..."
  }
}
```

### Response

```json
{
  "deployment": {
    "id": "dep_next",
    "installationId": "ins_abc123",
    "source": {
      "kind": "git",
      "ref": "main",
      "commit": "abc456"
    },
    "manifestDigest": "sha256:...",
    "status": "succeeded",
    "outputs": {/* ... */},
    "createdAt": 1716100000000
  }
}
```

## `POST /v1/installations/{id}/rollback`

過去 Deployment を元に **新しい Deployment を作って** 巻き戻します。 historical
record を改竄せず、 forward-only な monotonic 履歴を維持します。

### Request

```json
{
  "deploymentId": "dep_previous"
}
```

### Response

```json
{
  "deployment": {
    "id": "dep_rollback_001",
    "installationId": "ins_abc123",
    "source": {
      "kind": "git",
      "ref": "main",
      "commit": "abc123"
    },
    "manifestDigest": "sha256:...",
    "status": "succeeded",
    "rolledBackFrom": "dep_next",
    "rolledBackTo": "dep_previous"
  }
}
```

**rollback の限界**: rollback は worker bundle / resource state
の巻き戻しのみで、 DB の row state / object-store の object 内容 は対象外です。
data backup / restore は別 feature。

## Entity shapes

### `Installation`

この status は takosumi kernel / installer の runtime status です。Takosumi
operator account-plane の Installation ledger が外部公開する `installing` /
`ready` / `failed` / `suspended` / `exported` とは別 enum で、 operator account
plane は kernel の `running` を Accounts 側の `ready` に map します。 export
lifecycle は operator Installation ledger が所有するため、この API の
Installation status には `exported` は登場しません。

```ts
interface Installation {
  readonly id: string;
  readonly accountId: string;
  readonly spaceId: string;
  readonly appId: string; // AppSpec metadata.id
  readonly currentDeploymentId: string | null;
  readonly status: "running" | "failed" | "suspended" | "deleted";
  readonly createdAt: number;
}
```

### `Deployment`

```ts
interface Deployment {
  readonly id: string;
  readonly installationId: string;
  readonly source: {
    readonly kind: "git" | "local" | "catalog" | "bundle";
    readonly url?: string;
    readonly ref?: string;
    readonly commit?: string;
  };
  readonly manifestDigest: string;
  readonly status: "running" | "succeeded" | "failed" | "rolled_back";
  readonly outputs: {
    readonly builds?: ReadonlyArray<{
      readonly component: string;
      readonly digest: string;
      readonly uri: string;
    }>;
    readonly resources?: ReadonlyArray<{
      readonly component: string;
      readonly kind: string;
      readonly provider: string;
      readonly providerResourceId: string;
    }>;
  };
  readonly rolledBackFrom?: string;
  readonly rolledBackTo?: string;
  readonly createdAt: number;
}
```

## Error envelope

```ts
interface ApiErrorEnvelope {
  readonly error: {
    readonly code:
      | "invalid_argument"
      | "unauthenticated"
      | "permission_denied"
      | "not_found"
      | "failed_precondition"
      | "resource_exhausted"
      | "not_implemented"
      | "internal_error";
    readonly message: string;
    readonly requestId: string;
    readonly details?: unknown;
  };
}
```

| code                  | HTTP | 主な発生要因                                                                                       |
| --------------------- | ---- | -------------------------------------------------------------------------------------------------- |
| `invalid_argument`    | 400  | AppSpec schema違反、 unknown kind、 cyclic `publish` → `listen` graph                              |
| `unauthenticated`     | 401  | bearer 不足                                                                                        |
| `permission_denied`   | 403  | actor が Space に対する権限不足                                                                    |
| `not_found`           | 404  | Installation / Deployment 不在                                                                     |
| `failed_precondition` | 409  | `expected.commit` mismatch、 既存 Installation suspended、 listen 対象 namespace path が未 publish |
| `resource_exhausted`  | 413  | build artifact / payload が provider quota / request size 上限超過                                 |
| `internal_error`      | 500  | unhandled exception                                                                                |

## Cross-references

- [AppSpec](./app-spec.md) — `.takosumi.yml` 仕様
- [Component Kind Catalog](./component-kind-catalog.md) — 4 kind の schema /
  publishes / listens
- [Architecture: Kernel](./architecture/kernel.md) — installer pipeline
  の責務境界
