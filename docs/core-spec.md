# Takosumi Core Specification

> **このドキュメントは Takosumi core の正本 (canonical spec) です。**
> 2026-06-07 改訂: OpenTofu Capsule DAG モデルを採用。reference docs、AGENTS.md、
> implementation docs が本書と矛盾する場合は本書を優先します。適合状況は
> [`core-conformance.md`](./core-conformance.md) に記録します。

## 1. 定義

**Takosumi は、Space 直下の OpenTofu Capsule DAG を管理する OSS control plane。**

ユーザーは Git URL から OpenTofu Capsule を Space にインストールする。Takosumi はその Capsule を正規化し、
生成した root module で包み、OpenTofu で plan / apply / destroy し、state・outputs・dependencies・credentials・
artifacts・activity・billing を管理する。

```txt
Space: @shota
  ├─ Installation: core
  ├─ Installation: files
  ├─ Installation: talk
  └─ Installation: blog

Dependency Graph:
  core.base_domain          -> files.base_domain
  core.base_domain          -> talk.base_domain
  core.member_issuer        -> talk.member_issuer
  files.attachments_bucket  -> talk.attachments_bucket
```

この構造は filesystem ではなく **D1 上の OpenTofu Capsule DAG**。R2 の保存パスは階層化するが、正本は
D1 の Space / Installation / Dependency / StateSnapshot / OutputSnapshot / Run。

## 2. コア思想

### 2.1 すべては Capsule

Takosumi にインストールされる単位はすべて **OpenTofu Capsule**。

```txt
OpenTofu Capsule =
  Git URLから取得できるOpenTofu configurationを、
  Takosumiが child module として呼べる形に正規化し、
  Takosumi generated root module で包んで実行する単位。
```

ユーザーから見ると、常にこれだけ。

```txt
Git URLからOpenTofu Capsuleをインストール
```

内部では Capsule Normalizer が互換性を判定し、必要なら runner の一時 workspace 上で module 化する。

### 2.2 Takosumi が root を所有する

Capsule の source 側は child module。Takosumi 側は root module。

```txt
Git Source
  -> SourceSnapshot
  -> Capsule Normalizer
  -> Takosumi Generated Root
       ├─ backend/state
       ├─ provider configuration
       ├─ credentials
       ├─ dependency injection
       ├─ policy boundary
       └─ module "service" { source = "../module" }
  -> tofu plan / apply
```

Provider configuration、backend、state、credential は Takosumi generated root が所有する。

### 2.3 OpenTofu-native

Takosumi の正本は OpenTofu の構造に合わせる。

```txt
入力値      = variables
出力値      = outputs
値交換      = outputs -> variables / remote_state
実行単位    = root module
再利用単位  = child module
実行計画    = tofu plan
反映        = tofu apply saved plan
状態        = tfstate
検査        = tofu show -json
provider   = OpenTofu provider
```

### 2.4 Space は軽い owner namespace

Space は GitHub の user / org に近い。

```txt
@shota
@takos
@family
@company
```

Space は作成者・所有者・権限・state namespace・connection・billing の単位。

### 2.5 Connections は default と override

Takosumi instance には operator default connections がある。

```txt
compute default
dns default
storage default
source default
```

Space は必要に応じて connection を追加し、capability ごとに default を上書きできる。

```txt
compute = default
dns     = connection: my-cloudflare-zone
storage = default
```

Self-host では operator default connection が自分のリソース。Hosted では operator default connection が運営側リソース。

## 3. 全体アーキテクチャ

```txt
Takosumi Instance
  ├─ Operator Default Connections
  │    ├─ compute
  │    ├─ dns
  │    ├─ storage
  │    └─ source
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
       │    ├─ UsageEvents
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

実行境界。

```txt
Takosumi Worker
  trusted control plane

Runner Container
  Git clone / normalize / build / OpenTofu execution boundary
```

## 4. OpenTofu Capsule Pipeline

すべての Installation は同じ pipeline を通る。

```txt
Git URL
  -> SourceSnapshot
  -> Capsule Normalizer
  -> Compatibility Report
  -> tofu init without provider credentials
  -> Capsule Gate
  -> Generated Root
  -> DependencySnapshot
  -> Credential Mint
  -> tofu plan -out=tfplan
  -> tofu show -json
  -> Policy Evaluation
  -> Approval
  -> Credential Re-mint
  -> tofu apply saved plan
  -> StateSnapshot
  -> OutputSnapshot
  -> Deployment
  -> Stale Propagation
```

Compatibility check は provider credential を mint しない。Provider credential は Capsule Gate 通過後の plan / apply /
destroy phase だけで mint する。

## 5. Capsule Normalizer

Capsule Normalizer は Git URL から取得した OpenTofu configuration を、Takosumi が扱える Capsule へ正規化する。

### 5.1 Compatibility levels

ユーザーには mode を選ばせず、互換性レベルとして表示する。

```txt
Ready
Auto-capsulized
Needs patch
Unsupported
```

#### Ready

そのまま child module として呼べる。

```txt
- reusable OpenTofu moduleとして成立
- provider configurationをrootへ委譲できる
- backendを持たない、または影響なし
- required_providersが明確
- variables / outputs が明確
- providerがallowlist内
- data sourceがallowlist内
- provisionerがpolicy内
```

#### Auto-capsulized

一時 workspace 上で安全に module 化できる。

```txt
backend "s3"        -> Takosumi managed state
provider "aws"      -> generated root provider
provider region     -> DeploymentProfile / provider config
root-like config     -> child module copy
```

UI 表示例。

```txt
Takosumi will adapt:
- backend "s3" -> Takosumi managed state
- provider "aws" -> default storage connection
- provider "cloudflare" -> default dns connection
```

#### Needs patch

安全な自動変換には少し修正が必要。

```txt
- provider configにcredential入力が含まれる
- required_providersが不足
- provider aliasesが不明確
- outputが不足
- data sourceが未許可
- module化に必要なvariableが足りない
```

UI 表示例。

```txt
Needs changes:
1. Move provider configuration to the caller.
2. Add required_providers.
3. Expose public_url as output.
```

#### Unsupported

ワンタッチ安全実行の範囲外。

```txt
- raw credentialをvariableとして要求
- local-exec / remote-execが本質的に必要
- external programが必要
- allowlist外providerが必要
- allowlist外data sourceが必要
- plan前にsecret data sourceを読む必要がある
- root backend/stateに強く依存
- import/state surgery前提
```

## 6. Capsule Gate

Capsule Gate は credential mint 前に実行する互換性・安全性検査。

```txt
SourceSnapshot
  -> Normalizer
  -> tofu init without provider credentials
  -> module tree scan
  -> Capsule Gate
  -> credential mint
```

Gate が見るもの。

```txt
- required_providers
- provider blocks
- backend blocks
- resource types
- data source types
- provisioners
- module sources
- provider aliases
- variables
- outputs
- dependency lock
- filesystem-sensitive expressions
```

Gate の出力は Compatibility Report に統合される。

```ts
type CapsuleCompatibilityReport = {
  id: string;
  sourceSnapshotId: string;

  level:
    | "ready"
    | "auto_capsulized"
    | "needs_patch"
    | "unsupported";

  findings: Array<{
    severity: "info" | "warning" | "error";
    code: string;
    message: string;
    path?: string;
    suggestion?: string;
  }>;

  providers: Array<{
    source: string;
    versionConstraint?: string;
    aliases: string[];
    allowed: boolean;
  }>;

  resources: Array<{
    type: string;
    count?: number;
    allowed: boolean;
  }>;

  dataSources: Array<{
    type: string;
    allowed: boolean;
  }>;

  provisioners: Array<{
    type: string;
    allowed: boolean;
  }>;

  normalizedObjectKey?: string;
  normalizedDigest?: string;

  createdAt: string;
};
```

## 7. Generated Root Module

Takosumi は必ず root module を生成する。

```hcl
terraform {
  required_providers {
    aws = {
      source = "hashicorp/aws"
    }

    cloudflare = {
      source = "cloudflare/cloudflare"
    }
  }
}

variable "takosumi_aws_storage" {
  type = object({
    access_key    = string
    secret_key    = string
    session_token = string
  })

  sensitive = true
  ephemeral = true
}

variable "takosumi_cloudflare_compute_token" {
  type      = string
  sensitive = true
  ephemeral = true
}

variable "takosumi_cloudflare_dns_token" {
  type      = string
  sensitive = true
  ephemeral = true
}

provider "aws" {
  alias      = "storage"
  region     = var.aws_storage_region
  access_key = var.takosumi_aws_storage.access_key
  secret_key = var.takosumi_aws_storage.secret_key
  token      = var.takosumi_aws_storage.session_token
}

provider "cloudflare" {
  alias     = "compute"
  api_token = var.takosumi_cloudflare_compute_token
}

provider "cloudflare" {
  alias     = "dns"
  api_token = var.takosumi_cloudflare_dns_token
}

module "service" {
  source = "../module"

  providers = {
    aws.storage         = aws.storage
    cloudflare.compute = cloudflare.compute
    cloudflare.dns     = cloudflare.dns
  }

  base_domain   = var.base_domain
  member_issuer = var.member_issuer
  service_slug  = var.service_slug
}
```

Capsule 側は普通の OpenTofu reusable module。

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

    aws = {
      source = "hashicorp/aws"
      configuration_aliases = [
        aws.storage
      ]
    }
  }
}

variable "base_domain" {
  type = string
}

variable "service_slug" {
  type = string
}

output "public_url" {
  value = "https://${var.base_domain}/${var.service_slug}"
}
```

Provider credentials は module-readable file、normal tfvars、public output に materialize しない。Generated root の
provider configuration だけが credential を受け取る。

## 8. Provider and credential handling

### 8.1 Credential classes

```txt
Operator root secret
  Worker secret / bootstrap secret

Operator connection
  instance default connection
  encrypted SecretBlob

Space connection
  Space-owned connection
  encrypted SecretBlob

Run credential
  run/phase/capability scoped temporary credential

App secret
  runtime secret for installed services
```

### 8.2 Credential phases

```txt
source phase
  Git credential

normalize phase
  no provider credential

build phase
  build inputs

plan phase
  provider credentials

apply phase
  provider credentials

destroy phase
  provider credentials
```

### 8.3 Mint request

```ts
type MintRequest = {
  runId: string;
  installationId: string;
  phase:
    | "source"
    | "normalize"
    | "build"
    | "plan"
    | "apply"
    | "destroy";

  capabilities: Array<
    | "source"
    | "compute"
    | "dns"
    | "storage"
    | "database"
    | "secrets"
  >;
};
```

### 8.4 Mint response

```ts
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

Provider credentials は module が読める normal tfvars file に materialize しない。Generated root の provider
configuration にだけ渡す。

### 8.5 Git source credentials

HTTPS token。

```txt
GIT_TERMINAL_PROMPT=0
GIT_ASKPASS=/tmp/takosumi-askpass
```

SSH key。

```txt
GIT_SSH_COMMAND="ssh -i /tmp/source_key -o UserKnownHostsFile=/tmp/known_hosts -o StrictHostKeyChecking=yes"
```

### 8.6 AWS operator connection

AWS は operator bootstrap から STS AssumeRole で run-scoped temporary credential を作る。

```txt
operator bootstrap credential
  -> sts:AssumeRole
  -> run-scoped temporary credential
  -> generated root provider config
```

AWS 側の制限。

```txt
- session policy
- permission boundary
- SCP
- resource prefix
- tag boundary
- region allowlist
- quota
```

## 9. Space

```ts
type Space = {
  id: string;

  handle: string;
  displayName: string;

  type:
    | "personal"
    | "organization";

  ownerUserId: string;

  billingAccountId?: string;

  createdAt: string;
  updatedAt: string;
};
```

Space が持つもの。

```txt
members
roles
sources
connections
installations
dependencies
output shares
state namespace
policy
activity
billing
```

## 10. Source

```ts
type Source = {
  id: string;
  spaceId: string;

  name: string;

  url: string;
  defaultRef: string;
  defaultPath: string;

  authConnectionId?: string;

  status:
    | "active"
    | "disabled"
    | "error";

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

SourceSnapshot。

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

## 11. Connection

```ts
type Connection = {
  id: string;

  scope:
    | "operator"
    | "space";

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

Operator default connections。

```ts
type OperatorConnectionDefault = {
  id: string;

  capability:
    | "source"
    | "compute"
    | "dns"
    | "storage"
    | "database"
    | "secrets";

  provider: string;
  connectionId: string;

  createdAt: string;
  updatedAt: string;
};
```

Capability binding。

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

## 12. Installation

```ts
type Installation = {
  id: string;

  spaceId: string;

  name: string;
  slug: string;

  sourceId: string;

  installConfigId: string;

  environment: string;

  currentDeploymentId?: string;
  currentStateGeneration: number;
  currentOutputSnapshotId?: string;

  compatibilityReportId?: string;

  status:
    | "pending"
    | "active"
    | "stale"
    | "error"
    | "disabled"
    | "destroyed";

  createdAt: string;
  updatedAt: string;
};
```

Installation full name。

```txt
@space/name
```

Example。

```txt
@shota/core
@shota/talk
@shota/files
@company/internal-chat
```

## 13. InstallConfig

InstallConfig は service-side config。

```ts
type InstallConfig = {
  id: string;

  spaceId?: string;

  name: string;

  trustLevel:
    | "official"
    | "trusted"
    | "space"
    | "raw";

  modulePath?: string;

  normalization: {
    allowBackendRewrite: boolean;
    allowProviderLift: boolean;
    allowAliasInjection: boolean;
  };

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

## 14. DeploymentProfile

```ts
type DeploymentProfile = {
  id: string;

  spaceId: string;
  installationId: string;
  environment: string;

  bindings: {
    source?: CapabilityBinding;
    compute?: CapabilityBinding;
    dns?: CapabilityBinding;
    storage?: CapabilityBinding;
    database?: CapabilityBinding;
    secrets?: CapabilityBinding;
  };

  createdAt: string;
  updatedAt: string;
};
```

Example。

```json
{
  "bindings": {
    "source": {
      "mode": "default"
    },
    "compute": {
      "mode": "default"
    },
    "dns": {
      "mode": "connection",
      "connectionId": "conn_space_cloudflare_zone"
    },
    "storage": {
      "mode": "default"
    }
  }
}
```

## 15. Dependencies

Dependency は Installation 同士の output/input 接続。

```ts
type Dependency = {
  id: string;

  spaceId: string;

  producerInstallationId: string;
  consumerInstallationId: string;

  mode:
    | "variable_injection"
    | "remote_state"
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

### 15.1 variable_injection

標準 mode。Producer output から `.auto.tfvars.json` を生成する。

```json
{
  "base_domain": "shota.example.com",
  "member_issuer": "https://shota.example.com/auth",
  "attachments_bucket": "talk-attachments"
}
```

### 15.2 remote_state

同一 Space の trusted dependency 用。

```hcl
data "terraform_remote_state" "core" {
  backend = "local"

  config = {
    path = "/work/deps/core.tfstate"
  }
}
```

### 15.3 published_output

Space 間共有用。

```txt
producer OutputSnapshot
  -> OutputShare
  -> consumer Space
  -> variable_injection
```

## 16. OutputSnapshot

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
  UI / summary / external display
```

Projection pipeline。

```txt
tofu output -json
  -> sensitive flag check
  -> InstallConfig outputAllowlist
  -> type validation
  -> OutputSnapshot
```

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

  mode:
    | "strict"
    | "pinned";

  createdAt: string;
};
```

Plan 時。

```txt
1. consumer Installation の dependencies を読む
2. producer OutputSnapshot を読む
3. 必要な値を固定
4. DependencySnapshot を作る
5. snapshot で tofu plan
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
strict
```

Preview / development default。

```txt
pinned
```

## 18. OutputShare

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
    | "compatibility_check"
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
  compatibilityReportId?: string;

  baseStateGeneration?: number;

  planDigest?: string;
  planArtifactKey?: string;

  policyStatus?:
    | "pass"
    | "warn"
    | "deny";

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

## 20. StateSnapshot

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

Generation guard。

```txt
Plan:
  baseStateGeneration = currentStateGeneration

Apply:
  currentStateGeneration == plan.baseStateGeneration
```

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

  status:
    | "active"
    | "superseded"
    | "rolled_back"
    | "destroyed";

  createdAt: string;
};
```

## 22. Runner

Execution path。

```txt
API request
  -> Run作成
  -> Queue投入
  -> Queue consumer
  -> CoordinationObject
  -> OpenTofuRunnerObject
  -> Runner Container
  -> git / normalize / tofu
```

Workspace。

```txt
/work
  /source
  /normalized
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
hcl parser / normalizer helper
```

Phases。

```txt
source
  Git credential

normalize
  no provider credential

build
  build inputs

plan
  provider credentials
  dependency values/states
  tofu plan

apply
  provider credentials
  saved plan
  tfstate

destroy
  provider credentials
  saved destroy plan
```

## 23. Run lifecycle

### 23.1 Source sync

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

### 23.2 Compatibility check

```txt
1. SourceSnapshot展開
2. Capsule Normalizer実行
3. generated normalized module作成
4. tofu init without provider credentials
5. module tree scan
6. Capsule Gate
7. CompatibilityReport保存
8. Run succeeded / failed
```

### 23.3 Plan

```txt
1. Plan Run作成
2. Installation lease取得
3. SourceSnapshot確定
4. CompatibilityReport確認
5. DependencySnapshot作成
6. current state generation取得
7. source/normalized module展開
8. dependencies展開
9. generated root作成
10. provider credential mint
11. tofu init
12. tofu plan -out=tfplan
13. tofu show -json tfplan
14. policy evaluation
15. cost estimate
16. credit reservation
17. plan artifact保存
18. Run waiting_approval / succeeded
```

### 23.4 Apply

```txt
1. Apply Run作成
2. 対象Plan Run取得
3. plan digest検証
4. source snapshot検証
5. compatibility report検証
6. dependency snapshot検証
7. current state generation検証
8. credit reservation確認
9. Installation lease取得
10. tfstate復元
11. dependencies復元
12. provider credential再mint
13. tofu apply saved plan
14. new tfstate保存
15. StateSnapshot generation +1
16. tofu output -json
17. OutputSnapshot作成
18. Deployment作成
19. UsageEvent確定
20. CreditReservation capture/release
21. downstream stale marking
```

### 23.5 Destroy

```txt
destroy_plan
  -> approval
  -> destroy_apply
```

## 24. Stale propagation

Producer output が変わると downstream Installation を stale にする。

```txt
core.base_domain changed
  -> files stale
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

RunGroup。

```txt
Space update

1. core
   ~ base_domain changed

2. files
   no changes

3. talk
   ~ variables changed

[Apply update]
```

## 25. Policy

Policy は2段階。

```txt
Capsule Gate
  credential mint前の静的/構造検査

Plan Policy
  tofu show -json 後のresource/action/scope検査
```

Layers。

```txt
1. Space policy
2. InstallConfig trust
3. compatibility level
4. provider allowlist
5. provider mirror / lockfile
6. data source allowlist
7. provisioner policy
8. resource type allowlist
9. action policy
10. scope boundary
11. dependency policy
12. output policy
13. quota
14. billing reservation
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
  trusted dependency

cross Space:
  OutputShare

sensitive output:
  explicit permission
```

## 26. Security invariants

```txt
1. Public API returns no raw secret
2. User source executes only in Runner Container
3. Provider credentials are root-only
4. Provider credentials are ephemeral
5. Provider credentials are not normal tfvars files
6. Source phase receives Git credential only
7. Normalize phase receives no provider credential
8. Build phase receives build inputs only
9. Plan/apply phase receives provider credentials only
10. Capsule Gate runs before provider credential mint
11. Apply uses saved plan
12. Apply verifies plan digest
13. Apply verifies source snapshot
14. Apply verifies compatibility report
15. Apply verifies dependency snapshot
16. Apply verifies state generation
17. Output publication uses allowlist
18. Sensitive output sharing requires explicit policy
19. Cross-Space sharing uses OutputShare
20. State, plan, raw outputs are encrypted artifacts
21. Logs pass through redaction
22. Destroy uses destroy plan and approval
23. Credential mint is audited
24. Provider install uses allowlist/mirror/lockfile policy
```

## 27. Storage layout

```txt
R2_SOURCE/
  spaces/{spaceId}/sources/{sourceId}/snapshots/{snapshotId}/
    source.tar.zst
    source.json

R2_ARTIFACTS/
  spaces/{spaceId}/installations/{installationId}/runs/{runId}/
    normalized-module.tar.zst
    generated-root.tar.zst
    build.log.ndjson.zst
    plan.bin.enc
    plan.json.zst.enc
    policy.json
    compatibility-report.json
    dependency-snapshot.json
    cost-estimate.json
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

## 28. Billing

### 28.1 Billing concept

課金単位は Space。

```txt
Space Plan
  基本料

Managed Credits
  operator default connectionを使うmanaged resourceとrunner usage

Space connection
  ユーザー側クラウド費用 + Takosumi管理料/runner usage

Manual
  Takosumi管理料/runner usage
```

Billing machinery は常に ledger として実装するが、operator / self-host 設定で mode を切り替える。

```txt
disabled
  billing ledger を表示せず、apply を止めない。self-host default。

showback
  cost estimate / usage capture を記録するが apply は止めない。

enforce
  credit reservation を plan/apply gate に入れる。hosted SaaS default。
```

### 28.2 Plans

```txt
Free
Pro
Team
Enterprise
Self-hosted
```

### 28.3 Credit Ledger

Apply 前に credit を見積もり、予約する。

```txt
tofu plan
  -> policy
  -> cost estimate
  -> credit reservation
  -> approval
  -> apply
  -> usage event
  -> capture/release reservation
```

### 28.4 Billing types

```txt
runner_minute
managed_compute
managed_storage_gb_hour
artifact_storage_gb_hour
backup_storage_gb_hour
egress_gb
operation
```

### 28.5 Billing models

```ts
type BillingAccount = {
  id: string;

  ownerType:
    | "user"
    | "space";

  ownerId: string;

  provider:
    | "stripe"
    | "manual"
    | "none";

  stripeCustomerId?: string;

  status:
    | "active"
    | "past_due"
    | "disabled"
    | "trialing";

  createdAt: string;
};

type SpaceSubscription = {
  id: string;

  spaceId: string;
  billingAccountId: string;
  planId: string;

  status:
    | "active"
    | "trialing"
    | "past_due"
    | "cancelled";

  currentPeriodStart: string;
  currentPeriodEnd: string;

  createdAt: string;
};

type CreditBalance = {
  spaceId: string;

  availableCredits: number;
  reservedCredits: number;

  monthlyIncludedCredits: number;
  purchasedCredits: number;

  updatedAt: string;
};

type UsageEvent = {
  id: string;

  spaceId: string;
  installationId?: string;
  runId?: string;

  kind:
    | "runner_minute"
    | "managed_compute"
    | "managed_storage_gb_hour"
    | "artifact_storage_gb_hour"
    | "backup_storage_gb_hour"
    | "egress_gb"
    | "operation";

  quantity: number;
  credits: number;

  source:
    | "runner"
    | "resource_meter"
    | "billing_reconciliation"
    | "manual_adjustment";

  idempotencyKey: string;

  createdAt: string;
};

type CreditReservation = {
  id: string;

  spaceId: string;
  runId: string;

  estimatedCredits: number;

  status:
    | "reserved"
    | "captured"
    | "released"
    | "expired";

  createdAt: string;
  expiresAt: string;
};
```

### 28.6 Apply UI

```txt
Billing impact

Takosumi credits:
+ 28 credits estimated

Included:
Runner: 3 credits
Managed compute: 20 credits/month
Managed storage: 5 credits/month

Your cloud accounts:
none

Available credits:
680

[Apply]
```

Space connection 使用時。

```txt
Billing impact

Takosumi credits:
+ 3 credits for runner

Your AWS:
S3 charges may apply

Connections:
storage = my-aws-role
```

Self-host。

```txt
Billing disabled
or
Showback mode
```

## 29. Backup / Export

Backup は2層。

### 29.1 Control backup

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

### 29.2 Service data backup

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

## 30. D1 schema

This is the logical D1 schema. Physical implementations may use Drizzle and compact JSON ledger columns, but the
logical records, uniqueness constraints, and cross-record references must preserve this model.

```sql
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE,
  name TEXT,
  avatar_url TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

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

CREATE TABLE space_members (
  space_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (space_id, user_id)
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
  trust_level TEXT NOT NULL,
  module_path TEXT,
  normalization_json TEXT NOT NULL,
  build_json TEXT,
  variable_mapping_json TEXT NOT NULL,
  output_allowlist_json TEXT NOT NULL,
  policy_json TEXT NOT NULL,
  backup_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE capsule_compatibility_reports (
  id TEXT PRIMARY KEY,
  source_snapshot_id TEXT NOT NULL,
  level TEXT NOT NULL,
  findings_json TEXT NOT NULL,
  providers_json TEXT NOT NULL,
  resources_json TEXT NOT NULL,
  data_sources_json TEXT NOT NULL,
  provisioners_json TEXT NOT NULL,
  normalized_object_key TEXT,
  normalized_digest TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE installations (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  source_id TEXT NOT NULL,
  install_config_id TEXT NOT NULL,
  environment TEXT NOT NULL,
  current_deployment_id TEXT,
  current_state_generation INTEGER NOT NULL DEFAULT 0,
  current_output_snapshot_id TEXT,
  compatibility_report_id TEXT,
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
  compatibility_report_id TEXT,
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
  status TEXT NOT NULL,
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

CREATE TABLE credential_mint_events (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  installation_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  phase TEXT NOT NULL,
  capabilities_json TEXT NOT NULL,
  actor_id TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE security_findings (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL,
  installation_id TEXT,
  run_id TEXT,
  severity TEXT NOT NULL,
  type TEXT NOT NULL,
  message TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE billing_accounts (
  id TEXT PRIMARY KEY,
  owner_type TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  stripe_customer_id TEXT,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE plans (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  monthly_base_price INTEGER NOT NULL,
  included_credits INTEGER NOT NULL,
  limits_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE space_subscriptions (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL,
  billing_account_id TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  status TEXT NOT NULL,
  current_period_start TEXT NOT NULL,
  current_period_end TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE credit_balances (
  space_id TEXT PRIMARY KEY,
  available_credits INTEGER NOT NULL,
  reserved_credits INTEGER NOT NULL,
  monthly_included_credits INTEGER NOT NULL,
  purchased_credits INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE usage_events (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL,
  installation_id TEXT,
  run_id TEXT,
  kind TEXT NOT NULL,
  quantity REAL NOT NULL,
  credits INTEGER NOT NULL,
  source TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

CREATE TABLE credit_reservations (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  estimated_credits INTEGER NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
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

## 31. Single Worker code layout

This is the canonical logical code layout for the product. Current physical paths may be in migration; conformance
tracks those differences.

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
        capsule-normalizer/
        capsule-gate/
        compatibility/
        installations/
        dependencies/
        outputs/
        runs/
        deployments/
        policy/
        state/
        artifacts/
        billing/
        backups/

      durable/
        CoordinationObject.ts
        OpenTofuRunnerObject.ts

      queue/
        consumer.ts

      scheduled/
        polling.ts
        cleanup.ts
        drift.ts
        billing.ts

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
    hcl/
    rootgen/
    normalizer/
    graph/
    policy/
    opentofu/
    billing/
    audit/

  opentofu-modules/
    core/
    cloudflare-worker-service/
    cloudflare-static-site/
    cloudflare-r2-storage/
    aws-s3-storage/
```

## 32. wrangler shape

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

## 33. API

Version prefix は置かず `/api` にまとめる。`/install` は public deep link で、dashboard session gate へ渡す。

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

### Capsule compatibility

```txt
POST /api/sources/:sourceId/compatibility-check
GET  /api/compatibility-reports/:reportId
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

### Billing

```txt
GET  /api/spaces/:spaceId/billing
GET  /api/spaces/:spaceId/usage
POST /api/spaces/:spaceId/credits/top-up
POST /api/spaces/:spaceId/subscription/change
```

### Install link

```txt
GET /install?source=git::https://...
GET /install?git=https://...&ref=...&path=...
```

## 34. UI

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
Billing
Settings
```

### Installations

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

### Graph

```txt
core -----> talk
  |          ^
  v          |
files -------+
```

### Install from Git

```txt
Install OpenTofu Capsule

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

[Check compatibility]
```

Compatibility result。

```txt
Compatibility:
Auto-capsulized

Takosumi will adapt:
- backend "s3" -> Takosumi managed state
- provider "aws" -> default storage connection
- provider "cloudflare" -> default dns connection

[Continue]
```

Inputs。

```txt
Inputs

base_domain
  <- core.base_domain

member_issuer
  <- core.member_issuer

attachments_bucket
  <- files.attachments_bucket
```

Plan summary。

```txt
Changes

Create
+ aws_s3_bucket.attachments
+ cloudflare_workers_script.talk
+ cloudflare_dns_record.talk

Update
none

Delete
none

Inputs
base_domain        <- core.base_domain
member_issuer      <- core.member_issuer
attachments_bucket <- files.attachments_bucket

Connections
compute: default
storage: default
dns: default

Policy
passed

Billing
28 credits estimated
680 credits available

[Apply]
[Details]
```

Needs patch。

```txt
Compatibility:
Needs patch

Reasons:
1. provider "aws" includes credential settings.
2. output "public_url" is missing.

Suggested changes:
- Move provider configuration to the caller.
- Add public_url output.
```

## 35. MVP

最初に作る範囲。

```txt
Single Worker
Dashboard
Space作成
Operator default connections
Connection vault
Git URL Source
SourceSnapshot
Capsule Normalizer basic
Compatibility Report
Capsule Gate basic
Generated Root
OpenTofu Capsule Installation
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
Credit Ledger basic
Apply credit reservation
Stale propagation
Activity
```

最初の公式 Capsule。

```txt
core
talk
files
```

## 36. 実装順序

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
Credential mint audit
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

### Phase 4: Capsule core

```txt
Capsule Normalizer basic
Generated Root Builder
Capsule Gate basic
Compatibility Report
provider allowlist
```

### Phase 5: core Installation

```txt
core official Capsule
tofu init
tofu plan
tofu apply
StateSnapshot
OutputSnapshot
Deployment
```

### Phase 6: Capsule Installation

```txt
OpenTofu Capsule install
provider alias
capability binding
Plan/Apply
```

### Phase 7: Dependency Graph

```txt
installation_dependencies
variable_injection
DependencySnapshot
stale propagation
Graph UI
RunGroup basic
```

### Phase 8: Policy

```txt
provider allowlist
resource allowlist
data source allowlist
provisioner policy
scope boundary
action policy
output policy
quota
```

### Phase 9: Billing

```txt
Space plan
CreditBalance
UsageEvent
CreditReservation
Apply estimate
Apply reservation
Stripe subscription integration
```

### Phase 10: Advanced

```txt
remote_state same-Space
OutputShare cross-Space
Auto-capsulized provider/backend lift
backup/export
migration
provider mirror/cache
```

## 37. 最終正本

```txt
Takosumi = Space直下のOpenTofu Capsule DAG Manager
```

```txt
Space
  GitHubのuser/orgに近い軽いowner namespace。
  billingはoptional。

Capsule
  Git URLから取得したOpenTofu configurationを
  Takosumi generated rootで包んで実行する単位。

Installation
  Capsule + environment + state + outputs + deployments。

SourceSnapshot
  Git commit固定入力。

Capsule Normalizer
  OpenTofuをTakosumi Capsuleに正規化する。

Compatibility Report
  Ready / Auto-capsulized / Needs patch / Unsupported。

Capsule Gate
  credential mint前の互換性・安全性検査。

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

Billing
  Space plan + managed credits + apply reservation。
```

この仕様で、OpenTofu ecosystem を使いながら、顧客の Git URL をワンタッチで安全寄りにインストールできる。鍵は
generated root の provider configuration に閉じ、Capsule Gate と plan policy と IAM/connection boundary で不正利用を
抑え、互換性は Compatibility Report で明確に出す。
