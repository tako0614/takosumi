# Provider Resolution

このページは Shape manifest を concrete deployment plan に落とす **provider resolution**
の正本仕様です。`resources[].provider` を optional hint にした以上、operator policy / provider registry
が何を決めるのかをここで 固定します。

## 1. Principle

`resources[].shape` が semantic contract です。`resources[].provider` は authoring intent / placement hint であり、Shape
の意味を決める必須 field では ありません。

provider resolution は次の問いに答える operator-controlled decision です。

```text
この Space で、この Shape resource を、どの ProviderPlugin / runtime-agent
implementation で materialize するか。
```

kernel は provider を推測しません。kernel は catalog / provider registry / operator policy の入力を使って resolution
を実行し、結果を Deployment evidence と audit に残します。

## 2. Inputs

Resolution input は次に閉じます。

| Input            | 例                             | 説明                                         |
| ---------------- | ------------------------------ | -------------------------------------------- |
| `shape`          | `worker@v1`                    | resource の semantic contract                |
| `spec`           | `{ artifact, routes }`         | shape validator 済み desired state           |
| `requires[]`     | `["presigned-urls"]`           | provider capability constraint               |
| `providerHint`   | `@takos/cloudflare-workers`    | optional authoring hint                      |
| `spaceId`        | `space_acme_prod`              | Space catalog / policy の lookup key         |
| `runtimeMode`    | `shared-cell`                  | AppInstallation 経由の場合の mode            |
| `catalogRelease` | digest / release id            | shape / provider / template release pin      |
| `operatorPolicy` | policy pack id + version       | placement / region / quota / compliance rule |
| `costContext`    | plan / quota / billing account | cost estimate と admission gate              |
| `trustContext`   | catalog signature state        | adopted release / implementation trust state |

consumer manifest に endpoint URL、service import、anchor URL、operator hostname は 書きません。OIDC / billing /
dashboard / deploy API は namespace export / account API / OIDC discovery / BillingPort で扱います。

## 3. Output

Resolution output は `ResolvedProviderDecision` として Deployment evidence に残す。

```ts
interface ResolvedProviderDecision {
  readonly resourceName: string;
  readonly shape: string;
  readonly providerId: string;
  readonly implementationId: string;
  readonly catalogReleaseDigest: string;
  readonly policyPackId: string;
  readonly policyPackVersion: string;
  readonly reason: readonly string[];
  readonly constraints: readonly string[];
  readonly risks: readonly string[];
  readonly decidedAt: string;
}
```

`reason` は人間が説明できる短い根拠です。例:

```text
shape worker@v1 supported
requires js-bundle and edge-routes satisfied
space policy prefers cloudflare-workers in shared-cell
catalog release digest sha256:... verified
```

`constraints` は今後の drift / rollback / audit で再評価できる machine-readable 条件です。`risks` は approval UI /
policy decision に出す warning または error です。

## 4. Algorithm

Resolution は fail-closed です。

1. envelope / resource schema を validate する。
2. Space に adopted な CatalogRelease を読む。
3. CatalogRelease signature と publisher key state を verify する。
4. `shape` を実装する provider candidates を provider registry から列挙する。
5. `requires[]` と provider capability を照合する。
6. `providerHint` がある場合は candidates をその provider に絞る。
7. operator policy で Space / runtime mode / region / quota / compliance を評価する。
8. 1 件に決まれば `ResolvedProviderDecision` を記録する。
9. 0 件なら reject。複数件で priority が決まらなければ reject。

operator policy は deterministic でなければなりません。同じ input digest に対して 別 provider を返す policy は invalid
です。policy を変える場合は policy pack version を上げ、Deployment evidence に新旧の decision を残します。

## 5. Failure Modes

| Failure                                | 結果                             |
| -------------------------------------- | -------------------------------- |
| provider が shape を実装しない         | reject                           |
| `requires[]` を満たせない              | reject                           |
| provider hint が Space policy で禁止   | reject                           |
| candidates が 0 件                     | reject                           |
| candidates が複数で priority 不定      | reject                           |
| CatalogRelease trust failure           | reject before side effect        |
| cost / quota / compliance gate failure | reject or approval-required risk |

dev fallback は production で使ってはいけません。production mode で必要な catalog / provider registry / policy pack
が無い場合は fail-closed です。

## 6. Audit

次の値は Deployment evidence / audit に残します。

- input manifest digest
- resource name / shape / optional provider hint
- selected provider id / implementation id
- CatalogRelease digest
- policy pack id / version
- decision reason / constraints / risks
- actor / Space / timestamp

provider resolution は service discovery ではありません。endpoint URL を audit して provider
を信頼する仕組みではなく、catalog と policy に基づく placement decision を記録する仕組みです。

## 7. Non Goals

- consumer manifest の endpoint URL 記述
- endpoint discovery による provider switching
- operator policy による shape semantics の変更

Shape の意味は Shape descriptor / contract package / JSON-LD context が持ち、 provider resolution はその Shape
をどこでどう実装するかだけを決めます。
