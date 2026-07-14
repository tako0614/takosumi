# Operations: Retired Resource State Adoption

> このページでわかること: backing Capsule を使っていた旧 Resource Shape 実装の
> encrypted OpenTofu state を、現在の Resource-owned Run/state scope へ明示的に
> 1 回だけ引き継ぐ手順と fail-closed 条件。

現在の module-backed Resource は Resource 自身を Run subject とし、Resource record が
最新の encrypted-state pointer と public outputs を所有します。通常の preview / apply /
delete は Capsule、InstallConfig、Source、StateVersion、Capsule Output を作成・検索しません。

この runbook の migration は retired backing-Capsule 実装を使用した既存環境だけが対象です。
通常実行の fallback ではなく、operator が候補を確認して確定する one-shot operation です。

## Preconditions

- control DB migration `resources.legacy_state_adoption.add` (Postgres) または
  `d1_resource_legacy_state_adoption_add` (D1) が適用済み
- 旧 Capsule ledger と、その `currentStateVersionId` が指す encrypted R2 state object が
  読み取り可能
- 対象 Resource に Resource-owned `execution` がまだ存在しない
- trusted control process から internal deploy-control seam を呼べる

local node-postgres runner は legacy R2 object-store state を読めないため、この adoption を
実行しません。対象 environment は R2 state reader を持つ runner で apply します。

## 1. Generate A Read-only Report

trusted control process から、operator authorization を付けて次を呼びます。この route は
edge-public customer API ではありません。

```text
GET /internal/v1/workspaces/{workspaceId}/migrations/resource-state-adoption
```

report は Resource ごとに `candidates` または `issues` を返しますが、DB / R2 を変更しません。
candidate になるのは次の全条件が一致する場合だけです。

- retired implementation と同じ deterministic Capsule name
- exact Workspace、environment、retired internal install-config identity
- Capsule の current StateVersion と state owner fields が一致
- state object key が旧 deterministic R2 key と完全一致
- 同じ Resource に current execution / pending adoption がない

0 件は「移行不要」または exact legacy record 不在です。複数候補、destroyed Capsule、欠落
StateVersion、不正 object key は `issues` になり、自動選択されません。

## 2. Review And Confirm One Exact Candidate

operator は report と R2 object inventory を照合し、対象 Resource / Capsule /
StateVersion / digest が意図した旧 state であることを確認します。確認後、report の candidate
fields を変更せず同じ internal route へ POST します。

```json
{
  "resourceId": "tkrn:workspace-id:default:ResourceKind:resource-name",
  "resourceUpdatedAt": "2026-07-13T00:00:00.000Z",
  "expectedLegacyCapsuleName": "rs-resource-kind-resource-name-abcdefg",
  "capsuleId": "cap_legacy",
  "stateVersionId": "sv_legacy",
  "stateGeneration": 3,
  "stateRef": "artifact:reviewed-legacy-state",
  "stateDigest": "sha256:reviewed-digest"
}
```

```text
POST /internal/v1/workspaces/{workspaceId}/migrations/resource-state-adoption
```

server は candidate report を再生成し、全 field と Resource `updatedAt` を比較してから
timestamp-fenced write を行います。candidate が変わった、別 operator が先に確定した、Resource
execution が既にある場合は失敗します。request body に state bytes や credential は含めません。

## 3. Apply Once And Verify Consumption

通常の Resource preview で plan を確認し、同じ Resource を apply します。runner は次の順序を
fail closed で実行します。

1. canonical Resource state scope を確認する。既存 state があれば adoption を拒否する。
2. descriptor が指す exact legacy key だけを読み、generation / digest / Workspace を照合する。
3. その state を初期 state として plan/apply する。
4. 成功した state を canonical Resource scope に次 generation として保存する。
5. Resource record に execution pointer を保存した後だけ adoption descriptor を削除する。

apply が失敗した場合、descriptor は pending のまま残り、暗黙に別 Capsule / StateVersion を探しません。
runner が state 保存後に応答を失った retry は同じ Run identity で完了を再採用します。成功確認後は
以下を記録します。

- successful Resource Run id
- canonical Resource state generation / object key / digest
- Resource record に `execution` があり、`stateAdoption` がないこと
- plan が意図しない create / replace / destroy を含まなかったこと
- operator confirmation と apply の audit evidence

旧 Capsule / StateVersion rows と旧 R2 object の削除はこの operation の一部ではありません。
retention、backup、rollback window を確認した後の別の destructive migration として扱います。

## Abort Conditions

次のいずれかなら confirm / apply を止め、新しい report と evidence review からやり直します。

- report が ambiguous / missing / invalid pointer を返す
- report 後に Resource または legacy StateVersion が変わった
- canonical Resource state が既に存在する
- digest / generation / Workspace が一致しない
- runner が legacy R2 state reader を持たない
- preview に意図しない destructive change がある

候補を手作業で補正したり object key を推測したりしてはいけません。exact candidate が得られない
場合は state adoption ではなく、provider-native import または明示的な再作成計画を選びます。
