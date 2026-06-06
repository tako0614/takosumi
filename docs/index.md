# Takosumi

Takosumi は **Space 直下の OpenTofu Installation DAG を管理する OSS control plane** です。ユーザーは任意の Git URL から Service を Space (`@handle`) にインストールし、Takosumi が plan / apply / destroy の実行記録、state 世代、outputs、Installation 間の依存 DAG、credential、audit trail を管理します。

OpenTofu の設定が resource definition です。Takosumi は別の設定形式で infrastructure を再定義しません。repo の Git URL、commit、module path、OpenTofu provider lock、`tofu plan`、`tofu output -json` から必要な情報を記録します。

## 何をするか

1. Operator が operator default connections (compute / dns / storage / source) を用意します。
2. User または dashboard が Git URL を Source として登録し、Space 直下に Installation を作ります (`@space/name`)。
3. Takosumi が plan Run を作り、SourceSnapshot と DependencySnapshot を固定し、plan JSON を policy 層 (provider / resource allowlist / action policy) で評価します。
4. 承認が必要な plan (destroy / destructive change) は approve を経て apply されます。apply は saved plan のみを実行し、plan digest / source snapshot / dependency snapshot / state generation を検証します。
5. 成功した apply は StateSnapshot 世代を進め、OutputSnapshot (spaceOutputs / publicOutputs、raw は暗号化 artifact) と Deployment を記録し、downstream Installation を stale にします。

## 何ではないか

Takosumi は OpenTofu の置き換えではありません。resource graph、provider schema、state operation、drift detection の正本は OpenTofu です。

Takosumi は provider adapter registry ではありません。どの provider を許可し、どの credential で実行するかは Connection + CapabilityBinding と policy 層、および operator が決めます。

Takosumi は 2 層 product ではありません。managed dashboard、account plane、control plane は同じ Takosumi distribution の operator-facing surface です。

## Public surface

| Concept | Meaning |
| --- | --- |
| Space | GitHub の user/org に近い owner namespace (`@handle`)。members / sources / connections / installations / dependency graph / policy / activity / optional billing を持つ |
| Source | 登録された Git repository。immutable な SourceSnapshot (commit 固定 + digest) を生む |
| Connection | 外部接続 (Git token / SSH key / Cloudflare token 等)。scope は operator / space。Installation は capability ごとに CapabilityBinding (default / connection / manual / disabled) で束ねる |
| Installation | Space 直下の OpenTofu root/state 単位 (`@space/name`)。InstallConfig (install type / trust / variable mapping / output allowlist / policy) が扱いを決める |
| Dependency | producer outputs → consumer inputs の DAG edge (variable_injection が標準)。plan 時に DependencySnapshot で固定 |
| Run | 1 回の実行 (source_sync / plan / apply / destroy_plan / destroy_apply)。RunGroup が DAG 順の一括更新を束ねる |
| Deployment | 成功した apply の ledger record (active → superseded / destroyed) |
| OutputSnapshot | apply 後の `tofu output -json` 世代。spaceOutputs / publicOutputs に projection、raw は暗号化 artifact |
| Activity | Space 単位の audit trail |

次に読む: [Quickstart](./getting-started/quickstart.md)
