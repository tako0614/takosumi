# Takosumi Core Specification

> **このドキュメントは Takosumi core の正本 (canonical spec) です。** 2026-06-06 採用（原文 verbatim）。
> 個別の reference docs (`docs/reference/*.md`) や AGENTS.md は本 spec に従属し、矛盾した場合は本 spec が優先します。
> 適合状況は [`core-conformance.md`](./core-conformance.md) を参照してください。

## 0. 定義

Takosumi は、**Git リポジトリを入力にして、OpenTofu による plan / apply / destroy を安全に実行し、その履歴・state・artifact・output を台帳として保存する deploy control plane** である。

Takosumi 自体はユーザーリポジトリに独自 format を要求しない。ユーザーが用意するものは基本的に次のどれかだけ。

```txt
1. 普通のアプリケーションソースコードの Git repo
2. 普通の OpenTofu module の Git repo
3. 普通の OpenTofu root configuration の Git repo
```

Takosumi 側の設定、たとえば「どの Git repo を使うか」「どの Connection を使うか」「どの module として扱うか」「自社キーかユーザーキーか」は、**サービス側DBの設定**として持つ。ユーザー repo に `.takosumi.yaml` のような独自 manifest を置かせない。

---

## 1. 設計原則

### 1.1 GitHub 非依存

Takosumi core は GitHub を知らない。

Core が知るのはこれだけ。

```ts
type GitAddress = {
  url: string;
  ref: string;
  path: string;
  credentialId?: string;
};
```

禁止する core 概念。

```txt
githubInstallationId
githubRepoId
githubOwner
githubWebhookPayload
GitHub App 前提の認証
GitHub repo 一覧取得前提の UX
```

GitHub, GitLab, Gitea, Forgejo, Bitbucket, 自前 Git server はすべて **Git URL** として扱う。OpenTofu も任意 Git repository を module source として扱え、Git repository module の取得には `git clone` が使われるため、Takosumi の source model も Git URL / ref / path / credential に寄せる。

### 1.2 単一 Worker

本番の実行単位は基本的に 1 つ。

```txt
Cloudflare Worker: takosumi
```

Worker を `web` / `core` / `vault` / `runner` に物理分割しない。
代わりに、1 Worker の中で module 分割する。

```txt
takosumi Worker
  ├─ public router
  ├─ dashboard assets
  ├─ auth/session
  ├─ source module
  ├─ connection/vault module
  ├─ install/deployment module
  ├─ policy module
  ├─ state/artifact module
  ├─ queue consumer
  ├─ scheduled jobs
  ├─ CoordinationObject
  └─ OpenTofuRunnerObject + Container
```

未信頼コードは Worker 内で動かさない。未信頼 repo の clone / build / OpenTofu 実行は Container に閉じ込める。Cloudflare Containers は Workers から制御でき、フル filesystem や Linux-like environment が必要な処理を実行できるため、OpenTofu runner の実行境界として使う。

### 1.3 実行境界は Worker vs Container

Takosumi Worker は trusted control plane。
Runner Container は untrusted execution boundary。

```txt
trusted:
  takosumi Worker
  D1/R2/Queue/DO 操作
  vault module
  policy module
  ledger update

untrusted:
  Git repo clone
  user build script
  tofu init / plan / apply
  provider plugin execution
```

Container は Durable Object と Worker 経由で制御される。Cloudflare docs でも Containers は Durable Objects と Workers に backed され、Worker → Durable Object → Container の経路になると説明されている。

### 1.4 独自 format を要求しない

Takosumi はユーザー repo に独自 manifest を要求しない。
以下はすべて service-side 設定として扱う。

```txt
Install type
Source URL
Ref
Path
Environment
Connection binding
Policy
Output projection
Build command
Module variable mapping
```

つまり、ユーザー repo に置くのは普通のコードか普通の `.tf` / `.tofu` ファイルだけでよい。OpenTofu の module は `.tf`, `.tofu`, `.tf.json`, `.tofu.json` などを含むディレクトリとして扱われ、root module / child module という通常の OpenTofu model に乗る。

---

## 2. 公開概念

ユーザーに見せる概念はこれだけ。

```txt
Space
Source
App
Environment
Connection
Deployment
Activity
```

### Space

作業領域。個人またはチーム。

### Source

Git repo。

```txt
URL
ref
path
credential
```

だけを持つ。

### App

Takosumi に install された対象。
Web アプリ、API、Worker、静的サイト、OpenTofu module などをまとめて App と呼ぶ。

### Environment

`production` / `staging` / `preview` など。
Environment ごとに ref, path, Connection binding, state が分かれる。

### Connection

外部に接続するための認証情報または手動設定。

```txt
Git HTTPS token
Git SSH key
Cloudflare API token
AWS AssumeRole
manual DNS
service-owned credential
customer-owned credential
```

### Deployment

成功した apply の結果。
Deployment は immutable snapshot として扱う。

### Activity

実行履歴、audit event、log、plan/apply/destroy の状態。

---

## 3. install type

Takosumi は 3 種類の install をサポートする。

### 3.1 App Source Install

非開発者向けの標準。

```txt
Git repo = アプリケーションソース
Takosumi側設定 = build方法 + deploy方法
OpenTofu module = Takosumi側の公式module
```

例。

```txt
ユーザーrepo:
  Hono app
  Solid app
  静的サイト
  Docker app

Takosumi:
  build
  Cloudflare Worker/R2/DNS等へdeploy
```

この mode では、ユーザー repo に OpenTofu がなくてもよい。

### 3.2 OpenTofu Module Install

Git repo を reusable OpenTofu module として扱う。

```txt
Git repo = child module
Takosumi = generated root module を作る
```

Takosumi が root module を生成し、その中からユーザー module を呼ぶ。これにより、provider alias や credential binding を Takosumi 側で制御できる。

### 3.3 OpenTofu Root Install

Git repo を OpenTofu root configuration としてそのまま実行する。

```txt
Git repo = root module
Takosumi = tofu init / plan / apply
```

これは上級者向け。
制限を強くする。

```txt
service-owned credential は渡さない
customer-owned credential のみ
auto apply 原則 off
provider allowlist 必須
resource allowlist 必須
local-exec / external data source は禁止または明示承認
```

`local-exec` は OpenTofu を実行しているマシン上でローカル実行ファイルを呼ぶ provisioner なので、raw root mode では特に危険扱いにする。

---

## 4. 単一 Worker アーキテクチャ

### 4.1 物理構成

```txt
app.takosumi.com
  └─ Cloudflare Worker: takosumi
       ├─ fetch handler
       ├─ queue handler
       ├─ scheduled handler
       ├─ CoordinationObject
       ├─ OpenTofuRunnerObject
       └─ Runner Container
```

外部公開 HTTP は `takosumi` Worker のみ。

```txt
/api/*
/hooks/*
/login
/logout
/dashboard/*
```

内部用 HTTP service は作らない。
deploy-control も vault も policy も **in-process function call** で呼ぶ。

### 4.2 論理 module

```txt
worker/src/
  index.ts
  router.ts

  modules/
    accounts/
    auth/
    sources/
    connections/
    vault/
    apps/
    environments/
    runs/
    deployments/
    policy/
    state/
    artifacts/
    runner/
    billing/

  durable/
    CoordinationObject.ts
    OpenTofuRunnerObject.ts

  queue/
    consumer.ts

  scheduled/
    polling.ts
    cleanup.ts
    drift.ts
```

重要なのは、物理分割ではなく責務分離。

```txt
public router は raw secret に触らない
vault module は raw secret を外に返さない
runner module は mint された最小 credential だけ受け取る
policy module は plan JSON だけで判定する
state module は generation guard を強制する
```

### 4.3 Worker entry

```ts
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const services = createServices(env, ctx);
    return router.fetch(request, services);
  },

  async queue(batch: MessageBatch, env: Env, ctx: ExecutionContext) {
    const services = createServices(env, ctx);
    return consumeQueue(batch, services);
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    const services = createServices(env, ctx);
    return runScheduled(event, services);
  },
};

export class CoordinationObject {
  // environment lease, heartbeat, state generation guard
}

export class OpenTofuRunnerObject {
  // container-backed runner control
}
```

---

## 5. Storage

### 5.1 D1

D1 は台帳。
巨大 artifact や state 本体は保存しない。

```txt
TAKOS_D1
  users
  sessions
  spaces
  sources
  source_snapshots
  apps
  environments
  connections
  secret_blobs
  install_profiles
  installations
  runs
  deployments
  state_snapshots
  artifacts
  audit_events
```

### 5.2 R2

R2 は blob store。

```txt
R2_SOURCE
  spaces/{spaceId}/sources/{sourceId}/snapshots/{snapshotId}/source.tar.zst
  spaces/{spaceId}/sources/{sourceId}/snapshots/{snapshotId}/source.json

R2_ARTIFACTS
  spaces/{spaceId}/apps/{appId}/envs/{envId}/runs/{runId}/generated-root.tar.zst
  spaces/{spaceId}/apps/{appId}/envs/{envId}/runs/{runId}/build.log.ndjson.zst
  spaces/{spaceId}/apps/{appId}/envs/{envId}/runs/{runId}/plan.bin.enc
  spaces/{spaceId}/apps/{appId}/envs/{envId}/runs/{runId}/plan.json.zst.enc
  spaces/{spaceId}/apps/{appId}/envs/{envId}/runs/{runId}/policy.json
  spaces/{spaceId}/apps/{appId}/envs/{envId}/runs/{runId}/apply.log.ndjson.zst
  spaces/{spaceId}/apps/{appId}/envs/{envId}/runs/{runId}/outputs.raw.json.enc
  spaces/{spaceId}/apps/{appId}/envs/{envId}/runs/{runId}/outputs.public.json

R2_STATE
  spaces/{spaceId}/apps/{appId}/envs/{envId}/states/00000001.tfstate.enc
  spaces/{spaceId}/apps/{appId}/envs/{envId}/states/00000002.tfstate.enc
  spaces/{spaceId}/apps/{appId}/envs/{envId}/states/current.json
```

Container disk は永続化先として信用しない。Cloudflare Containers の disk は ephemeral で、container が sleep した後に再起動すると fresh disk になると説明されているため、state・plan・source snapshot・log は必ず R2 に保存する。

---

## 6. Data model

### 6.1 Source

```ts
type Source = {
  id: string;
  spaceId: string;
  name: string;

  url: string;
  defaultRef: string;
  defaultPath: string;

  authConnectionId?: string;

  status: "active" | "disabled" | "error";
  createdAt: string;
  updatedAt: string;
};
```

許可する URL。

```txt
https://host/path/repo.git
ssh://git@host/path/repo.git
git@host:path/repo.git
```

禁止する URL。

```txt
file://...
/absolute/local/path
../relative/path
git://...
ext::...
URL内credential埋め込み
```

### 6.2 SourceSnapshot

```ts
type SourceSnapshot = {
  id: string;
  sourceId: string;

  url: string;
  ref: string;
  resolvedCommit: string;
  path: string;

  archiveObjectKey: string;
  archiveDigest: string;
  archiveSizeBytes: number;

  fetchedByRunId: string;
  fetchedAt: string;
};
```

SourceSnapshot は「この run で使った Git の中身」を固定する内部 artifact。
GitHub の commit ID ではなく、Git の resolved commit と archive digest を正本にする。

### 6.3 App

```ts
type App = {
  id: string;
  spaceId: string;

  name: string;
  sourceId: string;

  installType:
    | "app_source"
    | "opentofu_module"
    | "opentofu_root";

  installProfileId?: string;

  createdAt: string;
  updatedAt: string;
};
```

### 6.4 Environment

```ts
type Environment = {
  id: string;
  appId: string;

  name: string;       // production, staging, preview, etc.
  ref: string;        // main, release, tag, commit, etc.
  path: string;

  autoSync: boolean;
  autoPlan: boolean;
  autoApply: boolean;
  requireApproval: boolean;

  currentDeploymentId?: string;

  createdAt: string;
  updatedAt: string;
};
```

production default。

```txt
autoSync = true
autoPlan = true
autoApply = false
requireApproval = true
```

preview default。

```txt
autoSync = true
autoPlan = true
autoApply = true
requireApproval = false
```

### 6.5 Connection

```ts
type Connection = {
  id: string;
  spaceId: string;

  kind:
    | "source_git_https_token"
    | "source_git_ssh_key"
    | "cloudflare_api_token"
    | "aws_assume_role"
    | "static_secret"
    | "manual";

  owner: "service" | "customer" | "manual";

  displayName: string;
  status: "pending" | "verified" | "revoked" | "expired" | "error";

  scope: Record<string, unknown>;
  secretRef?: string;

  createdAt: string;
  verifiedAt?: string;
  expiresAt?: string;
};
```

### 6.6 InstallProfile

InstallProfile は独自 repo format ではない。
Takosumi 側 DB に保存される「どう扱うか」の設定。

```ts
type InstallProfile = {
  id: string;
  name: string;

  installType:
    | "app_source"
    | "opentofu_module"
    | "opentofu_root";

  trustLevel:
    | "official"
    | "trusted"
    | "customer"
    | "raw";

  moduleSource?: {
    type: "git" | "r2_archive";
    url?: string;
    ref?: string;
    path?: string;
    objectKey?: string;
    digest?: string;
  };

  build?: {
    enabled: boolean;
    workingDirectory?: string;
    commands: string[];
    artifactPath?: string;
  };

  variableMapping: Record<string, unknown>;
  outputAllowlist: Record<string, OutputProjection>;
  policyId: string;

  createdAt: string;
  updatedAt: string;
};
```

ここでいう `InstallProfile` は UI 上では「デプロイ方法」や「テンプレート」と呼んでよい。
ただし、ユーザー repo に置く manifest ではない。

### 6.7 DeploymentProfile

Environment ごとの Connection binding。

```ts
type DeploymentProfile = {
  id: string;
  environmentId: string;

  bindings: {
    source?: ConnectionBinding;
    compute?: ConnectionBinding;
    dns?: ConnectionBinding;
    storage?: ConnectionBinding;
    database?: ConnectionBinding;
    secrets?: ConnectionBinding;
  };

  createdAt: string;
  updatedAt: string;
};

type ConnectionBinding = {
  mode: "service" | "customer" | "manual" | "disabled";
  connectionId?: string;
  provider?: "cloudflare" | "aws" | "gcp" | "azure" | "kubernetes" | "docker";
  region?: string;
  scope?: Record<string, unknown>;
};
```

例。

```json
{
  "bindings": {
    "source": {
      "mode": "customer",
      "connectionId": "conn_git_token"
    },
    "compute": {
      "mode": "service",
      "connectionId": "conn_cf_takosumi"
    },
    "dns": {
      "mode": "customer",
      "connectionId": "conn_cf_user_zone"
    },
    "storage": {
      "mode": "customer",
      "connectionId": "conn_aws_user_role"
    }
  }
}
```

### 6.8 Run

```ts
type Run = {
  id: string;
  spaceId: string;
  appId: string;
  environmentId: string;

  type:
    | "source_sync"
    | "plan"
    | "apply"
    | "destroy_plan"
    | "destroy_apply"
    | "drift_check";

  status:
    | "queued"
    | "running"
    | "waiting_approval"
    | "succeeded"
    | "failed"
    | "cancelled"
    | "expired";

  sourceSnapshotId?: string;
  baseStateGeneration?: number;

  planDigest?: string;
  planArtifactKey?: string;

  policyStatus?: "pass" | "warn" | "deny";
  errorCode?: string;

  createdBy: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
};
```

### 6.9 StateSnapshot

```ts
type StateSnapshot = {
  id: string;
  appId: string;
  environmentId: string;

  generation: number;
  objectKey: string;
  digest: string;

  createdByRunId: string;
  createdAt: string;
};
```

### 6.10 Deployment

```ts
type Deployment = {
  id: string;
  appId: string;
  environmentId: string;

  applyRunId: string;
  sourceSnapshotId: string;
  stateGeneration: number;

  outputsPublic: Record<string, unknown>;

  createdAt: string;
};
```

---

## 7. Git source lifecycle

### 7.1 Source 登録

入力。

```json
{
  "name": "my-app",
  "url": "https://git.example.com/me/my-app.git",
  "defaultRef": "main",
  "defaultPath": ".",
  "authConnectionId": "conn_git_https_token"
}
```

処理。

```txt
1. URL policy 検査
2. credential 参照確認
3. git ls-remote で接続確認
4. Source record 作成
```

### 7.2 SourceSnapshot 作成

```txt
1. Runner Container 起動
2. Git credential を mint
3. git ls-remote で ref 解決
4. git clone / fetch
5. checkout resolved commit
6. path を archive 化
7. digest 計算
8. R2_SOURCE に保存
9. SourceSnapshot record 作成
```

credential は URL に埋め込まない。

HTTPS token。

```txt
GIT_TERMINAL_PROMPT=0
GIT_ASKPASS=/tmp/takosumi-askpass
```

SSH key。

```txt
GIT_SSH_COMMAND="ssh -i /tmp/source_key -o UserKnownHostsFile=/tmp/known_hosts -o StrictHostKeyChecking=yes"
```

`StrictHostKeyChecking=no` は禁止。

### 7.3 Webhook

GitHub 専用 webhook は作らない。

```txt
POST /hooks/sources/:sourceId
Authorization: Bearer <hook_secret>
```

payload は信用しない。
webhook は「変更されたかもしれない」という通知だけ。
実際の commit 解決は Takosumi が `git ls-remote` で行う。

### 7.4 Polling

Environment 単位で polling できる。

```txt
autoSync = true
pollInterval = 5m
```

polling は scheduled handler で行う。

---

## 8. Connection / Vault

### 8.1 Vault の位置

Vault は別 Worker にしない。
同じ `takosumi` Worker 内の module とする。

```txt
modules/vault
  ├─ encryptSecret
  ├─ decryptSecretForRun
  ├─ testConnection
  ├─ mintForSource
  ├─ mintForPlan
  └─ mintForApply
```

ただし public API に raw secret を返してはいけない。

### 8.2 SecretBlob

```ts
type SecretBlob = {
  id: string;
  spaceId: string;

  kind:
    | "source_https_token"
    | "source_ssh_private_key"
    | "cloudflare_api_token"
    | "aws_external_id"
    | "static_secret";

  ciphertext: string;
  encryptedDek: string;
  nonce: string;
  aad: string;
  keyVersion: number;

  createdAt: string;
  rotatedAt?: string;
};
```

### 8.3 Credential mint

Vault は phase ごとに最小 credential を返す。

```ts
type MintRequest = {
  runId: string;
  environmentId: string;
  phase:
    | "source"
    | "build"
    | "plan"
    | "apply"
    | "destroy";

  capabilities: string[];
};

type MintResponse = {
  expiresAt: string;
  env: Record<string, string>;
  files: Array<{
    path: string;
    mode: "0400" | "0600";
    content: string;
  }>;
};
```

### 8.4 Phase ごとの credential policy

```txt
source phase:
  Git credential のみ

build phase:
  原則 credential なし
  provider credential 禁止
  app secret も原則禁止

plan phase:
  provider credential 可
  Git credential 禁止

apply phase:
  provider credential 可
  Git credential 禁止

destroy phase:
  provider credential 可
  Git credential 禁止
```

最重要不変条件。

```txt
ユーザー repo の build script に Cloudflare/AWS/GCP credential を渡さない。
service-owned credential は official/trusted InstallProfile 以外に渡さない。
OpenTofu Root Install では service-owned credential を渡さない。
```

---

## 9. OpenTofu execution

### 9.1 App Source Install

流れ。

```txt
SourceSnapshot
  ↓
build
  ↓
build artifact
  ↓
Takosumi公式 module
  ↓
generated root module
  ↓
tofu plan/apply
```

### 9.2 OpenTofu Module Install

流れ。

```txt
SourceSnapshot
  ↓
moduleとして展開
  ↓
generated root module から呼び出し
  ↓
tofu plan/apply
```

Generated root example。

```hcl
terraform {
  required_providers {
    cloudflare = {
      source = "cloudflare/cloudflare"
    }
    aws = {
      source = "hashicorp/aws"
    }
  }
}

provider "cloudflare" {
  alias     = "compute"
  api_token = var.cloudflare_compute_token
}

provider "cloudflare" {
  alias     = "dns"
  api_token = var.cloudflare_dns_token
}

provider "aws" {
  alias      = "storage"
  region     = var.aws_storage_region
  access_key = var.aws_storage_access_key
  secret_key = var.aws_storage_secret_key
  token      = var.aws_storage_session_token
}

module "app" {
  source = "./module"

  providers = {
    cloudflare.compute = cloudflare.compute
    cloudflare.dns     = cloudflare.dns
    aws.storage        = aws.storage
  }

  app_name = var.app_name
}
```

これで同じ module でも、

```txt
compute = Takosumi Cloudflare
dns     = customer Cloudflare
storage = customer AWS
```

のような hybrid ができる。

### 9.3 OpenTofu Root Install

流れ。

```txt
SourceSnapshot
  ↓
root configとして展開
  ↓
tofu init
  ↓
tofu plan/apply
```

この mode では Takosumi が provider alias をきれいに差し込めない。
したがって、hybrid credential は repo 側が対応している場合のみ可能。

### 9.4 Provider cache / mirror

Runner image には provider cache / mirror を持たせる。

```txt
/opt/takosumi/tofu
/opt/takosumi/tofu.rc
/opt/takosumi/provider-cache
/opt/takosumi/provider-mirror
```

OpenTofu CLI は provider cache や provider installation 設定を扱える。lock file と checksum の扱いも関係するため、cache を使う場合でも `.terraform.lock.hcl` を尊重する。

推奨 `tofu.rc`。

```hcl
plugin_cache_dir = "/opt/takosumi/provider-cache"

provider_installation {
  filesystem_mirror {
    path = "/opt/takosumi/provider-mirror"
    include = [
      "registry.opentofu.org/cloudflare/cloudflare",
      "registry.opentofu.org/hashicorp/aws",
      "registry.opentofu.org/hashicorp/random",
      "registry.opentofu.org/hashicorp/tls"
    ]
  }

  direct {}
}
```

`.terraform.lock.hcl` は provider version と checksum を固定するために使う。OpenTofu docs でも lock file は provider version selection を記録し、version control に含めるべきものとして説明されている。

---

## 10. Run lifecycle

### 10.1 Queue

plan / apply / destroy は HTTP request 中に同期実行しない。
API は Run を作って Queue に投げる。

Cloudflare Queues はメッセージを保存し、少なくとも1回処理されることを保証し、Worker による非同期処理に使えるため、run job の投入先として使う。

```txt
POST /api/environments/:id/plan
  ↓
Run(status=queued)
  ↓
Queue message
  ↓
202 Accepted
```

### 10.2 Coordination

Environment ごとに write run は1つだけ。

```txt
lease key = environment:{environmentId}
```

`CoordinationObject` が管理するもの。

```txt
lease
heartbeat
timeout
cancel
state generation check
```

### 10.3 Source sync run

```txt
queued
  ↓
running
  ↓
git ref resolve
  ↓
clone/fetch
  ↓
archive
  ↓
R2_SOURCE 保存
  ↓
SourceSnapshot 作成
  ↓
succeeded
```

### 10.4 Plan run

```txt
1. Run 作成
2. Queue 投入
3. Environment lease 取得
4. SourceSnapshot 確定
5. current state generation 読み取り
6. Runner Container 起動
7. source 展開
8. build phase
9. module/root 準備
10. provider credential mint
11. tofu init
12. tofu plan -out=tfplan
13. tofu show -json tfplan
14. policy evaluation
15. plan artifact 保存
16. Run を waiting_approval または succeeded にする
```

Plan run が保存するもの。

```txt
sourceSnapshotId
baseStateGeneration
planDigest
planArtifactKey
planJsonArtifactKey
policyDecision
logs
```

### 10.5 Apply run

Apply は保存済み plan に対して行う。

```txt
1. Apply Run 作成
2. 対象 Plan Run 取得
3. planDigest 検証
4. sourceSnapshotId 検証
5. currentStateGeneration == baseStateGeneration を検証
6. Environment lease 取得
7. tfstate 復元
8. provider credential 再 mint
9. tofu apply tfplan
10. new tfstate 取得
11. StateSnapshot generation +1
12. outputs 取得
13. public output projection
14. Deployment 作成
15. Environment.currentDeploymentId 更新
```

### 10.6 Destroy

Destroy は必ず2段階。

```txt
destroy_plan
  ↓
明示承認
  ↓
destroy_apply
```

data resource を含む場合は追加確認。

```txt
database
bucket
volume
secret
DNS zone
```

### 10.7 Drift check

```txt
1. current state を復元
2. source snapshot を固定
3. tofu plan または refresh-only plan
4. 差分を Activity に保存
5. 自動 apply はしない
```

---

## 11. State

### 11.1 State backend

Takosumi は OpenTofu の state を自前管理する。

```txt
R2_STATE に encrypted tfstate を保存
D1 に StateSnapshot metadata を保存
CoordinationObject で write lock
generation guard で古い plan apply を防止
```

OpenTofu は state / plan file の at-rest encryption をサポートしているため、R2 に保存する state / plan は暗号化対象にする。暗号化は state 内の sensitive value 露出に対する防御になるが、古い state/plan を使わせる replay attack は防げないため、Takosumi 側で generation guard を必須にする。

### 11.2 Generation guard

Plan 時。

```txt
baseStateGeneration = currentStateGeneration
```

Apply 時。

```txt
currentStateGeneration == plan.baseStateGeneration
```

一致しなければ apply しない。

### 11.3 State object

```txt
R2_STATE:
  states/00000001.tfstate.enc
  states/00000002.tfstate.enc
  states/current.json
```

`current.json`。

```json
{
  "generation": 2,
  "objectKey": "spaces/.../states/00000002.tfstate.enc",
  "digest": "sha256:..."
}
```

---

## 12. Artifact

### 12.1 Artifact types

```txt
source archive
generated root archive
build log
plan binary
plan JSON
policy decision
apply log
raw outputs
public outputs
state snapshot
```

### 12.2 Digest

すべて digest を持つ。

```txt
sourceDigest
templateDigest / installProfileDigest
generatedRootDigest
planDigest
planJsonDigest
stateDigest
outputDigest
```

Digest は audit event と run record に保存する。

### 12.3 Logs

```txt
NDJSON
zstd圧縮
最大サイズ制限
secret redaction
line length制限
```

---

## 13. Policy

Policy は provider allowlist だけでは足りない。
`tofu show -json` の結果から resource change 単位で評価する。

### 13.1 Layers

```txt
1. install type
2. trust level
3. provider allowlist
4. resource type allowlist
5. scope boundary
6. action policy
7. quota
8. output policy
```

### 13.2 Provider allowlist

```json
{
  "allowedProviders": [
    "registry.opentofu.org/cloudflare/cloudflare",
    "registry.opentofu.org/hashicorp/aws",
    "registry.opentofu.org/hashicorp/random",
    "registry.opentofu.org/hashicorp/tls"
  ]
}
```

### 13.3 Resource allowlist

```json
{
  "allowedResourceTypes": [
    "cloudflare_workers_script",
    "cloudflare_workers_route",
    "cloudflare_dns_record",
    "cloudflare_r2_bucket",
    "aws_s3_bucket",
    "aws_s3_bucket_public_access_block",
    "random_id",
    "tls_private_key"
  ]
}
```

### 13.4 Forbidden by default

```txt
aws_iam_user
aws_iam_access_key
cloudflare_account_token
cloudflare_user_token
null_resource with local-exec
external data source
local_file outside workspace
```

### 13.5 Action policy

```txt
create:
  allow

update:
  allow if scope ok

delete:
  require approval

replace:
  require approval

destroy:
  require destroy flow
```

### 13.6 Scope boundary

Cloudflare。

```txt
zone_id == connection.scope.zoneId
account_id == connection.scope.accountId
```

AWS。

```txt
account_id == connection.scope.accountId
region in connection.scope.regionAllowlist
resource name/tag has Takosumi boundary
```

### 13.7 Quota

```txt
maxRunSeconds
maxSourceArchiveBytes
maxPlanJsonBytes
maxStateBytes
maxLogBytes
maxResourcesPerEnvironment
maxProviderCount
maxModuleDepth
```

### 13.8 Raw root policy

OpenTofu Root Install は追加制限。

```txt
service-owned credential 禁止
autoApply default false
delete/replace は明示承認
local-exec 禁止
remote-exec 禁止
external data source 禁止
任意 provider install は制限
任意 module source は制限
```

---

## 14. Output projection

raw output をそのまま UI に出さない。

```txt
tofu output -json
  ↓
sensitive flag check
  ↓
InstallProfile output allowlist
  ↓
type validation
  ↓
outputs.public.json
  ↓
Deployment.outputsPublic
```

名前ベース redaction は補助。

```txt
secret
token
password
private_key
credential
api_key
session
cookie
```

主防御は allowlist。

例。

```ts
type OutputProjection = {
  from: string;
  type: "string" | "url" | "hostname" | "number" | "boolean" | "json";
  required?: boolean;
};
```

---

## 15. API

API は version prefix を付けず、`/api` にまとめる。

### 15.1 Auth / account

```txt
GET  /api/me
POST /api/login
POST /api/logout
GET  /api/spaces
POST /api/spaces
```

### 15.2 Sources

```txt
POST /api/sources
GET  /api/sources
GET  /api/sources/:sourceId
PATCH /api/sources/:sourceId
POST /api/sources/:sourceId/sync
POST /hooks/sources/:sourceId
```

### 15.3 Connections

```txt
POST /api/connections/source/https-token
POST /api/connections/source/ssh-key
POST /api/connections/cloudflare/token
POST /api/connections/aws/assume-role
GET  /api/connections
GET  /api/connections/:connectionId
POST /api/connections/:connectionId/test
POST /api/connections/:connectionId/revoke
```

### 15.4 Apps

```txt
POST /api/apps
GET  /api/apps
GET  /api/apps/:appId
PATCH /api/apps/:appId
DELETE /api/apps/:appId
```

Create app。

```json
{
  "name": "shop",
  "sourceId": "src_xxx",
  "installType": "app_source",
  "installProfileId": "profile_cloudflare_worker"
}
```

### 15.5 Environments

```txt
POST /api/apps/:appId/environments
GET  /api/apps/:appId/environments
GET  /api/environments/:environmentId
PATCH /api/environments/:environmentId
```

### 15.6 Deployment profile

```txt
GET /api/environments/:environmentId/deployment-profile
PUT /api/environments/:environmentId/deployment-profile
```

### 15.7 Runs

```txt
POST /api/environments/:environmentId/plan
POST /api/runs/:runId/approve
POST /api/runs/:runId/cancel
POST /api/environments/:environmentId/destroy-plan
GET  /api/runs/:runId
GET  /api/runs/:runId/logs
GET  /api/runs/:runId/events
```

### 15.8 Deployments

```txt
GET /api/environments/:environmentId/deployments
GET /api/deployments/:deploymentId
POST /api/deployments/:deploymentId/rollback-plan
```

---

## 16. D1 schema

最小 schema。

```sql
CREATE TABLE spaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE sources (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  default_ref TEXT NOT NULL,
  default_path TEXT NOT NULL DEFAULT '.',
  auth_connection_id TEXT,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE source_snapshots (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  url TEXT NOT NULL,
  ref TEXT NOT NULL,
  resolved_commit TEXT NOT NULL,
  path TEXT NOT NULL,
  archive_object_key TEXT NOT NULL,
  archive_digest TEXT NOT NULL,
  archive_size_bytes INTEGER NOT NULL,
  fetched_by_run_id TEXT NOT NULL,
  fetched_at TEXT NOT NULL
);

CREATE TABLE connections (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  owner TEXT NOT NULL,
  display_name TEXT NOT NULL,
  status TEXT NOT NULL,
  scope_json TEXT NOT NULL,
  secret_ref TEXT,
  created_at TEXT NOT NULL,
  verified_at TEXT,
  expires_at TEXT
);

CREATE TABLE secret_blobs (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  encrypted_dek TEXT NOT NULL,
  nonce TEXT NOT NULL,
  aad TEXT NOT NULL,
  key_version INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  rotated_at TEXT
);

CREATE TABLE install_profiles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  install_type TEXT NOT NULL,
  trust_level TEXT NOT NULL,
  module_source_json TEXT,
  build_json TEXT,
  variable_mapping_json TEXT NOT NULL,
  output_allowlist_json TEXT NOT NULL,
  policy_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE apps (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL,
  name TEXT NOT NULL,
  source_id TEXT NOT NULL,
  install_type TEXT NOT NULL,
  install_profile_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE environments (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL,
  name TEXT NOT NULL,
  ref TEXT NOT NULL,
  path TEXT NOT NULL,
  auto_sync INTEGER NOT NULL,
  auto_plan INTEGER NOT NULL,
  auto_apply INTEGER NOT NULL,
  require_approval INTEGER NOT NULL,
  current_deployment_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE deployment_profiles (
  id TEXT PRIMARY KEY,
  environment_id TEXT NOT NULL,
  bindings_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL,
  app_id TEXT NOT NULL,
  environment_id TEXT NOT NULL,
  type TEXT NOT NULL,
  status TEXT NOT NULL,
  source_snapshot_id TEXT,
  base_state_generation INTEGER,
  plan_digest TEXT,
  plan_artifact_key TEXT,
  policy_status TEXT,
  error_code TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT
);

CREATE TABLE deployments (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL,
  environment_id TEXT NOT NULL,
  apply_run_id TEXT NOT NULL,
  source_snapshot_id TEXT NOT NULL,
  state_generation INTEGER NOT NULL,
  outputs_public_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE state_snapshots (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL,
  environment_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  object_key TEXT NOT NULL,
  digest TEXT NOT NULL,
  created_by_run_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(environment_id, generation)
);

CREATE TABLE artifacts (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  object_key TEXT NOT NULL,
  digest TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE audit_events (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL,
  actor_id TEXT,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  run_id TEXT,
  metadata_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
```

---

## 17. Runner image

Runner image に入れるもの。

```txt
git
openssh-client
OpenTofu
bun
node
tar
zstd
jq
ca-certificates
```

ディレクトリ。

```txt
/work
  /source
  /module
  /root
  /state
  /artifact
  /logs

/opt/takosumi
  /provider-cache
  /provider-mirror
  tofu.rc
```

entrypoint は Worker/DO から job spec を受け取り、phase ごとに実行する。

```ts
type RunnerJob = {
  runId: string;
  type: "source_sync" | "plan" | "apply" | "destroy_plan" | "destroy_apply";
  source?: SourceJobSpec;
  install?: InstallJobSpec;
  credentials?: MintResponse;
  state?: StateRestoreSpec;
};
```

---

## 18. Security invariants

絶対に破ってはいけない条件。

```txt
1. public API から raw secret を返さない
2. Worker 内でユーザー repo の build script を実行しない
3. build phase に provider credential を渡さない
4. source phase に provider credential を渡さない
5. plan/apply phase に Git credential を渡さない
6. service-owned credential は official/trusted install profile のみ
7. OpenTofu Root Install には service-owned credential を渡さない
8. apply は必ず saved plan に対して行う
9. apply 前に plan digest を検証する
10. apply 前に source snapshot を検証する
11. apply 前に state generation を検証する
12. output は allowlist されたものだけ公開する
13. state / plan / raw output は暗号化して保存する
14. logs は secret redaction を通す
15. destroy は2段階承認にする
```

---

## 19. Billing / ownership

Connection binding ごとに請求責任を明確にする。

```txt
service-owned:
  Takosumi 側 cloud account に課金
  ユーザーには Takosumi 利用料として請求

customer-owned:
  ユーザー cloud account に直接課金
  Takosumi は control plane / runner / management fee を請求

manual:
  Takosumi は変更しない
  ユーザーが手動設定
```

Plan summary には必ず出す。

```txt
作成されるもの:
  Cloudflare Worker: 1
  DNS record: 2
  R2 bucket: 1

使用する接続:
  compute: Takosumi Cloudflare
  dns: あなたの Cloudflare
  storage: Takosumi Cloudflare

請求:
  compute/storage: Takosumi側
  dns: あなたのCloudflare側
```

---

## 20. Migration rules

Connection binding の変更には2種類ある。

### 20.1 通常変更

```txt
domain追加
env var変更
route変更
worker script更新
non-data resource update
```

通常 plan/apply でよい。

### 20.2 ownership migration

```txt
storage: service → customer
database: service → customer
cloudflare account A → account B
AWS → Cloudflare
managed DB → BYOC DB
```

これは通常 apply で自動実行しない。
Migration flow にする。

```txt
1. target resource 作成
2. data copy
3. verification
4. traffic切替
5. old resource retention
6. 明示承認後に old resource 削除
```

---

## 21. Repo layout

```txt
takosumi/
  worker/
    src/
      index.ts
      router.ts

      modules/
        accounts/
        auth/
        sources/
        connections/
        vault/
        apps/
        environments/
        runs/
        deployments/
        policy/
        state/
        artifacts/
        runner/
        billing/

      durable/
        CoordinationObject.ts
        OpenTofuRunnerObject.ts

      queue/
        consumer.ts

      scheduled/
        polling.ts
        cleanup.ts
        drift.ts

  dashboard/
    src/

  runner-image/
    Dockerfile
    entrypoint.ts
    tofu.rc.template

  packages/
    schema/
    crypto/
    git/
    rootgen/
    policy/
    opentofu/
    audit/

  modules/
    cloudflare-worker/
    cloudflare-static-site/
    cloudflare-r2/
    aws-s3/

  docs/
    core-spec.md
    operations/
    security/
```

private repo。

```txt
takosumi-private/
  platform/
    wrangler.toml

  secrets/
    README.md

  runbooks/
    deploy-platform.md
    rotate-credentials.md
    restore-state.md
```

`takosumi-private` は operator state only。
コード禁止。

---

## 22. `wrangler.toml` 方針

単一 Worker。

```toml
name = "takosumi"
main = "../takosumi/worker/src/index.ts"
compatibility_date = "2026-06-06"

[[d1_databases]]
binding = "TAKOS_D1"
database_name = "takosumi"

[[r2_buckets]]
binding = "R2_SOURCE"
bucket_name = "takosumi-source"

[[r2_buckets]]
binding = "R2_ARTIFACTS"
bucket_name = "takosumi-artifacts"

[[r2_buckets]]
binding = "R2_STATE"
bucket_name = "takosumi-state"

[[queues.producers]]
binding = "RUN_QUEUE"
queue = "takosumi-runs"

[[queues.consumers]]
queue = "takosumi-runs"

[[durable_objects.bindings]]
name = "COORDINATION"
class_name = "CoordinationObject"

[[durable_objects.bindings]]
name = "RUNNER"
class_name = "OpenTofuRunnerObject"
```

実際の account ID / bucket ID / secrets は `takosumi-private` に置く。
public repo の `wrangler.toml` は template でよい。

---

## 23. UI flow

### 23.1 App Source Install

```txt
1. Sourceを追加
   Git URL
   ref
   path
   credential

2. Appを作成
   Source選択
   デプロイ方法選択
   Environment作成

3. Connectionを設定
   ぜんぶTakosumiに任せる
   DNSだけ自分のCloudflare
   storageだけ自分のAWS
   手動DNS

4. 変更を確認
   plan summary

5. 公開
   apply
```

### 23.2 OpenTofu Module Install

```txt
1. Git URLを入れる
2. module pathを選ぶ
3. 入力値を設定
4. Connection bindingを設定
5. plan
6. apply
```

### 23.3 OpenTofu Root Install

```txt
1. Git URLを入れる
2. root pathを選ぶ
3. customer connectionを設定
4. policyを確認
5. plan
6. 手動承認
7. apply
```

---

## 24. MVP scope

最初に作る範囲。

```txt
Single Worker
Dashboard SPA
D1 ledger
R2 source/artifacts/state
Queue-based run
CoordinationObject lease
Container runner
Git public clone
Git HTTPS token
Git SSH key
Cloudflare service connection
Cloudflare customer token connection
App Source Install
OpenTofu Module Install
generated root module
plan/apply/destroy
state generation guard
plan digest guard
output allowlist
basic policy
```

最初に不要。

```txt
GitHub App
GitHub repo picker
複数Worker分割
独自repo manifest
OpenTofu private registry
full Terraform Cloud互換
任意provider自由実行
raw root auto apply
大規模migration自動化
```

---

## 25. 実装順序

### Phase 1: 単一 Worker の骨格

```txt
fetch / queue / scheduled entry
D1 schema
R2 buckets
Queue
CoordinationObject
OpenTofuRunnerObject
dashboard shell
```

### Phase 2: Source

```txt
Git URL登録
URL policy
public clone
HTTPS token
SSH key
SourceSnapshot
generic webhook
polling
```

### Phase 3: Connection / Vault

```txt
connections table
secret_blobs
encryption
Cloudflare token
AWS assume role placeholder
mint API
audit events
```

### Phase 4: Runner

```txt
Container image
source phase
build phase
plan phase
apply phase
log streaming
artifact upload
timeout/cancel
```

### Phase 5: OpenTofu Module Install

```txt
generated root
provider alias
variable mapping
tofu init/plan/apply
state restore/save
output projection
```

### Phase 6: App Source Install

```txt
build command
artifact passing
official modules
Cloudflare Worker deploy
DNS deploy
```

### Phase 7: Policy

```txt
provider allowlist
resource allowlist
scope boundary
action policy
quota
raw root restrictions
```

### Phase 8: Production hardening

```txt
state/plan encryption
provider mirror/cache
DLQ
run retry strategy
secret redaction
billing summary
migration warning
```

---

## 最終的な正本

Takosumi の core はこれで固定する。

```txt
GitHub非依存
単一Cloudflare Worker
Container-backed OpenTofu runner
D1台帳
R2 source/artifact/state
Queue非同期実行
DOによるenvironment lease
Connection bindingによる service/customer/hybrid credential
SourceSnapshot / plan digest / state generation による再現性保証
独自repo formatなし
```

一番重要な分離は Worker 分割ではなく、これ。

```txt
Takosumi Worker:
  trusted control plane

Runner Container:
  untrusted execution boundary
```

一番重要な仕様判断はこれ。

```txt
ユーザーrepoには何も要求しない。
Takosumi側のDB設定で install type / connection / policy / output を決める。
Git URLをcloneして、OpenTofuを走らせ、結果を台帳化する。
```

この形なら、シンプルで、GitHubにも依存せず、OpenTofuの普通のmodule/root configも扱えて、自社キー・ユーザーキー・ハイブリッドも同じ仕組みで処理できる。
