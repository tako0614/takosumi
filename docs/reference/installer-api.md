# Installer API (`/v1/installations/*`) {#installer-api-v1-installations}

> このページでわかること: Takosumi の public 5 endpoint の wire spec (= dry-run
> / apply / rollback)。

Takosumi の public HTTP surface は Installation を中心にした 5 endpoint です。
対象は AppSpec / Installation / Deployment の 3 つで、endpoint はその lifecycle
に対応します。

```
POST /v1/installations/dry-run
POST /v1/installations
POST /v1/installations/{id}/deployments/dry-run
POST /v1/installations/{id}/deployments
POST /v1/installations/{id}/rollback
```

すべて Installation 中心です。dry-run の結果は response で返り、apply の結果は
Deployment record として保存されます。

## 認証 {#authentication}

| Credential       | Header                          | 適用範囲                   |
| ---------------- | ------------------------------- | -------------------------- |
| Installer bearer | `Authorization: Bearer <token>` | `/v1/installations/*` 全体 |

token は operator が actor 単位に発行する scoped credential です。 Space scope,
capability scope は token claims に含まれます。

## `POST /v1/installations/dry-run` {#post-v1-installations-dry-run}

新規 Installation を **作らず** に AppSpec を検証し、 推定変更と費用を返します。

### リクエスト

```json
{
  "spaceId": "space:personal",
  "source": {
    "kind": "git",
    "url": "https://github.com/example/notes",
    "ref": "main"
  }
}
```

| field           | required    | 説明                                       |
| --------------- | ----------- | ------------------------------------------ |
| `spaceId`       | yes         | 対象 Space                                 |
| `source.kind`   | yes         | `git` / `prepared`                         |
| `source.url`    | yes         | git repository URL または prepared tar URL |
| `source.ref`    | conditional | `git` 時の branch / tag / commit           |
| `source.digest` | conditional | `prepared` 時の source snapshot digest     |

`source.kind: "prepared"` は build service が作った prepared source snapshot の
handoff です。`source.url` は `.takosumi.yml` を含む tar snapshot を指し、
`source.digest` はその tar payload の `sha256:<hex>` です。kernel は tar digest
を検証してから展開し、AppSpec を読みます。build recipe、cache metadata、
provenance は build service 側の record として扱います。

Installer API の public source kind は `git` と `prepared` だけです。CLI / build
service / operator automation が必要に応じて source tree を取得し、remote kernel
へはどちらかの形で渡します。

### レスポンス

```json
{
  "source": {
    "kind": "git",
    "url": "https://github.com/example/notes",
    "ref": "main",
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

`expected` は resolved source kind に対応する guard です。git source では
`expected.commit` / `expected.manifestDigest`、prepared source では
`expected.sourceDigest` / `expected.manifestDigest` を次の apply
に渡せば、source が変わっていたら 409 で reject されます (= TOCTOU 防止)。

prepared source の dry-run response では `source.digest` と
`expected.sourceDigest` が同じ値になります。prepared source には git commit が
無いので `expected.commit` は出しません。

```json
{
  "source": {
    "kind": "prepared",
    "url": "https://build.example.com/snapshots/app-123.tar",
    "digest": "sha256:..."
  },
  "manifestDigest": "sha256:...",
  "changes": [],
  "expected": {
    "manifestDigest": "sha256:...",
    "sourceDigest": "sha256:..."
  }
}
```

## `POST /v1/installations` {#post-v1-installations}

Installation を作成し、 最初の Deployment を実行します。

### リクエスト

```json
{
  "spaceId": "space:personal",
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
し、 そのまま実行します (= 弱保証)。これは direct single-shot caller 向けの
non-retry-safe mode です。dry-run から apply に進む flow や retrying automation
は、dry-run response の `expected` guard を必ず送ります。`expected` を渡すと、
source が変わっていれば 409 `failed_precondition`。

prepared source を apply する場合は `expected.sourceDigest` を渡します。

```json
{
  "spaceId": "space:personal",
  "source": {
    "kind": "prepared",
    "url": "https://build.example.com/snapshots/app-123.tar",
    "digest": "sha256:..."
  },
  "expected": {
    "manifestDigest": "sha256:...",
    "sourceDigest": "sha256:..."
  }
}
```

### レスポンス

```json
{
  "installation": {
    "id": "installation:01HM9N7XK4QY8RT2P5JZF6V3W9",
    "spaceId": "space:personal",
    "appId": "com.example.notes",
    "status": "running"
  },
  "deployment": {
    "id": "deployment:01HM9N7XK4QY8RT2P5JZF6V3WA",
    "installationId": "installation:01HM9N7XK4QY8RT2P5JZF6V3W9",
    "source": {
      "kind": "git",
      "url": "https://github.com/example/notes",
      "ref": "main",
      "commit": "abc123"
    },
    "manifestDigest": "sha256:...",
    "status": "succeeded",
    "outputs": {
      "components": {
        "web": {
          "url": "https://notes.example.com"
        },
        "db": {
          "host": "db.internal",
          "port": 5432
        }
      }
    },
    "createdAt": 1716000000000
  }
}
```

`outputs` は component kind が publish する JSON object です。public installer
response は component output を opaque JSON として返します。operator-facing
ledger は internal apply evidence を別に保持できます。

`Deployment.status: "succeeded"` は、Deployment を current
として使うために必要な apply / activate
の同期部分が完了したことを表します。health observation は `observe` worker
により後続で更新されます。rollback は historical record を `rolled_back`
に書き換えず、新しい rollback Deployment を作ります。

## `POST /v1/installations/{id}/deployments/dry-run` {#post-v1-installations-id-deployments-dry-run}

既存 Installation に新 source を当てた場合の変更差分を返します。 新 Deployment
は **作りません**。

### リクエスト

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

### レスポンス

`POST /v1/installations/dry-run` と同じ response shape。 加えて `changes[]` に
`op: update` / `op: delete` も登場します。

## `POST /v1/installations/{id}/deployments` {#post-v1-installations-id-deployments}

既存 Installation に対して新 Deployment を実行します。resolved source の検証と
resource update / create / delete を伴います。source を build / prepare
する処理は build service が先に行います。

### リクエスト

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

prepared source の場合は install と同じく `source.digest` と
`expected.sourceDigest` を渡します。

### レスポンス

```json
{
  "deployment": {
    "id": "deployment:01HM9N7XK4QY8RT2P5JZF6V3WB",
    "installationId": "installation:01HM9N7XK4QY8RT2P5JZF6V3W9",
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

## `POST /v1/installations/{id}/rollback` {#post-v1-installations-id-rollback}

過去 Deployment を元に **新しい Deployment を作って** 巻き戻します。 historical
record を改竄せず、 forward-only な monotonic 履歴を維持します。

### リクエスト

```json
{
  "deploymentId": "deployment:01HM9N7XK4QY8RT2P5JZF6V3WA"
}
```

### レスポンス

```json
{
  "deployment": {
    "id": "deployment:01HM9N7XK4QY8RT2P5JZF6V3WC",
    "installationId": "installation:01HM9N7XK4QY8RT2P5JZF6V3W9",
    "source": {
      "kind": "git",
      "ref": "main",
      "commit": "abc123"
    },
    "manifestDigest": "sha256:...",
    "status": "succeeded",
    "rolledBackFrom": "deployment:01HM9N7XK4QY8RT2P5JZF6V3WB",
    "rolledBackTo": "deployment:01HM9N7XK4QY8RT2P5JZF6V3WA"
  }
}
```

rollback は過去 Deployment の source pin、manifestDigest、resolved snapshot /
internal evidence を元に、新しい Deployment を作る操作です。application data の
backup / restore は operator の data-protection workflow で扱います。

## エンティティ Fields {#entity-fields}

### `Installation` {#installation}

この status は takosumi kernel / installer の runtime status です。operator が
別の public ledger を公開する場合、その status enum とは別物です。外部 ledger の
export lifecycle は operator 側が所有するため、この API の Installation status
には `exported` は登場しません。

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

### `Deployment` {#deployment}

```ts
type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

interface Deployment {
  readonly id: string;
  readonly installationId: string;
  readonly source: {
    readonly kind: "git" | "prepared";
    readonly url?: string;
    readonly ref?: string;
    readonly commit?: string;
    readonly digest?: string;
  };
  readonly manifestDigest: string;
  readonly status: "running" | "succeeded" | "failed";
  readonly outputs: {
    readonly components?: Record<string, Record<string, JsonValue>>;
    readonly [key: string]: unknown;
  };
  readonly rolledBackFrom?: string;
  readonly rolledBackTo?: string;
  readonly createdAt: number;
}
```

## エラーエンベロープ {#error-envelope}

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

| code                  | HTTP | 主な発生要因                                                                                 |
| --------------------- | ---- | -------------------------------------------------------------------------------------------- |
| `invalid_argument`    | 400  | AppSpec schema違反、 malformed source、 cyclic `publish` → `listen` graph                    |
| `unauthenticated`     | 401  | bearer 不足                                                                                  |
| `permission_denied`   | 403  | actor が Space に対する権限不足                                                              |
| `not_found`           | 404  | Installation / Deployment 不在                                                               |
| `failed_precondition` | 409  | expected pin mismatch、 unresolved component kind/provider、 listen 対象 namespace path 不在 |
| `resource_exhausted`  | 413  | source snapshot / provider quota / request size 上限超過                                     |
| `not_implemented`     | 501  | operator extension が利用できない                                                            |
| `internal_error`      | 500  | unhandled exception                                                                          |

## クロスリファレンス {#cross-references}

- [AppSpec](./app-spec.md) — `.takosumi.yml` 仕様
- [Build service handoff](./build-spec.md) — `source.kind=prepared` を作る build
  service input
- [Reference Kind Examples](./kind-registry.md#reference-component-kinds) —
  takosumi.com reference kind examples の schema / publishes / listens
- [Architecture: Kernel](./architecture/kernel.md) — installer pipeline
  の責務境界

## 次に読む

- [AppSpec](./app-spec.md) — request body の中身 (`.takosumi.yml` envelope)
- [Build service handoff](./build-spec.md) — build service と prepared source の
  handoff
- [Architecture: Kernel](./architecture/kernel.md) — 5 endpoint を実装する
  installer pipeline の責務境界
- [Operator Bootstrap](../operator/bootstrap.md) — kernel を起動して 5 endpoint
  を expose するまでの手順
- [CLI Reference](./cli.md) — 5 endpoint を叩く `takosumi` コマンド surface
- [Closed Enums](./closed-enums.md) — error code / status enum の正本
