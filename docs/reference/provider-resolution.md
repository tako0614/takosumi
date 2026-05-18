# Provider Resolution

> このページでわかること: AppSpec component から provider
> を解決するアルゴリズム。

AppSpec component から concrete deployment plan を生成する **provider
resolution** のアルゴリズムを定義します。AppSpec の `components.<name>.kind` と
optional provider hint を元に、operator policy / provider registry
が何を決めるかを明確にします。

## 1. Principle

`components.<name>.kind` が semantic contract です。provider hint は authoring
intent / placement hint であり、 component kind の意味を決める必須 field
ではありません。

provider resolution は次の問いに答える operator-controlled decision です。

```text
この Space で、この AppSpec component を、どの ProviderPlugin / runtime-agent
implementation で materialize するか。
```

kernel は provider を推測しません。 kernel は catalog / provider registry /
operator policy の入力を使って resolution を実行し、 結果を Deployment evidence
と audit に残します。

## 2. Inputs

Resolution input は次に閉じます。

- `componentName` — AppSpec component name (例: `web`)
- `kind` — component の semantic contract (例: `worker`)
- `spec` — component kind validator 済み desired state (例: `{ build, routes }`)
- `requires[]` — provider capability constraint (例: `["presigned-urls"]`)
- `providerHint` — optional authoring hint (例: `@takos/cloudflare-workers`)
- `spaceId` — Space catalog / policy の lookup key (例: `space_acme_prod`)
- `runtimeMode` — AppInstallation 経由の場合の mode (例: `shared-cell`)
- `catalogRelease` — component kind / provider release pin (digest / release id)
- `operatorPolicy` — placement / region / quota / compliance rule (policy pack
  id + version)
- `costContext` — cost estimate と admission gate (plan / quota / billing
  account)
- `trustContext` — adopted release / implementation trust state (catalog digest
  pin state)

consumer manifest に endpoint URL、 service import、 anchor URL、 operator
hostname は書きません。 OIDC / billing / dashboard / deploy API は namespace
export / account API / OIDC discovery / BillingPort で扱います。

## 3. Output

Resolution output は `ResolvedProviderDecision` として Deployment evidence
に残す。

```ts
interface ResolvedProviderDecision {
  readonly resourceName: string;
  readonly kind: string;
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

`reason` は人間が説明できる短い根拠です。 例:

```text
kind worker supported
requires js-bundle and edge-routes satisfied
space policy prefers cloudflare-workers in shared-cell
catalog release digest sha256:... verified
```

`constraints` は今後の drift / rollback / audit で再評価できる machine-readable
条件です。 `risks` は approval UI / policy decision に出す warning または error
です。

## 4. Algorithm

Resolution は fail-closed です。

1. AppSpec envelope / component schema を validate する。
2. Space に adopted な CatalogRelease を読む。
3. CatalogRelease の sha256 が operator-pinned `CATALOG_DIGEST` と一致することを
   verify する (publisher signing ではなく digest pin。 詳細は
   [Supply Chain Trust § 6](./supply-chain-trust.md#6-catalog-release-trust))。
4. `kind` を実装する provider candidates を provider registry から列挙する。
5. `requires[]` と provider capability を照合する。
6. `providerHint` がある場合は candidates をその provider に絞る。
7. operator policy で Space / runtime mode / region / quota / compliance を
   評価する。
8. 1 件に決まれば `ResolvedProviderDecision` を記録する。
9. 0 件なら reject。 複数件で priority が決まらなければ reject。

operator policy は deterministic でなければなりません。 同じ input digest に
対して別 provider を返す policy は invalid です。 policy を変える場合は policy
pack version を上げ、 Deployment evidence に新旧の decision を残します。

## 5. Failure Modes

- provider が component kind を実装しない: reject
- `requires[]` を満たせない: reject
- provider hint が Space policy で禁止: reject
- candidates が 0 件: reject
- candidates が複数で priority 不定: reject
- CatalogRelease trust failure: reject before side effect
- cost / quota / compliance gate failure: reject または approval-required risk

dev fallback は production で使ってはいけません。 production mode で必要な
catalog / provider registry / policy pack が無い場合は fail-closed です。

## 6. Audit

次の値は Deployment evidence / audit に残します。

- input manifest digest
- component name / kind / optional provider hint
- selected provider id / implementation id
- CatalogRelease digest
- policy pack id / version
- decision reason / constraints / risks
- actor / Space / timestamp

provider resolution は service discovery ではありません。 endpoint URL を audit
して provider を信頼する仕組みではなく、 catalog と policy に基づく placement
decision を記録する仕組みです。

## 7. Non Goals

- consumer manifest の endpoint URL 記述
- endpoint discovery による provider switching
- operator policy による component kind semantics の変更

Component kind の意味は contract package / component kind catalog が持ち、
provider resolution はその kind をどこでどう実装するかだけを決めます。
