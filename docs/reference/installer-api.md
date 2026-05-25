# Installer API (5 endpoint) {#installer-api}

Takosumi の public Installer API は Installation を中心にした 5 endpoint です。
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

この 5 route が Takosumi public Installer API です。operator distribution が
account-plane API や facade を同じ host / URL prefix に置く場合、それらは
operator-owned API contract として versioning します。

## Write API And Read Surfaces {#write-api-and-read-surfaces}

The Installer API is the portable write lifecycle: preview, create Installation,
deploy, and rollback. It returns `Installation` and `Deployment` objects from
those writes, but it does not standardize list/get/poll routes in the
five-endpoint contract.

Operators provide the documented read projection required by workflows that need
Deployment history: dashboards, CLIs, rollback target selection, async apply
polling, audit review, and support tooling. That read surface can be a Cloud
account-plane API, a self-hosted operator API, or reference-kernel admin
tooling. Its route inventory, pagination, authentication, and redaction rules
belong to the operator distribution; its minimum semantics are defined in
[Status And Read Surfaces](./status-output.md).

## 認証 {#authentication}

| Credential       | Header                          | 適用範囲                  |
| ---------------- | ------------------------------- | ------------------------- |
| Installer bearer | `Authorization: Bearer <token>` | 上記 5 Installer endpoint |

token は operator が actor 単位に発行する scoped credential です。 Space scope,
capability scope は token claims に含まれます。

## `POST /v1/installations/dry-run` {#post-v1-installations-dry-run}

新規 Installation を **作らず** に AppSpec を検証し、予定変更を返します。

### リクエスト

```json
{
  "spaceId": "space_personal",
  "source": {
    "kind": "git",
    "url": "https://github.com/example/notes",
    "ref": "v1.2.3"
  }
}
```

| field           | required    | 説明                                                                             |
| --------------- | ----------- | -------------------------------------------------------------------------------- |
| `spaceId`       | yes         | 対象 Space                                                                       |
| `source.kind`   | yes         | `git` / `prepared` / dev・operator-local の `local`                              |
| `source.url`    | yes         | git URL、prepared archive URL、または `local` source path                        |
| `source.ref`    | conditional | `git` 時に必須の branch / tag / commit                                           |
| `source.digest` | conditional | `prepared` 時に必須の archive payload digest guard (`sha256:<64 lowercase hex>`) |

`git` と `prepared` が remote source kind です。remote operator / CLI / build
service はこの 2 つのどちらかを渡します。`local` は dev / operator-local profile
用で、kernel process から `source.url` の path が直接見える場合だけ使います。

remote `source.url` は HTTPS です。`http://localhost` / `http://127.0.0.1` は
single-host loopback dev だけで使えます。digest は integrity evidence であり、
public network transport の HTTPS 要求を置き換えません。file path や `file://`
locator は remote source ではなく、`source.kind: "local"` で表します。

source descriptor は kind ごとに閉じています。

- `git`: `url` と `ref` は必須。`ref` は branch / tag / commit。`digest` は
  invalid。
- `prepared`: `url` と `digest` は必須。`digest` は build service / caller が
  計算した archive payload guard。`ref` / `commit` は invalid。
- `local`: `url` は kernel-local path。`ref` / `commit` / `digest` は invalid。

`source.kind: "prepared"` は build service が作った prepared source archive の
handoff です。`source.url` は `.takosumi.yml` を含む archive payload を指しま
す。Installer API v1 wire は archive URL、declared digest、resolved digest、
archive root の `.takosumi.yml`、size cap、path-safety requirements を定義しま
す。Portable v1 prepared source payload は POSIX tar archive です。compatible
operators must accept that portable tar profile; operators may additionally
accept compressed tar or other parser profiles as distribution extensions.
kernel は実際に取得した payload bytes の `sha256:<hex>` を計算し、portable tar
/ profile parser と archive safety policy で検証してから AppSpec を読みます。
計算した payload digest が caller-supplied `source.digest` と一致しなければ 409
`failed_precondition` です。build recipe、cache metadata、provenance は build
service 側の record として扱います。

`git` と `prepared` は apply 前に immutable な source identity を解決します。
`git` は resolved commit、`prepared` は kernel が計算した archive digest が
resolved source identity になります。 AppSpec 内の file path は、この resolved
source 内の source-root-relative path です。`local` は request 時点の
kernel-local tree を読むため、portable source byte digest を wire で持ちません。

### レスポンス

The `outputs` example below shows catalog-shaped material produced by an
operator that adopted the official gateway and service-binding descriptors.
Core records non-secret output material; descriptor semantics remain catalog /
operator-owned.

```json
{
  "source": {
    "kind": "git",
    "url": "https://github.com/example/notes",
    "ref": "v1.2.3",
    "commit": "abc123"
  },
  "manifestDigest": "sha256:...",
  "appSpec": {
    "apiVersion": "v1",
    "metadata": {
      "id": "com.example.notes",
      "name": "Example Notes"
    },
    "components": {
      "web": {
        "kind": "worker",
        "spec": { "entrypoint": "src/worker.ts" },
        "publish": {
          "http": { "as": "http-endpoint" }
        }
      },
      "db": {
        "kind": "postgres",
        "spec": { "version": "16", "size": "small" }
      },
      "public": {
        "kind": "gateway",
        "listen": {
          "app": { "from": "web.http", "as": "upstream" }
        },
        "publish": {
          "public": { "as": "http-endpoint" }
        },
        "spec": {
          "listeners": {
            "public": {
              "protocol": "https",
              "host": "notes.example.com",
              "tls": "auto"
            }
          },
          "routes": [
            { "listener": "public", "path": "/", "to": "app" }
          ]
        }
      }
    }
  },
  "changes": [
    { "op": "create", "component": "web", "kind": "worker" },
    { "op": "create", "component": "db", "kind": "postgres" },
    { "op": "create", "component": "public", "kind": "gateway" }
  ],
  "expected": {
    "commit": "abc123",
    "manifestDigest": "sha256:..."
  }
}
```

core dry-run response は `changes[]` と `expected` guard です。Cost estimation,
billing quotes, approval prompts, and account-plane policy messages are operator
distribution responses around this Installer API call.

`changes[]` は component-level preview です。public `ChangeEntry.op` は次の 4
値です。

| Field       | Required | 説明                                                                                                        |
| ----------- | -------- | ----------------------------------------------------------------------------------------------------------- |
| `op`        | yes      | `create` / `update` / `delete` / `noop`。                                                                   |
| `component` | yes      | AppSpec の component name。                                                                                 |
| `kind`      | yes      | create / update / noop は submitted AppSpec kind。delete は current Deployment に記録された previous kind。 |
| `reason`    | no       | operator / reference implementation が返す短い説明。                                                        |

`noop` は既存 current Deployment と compared plan が同じ component に使えます。
plan entity は作られず、dry-run response 内だけの preview です。 resolved
descriptor URI や selected implementation binding を返したい operator
は、extension field と retained implementation/operator evidence に記録します。

`expected` は resolved source kind に対応する guard です。`manifestDigest` は常
に必須。git source では `expected.commit`、prepared source では
`expected.sourceDigest` も必須です。既存 Installation を対象にする deploy
dry-run では、review した base pointer として `expected.currentDeploymentId`
も返します。inapplicable field は 400 `invalid_argument`、正しい形の guard が
resolved source や current pointer と一致しない場合は 409 `failed_precondition`
です。

dry-run response の `expected` を次の apply にそのまま渡すと、review 済み source
と異なる入力は 409 で止まります。deploy apply では
`expected.currentDeploymentId` も照合するため、dry-run 後に別 Deployment が
current へ進んだ場合も 409 で止まります。この reviewed-source/base guard は
time-of-check/time-of-use drift を防ぎます。

prepared source の dry-run response では、kernel が計算した resolved
`source.digest` と `expected.sourceDigest` が同じ値になります。prepared source
には git commit が無いので `expected.commit` は出しません。

local source の dry-run response は `expected.manifestDigest` だけを返します。
これは `.takosumi.yml` bytes の guard であり、`src/worker.ts` など source tree
全体の byte drift は防ぎません。source tree byte まで apply guard に含める場合は
`git` または `prepared` を使います。

```json
{
  "source": {
    "kind": "prepared",
    "url": "https://build.example.com/snapshots/app-123.archive",
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

Installation の最初の apply を実行し、最初の Deployment を記録します。operator
account plane を持つ distribution では、Account / Space / ownership ledger
の作成 は operator facade が所有し、この route は AppSpec/source verification と
Deployment apply を担当します。

### リクエスト

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
    "manifestDigest": "sha256:..."
  }
}
```

`expected` を omit すると、apply 時に source を fetch して digest を計算し、その
attempt の resolved source で実行します。これは direct single-shot caller 向けで
す。dry-run から apply に進む flow や retrying automation は、dry-run response
の `expected` guard を送ります。`expected` を渡すと、source が変わっていれば 409
`failed_precondition`。

`expected` は reviewed-source guard であり、public idempotency key ではありませ
ん。apply の HTTP response を受け取る前に caller が timeout した場合は、operator
distribution の documented read surface で current Deployment と Deployment
history を確認してから retry します。同じ source が再送された場合も、 既に閉じた
Deployment を返すか新しい Deployment attempt として扱うかは operator
implementation の retry policy に従いますが、review 済み source と異なる入力は
必ず 409 で止まります。

prepared source を apply する場合、request の `source.digest` は必須です。
dry-run response の `expected.sourceDigest` は review 済み source を apply する
ための guard であり、`source.digest` の代替ではありません。kernel は fetched
payload digest を `source.digest` と照合し、さらに `expected.sourceDigest` が
渡されていれば同じ値であることを確認します。local source を apply する場合は
dry-run response の `expected.manifestDigest` を渡します。

```json
{
  "spaceId": "space_personal",
  "source": {
    "kind": "prepared",
    "url": "https://build.example.com/snapshots/app-123.archive",
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
    "id": "inst_01HM9N7XK4QY8RT2P5JZF6V3W9",
    "spaceId": "space_personal",
    "appId": "com.example.notes",
    "currentDeploymentId": "dep_01HM9N7XK4QY8RT2P5JZF6V3WA",
    "status": "ready",
    "createdAt": 1716000000000
  },
  "deployment": {
    "id": "dep_01HM9N7XK4QY8RT2P5JZF6V3WA",
    "installationId": "inst_01HM9N7XK4QY8RT2P5JZF6V3W9",
    "source": {
      "kind": "git",
      "url": "https://github.com/example/notes",
      "ref": "v1.2.3",
      "commit": "abc123"
    },
    "manifestDigest": "sha256:...",
    "status": "succeeded",
    "outputs": {
      "components": {
        "public": {
          "public": {
            "contract": "http-endpoint",
            "endpoints": [
              {
                "url": "https://notes.example.com",
                "scheme": "https",
                "host": "notes.example.com",
                "listener": "public",
                "visibility": "public",
                "primary": true,
                "routes": [{ "pathPrefix": "/", "to": "app" }]
              }
            ]
          }
        },
        "db": {
          "connection": {
            "contract": "service-binding",
            "configRef": "config://deployment/db/connection",
            "secretRefs": ["secret://runtime/db/password"]
          }
        }
      }
    },
    "createdAt": 1716000000000
  }
}
```

`outputs.components[componentName][publicationName]` は、その Deployment で
materialize された AppSpec `publish` entry の public / non-secret output です。
public installer response は catalog-defined publication material を JSON object
として返します。上の例は Takosumi official type catalog の `http-endpoint` と
`service-binding` material を使った response 例です。material field の意味は
選択された catalog / operator profile が所有し、operator-facing ledger は
internal apply evidence を別に保持できます。

public `outputs` は non-secret の runtime/public projection だけです。raw
credential、token、private key、password、cookie、provider secret は Deployment
outputs や export bundle に入れず、必要な値は `configRef` / `secretRef` /
operator-owned binding material として扱います。exporter-specific rejection and
redaction behavior belongs to the operator/exporter docs.

`Deployment.status: "succeeded"` は、Deployment を current
として使うために必要な apply / activate
の同期部分が完了したことを表します。health observation は後続で operator /
internal state を更新できます。activate は install / deploy / rollback の内部
phase であり、別の public activate endpoint はありません。rollback は historical
record を書き換えず、retained Deployment へ current pointer を戻します。

`Installation.currentDeploymentId` が指せるのは `succeeded` Deployment
だけです。 `running` / `failed` Deployment は history / operation evidence
として残せますが、current runtime authority にはなりません。

## `POST /v1/installations/{id}/deployments/dry-run` {#post-v1-installations-id-deployments-dry-run}

既存 Installation に新 source を当てた場合の変更差分を返します。新 Deployment は
**作りません**。

### リクエスト

```json
{
  "source": {
    "kind": "git",
    "url": "https://github.com/example/notes",
    "ref": "v1.2.4"
  }
}
```

source omit 時は Installation の current Deployment に記録された resolved source
identity を再利用します。git source は記録済み `commit` が authority であり、
prepared source は記録済み archive payload digest が authority です。`local`
source の current Deployment では portable resolved source byte identity
を再利用 できないため、deploy dry-run / apply は `source` omit
を受け付けません。`ref` は 表示 / intent の補助情報です。branch / tag ref
を再解決して最新化する操作では ありません。新しい ref を deploy したい場合は
request に `source` を明示します。

### レスポンス

`POST /v1/installations/dry-run` と同じ response shape。加えて `changes[]` に
`op: update` / `op: delete` も登場します。

```json
{
  "source": {
    "kind": "git",
    "url": "https://github.com/example/notes",
    "ref": "v1.2.4",
    "commit": "abc456"
  },
  "manifestDigest": "sha256:...",
  "changes": [
    { "op": "update", "component": "api", "kind": "web-service" },
    { "op": "create", "component": "cache", "kind": "object-store" },
    { "op": "delete", "component": "legacy-worker", "kind": "worker" }
  ],
  "expected": {
    "commit": "abc456",
    "manifestDigest": "sha256:...",
    "currentDeploymentId": "dep_01HM9N7XK4QY8RT2P5JZF6V3WA"
  }
}
```

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
    "ref": "v1.2.4"
  },
  "expected": {
    "commit": "abc456",
    "manifestDigest": "sha256:...",
    "currentDeploymentId": "dep_01HM9N7XK4QY8RT2P5JZF6V3WA"
  }
}
```

prepared source の場合は install と同じく `source.digest` が必須です。dry-run
response の `expected.sourceDigest` は reviewed-source guard として渡します。

source omit 時は dry-run と同じく current Deployment の resolved source identity
を再利用します。`local` source の current Deployment では portable resolved
source byte identity を再利用できないため、`source` omit は
`failed_precondition` です。 mutable branch / tag の最新化ではなく、記録済み
source の再 apply です。git commit や prepared archive payload
を再取得できない場合は `failed_precondition` として扱い、branch / tag
の現在位置へ暗黙 fallback しません。

deploy apply の `expected.currentDeploymentId` は dry-run 時点の current pointer
guard です。request の値が apply 開始時点の `Installation.currentDeploymentId`
と一致しない場合、provider side effect 前に 409 `failed_precondition` を返しま
す。

### レスポンス

```json
{
  "deployment": {
    "id": "dep_01HM9N7XK4QY8RT2P5JZF6V3WB",
    "installationId": "inst_01HM9N7XK4QY8RT2P5JZF6V3W9",
    "source": {
      "kind": "git",
      "url": "https://github.com/example/notes",
      "ref": "v1.2.4",
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

過去 Deployment を current pointer に戻します。historical Deployment record は
改竄せず、新しい Deployment も作りません。Installation の `currentDeploymentId`
を target Deployment に更新し、その Deployment の public/non-secret outputs を
current として再有効化します。

### リクエスト

```json
{
  "deploymentId": "dep_01HM9N7XK4QY8RT2P5JZF6V3WA"
}
```

### レスポンス

```json
{
  "installation": {
    "id": "inst_01HM9N7XK4QY8RT2P5JZF6V3W9",
    "spaceId": "space_personal",
    "appId": "com.example.notes",
    "currentDeploymentId": "dep_01HM9N7XK4QY8RT2P5JZF6V3WA",
    "status": "ready",
    "createdAt": 1716090000000
  },
  "deployment": {
    "id": "dep_01HM9N7XK4QY8RT2P5JZF6V3WA",
    "installationId": "inst_01HM9N7XK4QY8RT2P5JZF6V3W9",
    "source": {
      "kind": "git",
      "url": "https://github.com/example/notes",
      "ref": "v1.2.3",
      "commit": "abc123"
    },
    "manifestDigest": "sha256:...",
    "status": "succeeded",
    "outputs": {},
    "createdAt": 1716090000000
  },
  "rollback": {
    "rolledBackFrom": "dep_01HM9N7XK4QY8RT2P5JZF6V3WB",
    "rolledBackTo": "dep_01HM9N7XK4QY8RT2P5JZF6V3WA"
  }
}
```

`rollback` object is response metadata for this call. Durable audit/event shape
lives in the operator read projection or account-plane event API.

rollback は過去 Deployment の source pin、manifestDigest、public/non-secret
outputs、operator-retained reactivation evidence を authority として target
Deployment を再選択する操作です。source を再 fetch / rebuild しません。target
Deployment を current として再有効化するための retained evidence が無い場合、
provider side effect 前に 409 `failed_precondition` を返します。

Rollback target eligibility:

- target Deployment は同じ Installation に属する。
- target Deployment の `status` は `succeeded`。
- target Deployment の source identity、`manifestDigest`、public/non-secret
  outputs、operator-retained reactivation evidence が retention policy 上
  available。
- target Deployment が GC / export policy で rollback target から外れている場合
  は 409 `failed_precondition`。
- target `deploymentId` が存在しない、または別 Installation に属する場合は 404
  `not_found`。

application data の backup / restore は operator の data-protection workflow で
扱います。rollback は DB / object-store contents、migration、tenant data を
巻き戻しません。data restore が必要な場合は operator data-protection workflow、
backup restore、または account-plane export/import event と audit evidence で扱
います。

## エンティティ Fields {#entity-fields}

### `Installation` {#installation}

`Installation.status` は public Installation lifecycle status です。kernel-only
local dev response と public Installer API response は同じ 4 値を使います。
apply / rollback の進行中 detail は Deployment status、operation
metadata、または account-plane event payload に置き、別の public enum
を増やしません。

| Status       | 意味                                                                  |
| ------------ | --------------------------------------------------------------------- |
| `installing` | 初回 apply が進行中、または current Deployment がまだ確定していない。 |
| `ready`      | current Deployment が `succeeded` として有効。                        |
| `failed`     | 最後の install/apply attempt が失敗し、ready current が無い。         |
| `suspended`  | operator policy により apply / serving が停止されている。             |

operator account-plane distribution は export/import、uninstall、materialize
など の portability lifecycle を別 event / metadata / account-plane status
として持て ます。Takosumi Installer API の `Installation.status` は上の 4
値です。

`currentDeploymentId` は最後に current として選ばれた `succeeded` Deployment
を指します。apply 中や失敗した Deployment は履歴に記録できますが、 この pointer
を更新しません。rollback は retained `succeeded` Deployment を current pointer
として再選択します。

Provider rollout、activation、domain projection などの runtime-routing /
internal rollout projection は reference implementation docs
で扱います。Installer API の wire guarantee は、current pointer が `succeeded`
Deployment だけを指すことです。

```ts
interface Installation {
  readonly id: string;
  readonly spaceId: string;
  readonly appId: string; // AppSpec metadata.id
  readonly currentDeploymentId: string | null;
  readonly status: "installing" | "ready" | "failed" | "suspended";
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
    readonly kind: "git" | "prepared" | "local";
    readonly url?: string;
    readonly ref?: string;
    readonly commit?: string;
    readonly digest?: string;
  };
  readonly manifestDigest: string;
  readonly status: "running" | "succeeded" | "failed";
  readonly outputs: {
    readonly components?: Record<
      string,
      Record<string, Record<string, JsonValue>>
    >;
    readonly extensions?: Record<string, JsonValue>;
  };
  readonly createdAt: number;
}
```

The public Deployment wire guarantees source identity, `manifestDigest`, status,
and public/non-secret `outputs`. Portable evidence summaries can be exposed
through documented extension fields. Implementations and operator distributions
record resolution/materialization evidence in their retained ledger.

## Apply Result Semantics {#apply-result-semantics}

Validation, authentication, permission, source-guard, current-pointer guard, and
policy failures return the error envelope below before provider side effects and
before a new public Deployment is created.

Concurrent mutations are serialized per Installation. An operator may wait for
the active mutation to finish within its request deadline. If it cannot start
the requested mutation because another install/deploy/rollback remains active,
it returns 409 `failed_precondition` with an operator detail reason such as
`mutation-in-progress`; provider side effects for the rejected request have not
started.

Once an apply attempt has entered the Deployment lifecycle, the result is a
Deployment record:

| Deployment status | Meaning                                                                                  | Current pointer behavior                                       |
| ----------------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `running`         | The operator accepted the apply and continues work asynchronously.                       | Current pointer stays unchanged until a later `succeeded`.     |
| `succeeded`       | Required apply / activation work completed and the Deployment can become current.        | `Installation.currentDeploymentId` may advance to this record. |
| `failed`          | The apply attempt reached lifecycle execution and failed after validation/preconditions. | Current pointer stays on the previous succeeded Deployment.    |

If an apply returns `running`, the operator read projection must let callers
observe that Deployment until it reaches `succeeded` or `failed`. The five core
Installer endpoints define the write lifecycle and the Deployment record shape;
operator read projections define route names, pagination, authentication, and
account-facing enrichment.

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

| code                  | HTTP | 主な発生要因                                                                                                                                                                                                                                                                              |
| --------------------- | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `invalid_argument`    | 400  | AppSpec schema違反、malformed source、invalid local `listen` ref、unsupported field shape、cyclic `publish` → `listen`                                                                                                                                                                    |
| `unauthenticated`     | 401  | bearer 不足                                                                                                                                                                                                                                                                               |
| `permission_denied`   | 403  | actor が Space に対する権限不足、operator policy による拒否                                                                                                                                                                                                                               |
| `not_found`           | 404  | Installation / Deployment 不在                                                                                                                                                                                                                                                            |
| `failed_precondition` | 409  | source pin mismatch、prepared `source.digest` mismatch、expected guard mismatch、required external publication が current Space state に無い、duplicate visible external publication declarations、active mutation conflict、source omit が current local source を再利用しようとした場合 |
| `resource_exhausted`  | 413  | request body / manifest / source snapshot size 上限超過                                                                                                                                                                                                                                   |
| `not_implemented`     | 501  | API endpoint、recognized kind の implementation binding、または operator-defined extension がこの operator で実装されていない                                                                                                                                                             |
| `internal_error`      | 500  | unhandled exception                                                                                                                                                                                                                                                                       |

この error code set は 5 endpoint Installer API の scope です。operator
account-plane API は同じ URL prefix を使っても別 surface なので、
`state_conflict` など account-plane 固有 code を返せます。

## 関連ページ

- [AppSpec](./app-spec.md)
- [Build service handoff](./build-spec.md)
- [CLI Reference](./cli.md)
- [Enum and Value Index](./closed-enums.md)
