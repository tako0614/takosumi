# 認証情報

Takosumi は認証情報を、**書き込み専用で保存し、Run の実行中だけ渡し、記録には名前しか
残しません**。この 3 つがすべての土台になっています。

## BYOC と external managed Host

通常の BYOC では Workspace/customer が vendor account と credential、作成される
resource の authority を持ちます。Takosumi が扱う実行経路は次のとおりです。

```text
ProviderConnection
  → CredentialRecipe
  → ProviderBinding
  → run-scoped runner materialization
  → standard OpenTofu provider
  → customer-owned resource
```

Takoform を使う場合も通常の provider と同じです。managed supply を選ぶときは、外部の
Takoserver Takoform Host に対する Host-scoped credential を通常の ProviderConnection として
登録できます。Takosumi は Takoserver の親 provider credential、provider installation、
backend、capacity、Workers for Platforms (WfP) namespace、dispatcher、native identity、
managed Offering を受け取ったり選択したりしません。これらは Takoserver の authority です。

## Connection

認証情報は Connection に保存します。`.env` や manifest には書きません。保存された値は
書き込み専用で、**作成後に読み出す経路はありません**。画面にも API にも再表示されず、
失った場合は作り直します。

```bash
takosumi connections create \
  --provider registry.opentofu.org/example/example \
  --recipe generic-env \
  --auth-mode env \
  --secret-partition provider-credentials \
  --values-file ./provider-credentials.json
```

| オプション           | 意味                                                            |
| -------------------- | --------------------------------------------------------------- |
| `--provider`         | provider の source アドレス                                     |
| `--recipe`           | 使う Credential Recipe の id。汎用の `generic-env` もここに書く |
| `--auth-mode`        | `env` (環境変数として注入) など                                 |
| `--secret-partition` | 秘密の保存区画                                                  |
| `--values-file`      | 環境変数名と値の JSON                                           |
| `--files-file`       | ファイルとして渡す認証情報の JSON                               |
| `--workspace`        | 対象 Workspace                                                  |
| `--expires-at`       | 失効日時                                                        |

`--provider` はホスト名から始まる完全修飾のアドレスです。`example/example` のような
短い形は受け付けません。module の `required_providers` が `example/example` と書いて
いる場合は、既定のレジストリを補った `registry.opentofu.org/example/example` が同じ
provider として照合されるので、Connection もこの形で作ります。

`--recipe` と `--auth-mode` と `--secret-partition` は常に必要です。その provider に
どんな環境変数が要るかを Takosumi が知らない場合は、`--recipe generic-env`
`--auth-mode env` を選びます。`--values-file` に書いた名前がそのまま使われます。

API では `POST /api/v1/connections` です。`/api/v1/provider-connections` は Workspace
から見える一覧を返す**読み取り専用**の経路で、ここでは作成できません。

検証は `/test`、無効化は削除ではなく `/revoke` です。失効させると以降の Run では
使えなくなり、過去の Run の記録は残ります。

## 値がどこまで行くか

値が runner sandbox に渡るのは、Run が実行されている間だけです。実行が終われば
消えます。渡し方は Connection の設定で決まり、環境変数として渡す方式とファイルとして
渡す方式があります。

どちらの場合も、変数名やファイル名は module の `required_providers` と provider 公式
ドキュメントに従って**自分で指定します**。provider 名から必要な認証情報が補われることは
ありません。

Run に残るのは「どの環境変数名を注入したか」だけです。値は残りません。

## 変数名の決まり

`--values-file` の JSON はキーが環境変数名、値が文字列です。名前は大文字の環境変数
識別子でなければならず、先頭は英大文字か `_`、2 文字目以降は英大文字・数字・`_` に
限ります。

```text
^[A-Z_][A-Z0-9_]*$
```

runner 自身が使う名前は上書きできません。`PATH`、`HOME`、`TMPDIR`、`TEMP`、`TMP`、
`PWD`、`OLDPWD`、`SHELL`、`USER`、`LOGNAME`、`HOSTNAME`、`HTTP_PROXY`、`HTTPS_PROXY`、
`ALL_PROXY`、`NO_PROXY`、`GIT_ASKPASS`、`SSH_AUTH_SOCK`、`SSL_CERT_FILE`、
`SSL_CERT_DIR` と、`TAKOSUMI_`、`TF_`、`OPENTOFU_`、`NODE_`、`NPM_`、`BUN_`、`LD_`、
`DYLD_` で始まる名前を指定すると、作成が `invalid_argument` で失敗します。ファイルを
渡す方式で、その置き場所を環境変数でも知らせる場合 (`envName`) にも、同じ規則が
かかります。

## 必須と宣言した割り当てが無いと Run は始まりません

InstallConfig の `policy.providerCredentials.requiredProviders`、または選択した
RunnerProfile が Connection 必須とした provider に割り当てが無いと、その Run は
OpenTofu を起動する前に失敗します。配列には完全な provider source を指定し、
近い名前や同じ末尾の Connection が代わりに選ばれることはありません。credentialless
provider はこの一覧に入れず、通常の provider plugin として同じ runner で実行できます。

判断の内訳は Run の `providerResolutions` に、provider ごとに 1 件ずつ入ります。

```bash
curl -s "$TAKOSUMI_DEPLOY_CONTROL_URL/api/v1/runs/run_example" \
  -H "authorization: Bearer $TAKOSUMI_DEPLOY_CONTROL_TOKEN"
```

| `status`                       | 意味                                               |
| ------------------------------ | -------------------------------------------------- |
| `resolved_provider_connection` | 使う Connection が決まりました                     |
| `blocked_missing_connection`   | その provider に割り当てた Connection がありません |

決まった項目の `evidence` には、provider 名、選ばれた Connection の id、注入する予定の
環境変数名 (`requiredEnvNames`) が入ります。止まった項目には provider 名と、止まった
理由 (`reason`) が入ります。どちらにも認証情報の値は入りません。

## Credential Recipe は設定補助です

operator が用意する Credential Recipe は、Workspace/customer が自分の provider
credential を登録するときの**設定補助**です。環境変数名や file 名を記述しますが、
credential の値や vendor account の authority を持ちません。

```bash
curl -s "$TAKOSUMI_DEPLOY_CONTROL_URL/api/v1/credential-recipes" \
  -H "authorization: Bearer $TAKOSUMI_DEPLOY_CONTROL_TOKEN"
```

Recipe が無い provider も、generic な env / file の Connection を作れば同じように
実行できます。

## 非 secret の設定と混ぜないでください

endpoint や region のような非 secret の値は、Connection ではなく module の変数や
`providerConfig` で渡します。認証情報らしいフィールド (token、password、private key
など) をそこに書くと**拒否されます**。

## 同じ module を別の認証情報で動かす

module は認証情報を持ちません。どの Connection を使うかは Capsule の ProviderBinding が
決めます。同じ module から開発用と本番用の Capsule を作り、それぞれに別の Connection を
割り当てられます。これが Takosumi における環境の分け方です。

ProviderBinding は provider source に加えて、子 module の `moduleLocalName` と
`childAlias`、generated root 側の `rootAlias` を別々に保持します。たとえば子 module の
`primary.archive` を root の `primary.production` に割り当てられます。source の末尾から
local name を推測したり、一つの alias を両側へ暗黙に流用したりしません。

```bash
curl -X PUT "$TAKOSUMI_DEPLOY_CONTROL_URL/api/v1/capsules/cap_example/provider-bindings" \
  -H "authorization: Bearer $TAKOSUMI_DEPLOY_CONTROL_TOKEN" \
  -H 'content-type: application/json' \
  -d @bindings.json
```

## Interface のトークンは別の仕組みです

Interface を呼ぶためのトークンは Connection とは別に発行されます。要求のたびに作られ、有効期間は
ごく短く、更新用トークンはありません。長期保存を前提にしないでください
([Interface](./interfaces.md))。

## 関連

- [実行モデル](./run-model.md)
- [Source と Capsule](./sources.md)
