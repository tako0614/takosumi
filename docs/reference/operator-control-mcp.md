# MCP から Takosumi を操作する

Operator control MCP adapter を使うと、Takos や別の MCP client から Takosumi の
Capsule と Run を操作できます。できるのは Capsule の一覧、plan、Run の確認、承認、
apply です。

この adapter は任意機能です。Takos 専用の tool を組み込むのではなく、通常の
`mcp.server` Interface として `/mcp/operator-control/v1` に公開します。client は
MCP の `tools/list` から、その endpoint が提供する tool を読み取ります。

## 前提条件

- Takosumi Accounts と dashboard が動いている
- 外から到達できる HTTPS の Takosumi origin がある
- operator が MCP adapter を有効にできる
- 利用者が対象 Workspace の member である

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

dashboard の Add service で次を指定します。

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

| Tool                     | 用途                                  |
| ------------------------ | ------------------------------------- |
| `takosumi_capsules_list` | Capsule の一覧を読む                  |
| `takosumi_capsule_plan`  | Capsule の plan を開始する            |
| `takosumi_run_get`       | Run の状態と plan の要約を読む        |
| `takosumi_run_approve`   | 確認済みの Run を承認する             |
| `takosumi_run_apply`     | 承認済みの保存済み plan を apply する |

`list` と `get` は読み取り専用です。`plan` は Run を作成します。`approve` と `apply`
は変更を伴うため、MCP client は実行前に利用者へ確認する必要があります。

tool の一覧と入力 schema は adapter が `tools/list` で返します。client 側に固定の
Takosumi tool catalog を持たせないでください。

## 認証と安全性

各 MCP request では、Takosumi が OAuth token、Interface、Binding、Workspace、
`mcp.invoke` permission を確認します。Capsule と Run も同じ Workspace に属している
必要があります。

adapter は確認済みの Workspace と利用者情報だけを既存の Takosumi API handler に渡します。
元の bearer token を Run、state、Output、audit、log へ保存しません。通常の Workspace
role、policy、plan 承認、保存済み plan の digest 検証もそのまま適用されます。

`takosumi_run_apply` は MCP request から apply guard を上書きできません。server が
保存済み plan、state、provider connection をもう一度検証してから実行します。

## うまく接続できないとき

| 症状                              | 確認すること                                                                |
| --------------------------------- | --------------------------------------------------------------------------- |
| route が `404`                    | `TAKOSUMI_OPERATOR_CONTROL_MCP_ENABLED=1` が実行環境に反映されているか      |
| OAuth Binding が Ready にならない | Accounts issuer、公開 origin、module の `takosumi_origin` が一致しているか  |
| `401` / `403`                     | token の audience、`mcp.invoke` permission、Workspace membership を確認する |
| Capsule や Run が見つからない     | Binding と対象が同じ Workspace にあるか                                     |
| tool が古い                       | client の固定一覧ではなく、接続先で `tools/list` を再取得する               |

運用ログへ bearer token や provider credential を出さないでください。
