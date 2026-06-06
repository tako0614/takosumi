# Takosumi Core Specification

> **このドキュメントは Takosumi core の正本 (canonical spec) です。** 2026-06-06 全面改訂 (Space 直下 Installation DAG モデル採用)。
> 個別の reference docs (`docs/reference/*.md`) や AGENTS.md は本 spec に従属し、矛盾した場合は本 spec が優先します。
> 適合状況は [`core-conformance.md`](./core-conformance.md) を参照してください。

## 1. 一言定義

**Takosumi は、Space 直下の OpenTofu Installation DAG を管理する OSS control plane。**

ユーザーは Git URL から Service を Space にインストールする。
Takosumi はそれを OpenTofu で plan / apply / destroy し、state・outputs・依存関係・credential・artifact・履歴を管理する。

```txt
Space: @shota
  ├─ Installation: core
  ├─ Installation: files
  ├─ Installation: talk
  └─ Installation: blog

Graph:
  core.base_domain          → files.base_domain
  core.base_domain          → talk.base_domain
  core.member_issuer        → talk.member_issuer
  files.attachments_bucket  → talk.attachments_bucket
```

この構造は filesystem ではなく **Installation graph**。
保存上は R2 prefix を階層化するが、正本は D1 上の DAG。

---

## 2. コンセプト

Takosumi のプロダクトコンセプトはこれ。

```txt
SaaSを借りるのではなく、自分のSpaceにServiceとして持つ。
```

Talk / Files / Blog / Calls のような機能は Takosumi に内蔵するのではなく、全部 Git URL から入る Installation として扱う。

```txt
@shota/talk
@shota/files
@family/talk
@company/internal-chat
```

Service の配布元は任意の Git repository。

```txt
https://git.example.com/takos/talk.git
https://github.com/user/talk.git
git@git.example.com:company/internal-chat.git
```

外部サイトにはこういう導線を置ける。

```txt
Install to Takosumi
```

リンク先。

```txt
https://app.takosumi.com/install?source=git::https://git.example.com/takos/talk.git//deploy?ref=main
```

---

## 3. 最終アーキテクチャ

```txt
Takosumi Instance
  ├─ Operator Default Connections
  │    ├─ compute default
  │    ├─ dns default
  │    ├─ storage default
  │    └─ source default
  │
  └─ Spaces
       ├─ @shota
       │    ├─ Sources
       │    ├─ Connections
       │    ├─ Installations
       │    ├─ Dependencies
       │    ├─ Runs
       │    ├─ Deployments
       │    ├─ StateSnapshots
       │    ├─ OutputSnapshots
       │    └─ Activity
       │
       └─ @takos
            ├─ Sources
            ├─ Installations
            └─ Activity
```

Runtime は単一 Cloudflare Worker。

```txt
Cloudflare Worker: takosumi
  ├─ fetch handler
  ├─ queue handler
  ├─ scheduled handler
  ├─ dashboard assets
  ├─ modules/*
  ├─ CoordinationObject
  └─ OpenTofuRunnerObject
       └─ Runner Container
```

実行境界はこれ。

```txt
Takosumi Worker
  trusted control plane

Runner Container
  Git clone / build / OpenTofu execution boundary
```

---

## 4. Space

Space は GitHub の user / org に近い owner namespace。

```txt
@shota
@takos
@family
@company
```

Space が持つもの。

```txt
members
roles
sources
connections
installations
dependency graph
outputs
state namespace
policy
activity
optional billing
```

Billing は Space に紐づけられる。

```txt
@shota
  billing: personal

@company
  billing: company invoice

@family
  billing: optional
```

Space は軽い所有単位。
初回ログイン時に個人 Space を自動作成する。

```txt
@shota
```

Organization 的に使いたい場合は追加 Space を作る。

```txt
@takos
@family
@company
```

---

## 5. Installation

Installation は Space 直下の OpenTofu 実行単位。

```txt
@shota/core
@shota/talk
@shota/files
@takos/talk
```

1 Installation = 1 OpenTofu root/state。

Installation が持つもの。

```txt
Source
SourceSnapshot
InstallConfig
DeploymentProfile
Dependencies
Runs
StateSnapshots
OutputSnapshots
Deployments
```

Installation full name。

```txt
@space/name
```

例。

```txt
@shota/core
@shota/talk
@shota/files
@company/internal-chat
```

`core` は標準の基盤 Installation。
普通の Installation と同じ扱いで、他 Installation に共有する outputs を出す。

```txt
@shota/core outputs:
  base_domain
  public_origin
  member_issuer
  service_registry_url
```

---

## 6. Source

Source は Git repository。

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

許可 URL。

```txt
https://host/path/repo.git
ssh://git@host/path/repo.git
git@host:path/repo.git
```

GitHub / GitLab / Gitea / Forgejo / Bitbucket / 自前 Git server はすべて同じ Source として扱う。

core は **GitHub 非依存**。 git source の抽象は `GitAddress` (`{ url, ref, path, credentialId? }`) のみで、
`githubInstallationId` 等の forge 固有 identifier を core 型に持ち込まない。 forge 連携は core の外の optional adapter。

user repo に Takosumi 独自 manifest は要求しない。 install 設定は service-side DB config (InstallConfig) として持つ。

---

## 7. SourceSnapshot

SourceSnapshot は Git ref を commit に固定した immutable input。

```txt
Git URL + ref + path
  ↓
resolved commit
  ↓
source archive
  ↓
digest
  ↓
R2_SOURCE
```

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

Lifecycle。

```txt
1. Source URL / ref / path を受け取る
2. Git credential を mint
3. git ls-remote で ref 解決
4. commit を固定
5. clone / fetch
6. path を archive 化
7. digest 計算
8. R2_SOURCE に保存
9. SourceSnapshot 作成
```

HTTPS token。

```txt
GIT_TERMINAL_PROMPT=0
GIT_ASKPASS=/tmp/takosumi-askpass
```

SSH key。

```txt
GIT_SSH_COMMAND="ssh -i /tmp/source_key -o UserKnownHostsFile=/tmp/known_hosts -o StrictHostKeyChecking=yes"
```

---

## 8. Connection

Connection は外部接続。

```txt
Git token
Git SSH key
Cloudflare API token
AWS AssumeRole
static secret
manual value
```

Connection scope は2種類。

```txt
operator
  Takosumi instance 全体の接続

space
  Space に追加された接続
```

Self-host では operator connection は自分のリソース。
Hosted SaaS では operator connection は運営側リソース。

```ts
type Connection = {
  id: string;

  scope: "operator" | "space";
  spaceId?: string;

  kind:
    | "source_git_https_token"
    | "source_git_ssh_key"
    | "cloudflare_api_token"
    | "aws_assume_role"
    | "static_secret"
    | "manual";

  displayName: string;

  status:
    | "pending"
    | "verified"
    | "revoked"
    | "expired"
    | "error";

  capabilityHints: Array<
    | "source"
    | "compute"
    | "dns"
    | "storage"
    | "database"
    | "secrets"
  >;

  scopeJson: Record<string, unknown>;
  secretRef?: string;

  createdAt: string;
  verifiedAt?: string;
  expiresAt?: string;
};
```

SecretBlob。

```ts
type SecretBlob = {
  id: string;
  spaceId?: string;

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

---

## 9. Operator Default Connections

Takosumi instance 全体の default 接続。

```json
{
  "defaults": {
    "compute": "conn_operator_cloudflare",
    "dns": "conn_operator_cloudflare",
    "storage": "conn_operator_r2",
    "source": "conn_operator_git"
  }
}
```

Installation 側は capability ごとに binding する。

```json
{
  "compute": { "mode": "default" },
  "dns": { "mode": "default" },
  "storage": { "mode": "default" }
}
```

Space connection で上書きする場合。

```json
{
  "compute": { "mode": "default" },
  "dns": {
    "mode": "connection",
    "connectionId": "conn_space_cloudflare_dns"
  },
  "storage": { "mode": "default" }
}
```

手動設定。

```json
{
  "dns": {
    "mode": "manual",
    "values": {
      "type": "CNAME",
      "name": "talk.example.com",
      "target": "cname.takosumi.example"
    }
  }
}
```

CapabilityBinding。

```ts
type CapabilityBinding = {
  mode:
    | "default"
    | "connection"
    | "manual"
    | "disabled";

  connectionId?: string;
  provider?: string;
  region?: string;
  values?: Record<string, unknown>;
};
```

---

## 10. Install type

Installation の実行方式。

```txt
core
opentofu_module
opentofu_root
app_source
```

### core

Space の基盤用 Installation。

標準 outputs。

```txt
base_domain
public_origin
member_issuer
service_registry_url
```

### opentofu_module

Git repo の指定 path を OpenTofu module として扱い、Takosumi が generated root module を作る。

```txt
SourceSnapshot
  ↓
moduleとして展開
  ↓
generated root
  ↓
tofu plan/apply
```

標準的な Service install mode。

### opentofu_root

Git repo の指定 path を OpenTofu root configuration として実行する。

```txt
SourceSnapshot
  ↓
tofu init
  ↓
tofu plan
  ↓
tofu apply
```

### app_source

Git repo をアプリソースとして build し、artifact を公式 OpenTofu deploy module に渡す。

```txt
app source
  ↓
build
  ↓
artifact
  ↓
official deploy module
  ↓
tofu plan/apply
```

---

## 11. InstallConfig

InstallConfig は Takosumi 側 DB に保存される「この Source をどう扱うか」の設定。

```ts
type InstallConfig = {
  id: string;
  spaceId?: string;

  name: string;

  installType:
    | "core"
    | "opentofu_module"
    | "opentofu_root"
    | "app_source";

  trustLevel:
    | "official"
    | "trusted"
    | "space"
    | "raw";

  modulePath?: string;

  build?: {
    enabled: boolean;
    workingDirectory?: string;
    commands: string[];
    artifactPath?: string;
  };

  variableMapping: Record<string, unknown>;

  outputAllowlist: Record<string, {
    from: string;
    type:
      | "string"
      | "url"
      | "hostname"
      | "number"
      | "boolean"
      | "json";
    required?: boolean;
  }>;

  policy: PolicyConfig;

  backup?: BackupConfig;

  createdAt: string;
  updatedAt: string;
};
```

---

## 12. External install link

外部サイトは Git URL を渡す。

```txt
https://app.takosumi.com/install?source=git::https://git.example.com/takos/talk.git//deploy?ref=main
```

簡易形。

```txt
https://app.takosumi.com/install?git=https://git.example.com/takos/talk.git&ref=main&path=deploy
```

UI。

```txt
Install Service

Source:
git.example.com/takos/talk.git

Ref:
main

Path:
deploy

Install into:
@shota

Installation name:
talk

Environment:
production
```

---

## 13. Generated root module

`opentofu_module` では Takosumi が OpenTofu root module を生成する。

```hcl
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

module "service" {
  source = "./module"

  providers = {
    cloudflare.compute = cloudflare.compute
    cloudflare.dns     = cloudflare.dns
    aws.storage        = aws.storage
  }

  service_slug = var.service_slug
}
```

Module 側。

```hcl
terraform {
  required_providers {
    cloudflare = {
      source = "cloudflare/cloudflare"
      configuration_aliases = [
        cloudflare.compute,
        cloudflare.dns
      ]
    }
  }
}
```

---

## 14. Dependency graph

Space 内の Installation は DAG として管理する。

```txt
core ───────▶ talk
  │            ▲
  ▼            │
files ─────────┘
```

Dependency model。

```ts
type Dependency = {
  id: string;
  spaceId: string;

  producerInstallationId: string;
  consumerInstallationId: string;

  mode:
    | "remote_state"
    | "variable_injection"
    | "published_output";

  outputs: Record<string, {
    from: string;
    to: string;
    required: boolean;
    type?:
      | "string"
      | "url"
      | "hostname"
      | "number"
      | "boolean"
      | "json";
  }>;

  visibility:
    | "space"
    | "cross_space";

  createdAt: string;
};
```

Example.

```json
{
  "producerInstallationId": "inst_core",
  "consumerInstallationId": "inst_talk",
  "mode": "variable_injection",
  "outputs": {
    "base_domain": {
      "from": "base_domain",
      "to": "base_domain",
      "required": true,
      "type": "hostname"
    },
    "member_issuer": {
      "from": "member_issuer",
      "to": "member_issuer",
      "required": true,
      "type": "url"
    }
  },
  "visibility": "space"
}
```

---

## 15. Dependency modes

### variable_injection

Takosumi が producer output を読み、consumer の `.auto.tfvars.json` を生成する。

```json
{
  "base_domain": "shota.example.com",
  "member_issuer": "https://shota.example.com/auth",
  "attachments_bucket": "talk-attachments"
}
```

Consumer module。

```hcl
variable "base_domain" {
  type = string
}

variable "member_issuer" {
  type = string
}

variable "attachments_bucket" {
  type = string
}
```

標準 mode。

### remote_state

同一 Space 内で producer state を read-only materialize し、consumer が `terraform_remote_state` で読む。

```hcl
data "terraform_remote_state" "core" {
  backend = "local"

  config = {
    path = "/work/deps/core.tfstate"
  }
}

module "service" {
  source = "./module"

  base_domain   = data.terraform_remote_state.core.outputs.base_domain
  member_issuer = data.terraform_remote_state.core.outputs.member_issuer
}
```

OpenTofu-native な強結合 mode。

### published_output

Space 間共有用。

```txt
producer OutputSnapshot
  ↓
OutputShare
  ↓
consumer Space
  ↓
variable_injection
```

---

## 16. OutputSnapshot

Apply 後に `tofu output -json` を取得して保存する。

```ts
type OutputSnapshot = {
  id: string;
  spaceId: string;
  installationId: string;

  stateGeneration: number;

  rawOutputArtifactKey: string;

  publicOutputs: Record<string, unknown>;
  spaceOutputs: Record<string, unknown>;

  outputDigest: string;

  createdAt: string;
};
```

Output categories。

```txt
raw outputs
  tofu output -json
  encrypted artifact

space outputs
  same Space dependency で利用

public outputs
  UI / install summary / external display
```

Output projection。

```txt
tofu output -json
  ↓
sensitive flag check
  ↓
InstallConfig outputAllowlist
  ↓
type validation
  ↓
OutputSnapshot
```

---

## 17. DependencySnapshot

Plan 時に依存入力を固定する。

```ts
type DependencySnapshot = {
  id: string;
  runId: string;

  dependencies: Array<{
    dependencyId: string;
    producerInstallationId: string;
    producerStateGeneration: number;
    producerOutputSnapshotId: string;
    producerOutputDigest: string;
    valuesDigest: string;
    values: Record<string, unknown>;
  }>;

  mode: "strict" | "pinned";

  createdAt: string;
};
```

Plan 時。

```txt
1. consumer Installation の Dependencies を読む
2. producer OutputSnapshot を読む
3. 必要な値を固定
4. DependencySnapshot を作る
5. その snapshot で tofu plan
```

Apply 時。

```txt
1. plan digest 確認
2. source snapshot 確認
3. dependency snapshot 確認
4. consumer state generation 確認
5. tofu apply saved plan
```

Production default。

```txt
DependencySnapshot.mode = strict
```

Preview / dev default。

```txt
DependencySnapshot.mode = pinned
```

---

## 18. OutputShare

Space 間で output を共有する。

```ts
type OutputShare = {
  id: string;

  fromSpaceId: string;
  toSpaceId: string;

  producerInstallationId: string;

  outputs: Array<{
    name: string;
    alias?: string;
    type?: string;
    sensitive: boolean;
  }>;

  status:
    | "pending"
    | "active"
    | "revoked";

  createdAt: string;
  revokedAt?: string;
};
```

UI。

```txt
Share outputs

From:
@company/domain

To:
@shota

Outputs:
✓ domain
✓ public_origin
```

Consumer 側では variable として受け取る。

---

## 19. Run

```ts
type Run = {
  id: string;
  runGroupId?: string;

  spaceId: string;
  installationId: string;
  environment: string;

  type:
    | "source_sync"
    | "plan"
    | "apply"
    | "destroy_plan"
    | "destroy_apply"
    | "drift_check"
    | "backup"
    | "restore";

  status:
    | "queued"
    | "running"
    | "waiting_approval"
    | "succeeded"
    | "failed"
    | "cancelled"
    | "expired";

  sourceSnapshotId?: string;
  dependencySnapshotId?: string;

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

RunGroup。

```ts
type RunGroup = {
  id: string;
  spaceId: string;

  type:
    | "space_update"
    | "installation_install"
    | "installation_update"
    | "installation_destroy"
    | "migration";

  status:
    | "queued"
    | "running"
    | "waiting_approval"
    | "succeeded"
    | "failed"
    | "cancelled";

  graphJson: string;

  createdAt: string;
  finishedAt?: string;
};
```

---

## 20. StateSnapshot

Installation ごとの tfstate 世代。

```ts
type StateSnapshot = {
  id: string;

  spaceId: string;
  installationId: string;
  environment: string;

  generation: number;

  objectKey: string;
  digest: string;

  createdByRunId: string;
  createdAt: string;
};
```

R2 layout。

```txt
R2_STATE/
  spaces/{spaceId}/installations/{installationId}/envs/{environment}/states/
    00000001.tfstate.enc
    00000002.tfstate.enc
    current.json
```

Generation guard。

```txt
Plan:
  baseStateGeneration = currentStateGeneration

Apply:
  currentStateGeneration == plan.baseStateGeneration
```

---

## 21. Deployment

```ts
type Deployment = {
  id: string;

  spaceId: string;
  installationId: string;
  environment: string;

  applyRunId: string;

  sourceSnapshotId: string;
  dependencySnapshotId?: string;

  stateGeneration: number;
  outputSnapshotId: string;

  outputsPublic: Record<string, unknown>;

  createdAt: string;
};
```

Deployment status。

```txt
active
superseded
rolled_back
destroyed
```

---

## 22. Runner architecture

```txt
API request
  ↓
Run作成
  ↓
Queue投入
  ↓
Queue consumer
  ↓
CoordinationObject
  ↓
OpenTofuRunnerObject
  ↓
Runner Container
  ↓
git / build / tofu
```

Runner workspace。

```txt
/work
  /source
  /module
  /root
  /deps
  /state
  /artifact
  /logs
```

Runner image。

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

Phases。

```txt
source phase
  Git credential

build phase
  build inputs

plan phase
  provider credentials
  dependency states / variables
  tofu plan

apply phase
  provider credentials
  saved plan
  tfstate

destroy phase
  provider credentials
  saved destroy plan
```

---

## 23. Run lifecycle

### Source sync

```txt
1. Run作成
2. Queue投入
3. Runner起動
4. Git credential mint
5. git ls-remote
6. refをcommitに固定
7. clone/fetch
8. archive
9. R2_SOURCE保存
10. SourceSnapshot作成
11. Run succeeded
```

### Plan

```txt
1. Plan Run作成
2. Installation lease取得
3. SourceSnapshot確定
4. DependencySnapshot作成
5. current state generation取得
6. source展開
7. dependencies展開
8. build phase
9. generated root作成
10. provider credential mint
11. tofu init
12. tofu plan -out=tfplan
13. tofu show -json tfplan
14. policy evaluation
15. plan artifact保存
16. Run waiting_approval / succeeded
```

### Apply

```txt
1. Apply Run作成
2. 対象Plan Run取得
3. plan digest検証
4. source snapshot検証
5. dependency snapshot検証
6. current state generation検証
7. Installation lease取得
8. tfstate復元
9. dependencies復元
10. provider credential再mint
11. tofu apply saved plan
12. new tfstate保存
13. StateSnapshot generation +1
14. tofu output -json
15. OutputSnapshot作成
16. Deployment作成
17. downstream stale marking
```

### Destroy

```txt
destroy_plan
  ↓
approval
  ↓
destroy_apply
```

---

## 24. Stale propagation

Producer output が変わると downstream Installation を stale にする。

例。

```txt
core.base_domain changed
  ↓
files stale
talk stale
```

Graph。

```txt
core -> files -> talk
core -> talk
```

UI。

```txt
talk needs update

Reason:
core.base_domain changed

[Create plan]
```

RunGroup でまとめて更新。

```txt
Space update

1. core
   ~ domain changed

2. files
   no changes

3. talk
   ~ variables changed

[Apply update]
```

---

## 25. Policy

Policy は OpenTofu plan JSON を評価する。

Layers。

```txt
1. Space policy
2. InstallConfig trust
3. install type
4. provider allowlist
5. resource type allowlist
6. scope boundary
7. action policy
8. dependency policy
9. output policy
10. quota
```

Provider allowlist。

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

Resource allowlist。

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

Action policy。

```txt
create:
  allow

update:
  allow if scope ok

delete:
  approval

replace:
  approval

destroy:
  destroy flow
```

Dependency policy。

```txt
same Space + variable_injection:
  allow

same Space + remote_state:
  allow

cross Space:
  OutputShare

sensitive output:
  explicit permission
```

Capability binding trust。

```txt
official / trusted:
  default connection available

app_source:
  build phase isolated
  official deploy adapter uses default connection

opentofu_module:
  trust policy decides default / connection

opentofu_root:
  space connection focused
```

`local-exec` provisioner / `external` data source は forbidden-by-default。

---

## 26. Storage layout

```txt
R2_SOURCE/
  spaces/{spaceId}/sources/{sourceId}/snapshots/{snapshotId}/
    source.tar.zst
    source.json

R2_ARTIFACTS/
  spaces/{spaceId}/installations/{installationId}/runs/{runId}/
    generated-root.tar.zst
    build.log.ndjson.zst
    plan.bin.enc
    plan.json.zst.enc
    policy.json
    dependency-snapshot.json
    apply.log.ndjson.zst
    outputs.raw.json.enc
    outputs.public.json
    run.meta.json

R2_STATE/
  spaces/{spaceId}/installations/{installationId}/envs/{environment}/states/
    00000001.tfstate.enc
    00000002.tfstate.enc
    current.json

R2_BACKUPS/
  spaces/{spaceId}/backups/{backupId}/
    control.json.zst.enc
    state.tar.zst.enc
    artifacts.manifest.json
    service-data.tar.zst.enc
```

---

## 27. D1 schema

以下は **logical schema の正本**。 D1 / Postgres / in-memory の各 store backend はこの schema に対称に従う。

```sql
CREATE TABLE spaces (
  id TEXT PRIMARY KEY,
  handle TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  type TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  billing_account_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
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
  scope TEXT NOT NULL,
  space_id TEXT,
  kind TEXT NOT NULL,
  display_name TEXT NOT NULL,
  status TEXT NOT NULL,
  capability_hints_json TEXT NOT NULL,
  scope_json TEXT NOT NULL,
  secret_ref TEXT,
  created_at TEXT NOT NULL,
  verified_at TEXT,
  expires_at TEXT
);

CREATE TABLE secret_blobs (
  id TEXT PRIMARY KEY,
  space_id TEXT,
  kind TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  encrypted_dek TEXT NOT NULL,
  nonce TEXT NOT NULL,
  aad TEXT NOT NULL,
  key_version INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  rotated_at TEXT
);

CREATE TABLE operator_connection_defaults (
  id TEXT PRIMARY KEY,
  capability TEXT NOT NULL,
  provider TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE install_configs (
  id TEXT PRIMARY KEY,
  space_id TEXT,
  name TEXT NOT NULL,
  install_type TEXT NOT NULL,
  trust_level TEXT NOT NULL,
  module_path TEXT,
  build_json TEXT,
  variable_mapping_json TEXT NOT NULL,
  output_allowlist_json TEXT NOT NULL,
  policy_json TEXT NOT NULL,
  backup_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE installations (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  source_id TEXT NOT NULL,
  install_type TEXT NOT NULL,
  install_config_id TEXT NOT NULL,
  environment TEXT NOT NULL,
  current_deployment_id TEXT,
  current_state_generation INTEGER NOT NULL DEFAULT 0,
  current_output_snapshot_id TEXT,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(space_id, name, environment)
);

CREATE TABLE deployment_profiles (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL,
  installation_id TEXT NOT NULL,
  environment TEXT NOT NULL,
  bindings_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE installation_dependencies (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL,
  producer_installation_id TEXT NOT NULL,
  consumer_installation_id TEXT NOT NULL,
  mode TEXT NOT NULL,
  outputs_json TEXT NOT NULL,
  visibility TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE output_snapshots (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL,
  installation_id TEXT NOT NULL,
  state_generation INTEGER NOT NULL,
  raw_output_artifact_key TEXT NOT NULL,
  public_outputs_json TEXT NOT NULL,
  space_outputs_json TEXT NOT NULL,
  output_digest TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE dependency_snapshots (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  dependencies_json TEXT NOT NULL,
  mode TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE output_shares (
  id TEXT PRIMARY KEY,
  from_space_id TEXT NOT NULL,
  to_space_id TEXT NOT NULL,
  producer_installation_id TEXT NOT NULL,
  outputs_json TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE TABLE run_groups (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL,
  type TEXT NOT NULL,
  status TEXT NOT NULL,
  graph_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  finished_at TEXT
);

CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  run_group_id TEXT,
  space_id TEXT NOT NULL,
  installation_id TEXT NOT NULL,
  environment TEXT NOT NULL,
  type TEXT NOT NULL,
  status TEXT NOT NULL,
  source_snapshot_id TEXT,
  dependency_snapshot_id TEXT,
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

CREATE TABLE state_snapshots (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL,
  installation_id TEXT NOT NULL,
  environment TEXT NOT NULL,
  generation INTEGER NOT NULL,
  object_key TEXT NOT NULL,
  digest TEXT NOT NULL,
  created_by_run_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(installation_id, environment, generation)
);

CREATE TABLE deployments (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL,
  installation_id TEXT NOT NULL,
  environment TEXT NOT NULL,
  apply_run_id TEXT NOT NULL,
  source_snapshot_id TEXT NOT NULL,
  dependency_snapshot_id TEXT,
  state_generation INTEGER NOT NULL,
  output_snapshot_id TEXT NOT NULL,
  outputs_public_json TEXT NOT NULL,
  created_at TEXT NOT NULL
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

## 28. Single Worker code layout

```txt
takosumi/
  worker/
    src/
      index.ts
      router.ts

      modules/
        accounts/
        auth/
        spaces/
        sources/
        connections/
        vault/
        install-configs/
        installations/
        dependencies/
        outputs/
        runs/
        deployments/
        policy/
        state/
        artifacts/
        backups/
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
    graph/
    policy/
    opentofu/
    audit/

  opentofu-modules/
    core/
    cloudflare-worker-service/
    cloudflare-static-site/
    cloudflare-r2-storage/
    aws-s3-storage/
```

`modules/accounts` / `modules/auth` / `modules/billing` は accounts plane
(`packages/accounts-service` / `packages/accounts-contract`) への thin mount であり、 accounts plane の実装 package は
物理的には `packages/` に残る。

---

## 29. wrangler shape

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

[[r2_buckets]]
binding = "R2_BACKUPS"
bucket_name = "takosumi-backups"

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

platform worker はこれに加えて accounts plane の binding (`TAKOSUMI_ACCOUNTS_DB` /
`TAKOSUMI_ACCOUNTS_EXPORTS` 等) を持つ。 realized config (実 resource ID) は operator-private の
`takosumi-private/platform/wrangler.toml` に置き、 この repo の wrangler.toml は placeholder template とする。

---

## 30. API

Version prefix は置かず `/api` にまとめる。

### Spaces

```txt
POST /api/spaces
GET  /api/spaces
GET  /api/spaces/:spaceId
PATCH /api/spaces/:spaceId
```

### Sources

```txt
POST /api/sources
GET  /api/sources
GET  /api/sources/:sourceId
POST /api/sources/:sourceId/sync
POST /hooks/sources/:sourceId
```

### Connections

```txt
POST /api/connections/source/https-token
POST /api/connections/source/ssh-key
POST /api/connections/cloudflare/token
POST /api/connections/aws/assume-role
GET  /api/connections
POST /api/connections/:connectionId/test
POST /api/connections/:connectionId/revoke
```

### Installations

```txt
POST /api/spaces/:spaceId/installations
GET  /api/spaces/:spaceId/installations
GET  /api/installations/:installationId
PATCH /api/installations/:installationId
DELETE /api/installations/:installationId
```

### Dependencies

```txt
POST /api/installations/:installationId/dependencies
GET  /api/installations/:installationId/dependencies
DELETE /api/dependencies/:dependencyId
```

### Output shares

```txt
POST /api/output-shares
GET  /api/output-shares
POST /api/output-shares/:shareId/revoke
```

### Runs

```txt
POST /api/installations/:installationId/plan
POST /api/runs/:runId/approve
POST /api/runs/:runId/cancel
POST /api/installations/:installationId/destroy-plan
GET  /api/runs/:runId
GET  /api/runs/:runId/logs
GET  /api/runs/:runId/events
```

### Run groups

```txt
POST /api/spaces/:spaceId/plan-update
POST /api/run-groups/:runGroupId/approve
GET  /api/run-groups/:runGroupId
```

### Deployments

```txt
GET /api/installations/:installationId/deployments
GET /api/deployments/:deploymentId
POST /api/deployments/:deploymentId/rollback-plan
```

### Install link

```txt
GET /install?source=git::https://...
GET /install?git=https://...&ref=...&path=...
```

---

## 31. UI

### Space selector

```txt
@shota ▼
@takos
@family
+ New Space
```

### Space dashboard

```txt
@shota

Installations
Sources
Connections
Graph
Activity
Settings
Billing
```

### Installations view

```txt
core
  active
  outputs: base_domain, member_issuer

files
  active
  depends on: core
  outputs: attachments_bucket

talk
  active
  depends on: core, files
  outputs: public_url, websocket_url
```

### Graph view

```txt
core ───────▶ talk
  │            ▲
  ▼            │
files ─────────┘
```

### Install from Git

```txt
Install Service

Git URL:
[ https://git.example.com/takos/talk.git ]

Ref:
[ main ]

Path:
[ deploy ]

Install into:
[ @shota ]

Installation name:
[ talk ]

Mode:
[ OpenTofu module ]

[Continue]
```

### Plan summary

```txt
Changes

Create
+ Worker: talk-production
+ Route: /talk
+ Storage binding: attachments

Update
none

Delete
none

Inputs
base_domain        ← core.base_domain
member_issuer      ← core.member_issuer
attachments_bucket ← files.attachments_bucket

Connections
compute: default
storage: default
dns: default

Policy
passed

[Apply]
[Details]
```

---

## 32. Security invariants

```txt
1. Public API returns no raw secret
2. User source build runs in Container
3. Build phase receives build inputs only
4. Source phase receives Git credential only
5. Plan/apply phase receives provider credentials only
6. Apply uses saved plan
7. Apply verifies plan digest
8. Apply verifies source snapshot
9. Apply verifies dependency snapshot
10. Apply verifies state generation
11. Output publication uses allowlist
12. Sensitive output sharing requires explicit policy
13. Cross-Space sharing uses OutputShare
14. State, plan, raw outputs are encrypted artifacts
15. Logs pass through redaction
16. Destroy uses destroy plan and approval
```

credential の取り扱い原則:

- mint policy は vault 内で判定し、 caller の主張を信用しない。
- credential は arg / URL に書かず、 askpass file / key file / env で渡す。
- SSH は `StrictHostKeyChecking=yes` を強制する。

---

## 33. Backup / Export

Backup は2層。

### Control backup

Takosumi が管理する制御情報。

```txt
spaces
sources
connections metadata
installations
dependencies
runs
deployments
state snapshots
output snapshots
artifacts manifest
audit events
```

### Service data backup

Installation 固有データ。

```txt
messages
attachments
files
posts
profiles
```

BackupConfig。

```ts
type BackupConfig = {
  enabled: boolean;

  mode:
    | "none"
    | "artifact_export"
    | "provider_snapshot"
    | "custom_command";

  command?: string[];
  outputPath?: string;
};
```

---

## 34. MVP

最初に作る範囲。

```txt
Single Worker
Dashboard
Space作成
Operator default connections
Git URL Source
SourceSnapshot
core Installation
opentofu_module Installation
app_source Installation
External install link
Connection: Cloudflare token
Connection: Git HTTPS token
Connection: Git SSH key
Capability binding: default / connection / manual
Queue run
CoordinationObject lease
Container runner
R2 source/artifact/state
D1 ledger
Dependency: variable_injection
StateSnapshot
OutputSnapshot
Plan/Apply
Policy basic
Stale propagation
Activity
```

最初の公式 Installation。

```txt
core
talk
files
```

Talk も Files も Git URL から入る公式 Installation。

OutputShare / remote_state / published_output / backup 実装 / drift_check は MVP 外 (§35 Phase 8)。
型と logical schema は §27 のとおり先に定義するが、 実装は MVP 後。

---

## 35. 実装順序

### Phase 1: Foundation

```txt
Single Worker skeleton
D1 schema
R2 buckets
Queue
CoordinationObject
OpenTofuRunnerObject
Dashboard shell
```

### Phase 2: Connections

```txt
Operator default connections
Connection vault
Cloudflare token
Git token
Git SSH key
Capability binding
```

### Phase 3: Source

```txt
Git URL validation
Source record
SourceSnapshot
R2_SOURCE
External install link
Generic webhook
```

### Phase 4: Core Installation

```txt
core official module
generated root
tofu init
tofu plan
tofu apply
StateSnapshot
OutputSnapshot
Deployment
```

### Phase 5: Service Installation

```txt
opentofu_module install
app_source install
provider alias
capability binding
Plan/Apply
```

### Phase 6: Dependency Graph

```txt
installation_dependencies
variable_injection
DependencySnapshot
stale propagation
Graph UI
RunGroup basic
```

### Phase 7: Policy

```txt
provider allowlist
resource allowlist
scope boundary
action policy
dependency policy
output policy
quota
```

### Phase 8: Advanced

```txt
remote_state same-Space
OutputShare cross-Space
opentofu_root advanced
backup/export
migration
provider mirror/cache
```

---

## 36. Final canonical model

```txt
Takosumi = Space直下のOpenTofu Installation DAG Manager
```

```txt
Space
  GitHubのuser/orgに近い軽いowner namespace。
  billingはoptional。

Installation
  Space直下のOpenTofu root/state単位。

Source
  Git URL / ref / path / credential。

SourceSnapshot
  Git commit固定入力。

Connection
  operator default or space connection。

CapabilityBinding
  default / connection / manual / disabled。

Dependency
  OutputSnapshotからconsumer inputへの接続。

DependencySnapshot
  plan時の依存値固定。

StateSnapshot
  tfstate世代。

OutputSnapshot
  tofu output世代。

Run
  tofu init / plan / apply / destroy。

Deployment
  成功したapply。

Talk / Files / Blog
  Git URLから入るInstallation。
```

この構成で、OSS self-host と hosted SaaS の両方を同じモデルで扱える。Self-host では operator default connection が自分のリソースになり、hosted では operator default connection が運営側リソースになる。Space connection は capability ごとの上書きとして機能する。

---

## Appendix A: Build targets と alias seam

`takosumi/` は source module であり、 2 つの build target に in-process で組み込まれる:

- **Takosumi platform worker** (`deploy/platform/`, operator が `app.takosumi.com` で運用): accounts plane
  (bare-origin OIDC issuer) + 本 spec の control plane + dashboard SPA + OpenTofu runner container。
- **Takos product worker** (`takos/deploy/cloudflare/` template, self-hoster が自分の origin で運用): Takos product +
  embedded accounts plane + 本 spec の control plane を同一プロセスに持つ。

takos からは tsconfig path alias で source を直接参照する。 control plane は public route を takos 側に要求せず、
in-process fetch seam (handler export) 経由でも到達できる。 §28 / §29 の layout を変更するときはこの alias seam
(`takos/tsconfig.json` / `takosumi/tsconfig.json`) を同一変更で原子的に再ポイントする。

Takos は plain OpenTofu module として完結する self-hostable application であり、 Takosumi にとって何の特権もない。
Takos の self-host に Takosumi は不要 (この原則は本 spec でも不変)。
