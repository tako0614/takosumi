# Managed Offering ローンチ準備

> このページでわかること: 本 `takosumi` operator 実装で Takos を public managed service として提供するための operator evidence チェックリスト。

Takos / Takosumi の product 境界はここでは再定義しません。 Takos は AI-first chat / agent product、 Takosumi は platform substrate、 `takosumi` は reference なアカウント管理 / dashboard / billing owner / ownership ledger を package する置換可能な operator 実装です。

## スコープ

root completion roadmap の local gate は repository / CI 相当の readiness を確認するもので、 public paid managed Takos service を販売・運用する安全性を証明しません。 launch readiness には ecosystem ROADMAP の Managed Takos Offering gap audit に対する live operator evidence が必要です。

各 rehearsal の evidence は tenant data / secret / provider account ID / legal material を含むため、 public source control の外、 operator 所有の場所に記録してください。 public docs にはサニタイズ済みサマリーへのリンクのみ載せます。 customer-facing な launch scope / SKU / support / onboarding / billing / export wording の draft は [`managed-offering-customer-boundary.md`](./managed-offering-customer-boundary.md) に置きます。この draft は `offering-definition` / `customer-operations` evidence の入力であり、operator/support/legal sign-off や live rehearsal の代替ではありません。

## Evidence ルール

- 各行に日付つき evidence record / environment / owner / reviewer / pass-fail 結果を残す
- screenshot は supporting evidence。 primary evidence としては command transcript、 signed artifact、 immutable image digest、 event ID、 dashboard URL、 runbook link を優先する
- dry-run は明示的に許容された行を除き live evidence にはならない
- green local gate は production の rollback / DR / billing / support rehearsal の代替ではない
- 全 P0 行と少なくとも 1 回の staged launch rehearsal を完了するまで public managed readiness は宣言しない

evidence record に含めるもの:

- 日付 / 環境 / operator owner / reviewer
- command transcript / event ID / artifact digest / dashboard URL / runbook link
- 各 step の pass-fail 結果と、失敗時の follow-up issue
- private record に tenant data / provider ID / secret / billing detail / legal material が含まれるときは public summary をサニタイズして添える

まず `takos-private` から fail-closed な skeleton を生成する:

```bash
cd ../takos-private
bun run managed-offering:workspace -- --environment staging --date YYYY-MM-DD
```

`managed-offering:workspace` は下層で `takosumi launch-readiness template` と production-topology template を呼び、 `.managed-readiness/<env>/` に readiness bundle と staging / production topology skeleton を作成します。template は全 P0 domain / staged rehearsal step の `requiredEvidenceTypes` ごとに evidence entry を展開し、必要な structured field、 `private: true`、`publicSummary` placeholder を含めます。operator は空欄・placeholder を live evidence の `ref` / `summary` / `publicSummary` / structured field に置き換えてから `status: "passed"` にします。各 evidence type の collection source、実行する route / probe / dashboard export、private artifact ref、required structured fields、pass criteria、public redaction rule は [`managed-offering-evidence-collection-matrix.md`](./managed-offering-evidence-collection-matrix.md) に従います。

最終 evidence bundle は `takos-private` wrapper で検証する:

```bash
cd ../takos-private
bun run managed-offering:validate -- --environment staging --date YYYY-MM-DD
```

下層の fail-closed validator は `takosumi launch-readiness validate --file <json>` です。public signup 前の operator runbook では wrapper を使い、default private paths と topology / summary / audit handoff を同じ規約に揃えます。

public docs に載せる summary は raw bundle から手で抜き出さず、validator 結果から public-safe JSON または Markdown row を生成する:

```bash
cd ../takos-private
bun run managed-offering:public-summary -- \
  --environment staging \
  --date YYYY-MM-DD \
  --evidence-ref vault://managed-readiness/staging/rehearsal.json \
  --public-summary "P0 evidence and one staged launch rehearsal passed; operator approval remains separate."
```

`managed-offering:public-summary` は下層の `takosumi launch-readiness public-summary` を呼び、private evidence ref を scheme class (`vault://...` など) だけに丸め、canonical `evidenceDigest`、 opaque `rehearsalRun.id`、validator status、sanitized public summary だけを出力します。Markdown row が必要な場合は、生成済み JSON を validation した後に下層 CLI の `--markdown-row` を使います。validator-ready な bundle で `--evidence-ref` がない場合、または summary に email address / Stripe object ID / API key / bearer token / provider account ID / internal resource ID が残っている場合は失敗します。

JSON summary を保存する場合は、公開前に同じ private bundle に対して再検証します:

```bash
cd ../takos-private
bun run managed-offering:public-summary:validate -- --environment staging --date YYYY-MM-DD
```

この validation は下層の `takosumi launch-readiness public-summary validate` を呼び、 `evidenceDigest`、ready state、missing / incomplete domain and rehearsal arrays、 `rehearsalRun.id`、environment、completed date、redaction-sensitive string を照合します。

`accounts serve` は managed offering access を default `closed` として扱う。 public signup / new access / install / paid surfaces (`/start`, `/dashboard/use-takos`, core OAuth authorize/token, personal access token create, installation dry-run/apply/import, deployment/materialize/export access mutations, install/deployment 内の OIDC client / permission scope materialization, status ready/reopen patch (ready or installing), dashboard approval, dashboard deployment operations, launch-token creation/consume, upstream OAuth authorize/callback, passkey register/authenticate, Stripe checkout) を開く production-like operator surface では、まず final live audit を `takos-private` から実行し、同じ readiness bundle / digest / evidence ref / approval ref / public summary で Accounts open access の dry-run を通す:

Cloudflare Worker distribution は `accounts serve` の argv ではなく Worker env vars で同じ gate を開きます。 public signup を開く場合は live audit output の `accountsServeManagedOfferingArgs` から readiness digest / evidence ref / approval ref / public summary をそのまま対応する `TAKOSUMI_ACCOUNTS_MANAGED_OFFERING_*` env vars に移し替え、手で別値を作らないでください。Worker は `open` 時に `TAKOSUMI_ACCOUNTS_ISSUER` とこれらの値を必須にし、 placeholder ref / reused evidence+approval ref / sensitive or underspecified public summary を fail-closed にします。

```bash
cd ../takos-private
bun run managed-offering:audit -- \
  --environment staging \
  --date YYYY-MM-DD \
  --evidence-ref vault://managed-readiness/staging/rehearsal.json \
  --approval-ref approval://managed-readiness/staging/operator-approval.json
```

audit output の `accountsServeManagedOfferingArgs` を、operator 固有の `takosumi accounts serve` 設定または Cloudflare Worker env 設定に追加して起動します。digest や public summary を手で転記し直さないでください。

`--managed-offering-evidence-ref` は `evidence://...`、`todo`、`TBD`、 `dummy`、`fake`、`changeme`、`example.com` を含む placeholder を受け付けません。 `--managed-offering-approval-ref` も同じ placeholder を受け付けず、public signup または paid access を開く separate operator approval の証跡を指す必要があります。 `--managed-offering-readiness-digest` は private bundle の canonical digest と一致しなければ通りません。 `--managed-offering-public-summary` も短すぎる文字列や placeholder では通らず、 P0 evidence と staged launch rehearsal status の両方を public-safe に説明する必要があります。email address、Stripe object ID (`cus_...` / `sub_...` / `in_...` / `pi_...` / `pm_...` / `price_...` / `prod_...` / `cs_...` / `evt_...` / `re_...` / `cn_...` など)、Stripe API key (`sk_live_...` / `sk_test_...`)、bearer token 風の文字列、provider account ID、internal resource ID を含む summary は redaction 失敗として拒否します。

production topology evidence は static preflight で最低形を確認できます。これは live health probe の実行ではなく、manifest / artifact digest / migration transcript / health probe ref / TLS evidence / rollback target が揃っているか、 component `id` / `role` が重複していないか、`rollbackTarget.role` が deployable component role かつ declared component role を指しているか、component entry が object であるか、`owner` と `reviewer` が同じ self-review でないかを弾く補助 gate です。Accounts component は `runtime:"cloudflare-worker"`、 `containerRuntime:false`、`D1:TAKOSUMI_ACCOUNTS_DB` / `R2:TAKOSUMI_ACCOUNTS_EXPORTS` bindings、wrangler config evidence ref を持つ必要があります。

Cloudflare Accounts の DNS/TLS / health probe evidence は、Workers.dev bootstrap だけでは通しません。`takosumi` の `deploy:accounts-cloudflare:ensure-dns -- --check --fail-on-not-ready` で live `accounts.takosumi.com` proxied CNAME を確認し、 `deploy:accounts-cloudflare:probe -- --fail-on-not-ready` で custom-domain `/healthz` と OIDC issuer を確認した JSON を private artifact に保存してから、topology の `dns-tls` / `healthProbeEvidenceRef` / `wranglerConfigRef` に紐づけます。

preflight input の shape は `managed-offering:workspace` が作成した `production-topology-staging-YYYY-MM-DD.json` と `production-topology-production-YYYY-MM-DD.json` を埋めます。個別に再作成する場合も `takos-private` workspace wrapper を使います。

```bash
cd ../takos-private
bun run managed-offering:topology:preflight -- \
  --environment staging \
  --topology-environment staging \
  --date YYYY-MM-DD

bun run managed-offering:topology:preflight -- \
  --environment staging \
  --topology-environment production \
  --date YYYY-MM-DD
```

preflight が pass すると `production-topology` domain に貼り付けられる structured evidence entry を返します。staging と production は別々に preflight し、最終 readiness bundle には両方の environment-specific evidence type (`staging-*` と `production-*`) を含めます。各 service の実 probe 結果や provider 側証跡は、 private evidence store に別途保存してください。 final validator でも production topology evidence は generic な `runbook://...` 参照だけでは通りません。preflight が返す `topologyEnvironment`, `componentCount`, `deployableComponentCount`, `artifactDigestEvidenceRef`, `healthProbeEvidenceRef`, `healthProbeCount`, `rollbackRole`, `artifactDigest`, rollback evidence digest などの structured fields を保持してください。current wire では一部の private evidence digest/ref field が `artifactDigest*` 名を持ちますが、 reader-facing には managed-offering private evidence digest/ref として扱います。 Takosumi DataAsset digest や prepared source digest とは別です。health probe の aggregate evidence も `topology://...` のような synthetic ref ではなく、 operator-owned private evidence ref に紐づけます。 `production-topology` domain entry は staging と production の両方を含むため、`environment: "staging+production"` で記録します。古い private topology skeleton が現行テンプレートの field を欠く場合は、 `takos-private` の managed-offering launch rehearsal runbook に従い、 live evidence を上書きしない `managed-offering:workspace:refresh-template` で readiness / topology の missing template field だけを補完します。

High-risk structured fields include `bundledAppInstallationIds`, `permissionDigest`, and `permissionScopeDigest`.

staging / production の preflight report は手で合成せず、merge gate を通して final domain entry を作ります:

```bash
cd ../takos-private
bun run managed-offering:topology:merge -- --environment staging --date YYYY-MM-DD
```

下層の `takosumi launch-readiness production-topology preflight` / `production-topology merge` は、`--staging-report` と `--production-report` の両方の preflight report が ready であること、environment が staging / production に分かれていること、staging / production の owner が一致し、 reviewer も一致し、かつ owner と reviewer は異なること、required evidence type が揃っていることを確認し、`environment: "staging+production"` の domain entry を返します。

`takos-private` の read-only `managed-offering:status` は、下層 report の `ready: true` だけで public openability と扱いません。期待する report kind、 `production-topology` evidence entry、staging / production の environment、 required evidence type、非 placeholder の evidence ref、wrapper provenance、 source input / preflight report の sha256 digest 一致まで確認した `acceptedReady: true` を staging preflight、production preflight、merge のすべてに要求します。preflight input や preflight report を差し替えた後は、対応する preflight / merge command を `--force` で再実行してください。 blocked status output は直列の `nextCommand` に加えて `blockingSummary` を返し、 topology entry では `topologyBlockers` に provenance / digest / evidence type / evidence ref のどれが未達かを machine-readable に載せます。 `missingEvidenceTypes` は `sourcePath` / `sourceReports` に追加すべき topology evidence type の機械可読 TODO です。

validator は全 P0 domain と staged rehearsal step が `status: "passed"`、非空の `owner` / `environment` / `reviewer`、 calendar-valid な ISO-8601 UTC timestamp (`YYYY-MM-DDTHH:mm:ssZ` または millisecond 付き) で parse 可能かつ future ではない `completedAt`、 1 件以上の structured evidence reference (`type` / `ref` / `summary`) を持つまで fail-close する。 private evidence reference には短すぎず placeholder ではない sanitized `publicSummary` も必要です。 `summary` 自体も短すぎる `todo` / `TBD` / `dummy` / `fake` / `changeme` では通らず、同じ `type` を複数回入れた ambiguous な evidence record も拒否します。 template の `requiredEvidenceTypes` は各 P0 domain / rehearsal step が minimum で要求する evidence type です。 `status: "passed"` にする場合、その type をすべて evidence 配列に含めます。`requiredEvidenceTypes` 以外の unknown evidence type も拒否します。補足情報は任意 type を足さず、既存 required type の structured field、`summary`、または private `ref` に紐づけてください。summary には email address、Stripe object ID、API key、bearer token を含めないでください。 `reviewer` は `owner` と同じ値では通りません。実施者本人だけの self-approval は launch evidence として扱わず、validator も fail-close します。 domain evidence の `environment` は `staging` / `production` / `staging+production`、 staged rehearsal の `rehearsalRun.environment` と各 step は `staging` または `production` だけを受け付けます。 staged rehearsal は top-level `rehearsalRun` を持ち、各 rehearsal step と `evidence[]` の `runId` / `environment` が同じ run を指し、`completedAt` が run window 内かつ checklist 順に厳密に増加する必要があります。同時刻の step は順序証跡として扱いません。異なる日・環境で集めた step や、後続 step だけを先に通した記録を 1 回の end-to-end rehearsal として扱ってはいけません。

`billing-entitlement` の evidence は generic な `runbook://...` 参照だけでは通りません。`stripe-sandbox` / `stripe-live` は `mode`, `checkoutSessionId`, `webhookEventId` を持ち、 checkout session は `cs_test_...` / `cs_live_...`、 webhook event は `evt_...` の invoice reference でなければなりません。 `invoice` は `in_...` の `invoiceId` と `status`、 `failed-payment` は `in_...` の `invoiceId` と `evt_...` の `webhookEventId`、`plan-transition` は `sub_...` の `subscriptionId` / `fromPlan` / `toPlan`、`refund-credit` は `accountId` と `re_...` の `refundId` または `cn_...` の `creditNoteId`、 `usage-aggregation-policy` は billing window を示す `policyRef` / `windowStart` / `windowEnd` を持つ必要があります。これらは operator private record の中身を public repo に置くためではなく、証跡 bundle が実際の billing rehearsal に紐づくことを validator が機械的に確認するための最小 shape です。

`oidc-account-security` の high-risk evidence では OIDC conformance と signing-key rotation に加えて、client-secret rotation の `oldSecretId` / `newSecretId` / `overlapWindowSeconds` / `revocationEventId` を private bundle に入れてください。 `backup-dr` / `release-provenance` / `security-operations` の high-risk evidence も type 名だけでは通りません。restore transcript は `restoreRunId` と `transcriptRef`、DR simulation は `simulationRunId`、RPO/RTO は `rpoSeconds` / `rtoSeconds`、restore target smoke は `restoreTargetId` / `smokeRunId`、release evidence は `ciRunId`、`sbomRef`、`signatureRef`、`imageDigest`、 `packageVersion`、`exportRef`、`immutabilityRef`、`rollbackRunId`、 security evidence は `threatModelRef`、`reviewId`、`policyRef`、`inventoryRef`、 `rotationRunId`、`contactTestId`、`blockEventId` などの structured fields を private bundle に入れてください。

staged rehearsal step の evidence も type 名だけでは通りません。fresh signup は `accountId` / `spaceId` / email assurance の `assuranceMethod` / `verifiedAt` / team membership の `membershipRole` / `membershipEventId` / `termsVersion`、Use Takos launch は `installationId` / `launchTokenJti` / `sessionId` に加えて `bundledInstallationIds` と default app uninstall/reinstall の event id、Git URL install は `sourceIdentity`、`expected.planSnapshotDigest`、operator approval evidence / cost review / `oidcClientId` / event hash、quota drill は `meter` / `cap` / per-plan quota / spend cap / LLM・tool cap / noisy-tenant throttle / deploy kill switch / abuse queue review / `overrideEventId`、 shared-cell drill は `tenantCount >= 2`、2 tenant の `tenantAInstallationId` / `tenantBInstallationId`、same `runtimeCellId`、`isolationCheckId`、 per-installation metrics、materialize は readiness-before-cutover / `materializeOperationId` / private runtime target evidence ref / domain preservation / continuity evidence の `sourceIdentity` / `oidcClientId` / `domainName` / `dataPartition` / `capabilityGrantDigest` / `noDataLossCheckId`、export/import は `exportId` / `archiveDigest` / `importId` / post-import login / source retention state と `dataClasses` が `chat` / `memory` / `file` / `git` / `default-app` を含むこと、backup restore は `restoreTargetId` / target smoke result、SEV は `incidentId` / `alertId` / mitigation event / status update / postmortem / action item、privacy は `requestId` / retention record、billing operation は `invoice-paid` と `failed-payment` の `in_...` invoice / `evt_...` webhook、`dunningRunId` / suspension event、 recovery event と `re_...` refund または `cn_...` credit note evidence を private bundle に入れてください。

structured evidence の field shape も validator が確認します。`*Digest` / `*Hash` は `sha256:<64 hex>`、`commitSha` は 40 桁 hex、`sourceIdentity` は `{ kind: "git", commit, url?, ref? }` または `{ kind: "prepared", sourceDigest }` の union です。prepared の `sourceDigest` は Cloud evidence projection field name で、Installer-computed prepared archive payload digest を指します。`*Url` は HTTPS URL かつ `example.test` / `example.invalid` / `<placeholder>` を含まない具体 URL、 `*Ref` は `evidence://todo` や `example.com` を含まない具体 evidence reference、その他の string structured field も `accountId` / `eventId` などの `<placeholder>` や `example.test` / `example.invalid` を含む値では通りません。 `quantity` / `cap` / `tenantCount` / RPO / RTO 秒は正の数値でなければなりません。 `completedAt` / `reviewedAt` / `verifiedAt` と billing window (`windowStart` / `windowEnd`) は future ではない calendar-valid な ISO-8601 UTC timestamp で、billing window は `windowEnd > windowStart` です。 staged rehearsal step 内では、関連 evidence の account / installation / incident / release candidate / invoice reference が同じ対象を指す必要があります。例えば `fresh-signup` の account、`git-url-install` の installation、 `billing-operation` の failed-payment と dunning invoice は混在できません。

Validator vocabulary:

- ambiguous な evidence record: 同じ `type` の重複 record は拒否する。
- `requiredEvidenceTypes` 以外: unknown evidence type は拒否する。
- string structured field: placeholder / example domain / dummy value は拒否する。

成功を表す structured field は成功値も validator が確認します。例えば `invoice.status` は `paid`、`ci-equivalent.conclusion` は `success`、 `sandbox-review.decision` は `accepted`、`isolation-test.result` / `isolation-proof.result` / `clean-import.result` / `sar-delete-rehearsal.result` は `passed`、quota / guard action は `blocked` / `suspended` / `queued` のいずれかでなければ pass しません。

抜粋 JSON shape:

> validator を通すには `launch-readiness template` が出す全 P0 domain と全 rehearsal step を埋める必要があります。以下は 1 domain / 1 step の shape 例です。

```json
{
  "kind": "takosumi.managed-offering-readiness@v1",
  "rehearsalRun": {
    "id": "rehearsal-2026-05-13-staging",
    "environment": "staging",
    "owner": "ops",
    "reviewer": "release-owner",
    "startedAt": "2026-05-13T00:00:00Z",
    "completedAt": "2026-05-13T02:00:00Z"
  },
  "domains": [
    {
      "id": "offering-definition",
      "requiredEvidenceTypes": ["launch-brief", "operator-signoff"],
      "status": "passed",
      "owner": "ops",
      "environment": "staging",
      "reviewer": "release-owner",
      "completedAt": "2026-05-13T00:00:00Z",
      "evidence": [
        {
          "type": "launch-brief",
          "ref": "runbook://launch-brief",
          "summary": "SKU, quota, billing meter, support tier, and accepted-use scope were approved.",
          "private": true,
          "publicSummary": "Launch scope, quota, billing meter, and support tier were reviewed for staging."
        },
        {
          "type": "operator-signoff",
          "ref": "signoff://operator/launch-brief",
          "summary": "Operator approved the launch scope and support boundary.",
          "private": true,
          "publicSummary": "Operator approval was recorded for the launch scope and support boundary."
        }
      ]
    }
  ],
  "rehearsal": [
    {
      "id": "fresh-signup",
      "runId": "rehearsal-2026-05-13-staging",
      "requiredEvidenceTypes": [
        "signup-event",
        "email-assurance",
        "team-membership",
        "terms-acceptance",
        "entitlement-event"
      ],
      "status": "passed",
      "owner": "ops",
      "environment": "staging",
      "reviewer": "release-owner",
      "completedAt": "2026-05-13T00:00:00Z",
      "evidence": [
        {
          "type": "signup-event",
          "ref": "event://signup-smoke",
          "eventId": "signup-event-staging-001",
          "accountId": "account-staging-fresh-001",
          "spaceId": "space-staging-fresh-001",
          "summary": "Fresh customer signup reached account, space, terms, and entitlement creation.",
          "private": true,
          "publicSummary": "Fresh signup reached account, space, terms, and entitlement creation in staging."
        },
        {
          "type": "email-assurance",
          "ref": "event://email-assurance",
          "accountId": "account-staging-fresh-001",
          "assuranceMethod": "email-verified",
          "verifiedAt": "2026-05-13T00:10:00Z",
          "summary": "Email assurance was recorded for the rehearsal account.",
          "private": true,
          "publicSummary": "Email assurance was recorded during the staging rehearsal."
        },
        {
          "type": "team-membership",
          "ref": "event://team-membership",
          "accountId": "account-staging-fresh-001",
          "spaceId": "space-staging-fresh-001",
          "membershipRole": "owner",
          "membershipEventId": "membership-event-staging-001",
          "summary": "Team membership was recorded for the rehearsal account and space.",
          "private": true,
          "publicSummary": "Team membership was recorded during the staging rehearsal."
        },
        {
          "type": "terms-acceptance",
          "ref": "event://terms-accepted",
          "eventId": "terms-event-staging-001",
          "accountId": "account-staging-fresh-001",
          "termsVersion": "terms-2026-05",
          "summary": "Terms acceptance was recorded for the rehearsal account.",
          "private": true,
          "publicSummary": "Terms acceptance was recorded during the staging rehearsal."
        },
        {
          "type": "entitlement-event",
          "ref": "event://entitlement-created",
          "eventId": "entitlement-event-staging-001",
          "accountId": "account-staging-fresh-001",
          "entitlementId": "entitlement-staging-free-001",
          "summary": "Free-plan or checkout entitlement was recorded for the rehearsal account.",
          "private": true,
          "publicSummary": "Entitlement creation was recorded during the staging rehearsal."
        }
      ]
    }
  ]
}
```

## P0 Evidence Matrix

| ID                               | ドメイン                  | public signup 開始までに必要な evidence                                                                                                                                                                                                                 |
| -------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `offering-definition`            | Offering 定義             | target user / SKU / quota / meter / support tier / accepted-use 境界 / beta label / free-trial policy を mapping した launch brief                                                                                                                      |
| `production-topology`            | 本番 topology             | immutable private deployment evidence artifact digest / schema migration transcript / health probe / TLS evidence / rollback target を staging と production の両環境で記録                                                                             |
| `oidc-account-security`          | OIDC / account security   | OIDC conformance smoke / signing-key rotation drill / client-secret rotation drill / passkey browser e2e / CSRF・rate-limit evidence / audit event sample                                                                                               |
| `signup-tenant-lifecycle`        | signup / tenant lifecycle | fresh user が signup から email assurance / team membership / Space 作成 / 利用規約同意 (`terms_version` + `terms_accepted=true` が Accounts record に永続化されること) / Use Takos launch / bundled app install / suspend / recover まで到達する smoke |
| `billing-entitlement`            | Billing / entitlement     | Stripe sandbox + live mode で checkout / webhook / entitlement projection / usage meter / aggregation policy / tax / invoice / plan transition / failed payment / dunning / refund-credit / suspend-recover を rehearsal                                |
| `quota-abuse-spend-control`      | Quota / abuse / spend     | per-plan cap / spend cap / deploy・tool・LLM throttle・block / operator override / audit trail を確認する spike drill                                                                                                                                   |
| `shared-cell-production-runtime` | Shared-cell production    | 2 tenant の shared-cell load test (`tenantAInstallationId` / `tenantBInstallationId` / same `runtimeCellId` / `tenantCount >= 2`)、 isolation breach test、 per-installation metric label、 scale-out / drain event、 evacuation record                 |
| `dedicated-materialize`          | Dedicated materialize     | shared-cell から dedicated への drill で readiness / cutover / rollback と、 OIDC・domain・data・`capabilityGrantDigest`・`noDataLossCheckId`・resolved source identity の preserve 検証                                                                |
| `export-self-host-sovereignty`   | Export / self-host        | staging から clean self-host target への encrypted export、 login + `dataClasses` による chat / memory / file / Git / default-app data 検証                                                                                                             |
| `backup-dr`                      | Backup / DR               | アカウント管理 / Takos product / Takosumi restore transcript と RPO・RTO サンプル、 audit-chain 検証                                                                                                                                                    |
| `observability-slo-on-call`      | Observability / SLO       | dashboard / alert routing / synthetic signup・login・install・launch・export probe / status update workflow / staging SEV-1 drill                                                                                                                       |
| `release-provenance`             | Release / provenance      | CI 相当 (or hosted) green record、 SBOM、 signature、 image digest、 package version、 branch protection export、 rollback drill                                                                                                                        |
| `security-operations`            | Security operations       | threat model、 installer sandbox review、 WAF / rate limit、 vulnerability SLA、 secret inventory、 emergency rotation、 security contact                                                                                                               |
| `legal-privacy-support`          | Legal / privacy / support | 利用規約 / Privacy Policy / DPA の legal review、 support・security mailbox test、 SAR・export・delete rehearsal、 billing-support process                                                                                                              |
| `customer-operations`            | Customer operations       | onboarding guide / admin guide / billing FAQ / self-host export guide / escalation matrix / suspension・delete・export 顧客文言                                                                                                                         |

## Required Staged Rehearsal

少なくとも 1 回、 end-to-end の staged rehearsal を実施し、 evidence ID を記録してください。

1. `fresh-signup`: fresh customer signup → email assurance → team membership → 利用規約同意→ Takosumi Account / Space 作成→ checkout または free-plan entitlement
2. `use-takos-launch`: Use Takos → launch token consume → Takos session → bundled app auto-install → default app uninstall / reinstall
3. `git-url-install`: Git URL installation dry-run → binding / policy / cost review → apply → installed app への OIDC login → Installation event hash chain の可視化
4. `quota-abuse-drill`: quota / abuse drill → usage / spend 超過→ guard が block / suspend → operator override / recovery を audit
5. `shared-cell-load`: shared-cell load drill → 1 warm cell に 2 tenant → isolation と per-installation metric 検証→ scale-out / drain event
6. `dedicated-materialize`: shared-cell → dedicated materialize → readiness / cutover → final cutover 前の rollback → OIDC / domain / data の preserve evidence
7. `export-self-host-import`: encrypted export → clean self-host import → login と sample data 検証→ source account retention 状態の記録
8. `backup-restore`: backup restore → isolated staging recovery → restore target smoke → audit chain 検証→ RPO / RTO サンプル
9. `sev-simulation`: SEV simulation → alert → ack → status update → mitigation → postmortem と action item
10. `release-rollback`: release promotion →新バージョン deploy → previous healthy image / artifact に rollback → release announcement / support note
11. `privacy-operation`: privacy operation → account export / delete 要求→ login 無効化 / data export → retention exception record
12. `billing-operation`: billing operation → invoice paid → failed payment → dunning / suspension → recovery / refund / credit path

## 表現

OK:

- 「local Takos and Takosumi gates are complete against the completion roadmap」
- 「`takosumi` has an account-plane MVP and the contracts needed to build a managed Takos offering」
- 「Managed offering readiness remains open until the P0 evidence matrix and staged rehearsal are complete」

NG:

- 「`takosumi` can safely provide public paid Takos today」
- 「A green local `check:all` proves managed service launch readiness」
- 「Removed Takos-owned surfaces require a customer carry-over plan」
