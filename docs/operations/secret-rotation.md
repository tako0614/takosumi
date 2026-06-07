# Secret Rotation Runbook

> このページでわかること: Takosumi operated environment で secret を rotation する実行手順。
> cadence / 監査要件 / 責任範囲は [Secret Rotation Policy](secret-rotation-policy.md) を正本とする。

## Scope

この runbook は operator が repo 外の approved vault に保持する secret を対象にする。secret 値、token body、
private key、provider credential JSON、rotation evidence は public repo に commit しない。

operator が直接 push する Worker secret は Takosumi platform worker
(`app.takosumi.com`) のものだけです。Space connection の secret は
Takosumi vault / SecretBlob を通して rotate し、通常の GET API に raw value を
返しません。

## Before Rotation

1. 対象 environment、secret class、影響する Space / Installation / Connection を特定する。
2. [Secret Rotation Policy](secret-rotation-policy.md) の cadence、authorized role、maintenance window を確認する。
3. current secret の参照先が repo 外の operator vault にあり、rollback 用に保持できることを確認する。
4. rotation 中に触る API / CLI / provider dashboard の audit trail が有効であることを確認する。

## Rotation Steps

1. 新しい secret を provider または operator vault で発行する。
2. Takosumi の Connection / SecretBlob / Worker secret など、対象 class に応じた参照先を新 secret に更新する。
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

non-interactive shell では必ず `--value-file` を使う:

```bash
export TAKOSUMI_CONTROL_PLANE_BEARER_SECRET_NAME=TAKOSUMI_DEPLOY_CONTROL_TOKEN

bunx wrangler secret put "$TAKOSUMI_CONTROL_PLANE_BEARER_SECRET_NAME" \
  --config "$TAKOSUMI_WRANGLER_CONFIG" \
  --value-file "$TAKOSUMI_SECRETS/$TAKOSUMI_CONTROL_PLANE_BEARER_SECRET_NAME"
```

`TAKOSUMI_DEPLOY_CONTROL_TOKEN` は現行実装の env 名です。operations docs では
これを public API concept ではなく、platform worker 内の accounts/control-plane
bearer secret class として扱います。値は operator vault にだけ置きます。

bulk helper を使う場合も、一時 JSON は `/tmp` など repo 外に作成し、push 後に
即削除する。shell history、terminal transcript、PR comment に secret value を
残さない。

## Platform Worker Smoke

Worker secret rotation 後は最低限以下を確認する:

```bash
curl -fsS https://app.takosumi.com/healthz
curl -fsS https://app.takosumi.com/.well-known/openid-configuration | head -c 200
curl -fsS https://app.takosumi.com/oauth/jwks >/dev/null
curl -s -o /dev/null -w "%{http_code}" https://app.takosumi.com/api/spaces
```

expected:

- OIDC issuer は `https://app.takosumi.com`
- JWKS が 200
- unauthenticated `/api/spaces` は 401
- accounts/control-plane bearer or handshake token を rotate した場合は dashboard login
  と `/api` session-gated route が通る
- provider / source Connection を rotate した場合は staging の Connection test と
  source_sync / plan smoke が通る

## Verification

- Public API が raw secret を返さないこと。
- plan / apply / destroy phase の credential mint が expected Connection から成功すること。
- source phase の Git credential が provider credential と混ざらないこと。
- logs が token body や private key material を含まないこと。
- affected Installation の next plan/apply が saved plan / source snapshot / dependency snapshot / state generation guard を維持すること。

## Rollback

1. new secret による認証失敗を確認したら、old secret の revoke 前なら参照先を old secret ref に戻す。
2. revoke 済みの場合は provider で emergency replacement を発行し、new secret と同じ手順で参照先を更新する。
3. Worker secret の場合は operator vault の previous value を `--value-file` で再 push する。
4. rollback 後も audit log に原因、復旧時刻、残タスクを記録する。

## Related Documents

- [Secret Rotation Policy](secret-rotation-policy.md)
- [Troubleshooting Playbook](troubleshooting.md)
- [Incident Response](incident-response.md)
