# MCP から Takosumi を操作する

Operator control MCP adapter を使うと、Takos や別の MCP client から Takosumi の
Git install-plan、アプリ、Run を操作できます。新しい Git Source から reviewable
Plan Run まで準備し、アプリの一覧、plan、Run の確認、承認、apply を行えます。
MCP 自身のアプリの所有者として、その人が所有するアプリだけを操作します。

この adapter は任意機能です。Takos 専用の tool を組み込むのではなく、通常の
`mcp.server` Interface として `/mcp/operator-control/v1` に公開します。client は
MCP の `tools/list` から、その endpoint が提供する tool を読み取ります。

## 前提条件

- Takosumi Accounts と dashboard が動いている
- 外から到達できる HTTPS の Takosumi origin がある
- operator が MCP adapter を有効にできる
- 利用者が MCP の module を install し、そのアプリの所有者である

## 接続する

### 1. adapter を有効にする

stock platform worker に次を設定します。

```text
TAKOSUMI_OPERATOR_CONTROL_MCP_ENABLED=1
TAKOSUMI_ACCOUNTS_ISSUER=https://<takosumi-origin>
```

flag がない場合、MCP route は `404` を返します。Accounts issuer は scheme と path を
含む Takosumi origin に合わせてください。

host が `TAKOSUMI_INSTALL_CONFIG_COMPOSITION` を独自の runtime object で置き換えている
場合は、`OPERATOR_CONTROL_MCP_INSTALL_CONFIG` もその配列へ追加します。

### 2. Git module をデプロイする

dashboard の **サービスを追加**（`/new`）で次を指定します。

```text
Git URL:     https://github.com/tako0614/takosumi.git
modulePath:  opentofu-modules/operator-control-mcp
variables:
  takosumi_origin = https://<takosumi-origin>
```

plan を確認して apply すると、module の `endpoint` Output から `mcp.server`
Interface が作られます。install した本人には `mcp.invoke` permission を持つ
OAuth Binding が提案されます。

この module は公開 Takosumi API だけを使います。Takoform provider は不要です。

### 3. MCP client から接続する

Interface の接続情報を dashboard で開き、MCP client に渡します。transport は
Streamable HTTP です。

```text
https://<takosumi-origin>/mcp/operator-control/v1
```

認証には Interface Binding から取得した OAuth token を使います。operator token や
module の provider credential は client へ渡しません。

## 提供する tool

| Tool                                | 用途                                                 |
| ----------------------------------- | ---------------------------------------------------- |
| `takosumi_install_plan_create`      | Git Source から durable install-plan を作成・再生する |
| `takosumi_install_plan_get`         | install-plan の現在状態を副作用なしで読む             |
| `takosumi_install_plan_reconcile`   | install-plan を明示的に一段だけ進める                  |
| `takosumi_capsules_list`            | 所有者のアプリの一覧を読む（次は `cursor`）           |
| `takosumi_capsule_plan`             | 既存のアプリの plan を開始する                         |
| `takosumi_capsule_destroy_plan`     | 既存のアプリの destroy plan を作り review で停止する   |
| `takosumi_run_get`                  | Run の状態と plan の要約を読む                         |
| `takosumi_run_approve`              | 確認済みの Run を承認する                              |
| `takosumi_run_apply`                | 承認済みの保存済み plan を apply する                  |

install-plan create には client が再試行でも維持する `idempotencyKey` が必須です。
`nextAction: reconcile` の間だけ reconcile を繰り返し、`review_run` になったら返された
Run を確認します。install-plan 自体は approve/apply しません。destroy-plan tool も
review 待ち Run を作るだけで、approve/apply は行いません。`list` と `get` は
読み取り専用です。`approve` と `apply` は変更を伴うため、MCP client は実行前に
利用者へ確認する必要があります。

tool の一覧と入力 schema は adapter が `tools/list` で返します。client 側に固定の
Takosumi tool catalog を持たせないでください。

## 認証と安全性

各 MCP request では、Takosumi が OAuth token、Interface、Binding、`mcp.invoke`
permission を確認します。token は MCP 自身のアプリ（Interface を持つ Capsule）を
示します。adapter が動くのは、token の利用者がいまそのアプリの所有者であるあいだ
だけで、対象もその利用者が所有するアプリ（そのアプリの install-plan、アプリが
できる前なら本人が始めた install、アプリ自体、そのアプリの Run）に限ります。
メンバーであるだけのアプリには MCP から届きません。MCP のアプリを他の人へ譲渡
したあとは何もできません。新しいアプリは `POST /api/v1/install-plans` で利用者の
個人の場所に入り、利用者が所有者になります。Workspace の route は使いません。

Interface token に Workspace が残っているあいだ（TASK-0118 の Phase 9.4 まで）は、
その Workspace を先に適用する制限として扱います。対象のアプリもその Workspace に
ある必要があり、新しいアプリがその外に入る install は断ります。Workspace が何かを
許可することはありません。

install-plan tool は公開 `/api/v1` の bounded request だけを転送します。variable 値、
credential、provider token、任意の control-plane path は受け付けません。Git credential
が必要な場合は、事前に作成した `authConnectionId` だけを参照します。

adapter は確認済みの利用者だけを、Workspace なしで既存の Takosumi API handler に
渡します。元の bearer token を Run、state、Output、audit、log へ保存しません。
利用者のアプリでの現在の役割、policy、plan 承認、保存済み plan の digest 検証も
そのまま適用されます。

`takosumi_run_apply` は MCP request から apply guard を上書きできません。server が
保存済み plan、state、provider connection をもう一度検証してから実行します。

## うまく接続できないとき

| 症状                              | 確認すること                                                                |
| --------------------------------- | --------------------------------------------------------------------------- |
| route が `404`                    | `TAKOSUMI_OPERATOR_CONTROL_MCP_ENABLED=1` が実行環境に反映されているか      |
| OAuth Binding が Ready にならない | Accounts issuer、公開 origin、module の `takosumi_origin` が一致しているか  |
| `401` / `403`                     | token の audience、`mcp.invoke` permission、利用者が MCP のアプリの所有者かを確認する |
| アプリや Run が見つからない       | 利用者が対象のアプリの所有者か（メンバーだけでは届かない）                  |
| tool が古い                       | client の固定一覧ではなく、接続先で `tools/list` を再取得する               |

運用ログへ bearer token や provider credential を出さないでください。
