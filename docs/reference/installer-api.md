# Installer API (5 endpoint) {#installer-api}

Takosumi の public Installer API は Installation を中心にした 5 endpoint です。対象は AppSpec / Installation / Deployment の 3 つで、endpoint はその lifecycle に対応します。

```
POST /v1/installations/dry-run
POST /v1/installations
POST /v1/installations/{id}/deployments/dry-run
POST /v1/installations/{id}/deployments
POST /v1/installations/{id}/rollback
```

すべて Installation 中心です。dry-run の結果は response で返り、apply の結果は Deployment record として保存されます。

この 5 route が Takosumi public Installer API です。operator distribution が account layer API や facade を同じ host / URL prefix に置く場合、それらは operator-owned API contract として versioning します。

## Write API と参照 API {#write-api-and-read-surfaces}

Installer API は portable な write lifecycle です。preview、Installation 作成、 deploy、rollback を扱い、それらの write 結果として `Installation` と `Deployment` object を返します。list / get / poll route は 5 endpoint contract には含めません。

Deployment history を必要とする workflow では、operator が参照 API を提供します。対象は dashboard、CLI、rollback target selection、async apply polling、audit review、support tooling などです。

参照 API の形式は Cloud account layer API、operator-managed read API、operator admin tooling のどれでもかまいません。route inventory、pagination、authentication、redaction rule は operator distribution が定義します。

参照 API は write lifecycle の周辺にある compatibility / read-model surface です。Takosumi core Installer API endpoint が増えるわけではありません。

## 認証 {#authentication}

| Credential       | Header                          | 適用範囲                  |
| ---------------- | ------------------------------- | ------------------------- |
| Installer bearer | `Authorization: Bearer <token>` | 上記 5 Installer endpoint |

token は operator が actor 単位に発行する scoped credential です。 Space scope, capability scope は token claims に含まれます。

## `POST /v1/installations/dry-run` {#post-v1-installations-dry-run}

新規 Installation を **作らず** に manifest を検証し、予定変更を返します。

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

`git` と `prepared` が remote source kind です。remote operator / CLI / build service はこの 2 つのどちらかを渡します。`local` は dev / operator-local profile 用で、kernel process から `source.url` の path が直接見える場合だけ使います。

remote `source.url` は HTTPS です。`http://localhost` / `http://127.0.0.1` は single-host loopback dev だけで使えます。digest は integrity evidence であり、 public network transport の HTTPS 要求を置き換えません。file path や `file://` locator は remote source ではなく、`source.kind: "local"` で表します。

source input の構造は kind ごとに閉じています。

- `git`: `url` と `ref` は必須。`ref` は branch / tag / commit。`digest` は invalid。
- `prepared`: `url` と `digest` は必須。`digest` は build service / caller が計算した archive payload guard。`ref` / `commit` は invalid。
- `local`: `url` は kernel-local path。`ref` / `commit` / `digest` は invalid。

`source.kind: "prepared"` は build service が作った prepared source archive の handoff です。`source.url` は `.takosumi.yml` を含む archive payload を指します。

Installer API v1 wire が定義する要素:

- archive URL、declared digest、resolved digest
- archive root の `.takosumi.yml`
- size cap、path-safety requirements

Portable v1 prepared source payload は uncompressed POSIX tar archive です。 operator-local profile が別 archive encoding を受け付ける場合でも、それは portable v1 の互換条件ではありません。

Takosumi は取得した payload bytes の `sha256:<hex>` を計算し、portable tar parser と archive safety policy で検証してから manifest を読みます。計算した payload digest が caller-supplied `source.digest` と一致しなければ 409 `failed_precondition` です。build recipe、cache metadata、provenance は build service 側の record として扱います。

この API reference の prepared source 例は、Installer API の request shape だけを示します。build service endpoint、storage layout、recipe format、cache key、 provenance format は定義しません。

`git` と `prepared` は apply 前に immutable な source identity を解決します。 `git` は resolved commit、`prepared` は Takosumi が計算した archive digest が resolved source identity になります。 manifest 内の file path は、この resolved source 内の source-root-relative path です。`local` は request 時点の kernel-local tree を読むため、portable source byte digest を wire で持ちません。

### レスポンス

下の `outputs` 例は、official gateway の kind 定義と service-binding の kind 定義を採用した operator が作る catalog-shaped な出力データです。Core は component output slot と root `publish` で公開された service path の non-secret output data を記録し、kind の定義の semantics は catalog / operator 側が定義します。

```json
{
  "source": {
    "kind": "git",
    "url": "https://github.com/example/notes",
    "ref": "v1.2.3",
    "commit": "abc123"
  },
  "manifestDigest": "sha256:...",
  "manifest": {
    "apiVersion": "v1",
    "metadata": {
      "id": "com.example.notes",
      "name": "Example Notes"
    },
    "components": {
      "web": {
        "kind": "worker",
        "spec": { "entrypoint": "src/worker.ts" }
      },
      "db": {
        "kind": "postgres",
        "spec": { "version": "16", "size": "small" }
      },
      "public": {
        "kind": "gateway",
        "connect": {
          "app": { "output": "web.http", "inject": "upstream" }
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
    },
    "publish": {
      "api": {
        "output": "public.endpoint",
        "kind": "http-endpoint",
        "path": "acme.notes.api"
      },
      "database": {
        "output": "db.connection",
        "kind": "service-binding",
        "path": "acme.database.reporting"
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

core dry-run response は `changes[]` と `expected` guard です。Cost estimation、 billing quote、approval prompt、account layer policy message は、この Installer API call の周辺にある operator distribution response です。

`changes[]` は component-level preview です。public `ChangeEntry.op` は次の 4 値です。

| Field       | Required | 説明                                                                                                         |
| ----------- | -------- | ------------------------------------------------------------------------------------------------------------ |
| `op`        | yes      | `create` / `update` / `delete` / `noop`。                                                                    |
| `component` | yes      | manifest の component name。                                                                                 |
| `kind`      | yes      | create / update / noop は submitted manifest kind。delete は current Deployment に記録された previous kind。 |
| `reason`    | no       | operator が返す短い説明。                                                                                    |

`noop` は既存 current Deployment と compared plan が同じ component に使えます。 plan entity は作られず、dry-run response 内だけの preview です。 resolved kind 定義 URI や selected binding を返したい operator は、extension field と deploy record に記録します。

`expected` は resolved source kind に対応する guard です。`manifestDigest` は常に必須です。

source kind ごとの追加 guard:

- git source: `expected.commit`
- prepared source: `expected.sourceDigest`
- 既存 Installation への deploy dry-run: `expected.currentDeploymentId`(review した base pointer)

inapplicable field は 400 `invalid_argument` です。正しい形の guard が resolved source や current pointer と一致しない場合は 409 `failed_precondition` です。

dry-run response の `expected` を次の apply にそのまま渡すと、review 済み source と異なる入力は 409 で止まります。deploy apply では `expected.currentDeploymentId` も照合するため、dry-run 後に別 Deployment が current へ進んだ場合も 409 で止まります。この reviewed-source/base guard は time-of-check/time-of-use drift を防ぎます。

`expected.currentDeploymentId` は `string | null` です。current pointer がまだ無い Installation を deploy dry-run した場合は `null` を返し、apply はその pointer がまだ `null` の場合だけ進みます。

prepared source の dry-run response では、Takosumi が計算した resolved `source.digest` と `expected.sourceDigest` が同じ値になります。prepared source には git commit が無いので `expected.commit` は出しません。

local source の dry-run response は `expected.manifestDigest` だけを返します。これは `.takosumi.yml` bytes の guard であり、`src/worker.ts` など source tree 全体の byte drift は防ぎません。source tree byte まで apply guard に含める場合は `git` または `prepared` を使います。

```json
{
  "source": {
    "kind": "prepared",
    "url": "https://source.example/prepared/notes.tar",
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

Installation の最初の apply を実行し、最初の Deployment を記録します。operator account layer を持つ distribution では、Account / Space / ownership ledger の作成は operator facade が担当し、この route は manifest/source verification と Deployment apply を担当します。

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

`expected` を omit すると、apply 時に source を fetch して digest を計算し、その attempt の resolved source で実行します。これは direct single-shot caller 向けです。dry-run から apply に進む flow や retrying automation は、dry-run response の `expected` guard を送ります。`expected` を渡すと、source が変わっていれば 409 `failed_precondition`。

`expected` は reviewed-source guard であり、public idempotency key ではありません。

caller が apply の HTTP response を受け取る前に timeout した場合は、operator distribution の参照 API で current Deployment と Deployment history を確認してから retry します。同じ source の再送時に、既に閉じた Deployment を返すか新しい attempt として扱うかは operator の retry policy 次第です。review 済み source と異なる入力は必ず 409 で止まります。

prepared source を apply する場合、request の `source.digest` は必須です。 dry-run response の `expected.sourceDigest` は review 済み source を apply するための guard であり、`source.digest` の代替ではありません。Takosumi は fetched payload digest を `source.digest` と照合し、さらに `expected.sourceDigest` が渡されていれば同じ値であることを確認します。local source を apply する場合は dry-run response の `expected.manifestDigest` を渡します。

```json
{
  "spaceId": "space_personal",
  "source": {
    "kind": "prepared",
    "url": "https://source.example/prepared/notes.tar",
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
          "endpoint": {
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
      },
      "extensions": {
        "servicePathExposures": {
          "api": {
            "path": "acme.notes.api",
            "kind": "http-endpoint",
            "output": "public.endpoint",
            "material": {
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
          "database": {
            "path": "acme.database.reporting",
            "kind": "service-binding",
            "output": "db.connection",
            "material": {
              "contract": "service-binding",
              "configRef": "config://deployment/db/connection",
              "secretRefs": ["secret://runtime/db/password"]
            }
          }
        }
      }
    },
    "createdAt": 1716000000000
  }
}
```

`outputs.components[componentName][outputSlot]` は、その Deployment で materialize された component output slot の public / non-secret output data です。root `publish` で宣言された Installation output publication は `outputs.extensions.servicePathExposures` に source output、optional path、material kind として記録できます。上の例は Takosumi 公式カタログの `http-endpoint` と `service-binding` material data を使った response 例です。出力データ field の意味は選択された catalog / operator distribution が定義し、operator-facing ledger は operator-held apply evidence を別に保持できます。

public `outputs` は non-secret の runtime / public な注入結果だけです。raw credential、token、private key、password、cookie、provider secret は Deployment outputs や export bundle に入れず、必要な値は `configRef` / `secretRef` / operator-owned binding の出力データとして扱います。exporter-specific rejection と redaction behavior は operator / exporter docs が定義します。

`Deployment.status: "succeeded"` は、Deployment を current として使うために必要な apply / activate の同期部分が完了したことを表します。health observation は後続で operator observation state を更新できます。activate は install / deploy / rollback の内部 phase であり、別の public activate endpoint はありません。rollback は historical record を書き換えず、過去の Deployment へ current pointer を戻します。

`Installation.currentDeploymentId` が指せるのは `succeeded` Deployment だけです。 `running` / `failed` Deployment は history / operation evidence として残せますが、current runtime authority にはなりません。

## `POST /v1/installations/{id}/deployments/dry-run` {#post-v1-installations-id-deployments-dry-run}

既存 Installation に新 source を当てた場合の変更差分を返します。新 Deployment は **作りません**。

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

source omit 時は Installation の current Deployment に記録された resolved source identity を再利用します。git source は記録済み `commit` が authority であり、 prepared source は記録済み archive payload digest が authority です。`local` source の current Deployment では portable resolved source byte identity を再利用できないため、deploy dry-run / apply は `source` omit を受け付けません。`ref` は表示 / intent の補助情報です。branch / tag ref を再解決して最新化する操作ではありません。新しい ref を deploy したい場合は request に `source` を明示します。

### レスポンス

`POST /v1/installations/dry-run` と同じ response shape。加えて `changes[]` に `op: update` / `op: delete` も登場します。

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

既存 Installation に対して新 Deployment を実行します。resolved source の検証と resource update / create / delete を伴います。source を build / prepare する処理は build service が先に行います。

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

prepared source の場合は install と同じく `source.digest` が必須です。dry-run response の `expected.sourceDigest` は reviewed-source guard として渡します。

source omit 時は dry-run と同じく current Deployment の resolved source identity を再利用します。`local` source の current Deployment では portable resolved source byte identity を再利用できないため、`source` omit は `failed_precondition` です。 mutable branch / tag の最新化ではなく、記録済み source の再 apply です。git commit や prepared archive payload を再取得できない場合は `failed_precondition` として扱い、branch / tag の現在位置へ暗黙 fallback しません。

deploy apply の `expected.currentDeploymentId` は dry-run 時点の current pointer guard です。request の値が apply 開始時点の `Installation.currentDeploymentId` と一致しない場合、リソースの作成・更新前に 409 `failed_precondition` を返します。

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
    "outputs": {},
    "createdAt": 1716100000000
  }
}
```

## `POST /v1/installations/{id}/rollback` {#post-v1-installations-id-rollback}

過去 Deployment を current pointer に戻します。historical Deployment record は改竄せず、新しい Deployment も作りません。Installation の `currentDeploymentId` を target Deployment に更新し、その Deployment の public/non-secret outputs を current として再有効化します。

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

`rollback` object はこの call の response metadata です。durable audit / event shape は operator の参照 API または account layer event API が定義します。

rollback は過去 Deployment を authority として再選択する操作です。authority に使う情報は source pin、manifestDigest、public/non-secret outputs、 operator が保持する reactivation の記録です。source の再 fetch / rebuild は行いません。

target Deployment を current として再有効化するための Deployment の記録が無い場合、リソースの作成・更新前に 409 `failed_precondition` を返します。

rollback target の条件:

- target Deployment は同じ Installation に属する。
- target Deployment の `status` は `succeeded`。
- target Deployment の source identity、`manifestDigest`、public/non-secret outputs、operator が保持する reactivation の記録が retention policy 上 available。

rollback success は core record level で atomic です。response が成功するのは、 `Installation.currentDeploymentId` が target Deployment を指し、target の public/non-secret outputs が current outputs になった後だけです。

バリデーション、Deployment の記録の確認、serialization check、reactivation step のいずれかが失敗した場合、endpoint は error を返し、`currentDeploymentId` を変更しません。failure は operator read/event surface に記録されます。
新しい Deployment record は作りません。

- target Deployment が GC / export policy で rollback target から外れている場合は 409 `failed_precondition`。
- target `deploymentId` が存在しない、または別 Installation に属する場合は 404 `not_found`。

application data の backup / restore は operator の data-protection workflow で扱います。rollback は DB / object-store contents、migration、tenant data を巻き戻しません。data restore が必要な場合は operator data-protection workflow、 backup restore、または account layer export/import event と audit evidence で扱います。

## エンティティ Fields {#entity-fields}

### `Installation` {#installation}

`Installation.status` は public Installation lifecycle status です。Takosumi-only local dev response と public Installer API response は同じ 4 値を使います。 apply / rollback の進行中 detail は Deployment status、operation metadata、または account layer event payload に置き、別の public enum を増やしません。

| Status       | 意味                                                                                |
| ------------ | ----------------------------------------------------------------------------------- |
| `installing` | 初回 apply が進行中、または current Deployment がまだ確定していない。               |
| `ready`      | current Deployment が `succeeded` として有効。                                      |
| `failed`     | 最後の install/apply attempt が失敗し、ready current が無い。                       |
| `suspended`  | operator policy により side-effecting deploy / rollback mutation が停止されている。 |

Installation が `suspended` の場合でも、dry-run endpoint は preview を返せます。 side effect を伴う deploy / rollback endpoint は、operator-owned lifecycle flow が Installation を resume するまで 409 `failed_precondition` を返します。 suspension 中の runtime serving behavior は operator distribution または account layer projection が定義します。

operator account layer distribution は export/import、uninstall、materialize などの portability lifecycle を別 event / metadata / account layer status として持てます。Takosumi Installer API の `Installation.status` は上の 4 値です。

`currentDeploymentId` は最後に current として選ばれた `succeeded` Deployment を指します。apply 中や失敗した Deployment は履歴に記録できますが、この pointer を更新しません。rollback は過去の `succeeded` Deployment を current pointer として再選択します。

Provider rollout、activation、domain projection などの runtime-routing と operator rollout view は operator distribution docs で扱います。Installer API の wire guarantee は、current pointer が `succeeded` Deployment だけを指すことです。

```ts
interface Installation {
  readonly id: string;
  readonly spaceId: string;
  readonly appId: string; // manifest metadata.id
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

public Deployment wire は source identity、`manifestDigest`、status、public / non-secret `outputs` を保証します。portable な記録の summary は documented extension field で公開できます。implementation と operator distribution は resolution / 実体化の記録を ledger に残します。

## Apply result semantics {#apply-result-semantics}

validation、authentication、permission、source guard、current pointer guard、 policy failure は、リソースの作成・更新前、かつ新しい public Deployment 作成前に下のエラーレスポンスを返します。

concurrent mutation は Installation ごとに serialize します。operator は request deadline 内で active mutation の完了を待てます。別の install / deploy / rollback が active なため request mutation を開始できない場合、operator は `mutation-in-progress` のような detail reason とともに 409 `failed_precondition` を返します。reject された request のリソースの作成・更新は開始していません。

apply attempt が Deployment lifecycle に入った後は、結果は Deployment の記録になります。

| Deployment status | Meaning                                                                   | Current pointer behavior                                        |
| ----------------- | ------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `running`         | operator が apply を受け付け、非同期で作業を続けている。                  | 後続で `succeeded` になるまで current pointer は変わらない。    |
| `succeeded`       | 必須の apply / activation work が完了し、Deployment を current にできる。 | `Installation.currentDeploymentId` はこの record へ進められる。 |
| `failed`          | apply attempt が lifecycle execution に入り、その後失敗した。             | current pointer は previous succeeded Deployment に残る。       |

apply が `running` を返す場合、operator の参照 API はその Deployment が `succeeded` または `failed` に到達するまで caller が観測できるようにします。5 つの core Installer endpoint は write lifecycle と Deployment record shape を定義します。operator の参照 API は route name、pagination、authentication、 account-facing enrichment を定義します。

## エラーレスポンス {#error-envelope}

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

| code                  | HTTP | 主な発生要因                                                                                                             |
| --------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------ |
| `invalid_argument`    | 400  | 下記参照                                                                                                                 |
| `unauthenticated`     | 401  | bearer 不足                                                                                                              |
| `permission_denied`   | 403  | actor が Space に対する権限不足、operator policy による拒否                                                              |
| `not_found`           | 404  | Installation / Deployment 不在                                                                                           |
| `failed_precondition` | 409  | 下記参照                                                                                                                 |
| `resource_exhausted`  | 413  | request body / manifest / prepared source payload size 上限超過                                                          |
| `not_implemented`     | 501  | API endpoint、採用済み kind の定義に対する binding、または operator-defined extension がこの operator で実装されていない |
| `internal_error`      | 500  | unhandled exception                                                                                                      |

`invalid_argument` の主な発生要因:

- manifest schema 違反
- malformed source
- malformed `listen.path` grammar
- invalid `connect.output` ref
- unsupported field shape
- cyclic `connect` graph

`failed_precondition` の主な発生要因:

- source pin mismatch
- prepared `source.digest` mismatch
- expected guard mismatch
- well-formed kind/出力の形式/注入モード term が current Space で未採用または不可視
- required platform service が current Space state に無い
- duplicate visible platform service declarations
- active mutation conflict
- source omit が current local source を再利用しようとした場合

この error code set は 5 endpoint Installer API の scope です。operator account layer API は同じ URL prefix を使っても別 surface なので、 `state_conflict` など account layer 固有 code を返せます。

## 関連ページ

- [manifest](./manifest.md)
- [ビルドサービス境界](./build-spec.md)
- [CLI](./cli.md)
