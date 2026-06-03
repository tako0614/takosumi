# Takosumi

Takosumi は OpenTofu module を預かり、plan / apply / destroy の実行記録、Deployment 台帳、公開可能な output を管理する deploy control plane です。

OpenTofu の設定が resource definition です。Takosumi は別の設定形式で infrastructure を再定義しません。repo の Git URL、commit、module path、OpenTofu provider lock、`tofu plan`、`tofu output -json` から必要な情報を記録します。

## 何をするか

1. Operator が RunnerProfile を用意します。
2. User または dashboard が OpenTofu module repo を Installation として登録します。
3. Takosumi が PlanRun を作り、provider policy、source digest、variables digest、plan digest を記録します。
4. Review 済み PlanRun から ApplyRun を作ります。apply request は PlanRun の digest と一致しないと通りません。
5. 成功した apply は Deployment になり、非 secret output だけが DeploymentOutput として公開されます。

## 何ではないか

Takosumi は OpenTofu の置き換えではありません。resource graph、provider schema、state operation、drift detection の正本は OpenTofu です。

Takosumi は provider adapter registry ではありません。どの provider を許可し、どの credential / state backend / runner image で実行するかは RunnerProfile と operator が決めます。

Takosumi は 2 層 product ではありません。managed dashboard、account plane、deploy facade は同じ Takosumi distribution の operator-facing surface です。

## Public v1 surface

| Concept | Meaning |
| --- | --- |
| Installation | Space 内に install された OpenTofu module repo と current Deployment pointer |
| PlanRun | `tofu plan` の試行、policy decision、plan digest、source / variables digest |
| ApplyRun | `tofu apply` または destroy の試行、state backend、lock evidence、audit events |
| Deployment | 成功した apply の ledger record |
| DeploymentOutput | successful apply から得た非 secret output |
| RunnerProfile | provider allowlist、credential refs、state backend、runner substrate、resource / network policy、tenant runtime boundary、secret exposure policy |

次に読む: [Quickstart](./getting-started/quickstart.md)
