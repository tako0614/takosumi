# Local-substrate smoke TODO

Remaining items after the Takosumi-only slim (2026-05-17). Each needs either upstream product work or a coordination call (out of scope of the Takosumi test bed itself).

## 筆頭: yurucommu / bundled-app の Takosumi-install 経路 (FOLLOW-UP TO SLIM)

Takosumi-only 化に伴い `yurucommu-a` / `yurucommu-b` の直起動 + federation smoke (federation-smoke.sh / federation-follow.sh) を削除した。結果として **federation を再 verify するには「Takosumi が yurucommu を install して miniflare 上で 2 instance 動かす」形に組み直すしかない**。

必要な infra:

1. **`@takos/local-miniflare-workers` connector** — `factories/local-substrate-factories.ts` に register。 source fixture の `worker` component spec を受けて miniflare instance を spawn し、source fixture が要求する D1 / R2 / KV / Queue / DO binding を動的 allocate する。現状 hand-rolled な `takosumi-worker` / `takosumi-service-worker` と同じ pattern を generic 化する。
2. **prepared source pipeline** — yurucommu / takos-app の repo に対して build service / CI が通常の package scripts を実行し、build 後の source tree を `source.kind: prepared` として installer に渡す。connector は build command を起動しない。
3. **installer-mock の本物化** — 今は fixture JSON を返してるだけ。本物の Takosumi service の installer dry-run に寄せて connector の解決パスを通す。
4. **federation 復活 smoke** — `yurucommu install x2 → allocated subdomain x2
   → Follow→Accept poll` を新 federation-follow.sh で実現。

### 詳細実装計画 (drafted 2026-05-18)

既存 worker kind implementations:

- `takosumi/docs/kinds/v1/worker.jsonld` — portable worker descriptor
- operator-owned Cloudflare Workers native binding
- operator-owned deploy-target native binding

native binding は operator-owned execution binding として実装し、必要な lifecycle client は DI できる (= mock 化容易)。

**必要な新規 module + 工数見積もり**:

| Sub-task                               | 内容                                                                                                                                                                                                                                                                                        |                 工数 |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------: |
| (1) `local-miniflare-worker` kind 実装 | `packages/kind-local-miniflare-worker/` 新規: `MiniflareLifecycleClient` impl — prepared source の `spec.entrypoint` を読み、miniflare subprocess を spawn + component `spec` の D1/R2/KV/Queue/DO bindings を flag 解釈 + Caddy admin API で `<scriptName>.app.takosumi.test` route 追加。 |                 4-6h |
| (2) factory wire                       | local-substrate bootstrap で operator-owned local implementation を wire する。 local mode (= TAKOSUMI_DEV_MODE=1) なら Cloudflare Workers kind の代わりに local-miniflare kind を使う。                                                           |                   1h |
| (3) installer-mock の本物化            | 現状 `installer-mock/main.ts` は fixture JSON 返すだけ。 service installer dry-run を呼ぶ shim に refactor、または Accounts 側の dry-run contract を `/v1/installations/dry-run` と統合                                                                                                      |                 2-4h |
| (4) prepared source pipeline (簡易版)  | yurucommu repo で通常の package scripts を事前に実行し、生成済み source tree を prepared source snapshot として pin する shim service は follow-up                                                                                                                                          |                 1-2h |
| (5) federation 復活 smoke              | 新 `scripts/yurucommu-install-federation.sh`: yurucommu source fixture を 2 つ複製 (metadata.id + route 差別化) → POST /v1/installations x 2 → allocated subdomain 2 個取得 → 旧 federation-follow.sh のロジックで Follow → Accept poll                                                            |                 2-3h |
| **計**                                 |                                                                                                                                                                                                                                                                                             | **10-16h = 1-2 day** |

session 内 complete は非現実的なため deferred。着手時はこの sub-plan をコピーして個別 PR にする (1 PR = 1 sub-task)。着手順は `(2) → (1) → (4) →
(3) → (5)` を推奨 (factory が一番先、 smoke が一番後)。これが landed したら yurucommu の federation 系 2 smoke を新 architecture で復活させる (= test bed が「Takosumi 1 個」を verify するための 1 example として yurucommu install が走る形)。

## Takos product side test bed (separate, owned by takos repo) — PLACEHOLDER

Takosumi-only 化に伴い `takos-app` / `takos-git` の直起動 + `phase1.app.health` / `prod-mirror.takos.*` / `private.lint` 系 smoke を削除した。

Takos product 側の integration test 責務は分離した:

- 各 product の **ユニット / Playwright / vitest** は対応 repo 内で従来通り動く (今回の slim で touch していない)
- **「Takos product as a whole が動く」 integration test** が必要なら takos repo 自身が独立 test bed (`takos/deploy/<name>/`) を持つべき。 Takosumi 側はこれを再現する責務を負わない (= identity 分離)

cross-link placeholder: 将来 takos repo 側で integration test bed ができたら、ここから link を貼る (現状 entry なし)。

yurucommu / road-to-me / takos-apps 同様の方針 (= 各 product owner が持つ)。

## Workers-profile service — LANDED (local Miniflare smoke as of 2026-05-17)

`takosumi/deploy/cloudflare/` is the Worker-first service scaffold. It bundles `deploy/cloudflare/src/worker.ts`, runs the service in-process through `createTakosumiService`, persists service snapshots / installer records in D1, and can store optional DataAsset objects in R2. It has no Cloudflare Container binding.

The local-substrate now runs that same bundle under Miniflare:

1. `takosumi-service-worker-build` bundles `takosumi/deploy/cloudflare/src/worker.ts`.
2. `takosumi-service-worker` serves it at `service-worker.takosumi.test` during the default postgres-profile smoke so the Bun+Postgres service remains available at `service.takosumi.test` for side-by-side parity checks.
3. `service-workers` is the replacement workers-profile service, aliasing itself as `service` when `--profile workers` is selected.
4. `scripts/workers-cli-smoke.sh` now verifies both workerd code paths: the Accounts Worker on D1/R2 and the Takosumi service Worker on D1/R2/Queue/DO (`/healthz`, `/__takosumi/exports/*` signature rejection, `/storage/healthz`, `/coordination/healthz`, `/queue/test`, and `/health`). It uses `service-worker.takosumi.test` for the postgres-profile mirror and `service.takosumi.test` for the workers profile.

## Tenant isolation — LANDED (smoke strict as of 2026-05-17)

`scripts/tenant-isolation.sh` runs in strict mode (subject B's cross-read of subject A's installation must be non-200). The upstream fix lives in `takosumi/packages/accounts-service/src/installation-routes.ts` — `handleGetAppInstallation` + `handleListAppInstallations` now go through `requireAccountSession()` + `subjectCanAccessAccount()` (see `account-session.ts`). CI runs the strict smoke directly, so any regression back to the open behavior is a hard FAIL.

## ActivityPub Follow → Accept federation smoke — RETIRED (slim 2026-05-17)

旧 `scripts/federation-smoke.sh` + `scripts/federation-follow.sh` は yurucommu-a / yurucommu-b の compose 直起動と一緒に削除済み。過去 once LANDED していた full Follow → Accept smoke は git history ( `yurucommu local-substrate-only` 系 commit) から参照可能。

復活 path は上記「筆頭: yurucommu / bundled-app の Takosumi-install 経路」の通り、 Takosumi-install 化が前提。

## brand-tokens JSR package (D13)

Today `takos/website/src/styles/{tokens,global}.css` is a 691-line fork of `takosumi/website/src/styles/global.css`. They will drift. The right fix is a small JSR package `@takos/brand-tokens` shipping:

- `tokens.css` — colors / typography / spacing / radii
- `components/{GeometricMark,InkdropMark,Wordmark}.tsx` — framework- agnostic mark + wordmark components

Then both takos/website and takosumi/website import from JSR. Out of scope of the test bed (publishing a new JSR scope + coordination with takosumi/website + landing PRs across multiple repos).

## smoke.d/ full split (D17 — partial, EVALUATED + SKIPPED 2026-05-18)

scripts/smoke.sh has a `run_script <label> <cmd>` helper that captures stdout+stderr to `$SMOKE_LOG_DIR/<label>.log` on failure. CI uploads that dir as a CI log bundle. The helper is plumbed into ~all stanzas now (OAuth replay, workers, registrar, MinIO, migrations, OTel, k6, mailpit, Stripe, installer API, docs link check, tenant isolation).

Refactoring smoke.sh stanzas into per-file `scripts/smoke.d/*.sh` with auto- discovery was evaluated and **skipped**: log capture already works, smoke.sh is ~440 lines and readable, and a per-file split adds boilerplate (one wrapper per stanza) without functional benefit. Revisit only if smoke.sh grows past ~700 lines or per-stanza CI parallelism becomes needed.

## wrangler dev --remote

Closer-to-prod test against real Cloudflare bindings (KV / DO / Queues / D1). Requires:

- Cloudflare account credentials (CLOUDFLARE_API_TOKEN env)
- `wrangler-staging.toml` separate from production
- Staging-only D1 / KV / DO namespaces

Add as a separate `scripts/wrangler-remote-smoke.sh` that's opt-in (not in the default smoke run) and reads creds from the user's keychain or 1Password CLI.

Today's miniflare-based cloud worker smoke catches the _code_ path; this would catch the _infrastructure_ path (binding semantics that miniflare emulates imperfectly: Queue ordering, DO single-instance guarantees, KV eventual consistency).
