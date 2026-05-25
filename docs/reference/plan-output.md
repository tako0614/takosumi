# Plan 出力 {#plan-output}

Dry-run response is Takosumi's preview surface. It returns the planned change set and expected source guards directly to the caller.

正本: [Installer API](./installer-api.md) の dry-run endpoint。

- `POST /v1/installations/dry-run` —新規 install の dry-run
- `POST /v1/installations/{id}/deployments/dry-run` — upgrade の dry-run

response には `changes[]` (= create / update / delete の予定変更) と、 `expected.commit` または `expected.sourceDigest`、`expected.manifestDigest` (= reviewed-source guard) が含まれます。既存 Installation の deploy dry-run では `expected.currentDeploymentId` も含まれ、apply 時に base current pointer を guard します。Cost estimate や billing quote は operator account layer response として扱います。

Risk サマリー、approval プロンプト、prediction digest、approval token はこの preview を囲む operator/account layer の拡張です。これらは operator フィールドまたは account layer record を通じて運ばれ、core manifest のフィールドは追加しません。

apply で実際に起きたことは [Deployment](./installer-api.md#entity-fields) record として恒久保存されます。

## Compatibility note

Takosumi v1 は preview を response shape として保持し、独立した Plan entity は作りません。
