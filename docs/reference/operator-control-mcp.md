# Operator control MCP adapter

Takosumi OSS には、Takos や別の MCP consumer から既存の public control
service を操作するための optional adapter があります。endpoint は
`/mcp/operator-control/v1`、Interface は通常の `mcp.server`、認可は通常の
Principal `InterfaceBinding` です。Takos 固定 tool や broad operator token を
配る別経路ではありません。

## Enable and install

stock platform worker では次を明示したときだけ route と service-side
InstallConfig が有効になります。

```text
TAKOSUMI_OPERATOR_CONTROL_MCP_ENABLED=1
TAKOSUMI_ACCOUNTS_ISSUER=https://<bare-operator-origin>
```

flag がない場合 route は `404` で、exact resource ownership proof も false
なので `oauth2` Binding は Ready になりません。host が
`TAKOSUMI_INSTALL_CONFIG_COMPOSITION` を独自 runtime object で完全置換する場合は、
`OPERATOR_CONTROL_MCP_INSTALL_CONFIG` も明示的にその配列へ追加します。これは
text env や Store metadata ではなく operator host-code composition です。

Capsule Source は普通の Git Source です。

```text
Git URL:     https://github.com/tako0614/takosumi.git
modulePath:  opentofu-modules/operator-control-mcp
variables:
  takosumi_origin = https://<bare-operator-origin>
```

module は credential-free な ordinary Output `endpoint` を返します。
`InstallConfig.interfaceBlueprints` が最初の successful apply 後に
`materializedFrom: capsule_blueprint` の Interface を作ります。この module は廃止済み
`takosumi/takosumi` provider に依存しません。Takoform の Interface descriptor は
Form Package から Form-backed Resource へ `form_descriptor` として materialize する別経路で、
この Capsule module の authoring path ではありません。

両方が収束する desired spec は次です。

```json
{
  "type": "mcp.server",
  "version": "2025-11-25",
  "document": {
    "transport": "streamable-http",
    "display": { "title": "Takosumi Operator Control" }
  },
  "inputs": {
    "endpoint": {
      "source": "capsule_output",
      "outputName": "endpoint"
    }
  },
  "access": {
    "visibility": "workspace",
    "resourceUriInput": "endpoint"
  }
}
```

Binding proposal は installing Principal への exact permission です。

```json
{
  "subject": { "source": "installing_principal" },
  "permissions": ["mcp.invoke"],
  "delivery": { "type": "oauth2" }
}
```

module code は Binding を作れません。host ownership authorizer が特別に
許可するのも、flag が有効で owner が Capsule のときの exact
`https://<operator-origin>/mcp/operator-control/v1` だけです。

## Invocation authority

全 MCP `POST` は body を処理する前に同じ platform verifier を通ります。

```text
Bearer invocation token
  -> authenticated Accounts /oauth/introspect
     (resource = exact /mcp/operator-control/v1 URL)
  -> Core revalidates current Interface + exact Ready Principal Binding
     + subject + mcp.invoke + resolvedRevision + Capsule owner lifecycle
  -> require token_use=interface_oauth, exact aud, one mcp.invoke scope,
     Workspace/Capsule/Interface/Binding/revision evidence
  -> strip raw bearer
  -> adapter authority { subject, introspected Workspace }
  -> existing public /api/v1 control dispatcher in-process
  -> existing Workspace owner/member RBAC, policy, saved-plan/apply guard,
     Run, StateVersion, Output, and AuditEvent authority
```

MCP argumentsに `workspaceId` はありません。Capsule/Run を受ける tool は
public dispatcher の RBAC に加えて、対象 ledger row の Workspace が introspection
Workspace と一致することを dispatch 前に確認します。したがって同じ Principal が
別 Workspace の member でも、その Binding から対象を広げられません。

raw Interface token は public control request、DB、Run、state、Output、audit、log
へ渡しません。`takosumi_run_apply` は reviewed plan idだけを public handlerへ渡し、
handler が saved-plan digest/state/provider-binding guard を server-side で再構築して
controller が再検証します。MCP arguments から apply guard を指定・上書きできません。

## Adapter-owned tools

tool catalog は versioned adapter route が MCP `tools/list` で返します。Takos の
static registry ではありません。

| Tool                     | Effect / annotation                              |
| ------------------------ | ------------------------------------------------ |
| `takosumi_capsules_list` | read-only                                        |
| `takosumi_capsule_plan`  | state side effect; not read-only, not idempotent |
| `takosumi_run_get`       | read-only                                        |
| `takosumi_run_approve`   | destructive/high-risk confirmation hint          |
| `takosumi_run_apply`     | destructive/high-risk confirmation hint          |

consumer は毎回 live `tools/list` を読みます。tool の追加・schema変更はこの adapter
version の責任であり、Takos の built-in tool contract ではありません。
