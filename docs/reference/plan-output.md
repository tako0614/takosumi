# Plan 出力 {#plan-output}

Dry-run response is Takosumi's preview surface. It returns the planned change set and expected source guards directly to the caller.

正本: [Installer API](./installer-api.md) の dry-run endpoint。

- `POST /v1/installations/dry-run` —新規 install の dry-run
- `POST /v1/installations/{id}/deployments/dry-run` — upgrade の dry-run

response には `InstallPlan` snapshot、`changes[]` (= 予定変更)、`planSnapshotDigest`、source identity guard (`expected.commit` または `expected.sourceDigest`) が含まれます。既存 Installation の deploy dry-run では `expected.currentDeploymentId` も含まれ、apply 時に base current pointer を guard します。Cost estimate や billing quote は operator account layer response として扱います。

> **実装状況 (reference kernel)**: 現状の reference apply pipeline は dry-run plan
> を **observed/prior state との diff を取らず**、すべての resource を `create`
> として列挙します (destroy dry-run のみ reverse DAG order の `delete`)。 つまり
> 無変更の Installation を再 apply しても dry-run は全 resource を `create` と表示し、
> `update` / `no-op` 分類はまだ surface しません。これは observed-state probe
> が未実装なためで、 [known-gaps](./known-gaps.md) に tracked されています。

Risk サマリー、approval プロンプト、prediction digest、approval token はこの preview を囲む operator/account layer の拡張です。これらは operator フィールドまたは account layer record を通じて運ばれ、Takosumi core の Source surface には追加しません。

apply で実際に起きたことは [Deployment](./installer-api.md#entity-fields) record として恒久保存されます。

## Compatibility note

Takosumi v1 は preview を response shape として保持し、独立した Plan entity は作りません。
