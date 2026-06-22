# Secret Rotation Runbook

> このページでわかること: Takosumi operated environment で secret を rotation する実行手順。
> cadence / 監査要件 / 責任範囲は [Secret Rotation Policy](secret-rotation-policy.md) を正本とする。

## Scope

この runbook は operator が repo 外の approved vault に保持する secret を対象にする。secret 値、token body、
private key、provider credential JSON、rotation evidence は public repo に commit しない。

operator が直接 push する Worker secret は Takosumi platform worker
(`app.takosumi.com`) のものだけです。Workspace connection の secret は
Takosumi vault / SecretBlob を通して rotate し、通常の GET API に raw value を
返しません。

Provider 対応が Cloudflare から AWS / GCP / GitHub / Kubernetes / Custom Provider
Connection へ広がっても、provider credential を raw Worker env として増やさない。
Provider credential は ProviderConnection / SecretBlob を rotate する。
`AWS_ACCESS_KEY_ID` や `GOOGLE_APPLICATION_CREDENTIALS` のような
provider-specific credential 名は runner の ambient env として常駐させず、credential
mint が run / phase / provider scoped な material に変換して generated root へ渡す。

## Before Rotation

1. 対象 environment、secret class、影響する Workspace / Capsule / ProviderConnection / backing Connection を特定する。
2. [Secret Rotation Policy](secret-rotation-policy.md) の cadence、authorized role、maintenance window を確認する。
3. current secret の参照先が repo 外の operator vault にあり、rollback 用に保持できることを確認する。
4. rotation 中に触る API / CLI / provider dashboard の audit trail が有効であることを確認する。
5. 対象 Provider Connection がどの CredentialRecipe / provider policy に属するか、OAuth helper / user-managed credential policy /
   egress policy / custom runner class に影響するかを確認する。provider policy は credential ではないため、token rotation
   では通常変更しない。

## Rotation Steps

1. 新しい secret を provider または operator vault で発行する。
2. Takosumi の internal provider resolver / SecretBlob / Worker secret など、対象 class に応じた参照先を新 secret に更新する。
3. 可能な class では grace window を取り、old secret と new secret の併用を許可する。
4. 対象 route、runner phase、Connection test、または smoke test で new secret の動作を確認する。
5. old secret を revoke する。grace window が必要な class では window 終了後に revoke する。
6. operator audit log に secret class、environment、実施者、開始/終了時刻、old/new secret ref、検証結果を記録する。

## Platform Worker Secret Push

platform worker の realized config は private repo が所有する:

```bash
export TAKOSUMI_PRIVATE=/path/to/takosumi-private
export TAKOSUMI_ENV=staging        # or production
export TAKOSUMI_WRANGLER_CONFIG="$TAKOSUMI_PRIVATE/platform/wrangler.toml"
export TAKOSUMI_SECRETS="$TAKOSUMI_PRIVATE/.secrets/$TAKOSUMI_ENV"
```

secret file は 1 secret 1 file、mode `0600` にする。

```bash
test -f "$TAKOSUMI_WRANGLER_CONFIG"
test -d "$TAKOSUMI_SECRETS"
find "$TAKOSUMI_SECRETS" -maxdepth 1 -type f -exec sh -c 'test "$(stat -c %a "$1")" = 600' sh {} \;
```

local vault と remote Worker secret 名を確認する:

```bash
takosumi secrets status \
  --config "$TAKOSUMI_WRANGLER_CONFIG" \
  --secrets-dir "$TAKOSUMI_SECRETS"
```

`TAKOSUMI_DEPLOY_CONTROL_TOKEN` は現行実装の env 名です。operations docs では
これを public API concept ではなく、platform worker 内の accounts/control-plane
bearer secret class として扱います。値は operator vault にだけ置きます。
Cloud-only AI Gateway extension 用の `TAKOSUMI_AI_GATEWAY_PROFILES` が env または wrangler config `[vars]`
にある場合、
`takosumi secrets status` は profile の `apiKeyEnv` が指す upstream provider
secret 名も不足検出します。

### Upstream OAuth sign-in secret

Google OAuth provider を hosted Takosumi sign-in に使う場合、
client id と redirect URI は realized wrangler config の `[vars]` に置き、client secret
だけを operator vault の file に置く。secret 値を shell history や transcript に残さない。

Google の例:

```bash
grep -E 'TAKOSUMI_ACCOUNTS_UPSTREAM_GOOGLE_(CLIENT_ID|REDIRECT_URI)' \
  "$TAKOSUMI_WRANGLER_CONFIG"

# operator-private vault に値を置く。helper は secret 値を出力せず、
# realized config の redirect URI も検証する。
bun run write:takosumi-oauth-secret -- \
  --private-root "$TAKOSUMI_PRIVATE" \
  --environment "$TAKOSUMI_ENV" \
  --provider google \
  --edit
```

設定後は sign-in scope だけを先に確認する:

```bash
bun run check:takosumi-live-evidence-prereqs -- \
  --private-root "$TAKOSUMI_PRIVATE" \
  --environment "$TAKOSUMI_ENV" \
  --scope sign-in

takosumi secrets status \
  --config "$TAKOSUMI_WRANGLER_CONFIG" \
  --secrets-dir "$TAKOSUMI_SECRETS"
```

`status:takosumi-completion -- --scope sign-in` は最終 completion audit も集約するため、
readiness summary の next action も同時に表示される。OAuth secret / config だけの
確認には上記の `check:takosumi-live-evidence-prereqs -- --scope sign-in` を使う。

Worker secret を適用する:

```bash
takosumi secrets apply \
  --config "$TAKOSUMI_WRANGLER_CONFIG" \
  --secrets-dir "$TAKOSUMI_SECRETS"
```

`apply` は不足している rotate-safe generated secret を local vault に作ってから
`wrangler secret put` の標準入力で push する。既存の OIDC signing key、
secret-store passphrase、pairwise secret、provider credential は上書きしない。
upstream OAuth client secret は manual protected secret なので自動生成しない。
初回 vault 作成で protected key も生成する場合だけ、operator approval 後に
`--init-protected` を付ける。remote push せず local vault だけ初期化する場合は
`--local-only` を併用する。

```bash
takosumi secrets apply \
  --config "$TAKOSUMI_WRANGLER_CONFIG" \
  --secrets-dir "$TAKOSUMI_SECRETS" \
  --init-protected \
  --local-only
```

safe generated secret を個別に再生成する場合だけ `--regenerate` を使う:

```bash
takosumi secrets apply \
  --config "$TAKOSUMI_WRANGLER_CONFIG" \
  --secrets-dir "$TAKOSUMI_SECRETS" \
  --regenerate TAKOSUMI_DEPLOY_CONTROL_TOKEN
takosumi secrets apply \
  --config "$TAKOSUMI_WRANGLER_CONFIG" \
  --secrets-dir "$TAKOSUMI_SECRETS" \
  --regenerate TAKOSUMI_ACCOUNTS_EXPORT_DOWNLOAD_SECRET
```

remote-only secret は自動削除しない。削除は `takosumi secrets status` で drift
を確認した後に operator が明示的に `wrangler secret delete` で行う。

Provider credential rotation は Worker secret push ではなく Connection 更新として
行う。新 credential を repo 外の file に置き、CLI で新 Connection を作成し、
必要な provider default を新 Connection へ向ける。

```bash
export TAKOSUMI_DEPLOY_CONTROL_URL=https://app.takosumi.com
export TAKOSUMI_DEPLOY_CONTROL_TOKEN="$(cat "$TAKOSUMI_SECRETS/TAKOSUMI_DEPLOY_CONTROL_TOKEN")"

takosumi connections set-cloudflare-token \
  --api-token-file "$TAKOSUMI_PRIVATE/.secrets/provider/cloudflare-api-token.next" \
  --default cloudflare

takosumi connections test <new-connection-id>
takosumi connections revoke <old-connection-id>
```

bulk helper を使う場合も、一時 JSON は `/tmp` など repo 外に作成し、push 後に
即削除する。shell history、terminal transcript、PR comment に secret value を
残さない。

## Platform Worker Smoke

Worker secret rotation 後は最低限以下を確認する:

```bash
curl -fsS https://app.takosumi.com/healthz
curl -fsS https://app.takosumi.com/.well-known/openid-configuration | head -c 200
curl -fsS https://app.takosumi.com/oauth/jwks >/dev/null
curl -s -o /dev/null -w "%{http_code}" https://app.takosumi.com/api/v1/spaces
```

expected:

- OIDC issuer は `https://app.takosumi.com`
- JWKS が 200
- unauthenticated `/api/v1/spaces` は 401
- accounts/control-plane bearer or handshake token を rotate した場合は dashboard login
  と `/api/v1` session-gated route が通る
- provider / source Connection を rotate した場合は staging の Connection test と
  source_sync / plan smoke が通る

## Verification

- Public API が raw secret を返さないこと。
- plan / apply / destroy phase の credential mint が expected Connection から成功すること。
- source phase の Git credential が provider credential と混ざらないこと。
- logs が token body や private key material を含まないこと。
- affected Capsule の next plan/apply が saved plan / source snapshot / dependency snapshot / state generation guard を維持すること。

## Rollback

1. new secret による認証失敗を確認したら、old secret の revoke 前なら参照先を old secret ref に戻す。
2. revoke 済みの場合は provider で emergency replacement を発行し、new secret と同じ手順で参照先を更新する。
3. Worker secret の場合は operator vault の previous value を `takosumi secrets apply` で再 push する。
4. rollback 後も audit log に原因、復旧時刻、残タスクを記録する。

## Related Documents

- [Secret Rotation Policy](secret-rotation-policy.md)
- [Troubleshooting Playbook](troubleshooting.md)
- [Incident Response](incident-response.md)
