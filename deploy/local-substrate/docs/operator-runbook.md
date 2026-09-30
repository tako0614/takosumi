# Operator runbook

## Incident-only local Accounts reauthentication (Postgres profile)

`scripts/local-accounts-reauth.ts` is an offline, local-substrate-only path for
invalidating opaque Accounts credentials after a local credential incident. It
is **not** a general administrator API, production key-rotation tool, schema
migration, or D1/Workers-profile tool. Renewing an ES256 signing key alone does
not invalidate persisted session cookies, PATs, OAuth access/refresh tokens, or
unspent authorization codes. This helper removes session, OAuth token, and code rows and
sets `revoked_at` on unrevoked PATs in one PostgreSQL transaction. It leaves
Accounts subjects, upstream identities, passkeys, OIDC client registration,
refresh-chain replay evidence, Workspace/Run/deployment state, and session
hash/subject derivation keys untouched. Its output contains only row counts,
database identity, and an aggregate row-generation checksum—never token hashes,
raw tokens, keys, or account data.

Use it only after an operator has separately authorized reauthentication for
the **exact** local controller stack and reviewed its state backup. Stop all
controller/worker/ingress containers for that Compose project; keep only its
existing `substrate-postgres` container running. Do not use `scripts/up.sh`,
seed a new dev session, rotate subject/session derivation material, or perform
any new Apply during this step. The helper never starts containers. It refuses
a published PostgreSQL port, any other running container in the same Compose
project, any other container attached to the shared
`local-substrate_takos-local-internal` network, and any other PostgreSQL client
connection. This network can be shared by another Compose project: quiesce and
read back **both** affected local controller stacks and ingress before the
plan/apply. Do not stop unrelated containers; if a required shared-network peer
remains, leave this helper unapplied and arrange an isolated maintenance window.
If any check fails, stop and investigate; do not weaken the guard.

For each independently authorized local stack, obtain the exact **full**
container ID, Compose project label, and Postgres data volume name from Docker
inventory. Do not use a container name, short ID, default project, ambient
`DATABASE_URL`, or a copied production URL. The target must be the existing
`substrate-postgres` service with its volume mounted at
`/var/lib/postgresql/data`. Then run the read-only plan and review its counts:

```bash
cd takosumi
bun scripts/local-accounts-reauth.ts plan \
  --project "$EXACT_LOCAL_PROJECT" \
  --container "$FULL_64_CHARACTER_CONTAINER_ID" \
  --volume "$EXACT_POSTGRES_DATA_VOLUME"
```

The plan prints `database: takosumi_accounts`, `databaseOid`,
`systemIdentifier`, `generation`, and counts for exactly five credential
tables. Keep that value-free plan in operator-private evidence, outside every
repository. Confirm the target and backup once more before applying. Type the
three identifiers from **that stack's** plan (not another stack's):

```bash
bun scripts/local-accounts-reauth.ts apply \
  --project "$EXACT_LOCAL_PROJECT" \
  --container "$FULL_64_CHARACTER_CONTAINER_ID" \
  --volume "$EXACT_POSTGRES_DATA_VOLUME" \
  --database-oid "$PLANNED_DATABASE_OID" \
  --system-identifier "$PLANNED_SYSTEM_IDENTIFIER" \
  --generation "$PLANNED_GENERATION"
```

Apply recomputes the plan after target verification and checks the same
database identity, row counts, and generation again under an exclusive table
lock. A pre-mutation refusal changes nothing; a detected mismatch inside the
transaction rolls back. However a lost `psql` reply, timeout, or failed
post-commit readback can mean the transaction **already committed**. On any
apply error, keep both stacks stopped and do not retry. Independently run a
fresh read-only plan/count against the same exact target, compare operator
evidence, and determine the actual state before choosing a next action. A
successful apply runs a post-transaction count-only plan;
all five counts must be zero. It does not renew ES256/private material; handle
that separately under the operator's secret-rotation authority. While services
remain stopped, independently verify the backup/custody record and the
read-only zero-row proof for each stack. An HTTP negative-auth smoke is not
possible while Accounts is stopped: after that offline proof, restart only the
Accounts-capable service on an isolated internal path with ingress still
blocked, and prove old session, PAT, and OAuth credentials are rejected before
restoring ingress or the other controllers. If an isolated service path is not
available, keep ingress blocked until that negative-auth proof can be made;
do not call the recovery verified merely from zero rows. Then require fresh
login/authorization. Run the plan/apply sequence separately for a second local
stack. Never point the helper at production or a service-managed database.

## 起動 / 停止

```bash
cd takosumi/deploy/local-substrate

# 起動 (Pebble + CoreDNS + Caddy。 minica と issuance root を auto-capture)
bash scripts/up.sh

# Postgres profile: Bun+Postgres Takosumi service + Accounts + cloud worker.
bash scripts/up.sh --profile postgres

# Workers profile: Accounts Worker on D1/R2 + Takosumi service Worker on
# D1/R2/DO. app.takosumi.test remains the canonical platform host;
# service*.takosumi.test is local-only worker probe ingress.
bash scripts/up.sh --profile workers

# 停止 (volume は残る)
bash scripts/down.sh

# 停止 + volume も消す (Pebble の issuance root が regen される)
bash scripts/down.sh -v
```

## ホスト初期設定 (一回だけ)

```bash
sudo bash scripts/ca-install.sh         # Pebble issuance root を host trust store に install
sudo bash scripts/configure-dns.sh      # systemd-resolved per-domain split
```

詳細は [root-ca-install.md](root-ca-install.md)。

## よくある障害

### `curl https://hello.takosumi.test/` が `SSL certificate problem` で失敗

- `caddy/runtime/pebble-issuance-root.pem` が存在するか確認
- `sudo bash scripts/ca-install.sh` を実行
- Pebble を restart した直後は issuance root が変わるので再 install 必須

### `curl: (6) Could not resolve host: hello.takosumi.test`

- `dig hello.takosumi.test @127.0.0.1` で CoreDNS 自体が答えているか確認
- 答えていれば systemd-resolved の per-domain split 未設定 → `sudo bash scripts/configure-dns.sh`
- 答えていなければ CoreDNS container が落ちている → `docker compose -f compose.ingress.yml logs coredns`

### Caddy が cert を obtain できない

```bash
docker compose -f compose.ingress.yml logs caddy | grep -i "error\|acme"
```

典型例:

- `caddy/runtime/pebble.minica.pem` が無い → `bash scripts/up.sh` を再実行
- Pebble が起動しきっていない → up.sh の `Waiting for Pebble` ループに任せる
- 新しい hostname を `compose.ingress.yml` の Caddy network alias に追加した直後 → `docker compose -f compose.ingress.yml up -d --force-recreate caddy` で Caddy container を作り直す。Caddyfile reload だけでは Docker network alias は増えない。

### Caddy admin API への curl が refused

Phase 0 では `127.0.0.1:2019` に bind 済み。 host から:

```bash
curl http://127.0.0.1:2019/config/
```

container 内からは `http://caddy:2019/config/` で接続する。

## 状態確認

```bash
# 全 container の状態
docker compose -f compose.ingress.yml ps

# Pebble 管理 API
curl -sk https://127.0.0.1:15000/dir

# CoreDNS 経由の wildcard 解決
dig random-name.takosumi.test @127.0.0.1 +short

# Postgres profile local-only worker probe
curl -sk --cacert caddy/runtime/pebble-issuance-root.pem https://service-worker.takosumi.test/healthz

# Workers profile local-only worker probes
curl -sk --cacert caddy/runtime/pebble-issuance-root.pem https://service.takosumi.test/healthz
```
