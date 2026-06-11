# Takosumi Core Specification

> **このドキュメントは Takosumi core の正本 (canonical spec) です。**
> 2026-06-08 改訂: OpenTofu Capsule DAG + Provider Template / Provider Env Set モデルを採用。reference docs、AGENTS.md、
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

### 2.0 Product concept

```txt
SaaSを借りるのではなく、自分のSpaceにCapsule Installationとして持つ。
```

Talk / Files / Blog / Calls のような機能は Takosumi に内蔵しない。すべて Git URL から入る OpenTofu Capsule Installation。

```txt
@shota/talk
@shota/files
@family/talk
@company/internal-chat
```

外部サイトは `Install to Takosumi` 導線を置ける。

```txt
https://app.takosumi.com/install?source=git::https://git.example.com/takos/talk.git//deploy?ref=main
```

### 2.1 すべては Capsule

Takosumi にインストールされる単位はすべて **OpenTofu Capsule**。

```txt
OpenTofu Capsule =
  Git URLから取得できるOpenTofu configurationを、
  Takosumiが child module として呼べる形に正規化し、
  Takosumi generated root module で包んで実行する単位。
```

ユーザーから見ると、Capsule の入口は 2 つある。

```txt
1. takosumi deploy <dir>  — ローカル Capsule を upload（既定。wrangler deploy 相当）
2. Git Source を connect   — push で source_sync（任意の add-on。Workers Builds 相当）
```

どちらも **SourceSnapshot**（digest 付き R2 artifact）を生み、そこから先（Capsule Gate / 正規化 / plan / apply /
DAG）は出自に依存しない。`SourceSnapshot.origin` が `git` か `upload` かを区別する。git は Installation の前提では
なく任意機能であり、`Installation.sourceId` は upload 由来では存在しない。

内部では Capsule Normalizer が互換性を判定し、必要なら runner の一時 workspace 上で module 化する。

### 2.1.1 Upload origin（`takosumi deploy`）

`takosumi deploy` はローカル作業ディレクトリを `tar --zstd` で固めて `POST /api/spaces/:id/uploads` に送る。worker は
R2_SOURCE に保存して `origin: "upload"` の SourceSnapshot を記録し、`POST /api/deploy` が `@space/name` Installation を
解決/作成（無ければ既定 InstallConfig を合成）して、その upload snapshot を pin した plan Run を起こす。runner は
plan/apply 時に snapshot の `archiveObjectKey` から R2 を復元する（git を再 clone しない）ので、upload も git も同じ
実行経路を通る。CLI は credential を一切扱わず、bundle / upload / Run トリガ / 表示だけを担う。

### 2.2 Takosumi が root を所有する

Capsule の source 側は child module。Takosumi 側は root module。

```txt
Git Source
  -> SourceSnapshot
  -> Capsule Normalizer
  -> Takosumi Generated Root
       ├─ backend/state
       ├─ provider configuration
       ├─ root-only credential injection points
       ├─ dependency injection
       ├─ policy boundary
       └─ module "service" { source = "./template-module" }
  -> tofu plan / apply
```

Provider configuration、backend、state、credential injection の形は Takosumi generated root が所有する。外部 credential
の正本は Connection / SecretBlob / Vault にあり、Runner へは credential mint phase ごとに root-only provider variables として
渡す。

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
cloudflare default
aws default
gcp default
source default
```

Space は必要に応じて connection を追加し、provider binding ごとに default を上書きできる。

```txt
cloudflare.main = default
cloudflare.zone = connection: my-cloudflare-zone
aws.archive     = connection: my-aws-role
```

Self-host では operator default connection が自分のリソース。Hosted では operator default connection が運営側リソース。

### 2.6 Provider support has two user-facing kinds

Takosumi は Cloudflare から始めるが、Cloudflare 専用 control plane ではない。AWS / GCP / GitHub / Kubernetes /
Docker / その他 OpenTofu provider は、ユーザーから見ると次の2種類だけで扱う。

```txt
Takosumi提供
  Hosted / operator が提供する managed provider。
  operator default Connection から run-scoped credential を mint する。
  初期は Cloudflare only。

ユーザーenvセット
  Space が所有する provider credential set。
  AWS / GCP / Cloudflare / GitHub / Kubernetes / 任意 provider はここから使える。
```

OAuth / AssumeRole / impersonation / token vending は第3の provider kind ではない。ユーザーenvセットまたは
Takosumi提供 credential を作成・更新・mint するための helper である。

Hosted production Worker に Cloudflare / AWS / GCP などの provider credential を raw Worker env として常駐させない。
provider credential の正本は `Connection` と sealed `SecretBlob` / Vault material であり、runner へ渡る credential は
run / phase / provider scoped に mint され、generated root の root-only provider configuration にだけ供給する。

したがって、将来 AWS / GCP / その他 provider を hosted managed default に昇格しても、追加するのは raw
`AWS_ACCESS_KEY_ID` や `GOOGLE_APPLICATION_CREDENTIALS` のような ambient Worker env ではない。追加されるのは
operator default Connection、policy pack、cost model、scope boundary、credential mint strategy、quota / abuse control、
rotation / audit evidence である。

### 2.7 App data-plane schema migration

app の DB schema migration は Capsule の責務。Takosumi core は migration の専用概念・専用 Run type を追加しない。
migration は既存の plan / apply ledger に乗るだけである。

推奨形は、migration を provider resource として Capsule 内に宣言し、apply 中に実行すること。

```txt
pending migration -> plan diff に現れる
migration 失敗    -> apply 失敗として Run に記録、Deployment は前世代のまま
```

ordering は resource dependency で表す。

```txt
database -> migration resource -> worker/script resource
```

migration は forward-only。rollback 互換は expand / contract で Capsule 作者が担保する。provider resource state の
汎用 rollback が OpenTofu module の範囲であるのと同じ整理である。

例外が 2 つある。Durable Object migration tag は worker script artifact upload の領域。container-local storage
(例: Git container の SQLite) は boot-time migration が唯一の経路。

Capsule 内部実装としての boot-time lazy migration は禁止しないが、Run ledger の外で失敗する点に留意する。ledger 形
(version / name / checksum / applied_at、forward-only) の推奨は ecosystem の migration runner contract に従う。

## 3. 全体アーキテクチャ

```txt
Takosumi Instance
  ├─ Operator Default Connections
  │    ├─ source
  │    ├─ cloudflare
  │    └─ future provider defaults
  ├─ Provider Templates
  │
  └─ Spaces
       ├─ @shota
       │    ├─ Sources
       │    ├─ Connections
       │    ├─ Provider Env Sets
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
  -> Billing / Credit Reservation
  -> Approval
  -> Credential Re-mint
  -> tofu apply saved plan
  -> StateSnapshot
  -> OutputSnapshot
  -> Deployment
  -> Stale Propagation
```

Compatibility check は provider credential を mint しない。Compatibility Report は Capsule Normalizer が draft を作り、
Capsule Gate が credential mint 前に評価し、Gate findings を含む finalized report として保存する。Provider credential は
Capsule Gate 通過後の plan / apply / destroy phase だけで mint する。

Hosted Takosumi の Takosumi提供 provider は最初 **Cloudflare only** とする。AWS / GCP / GitHub / Kubernetes /
任意 provider はユーザーenvセットとして Space-owned Connection から使う。Self-host operator は hosted conformance の外側で、
自分の責任により任意 provider を operator default に設定できる。

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
provider region     -> ProviderBinding resolution / provider config
root-like config     -> child module copy
```

UI 表示例。

```txt
Takosumi will adapt:
- backend "s3" -> Takosumi managed state
- provider "aws" -> Space AWS connection
- provider "cloudflare" -> default Cloudflare connection
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

Gate の出力は、Normalizer が作った Compatibility Report draft に統合され、finalized Compatibility Report として保存される。

```ts
type CapsuleCompatibilityReport = {
  id: string;
  sourceSnapshotId: string;

  level: "ready" | "auto_capsulized" | "needs_patch" | "unsupported";

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
    credentialSources?: Array<"takosumi_managed" | "user_env_set">;
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

  // Auto-capsulized の場合、backend/provider lift 後の正規化 artifact。
  // Ready の場合は未設定でよい。
  normalizedObjectKey?: string;
  normalizedDigest?: string;

  createdAt: string;
};
```

## 7. Provider Templates

Provider Templates は、OpenTofu provider source を UI / compatibility / env-set helper に接続する lightweight catalog。
Takosumi は provider registry を置き換えない。未知 provider でも、ユーザーenvセットに必要な env 名を登録できる。

```ts
type ProviderCredentialSource = "takosumi_managed" | "user_env_set";

type ProviderCredentialHelper =
  | "cloudflare_api_token"
  | "cloudflare_oauth"
  | "aws_assume_role"
  | "gcp_oauth_bootstrap"
  | "gcp_service_account_impersonation"
  | "generic_env";

type ProviderTemplate = {
  id: string;

  providerSource: string;
  displayName: string;

  recommendedEnvNames: string[];
  helpers: ProviderCredentialHelper[];
  credentialSources: ProviderCredentialSource[];
  takosumiManagedAvailable: boolean;

  allowedResources: string[];
  allowedDataSources: string[];

  policyPackId: string;
  costEstimatorId?: string;

  docsUrl?: string;

  createdAt: string;
  updatedAt: string;
};
```

Provider Template は provider を Takosumi 固定用途分類へ分けない。分類は
OpenTofu provider source、credential source、helper、policy、recommended env names で表す。Provider alias は
OpenTofu child module が要求する任意 alias であり、Takosumi の product category ではない。

### 7.1 Credential sources

```txt
takosumi_managed:
  operator default Connection で解決する。
  初期は Cloudflare only。

user_env_set:
  Space-owned Connection で解決する。
  AWS / GCP / Cloudflare / GitHub / Kubernetes / unknown provider まで扱える。
```

Unknown provider を見つけた Compatibility Report は、ユーザーenvセット追加 UI へ誘導する。

### 7.2 Initial templates

Cloudflare。

```json
{
  "id": "cloudflare",
  "providerSource": "registry.opentofu.org/cloudflare/cloudflare",
  "displayName": "Cloudflare",
  "recommendedEnvNames": ["CLOUDFLARE_API_TOKEN"],
  "helpers": ["cloudflare_api_token", "cloudflare_oauth"],
  "credentialSources": ["takosumi_managed", "user_env_set"],
  "takosumiManagedAvailable": true,
  "allowedResources": [
    "cloudflare_workers_script",
    "cloudflare_workers_route",
    "cloudflare_dns_record",
    "cloudflare_r2_bucket"
  ],
  "allowedDataSources": [],
  "policyPackId": "cloudflare-default",
  "costEstimatorId": "cloudflare-basic"
}
```

AWS。

```json
{
  "id": "aws",
  "providerSource": "registry.opentofu.org/hashicorp/aws",
  "displayName": "AWS",
  "recommendedEnvNames": [
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
    "AWS_REGION"
  ],
  "helpers": ["aws_assume_role", "generic_env"],
  "credentialSources": ["user_env_set"],
  "takosumiManagedAvailable": false,
  "allowedResources": ["aws_s3_bucket", "aws_s3_bucket_public_access_block"],
  "allowedDataSources": [],
  "policyPackId": "aws-basic"
}
```

Google Cloud。

```json
{
  "id": "gcp",
  "providerSource": "registry.opentofu.org/hashicorp/google",
  "displayName": "Google Cloud",
  "recommendedEnvNames": [
    "GOOGLE_CREDENTIALS",
    "GOOGLE_APPLICATION_CREDENTIALS",
    "GOOGLE_CLOUD_PROJECT"
  ],
  "helpers": [
    "gcp_oauth_bootstrap",
    "gcp_service_account_impersonation",
    "generic_env"
  ],
  "credentialSources": ["user_env_set"],
  "takosumiManagedAvailable": false,
  "allowedResources": ["google_storage_bucket", "google_cloud_run_v2_service"],
  "allowedDataSources": [],
  "policyPackId": "gcp-basic"
}
```

GitHub / Kubernetes / unknown provider は `user_env_set` として扱う。template がない provider でも、env 名を明示して
`provider_env_set` Connection を作成できる。

### 7.3 Takosumi提供 promotion

operator は特定の Provider Template を `takosumi_managed` へ昇格できる。昇格は template の
`takosumiManagedAvailable: true` と、`credentialSources` への `takosumi_managed` 追加で表す。Security invariant 25
(「explicitly promoted to Takosumi提供」) の正式な経路はこの昇格である。

昇格しても provider install の allowlist / lockfile / mirror policy と plan policy は免除されない。
`allowedResources` / `allowedDataSources` は template で pin する。

昇格の典型対象は、Takosumi 自身が所有・公開する official provider。

```txt
例: D1 schema-migration provider (planned / 未実装)
  Capsule 内の DB schema migration を apply 中に実行する resource を提供する。
  Cloudflare API のみを呼ぶ。
```

`takosumi_managed` の credential 解決は引き続き初期 Cloudflare operator default connection のみであり、7.1 の定義を
変更しない。

## 8. Provider Env Set

Provider Env Set は、ユーザーが Space に登録する provider credential set。値は write-only で、public API は `envNames`
だけを返す。

```ts
type ProviderEnvSetConnection = Connection & {
  kind: "provider_env_set";
  provider: string;
  envNames: string[];
};
```

作成 API。

```txt
POST /api/connections/provider-env-set
```

例。

```json
{
  "spaceId": "space_shota",
  "provider": "registry.opentofu.org/vercel/vercel",
  "kind": "provider_env_set",
  "values": {
    "VERCEL_API_TOKEN": "..."
  }
}
```

Provider helper。

```txt
Cloudflare token helper:
  POST /api/connections/cloudflare/token

AWS AssumeRole helper:
  POST /api/connections/aws/assume-role

Future GCP helper:
  OAuth bootstrap / service account impersonation
```

helper は provider kind ではない。最終的には Connection / SecretBlob / envNames に正規化される。

## 10. Generated Root Module

Takosumi は、すべての OpenTofu Capsule plan / apply / destroy に root module を生成する。

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

variable "takosumi_aws_archive" {
  type = object({
    access_key    = string
    secret_key    = string
    session_token = string
  })

  sensitive = true
  ephemeral = true
}

variable "takosumi_cloudflare_main_token" {
  type      = string
  sensitive = true
  ephemeral = true
}

variable "takosumi_cloudflare_zone_token" {
  type      = string
  sensitive = true
  ephemeral = true
}

variable "aws_archive_region" {
  type = string
}

variable "base_domain" {
  type = string
}

variable "member_issuer" {
  type = string
}

variable "service_slug" {
  type = string
}

provider "aws" {
  alias      = "archive"
  region     = var.aws_archive_region
  access_key = var.takosumi_aws_archive.access_key
  secret_key = var.takosumi_aws_archive.secret_key
  token      = var.takosumi_aws_archive.session_token
}

provider "cloudflare" {
  alias     = "main"
  api_token = var.takosumi_cloudflare_main_token
}

provider "cloudflare" {
  alias     = "zone"
  api_token = var.takosumi_cloudflare_zone_token
}

module "service" {
  source = "./template-module"

  providers = {
    aws.archive    = aws.archive
    cloudflare.main = cloudflare.main
    cloudflare.zone = cloudflare.zone
  }

  base_domain   = var.base_domain
  member_issuer = var.member_issuer
  service_slug  = var.service_slug
}
```

Capsule 側は普通の OpenTofu reusable module。
概念図では child module と root module を分けて示すが、reference runner は normalized or source module files を
generated root workspace の `./template-module` に materialize してこの `source` で呼ぶ。

```hcl
terraform {
  required_providers {
    cloudflare = {
      source = "cloudflare/cloudflare"
      configuration_aliases = [
        cloudflare.main,
        cloudflare.zone
      ]
    }

    aws = {
      source = "hashicorp/aws"
      configuration_aliases = [
        aws.archive
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

## 11. Provider and credential handling

### 11.1 Credential classes

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
  run/phase/provider scoped temporary credential

Installation runtime secret
  workload integration secret for installed services
```

### 11.2 Credential phases

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

Compatibility / normalize / gate は provider credential mint を作らない。SourceSnapshot 展開、Normalizer、`tofu init`
without provider credentials、Capsule Gate は credential mint 前に完了する。
Provider を必要とする plan / apply / destroy は Connection Vault が利用できない場合、runner dispatch 前に fail-closed する。
Runner の ambient provider env に fallback してはいけない。`requiredProviders` が空の provider-free run だけが credential bundle
なしで dispatch できる。

### 11.3 Mint request

```ts
type MintRequest =
  | {
      runId: string;
      spaceId: string;
      phase: "source";
      sourceId: string;
      sourceConnectionId?: string;
      capabilities: ["source"];
    }
  | {
      runId: string;
      spaceId: string;
      installationId: string;
      phase: "build" | "plan" | "apply" | "destroy";
      connectionIds?: string[];
      providerBindings: Array<{
        provider: string;
        alias?: string;
      }>;
    };
```

### 11.4 Mint response

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

Mint audit は secret 値を保存しないが、provider credential の delivery / TTL evidence を保存する。

```ts
type ProviderCredentialMintEvidence = {
  connectionId: string;
  provider: string;
  delivery: "provider_env" | "generated_root_variable";
  rootOnly: boolean;
  temporary: boolean;
  ttlEnforced: boolean;
  expiresAt?: string;
  ttlSeconds?: number;
  issuer?:
    | "aws_sts_assume_role"
    | "cloudflare_api_token_vending"
    | "static_secret";
};
```

AWS AssumeRole mint は STS `Expiration` を必須にし、`expiresAt` / `ttlSeconds` を evidence として記録する。
Cloudflare token-vending Connection は sealed bootstrap token を runner に渡さず、Cloudflare `POST /user/tokens` で
`expires_on` 付き run-scoped token を作り、生成 token だけを generated root provider variable に渡す。Cloudflare response が
token value または `expires_on` を返さない場合は fail-closed にする。
Static provider secret はユーザーenvセットとして許可できる。operator managed default は provider が
対応する限り temporary / TTL evidence を要求する。Space-owned static secret は Connection policy、ProviderBinding、
provider policy、runner policy で境界付ける。Connection に `expiresAt` がある
static secret は、期限切れ後の mint/test を fail-closed し、期限内 mint では `ttlEnforced=true` / `expiresAt` /
`ttlSeconds` を evidence として記録する。`expiresAt` のない static secret は `ttlEnforced=false`。
Generated root 変数 (`TF_VAR_<provider>_<alias>_<arg>`) で渡した credential は `rootOnly=true` として audit する。
ProviderBinding-resolved Installation では、rootgen が provider credential arg mapping を持つ provider (Cloudflare / AWS など)
は generated root 変数だけを runner dispatch に載せる。runner は shared provider env payload と ambient provider env を
tofu subprocess に渡さない。arg mapping がない provider は credential-free alias になり、root-only mapping が追加されるまで
provider credential delivery は unsupported。
Space policy / InstallConfig policy は provider credential evidence に対して fail-closed 条件を要求できる。
`providerCredentials.requireTemporary` は provider/driver が temporary credential を発行できる場合に static provider secret を
拒否し、`requireTtlEnforced` は provider-enforced expiry / TTL がない mint を拒否し、`requireRootOnly` は root-only delivery
evidence を必須にする。policy failure は runner dispatch 前に Plan / Apply / Destroy Run を失敗させるが、non-secret mint audit
は残す。
Provider credential mint 自体に必要な Vault / Connection がない場合も runner dispatch 前に失敗し、credential-less provider
execution や ambient env fallback は行わない。

Provider credentials は module が読める normal tfvars file に materialize しない。Generated root の provider
configuration にだけ渡す。

### 11.5 Git source credentials

Git credentials are minted only for `phase = "source"` and only from source-capable Connections. The exact environment
variables and credential files are runner implementation details and are not part of the public Capsule contract.

### 11.6 AWS Space connection via AssumeRole

AWS は verified Space provider として、Space-owned AWS assume-role Connection から STS AssumeRole で run-scoped
temporary credential を作る。Self-host operator は自分の責任で AWS を operator default に昇格できるが、hosted managed
default は Cloudflare only から始める。

```txt
space connection / optional operator-promoted bootstrap credential
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

## 12. Space

```ts
type Space = {
  id: string;

  handle: string;
  displayName: string;

  type: "personal" | "organization";

  ownerUserId: string;

  billingAccountId?: string;
  billingSettings?: BillingSettings;

  policy?: PolicyConfig;

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
provider templates
provider env sets
installations
dependencies
output shares
state namespace
policy
activity
billing
```

## 13. Source

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

## 14. Connection

```ts
type Connection = {
  id: string;

  scope: "operator" | "space";

  spaceId?: string;

  provider: string;

  kind?:
    | "source_git_https_token"
    | "source_git_ssh_key"
    | "cloudflare_oauth"
    | "cloudflare_api_token"
    | "aws_assume_role"
    | "gcp_oauth_bootstrap"
    | "gcp_service_account_impersonation"
    | "static_secret"
    | "manual";

  authMethod:
    | "static_secret"
    | "aws_assume_role"
    | "oauth"
    | "impersonation"
    | "api_token"
    | "kubeconfig"
    | "generic_env"
    | "manual";

  displayName?: string;

  status: "pending" | "verified" | "revoked" | "expired" | "error";

  scopeHints?: {
    accountId?: string;
    zoneId?: string;
    templateId?: string;
    awsRoleArn?: string;
    awsExternalId?: string;
    awsRegion?: string;
    gcpServiceAccountEmail?: string;
    gcpProjectId?: string;
    knownHostsEntry?: string;
    username?: string;
    cloudflareTokenVending?: CloudflareTokenVendingConfig;
  };

  envNames: string[];

  createdAt: string;
  updatedAt: string;
  verifiedAt?: string;
  expiresAt?: string;
};
```

Public Connection records never return raw secret values. `envNames` is only the provider environment variable names that
the Connection can supply; values live in sealed `SecretBlob` rows and are released only by the Vault broker during an
allowed credential mint phase. For Cloudflare token-vending Connections, `scopeHints` may include non-secret vending
policy. The sealed bootstrap token stays in `SecretBlob`; the policy ids, resource selectors, and TTL are public
control-plane metadata.

```ts
type CloudflareTokenVendingConfig = {
  policies: Array<{
    id?: string;
    effect: "allow" | "deny";
    permission_groups: Array<{
      id: string;
      meta?: Record<string, string>;
      name?: string;
    }>;
    resources: Record<string, unknown>;
  }>;

  ttlSeconds?: number;
  namePrefix?: string;
  condition?: Record<string, unknown>;
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
    | "cloudflare_oauth_refresh_token"
    | "cloudflare_api_token"
    | "aws_external_id"
    | "gcp_oauth_refresh_token"
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

Operator default connections。Hosted managed default は Cloudflare only から始める。AWS / GCP / GitHub /
Kubernetes などは verified Space provider として Space-owned Connection によって使い、Self-host operator は自分の責任で
任意 provider を operator default に昇格できる。

```ts
type OperatorConnectionDefault = {
  id: string;

  provider: string;
  connectionId: string;

  createdAt: string;
  updatedAt: string;
};
```

Provider binding。

```ts
type ProviderBinding = {
  provider: string;
  alias?: string;

  mode: "default" | "connection" | "manual" | "disabled";

  connectionId?: string;
  region?: string;

  values?: Record<string, unknown>;
};
```

ProviderBinding は fail-closed。`default` が operator default connection に解決できない場合、`connection` の
connection が存在しない / provider に合わない場合、または `manual` / `disabled` の binding を provider credential として
要求された場合、Takosumi は Space-wide provider connection を探索して fallback せず plan/apply/destroy を止める。

## 15. Installation

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

  status: "pending" | "active" | "stale" | "error" | "disabled" | "destroyed";

  createdAt: string;
  updatedAt: string;
};
```

Installation full name。

```txt
@space/name
```

Example。provider binding で Cloudflare default と Space AWS connection を組み合わせる形。

```txt
@shota/core
@shota/talk
@shota/files
@company/internal-chat
```

## 16. InstallConfig

InstallConfig は service-side config。

```ts
type InstallConfig = {
  id: string;

  spaceId?: string;

  name: string;

  trustLevel: "official" | "trusted" | "space" | "raw";

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

  outputAllowlist: Record<
    string,
    {
      from: string;
      type: "string" | "url" | "hostname" | "number" | "boolean" | "json";
      required?: boolean;
    }
  >;

  policy: PolicyConfig;

  backup?: BackupConfig;

  createdAt: string;
  updatedAt: string;
};
```

## 17. DeploymentProfile / ProviderBinding

DeploymentProfile は Installation / environment ごとの provider binding set。ProviderBinding は provider ごとの
実行時 binding。API / UI は Installation の provider / credential resolution をこの model で説明する。

```ts
type DeploymentProfile = {
  id: string;

  spaceId: string;
  installationId: string;
  environment: string;

  bindings: ProviderBinding[];

  createdAt: string;
  updatedAt: string;
};
```

Example。

```json
{
  "bindings": [
    {
      "provider": "cloudflare",
      "alias": "main",
      "mode": "default"
    },
    {
      "provider": "cloudflare",
      "alias": "zone",
      "mode": "connection",
      "connectionId": "conn_space_cloudflare_zone"
    },
    {
      "provider": "aws",
      "alias": "archive",
      "mode": "connection",
      "connectionId": "conn_space_aws_role",
      "region": "us-east-1"
    }
  ]
}
```

## 18. Dependencies

Dependency は Installation 同士の output/input 接続。

```ts
type Dependency = {
  id: string;

  spaceId: string;

  producerInstallationId: string;
  consumerInstallationId: string;

  mode: "variable_injection" | "remote_state" | "published_output";

  outputs: Record<
    string,
    {
      from: string;
      to: string;
      required: boolean;
      type?: "string" | "url" | "hostname" | "number" | "boolean" | "json";
    }
  >;

  visibility: "space" | "cross_space";

  createdAt: string;
};
```

### 18.1 variable_injection

標準 mode。Producer output から `.auto.tfvars.json` を生成する。

```json
{
  "base_domain": "shota.example.com",
  "member_issuer": "https://shota.example.com/auth",
  "attachments_bucket": "talk-attachments"
}
```

### 18.2 remote_state

同一 Space の trusted dependency 用。

```hcl
data "terraform_remote_state" "core" {
  backend = "local"

  config = {
    path = "/work/deps/core.tfstate"
  }
}
```

### 18.3 published_output

Space 間共有用。

```txt
producer OutputSnapshot
  -> OutputShare
  -> consumer Space
  -> variable_injection
```

## 19. OutputSnapshot

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

## 20. DependencySnapshot

Plan 時に依存入力を固定する。

```ts
type DependencySnapshot = {
  id: string;

  runId: string;

  dependencies: Array<{
    dependencyId: string;
    producerInstallationId: string;
    producerStateGeneration: number;
    producerStateSnapshotId?: string;
    producerStateObjectKey?: string;
    producerStateDigest?: string;
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
1. consumer Installation の dependencies を読む
2. producer OutputSnapshot / StateSnapshot を読む
3. 必要な値と remote_state 用 state bytes pointer を固定
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

## 21. OutputShare

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

  status: "pending" | "active" | "revoked";

  createdAt: string;
  revokedAt?: string;
};
```

UI example。

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

## 22. Run

```ts
type Run = {
  id: string;

  runGroupId?: string;

  spaceId: string;
  installationId?: string;
  sourceId?: string;
  environment?: string;

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

  policyStatus?: "pass" | "warn" | "deny";

  errorCode?: string;

  createdBy: string;

  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
};
```

`source_sync` / `compatibility_check` Run は Source-scoped なので `sourceId` を持ち、`installationId` / `environment` を持たない。
Installation-bound Run (`plan` / `apply` / `destroy_*` / `drift_check` / `backup` / `restore`) は `installationId` と
`environment` を持つ。

RunGroup。

```ts
type RunGroup = {
  id: string;

  spaceId: string;

  type:
    | "space_update"
    | "space_drift_check"
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

## 23. StateSnapshot

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

## 24. Deployment

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

  status: "active" | "superseded" | "rolled_back" | "destroyed";

  createdAt: string;
};
```

## 25. Runner

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

## 26. Cloudflare compute adapters

Takosumi hosted の初期 managed backend は Cloudflare。Cloudflare adapter は2種類。

```txt
cloudflare-direct-worker
cloudflare-workers-for-platforms
```

### 26.1 Direct Worker

MVP 用。Installation は通常の Cloudflare Worker / R2 / route として provision される。

```txt
Installation -> normal Cloudflare Worker / R2 / route
```

### 26.2 Workers for Platforms

スケール後の adapter。tenant / user Worker dispatch runtime として使い、provider credential を持つ OpenTofu runner とは
分ける。

```txt
takosumi-dispatch Worker
  -> dispatch namespace
      ├─ user Worker: @shota/talk
      ├─ user Worker: @shota/files
      └─ user Worker: @company/chat
```

managed (takosumi-hosted) な Cloudflare Worker capsule は **plain OpenTofu** のまま namespace に入る。capsule は普通の
`cloudflare_workers_script` (+ 普通の KV / D1 / R2 + 普通の `bindings`) を書くだけで WfP 固有の HCL を持たない。pin した
cloudflare provider (v5) は script を namespace に置けないため、control plane は managed run (operator-default credential、
§7.1) でのみ cloudflare provider の `base_url` を **cf-proxy** (`<origin>/internal/cf-proxy/<ns>/<installSlug>/client/v4`) に
向ける。cf-proxy は `…/workers/scripts/{n}` を `…/workers/dispatch/namespaces/{ns}/scripts/{installSlug}-{n}` に書き換え、
その他 (KV / D1 / R2) は素通しする。`{installSlug}` prefix で namespace 内 script 名が install 間で一意になる。capsule は
`base_url` を上書きできない (generated root が `providers = {}` を child に渡すので capsule の provider block は tofu plan で
落ちる、fail-closed)。self-host / 非 Worker capsule は `base_url` を受け取らず byte-identical。provider token は
`TF_VAR_cloudflare<_alias>_api_token` で、token-vending Connection policy に Workers Scripts: Edit が必要。

## 27. Run lifecycle

### 27.1 Source sync

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

### 27.2 Compatibility check

```txt
1. SourceSnapshot展開
2. Capsule Normalizer実行
3. generated normalized module作成
4. tofu init without provider credentials
5. module tree scan
6. Capsule Gate
7. Gate findings を含む finalized CompatibilityReport 保存
8. Run succeeded / failed
```

### 27.3 Plan

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

### 27.4 Apply

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

### 27.5 Destroy

```txt
destroy_plan
  -> approval
  -> destroy_apply
```

## 28. Stale propagation

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

Stale reason は changed output 名単位で表示する。OutputSnapshot 全体 digest だけでなく、Dependency mapping に含まれる
`from` output の差分を reason に投影する。

RunGroup。

```txt
Space update

1. core
   ~ base_domain changed

2. files
   no changes

3. talk
   ~ variables changed

[Approve runs]
```

Space drift check。

```txt
Space drift check

1. core
   drift_check succeeded

2. files
   drift_check succeeded

3. talk
   drift_check succeeded
```

`space_drift_check` RunGroup は active Installation を Space 単位にまとめ、member Run はすべて
`Run.type="drift_check"` として記録する。各 drift_check は read-only で、`waiting_approval` にならず、apply できない。
drift がある場合は Installation ごとの `installation.drift_detected` Activity に aggregate metadata と public-safe
remediation hints を記録する。Activity metadata は add/change/destroy counts、provider / resource type / action
aggregate、provider/resource/action から導ける remediation hint に限定し、resource address、raw values、provider account /
zone / region / scope ids は出さない。

## 29. Policy

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
4. provider credential source
5. provider allowlist / provider env set policy
6. provider lockfile
7. data source allowlist
8. provisioner policy
9. resource type allowlist
10. action policy
11. scope boundary
12. dependency policy
13. output policy
14. quota
15. billing reservation
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

PolicyConfig。

```ts
type PolicyConfig = {
  allowedProviders?: readonly string[];
  allowedResourceTypes?: readonly string[];
  allowedDataSourceTypes?: readonly string[];
  allowedProvisionerTypes?: readonly string[];

  destructiveChanges?: {
    requireExplicitConfirmation: boolean;
  };

  providerLockfile?: {
    requireDigest: boolean;
  };

  providerInstallation?: {
    requireMirror: boolean;
  };

  providerCredentials?: {
    requireTemporary?: boolean;
    requireTtlEnforced?: boolean;
    requireRootOnly?: boolean;
  };

  scopeBoundary?: {
    mode?: "permissive" | "strict";
    cloudflare?: {
      accountIds?: readonly string[];
      zoneIds?: readonly string[];
    };
    aws?: {
      accountIds?: readonly string[];
      regions?: readonly string[];
    };
  };

  quota?: Record<string, number>;
};
```

`providerLockfile.requireDigest` は runner が `.terraform.lock.hcl` digest を返さない plan を block する。
`providerInstallation.requireMirror` は runner が返す actual provider install attestation を検査し、required provider
ごとの attestation が欠けている、または `tofu init` が filesystem mirror からの provider install として証明されていない
plan を block する。Runner は mirror 必須 policy が dispatch された run で per-run `TF_CLI_CONFIG_FILE` を生成し、
known required providers を `filesystem_mirror.include` と `direct.exclude` の両方に入れてから `tofu init` を実行する。
attestation には per-run CLI config digest、installed provider path、installed provider digest を含める。plan / apply /
destroy_apply は同じ policy dispatch を受け取る。plan は PolicyDecision / `plan.policy_evaluated` audit に verdict と
evidence count を保存し、apply / destroy_apply は runner response の independent provider install evidence を
`apply.provider_installation_evaluated` / `destroy.provider_installation_evaluated` audit event に保存する。これにより
registry/network fallback を policy 境界の外に逃がさない。
`providerCredentials.requireTemporary` / `requireTtlEnforced` / `requireRootOnly` は credential mint audit evidence を検査し、
provider/driver が短期 credential に対応する場合の static secret、TTL のない provider credential、root-only evidence のない
mint を operator/Space/InstallConfig policy で fail-closed にする。Space policy と InstallConfig policy は OR semantics で
merge され、より厳しい側が有効になる。
unknown provider / user env set provider は operator default connection に暗黙解決せず、Space-owned credential、provider
allowlist / lockfile / mirror policy、egress policy、runner policy を満たした場合だけ実行する。

Capsule Gate policy overlay。

```txt
CompatibilityReport
  static default Gate findings
  ↓
Space policy ceiling
  ↓
InstallConfig policy
  ↓
plan/apply pre-mint runnable decision
```

`provider_not_allowed` / `resource_type_not_allowed` / `external_data_source_unsupported` / `provisioner_unsupported`
は Space / InstallConfig policy が明示許可した場合にだけ runnable として再評価できる。`needs_patch`、
filesystem escape、missing local module、credential-in-source などの module safety finding は allowlist では上書きしない。

Resource allowlist。managed Takosumi default は **標準で無害な (tenant-scoped / data-plane の) Cloudflare resource type**
を既定で許可し、素の Cloudflare Capsule (Worker + その Pages / D1 / KV / Queues / R2 data plane) を curated bounded
InstallConfig なしで installable にする。Workers の static assets は provider v5 では `cloudflare_workers_script` に内包
されるため、別途 assets resource type は不要。

```json
{
  "allowedResourceTypes": [
    "cloudflare_workers_script",
    "cloudflare_workers_script_subdomain",
    "cloudflare_pages_project",
    "cloudflare_d1_database",
    "cloudflare_queue",
    "cloudflare_workers_kv_namespace",
    "cloudflare_r2_bucket",
    "aws_s3_bucket",
    "aws_s3_bucket_public_access_block",
    "random_id",
    "tls_private_key"
  ]
}
```

**既定から意図的に除外する type** (= Capsule の自前 data plane を越えて他ドメイン / 他テナントに到達しうるもの。明示的な
Space / InstallConfig allowlist がなければ実行できない):

- `cloudflare_dns_record` — 任意の hostname / record を repoint でき、token が書き込めるあらゆる zone で record / domain
  takeover が成立する。
- `cloudflare_workers_route` — Worker を zone 上の任意 hostname / route pattern に bind でき、token が触れるあらゆる zone
  で production traffic hijack が成立する。
- `cloudflare_zone` / `cloudflare_account` / `*_member` / zone・account レベルの設定 type — account / zone 設定や他テナント
  影響系であり、managed default には決して入れない。

これは **resource-type layer のみの security 境界拡張** である。他の policy layer — Capsule Gate (provisioner 禁止 /
filesystem-sensitive expression 検査)、provider allowlist (managed default は cloudflare のみ)、billing / credit
reservation (実コスト式)、scope / action policy、quota — は変更せず引き続き適用される。policy 拡張で他の layer を緩めない。
DNS record / Worker route / zone・account 設定のような除外 type は、vetted な curated bounded InstallConfig が `cloudflare_dns_record`
等を明示 allowlist した場合にのみ runnable になる (`resource_type_not_allowed` の policy 再評価; module safety finding は上書き不可)。

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

## 30. Security invariants

```txt
1. Public API returns no raw secret
2. User source executes only in Runner Container
3. Provider credentials are root-only
4. Provider credentials are ephemeral / short-lived where supported
5. Provider credentials are not normal tfvars files
6. Source phase receives Git credential only
7. Normalize phase receives no provider credential
8. Build phase receives build inputs only
9. Plan/apply/destroy phase receives provider credentials only
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
24. Provider install uses allowlist/mirror/lockfile policy and records non-secret install evidence
25. User env set providers use Space-owned credentials unless explicitly promoted to Takosumi提供
26. Unknown providers require provider env set / egress policy before runnable
27. Unknown providers use the configured non-managed runner boundary
```

## 31. Storage layout

```txt
R2_SOURCE/
  spaces/{spaceId}/sources/{sourceId}/snapshots/{snapshotId}/
    source.tar.zst
    source.json

R2_ARTIFACTS/
  spaces/{spaceId}/sources/{sourceId}/snapshots/{snapshotId}/
    normalized-module.json

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

Control backup は zstd 圧縮した sealed JSON。state backup は StateSnapshot objects の encrypted export tar、
artifacts manifest は R2 object key / digest / size inventory、service-data backup は Installation 固有データの encrypted tar。
service-data export の生成は isolated Runner Container または provider snapshot adapter に閉じ、control backup path は
provider data の取得や任意 command 実行をしない。

`CapsuleCompatibilityReport.normalizedObjectKey` / `normalizedDigest` は SourceSnapshot scoped
`normalized-module.json` を指す。Run scoped `normalized-module.tar.zst` は plan/apply workspace 用に展開・再梱包した実行 artifact。

## 32. Billing

### 32.1 Billing concept

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

### 32.2 Plans

```txt
Free
Pro
Team
Enterprise
Self-hosted
```

`BillingPlan` は typed `BillingPlanLimits` を持つ。Plan completion は active `SpaceSubscription` の
`maxEstimatedCreditsPerRun` と `quota` を評価する。`enforce` では limit 超過時に reservation 前に block し、`showback`
では超過を audit evidence に記録して続行する。

### 32.3 Credit Ledger

Apply 前に credit を見積もり、予約する。

```txt
tofu plan
  -> policy
  -> cost estimate
  -> BillingPlan limit check
  -> credit reservation
  -> approval
  -> apply
  -> usage event
  -> capture/release reservation
```

Hosted Stripe では Checkout / subscription webhook の `metadata.space_id` を Takosumi core に reconcile し、
`BillingAccount` / `SpaceSubscription` / Space `BillingSettings` を更新する。payment-mode Checkout は
`metadata.space_id` + `metadata.credits` を core の Space credit top-up に capture する。Stripe event の検証と customer /
subscription / payment 状態の正本は accounts plane が所有し、core は raw Stripe secret を受け取らず Space-scoped billing
ledger だけを更新する。既存 customer の plan / payment method / cancellation management は account-plane の Customer
Portal session route が Stripe Customer Portal に委譲し、dashboard Billing 画面は Checkout と Customer Portal の hosted
session を起動するだけで raw Stripe secret を扱わない。

#### 32.3.1 Plan cost estimate

上の `cost estimate` ステップは透明・決定的・テスト可能な式で credit を見積もる。plan の各 resource change はその change の最も重い OpenTofu action token の weight を持ち（replace は OpenTofu が `["delete","create"]` として表すため create + delete として二重計上せず create 1 回として課金する）、estimate は `credits = max(BASE, Σ per-change weight)` で求める。`BASE` は最小課金として常に下限を与える。weight 表は次のとおり（`create` / `replace` = 2、`update` = 1、`delete` = 1、`read` / `no-op` = 0、`BASE` = 1）で、change が無い plan は `BASE` に落ちる。`runner_minute` 系の実行時間課金はこの式に含めず、run 後に別の `UsageEvent` として計上し（将来 estimate に加える場合は additive な別項として足す）将来拡張とする。

| action | weight |
| --- | --- |
| `create` | 2 |
| `replace` | 2 |
| `update` | 1 |
| `delete` | 1 |
| `read` | 0 |
| `no-op` | 0 |
| `BASE`（下限） | 1 |

### 32.4 Billing types

```txt
runner_minute
managed_compute
managed_storage_gb_hour
artifact_storage_gb_hour
backup_storage_gb_hour
egress_gb
operation
```

### 32.5 Billing models

```ts
type BillingSettings =
  | {
      mode: "disabled";
      provider: "none";
      reservationRequired?: false;
    }
  | {
      mode: "showback";
      provider: "stripe" | "manual" | "none";
      reservationRequired?: false;
    }
  | {
      mode: "enforce";
      provider: "stripe" | "manual";
      reservationRequired: true;
    };

type BillingAccount = {
  id: string;

  ownerType: "user" | "space";

  ownerId: string;

  provider: "stripe" | "manual" | "none";

  stripeCustomerId?: string;

  status: "active" | "past_due" | "disabled" | "trialing";

  createdAt: string;
  updatedAt: string;
};

type SpaceSubscription = {
  id: string;

  spaceId: string;
  billingAccountId: string;
  planId: string;

  status: "active" | "trialing" | "past_due" | "cancelled";

  currentPeriodStart: string;
  currentPeriodEnd: string;

  createdAt: string;
  updatedAt: string;
};

type BillingPlanLimits = {
  maxEstimatedCreditsPerRun?: number;
  quota?: Record<string, number>;
};

type BillingPlan = {
  id: string;
  name: "Free" | "Pro" | "Team" | "Enterprise" | "Self-hosted" | string;
  monthlyBasePrice: number;
  includedCredits: number;
  limits: BillingPlanLimits;
  createdAt: string;
  updatedAt: string;
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

  status: "reserved" | "captured" | "released" | "expired";

  mode: "disabled" | "showback" | "enforce";

  createdAt: string;
  expiresAt: string;
};
```

### 32.6 Apply UI

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
aws.archive = my-aws-role
```

Self-host。

```txt
Billing disabled
or
Showback mode
```

## 33. Compliance / resale positioning

Takosumi hosted は third-party cloud provider そのものを再販売するのではなく、OpenTofu Capsule の control plane、
runner、managed runtime capability、state/artifact/backup/audit ledger を Takosumi service として提供する。

```txt
Sell:
  Takosumi Space
  Takosumi Managed Compute
  Takosumi Managed Storage
  Takosumi Runner Credits
  Takosumi Backup
  Takosumi Control Plane

Technical backend:
  Hosted managed default: Cloudflare only
  AWS / GCP / other providers: customer Space Connections or self-host/custom cases
```

Terms 表現の正本方針。

```txt
Takosumi provides a managed control plane, runner, and managed runtime capabilities.
Takosumi may use third-party cloud infrastructure providers to operate the service.
Customers purchase Takosumi features, not direct access to third-party cloud provider services.
```

日本語。

```txt
Takosumi は、OpenTofu Capsule のインストール、実行、更新、依存関係、状態、バックアップ、監査を管理するサービスです。
当社は本サービス提供のために第三者クラウド基盤を利用する場合があります。
お客様は当社サービスの機能を利用するものであり、当該第三者クラウドサービスの利用権、アカウント、資格情報、再販売権を取得するものではありません。
```

この章は product positioning の正本であり、契約条項そのものではない。Hosted offering の公開前に operator legal review を通す。

## 34. Backup / Export

Backup は2層。

### 34.1 Control backup

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

### 34.2 Service data backup

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

  mode: "none" | "artifact_export" | "provider_snapshot" | "custom_command";

  command?: string[];
  outputPath?: string;
};

type BackupRecord = {
  id: string;
  spaceId: string;
  installationId?: string;
  environment?: string;
  objectKey: string;
  digest: string;
  sizeBytes: number;
  serviceData?: {
    objectKey: string;
    digest: string;
    sizeBytes: number;
    exportedCount: number;
    unsupportedCount: number;
    missingCount: number;
  };
  createdByRunId?: string;
  createdAt: string;
};
```

Service data backup は control backup とは別の encrypted tar として保存する。Takosumi は service bytes を Worker process で
直接読むのではなく、isolated Runner Container `backup` action、provider snapshot adapter、または Installation が
`outputPath` に投影した durable export artifact を通して `service-data.tar.zst.enc` に固定する。`service-data.tar.zst.enc`
は service-data manifest と durable artifact refs / provider-native snapshot refs を含み、`runner-local://...` のように
Runner 終了後に読めない pointer は `exported` として記録しない。Backup route は
`Run.type = "backup"` の ledger row を作成し、`BackupRecord.createdByRunId` はその backup Run を指す。
operator / scheduled 以外の ad-hoc imported backup pointer では `createdByRunId` は省略できる。

```txt
artifact_export
  Installation が作った export artifact pointer を outputPath から読む

provider_snapshot
  Runner Container の backup action が source restore なしで operator-provided provider snapshot adapter command を実行する。
  provider hint がある場合は `TAKOSUMI_PROVIDER_SNAPSHOT_COMMAND_<SAFE_PROVIDER>` を generic
  `TAKOSUMI_PROVIDER_SNAPSHOT_COMMAND` より優先する。`SAFE_PROVIDER` は provider source を uppercase alnum/underscore
  の env suffix に正規化した名前。adapter command には `TAKOSUMI_BACKUP_PROVIDER` と
  `TAKOSUMI_BACKUP_OUTPUT_PATH` を渡す。adapter command が未設定の場合、operator が runner filesystem に置いた packaged
  provider snapshot manifest を読む。provider hint がある場合は
  `TAKOSUMI_PROVIDER_SNAPSHOT_POINTER_DIR/<safe-provider>/<safe-outputPath>.json` を優先し、無ければ legacy
  `TAKOSUMI_PROVIDER_SNAPSHOT_POINTER_DIR/<safe-outputPath>.json` に fallback する。`safe-provider` / `safe-outputPath` は unsafe filename
  文字を `_` に正規化した名前。command と pointer がどちらも未設定で、provider hint が Cloudflare / AWS の場合は runner
  packaged provider snapshot adapter が non-secret metadata manifest を `/work/artifact` に生成する場合、その
  `runner-local://...` pointer は durable artifact ではないため Backup service は missing として扱う。いずれの path も provider-native snapshot の artifact pointer/evidence だけを返し、
  adapter / pointer が未設定・未対応の provider は unsupported / missing として記録するか、Installation が outputPath に投影した
  pointer fallback を読む

custom_command
  Runner Container の backup action が BackupConfig.command を復元済み SourceSnapshot 上で実行し、
  stdout の artifact pointer を返す。
  runner が未 wiring の場合は command を実行せず、Installation が既に outputPath に投影した pointer fallback だけを読む
```

`provider_snapshot` と `custom_command` の実行はどちらも isolated Runner Container backup action 境界で行う。
`provider_snapshot` は restored SourceSnapshot を必要とせず provider-scoped adapter command、generic adapter command、
operator-provided packaged provider snapshot adapter、または Cloudflare / AWS packaged metadata adapter で動き、`custom_command` は
`command` を必須にして restored SourceSnapshot 上で credential-free に動く。control backup path は control ledger と
object manifest を束ねるだけで、provider data の取得、任意 command 実行、service data bytes のコピーをしない。

## 35. D1 schema

This is the logical deploy-control ledger schema, not a byte-for-byte dump of every physical D1 / Postgres table.
Physical implementations may use Drizzle and compact JSON ledger columns with materialized searchable columns, but the
logical records, uniqueness constraints, and cross-record references must preserve this model. Accounts-plane
identity/session storage is separate from this deploy-control ledger.
Operator-internal support tables such as `runner_profiles` are included here only when they affect deploy-control
evidence or runner dispatch; they are not public Takosumi vocabulary.

```sql
CREATE TABLE runner_profiles (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  mode TEXT NOT NULL,
  default_env_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE spaces (
  id TEXT PRIMARY KEY,
  handle TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  type TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  billing_account_id TEXT,
  billing_settings_json TEXT NOT NULL,
  policy_json TEXT NOT NULL,
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

CREATE TABLE provider_templates (
  id TEXT PRIMARY KEY,
  provider_source TEXT NOT NULL,
  display_name TEXT NOT NULL,
  capabilities_json TEXT NOT NULL,
  aliases_json TEXT NOT NULL,
  recommended_env_names_json TEXT NOT NULL,
  helpers_json TEXT NOT NULL,
  credential_sources_json TEXT NOT NULL,
  takosumi_managed_available INTEGER NOT NULL,
  allowed_resources_json TEXT NOT NULL,
  allowed_data_sources_json TEXT NOT NULL,
  policy_pack_id TEXT,
  cost_estimator_id TEXT,
  docs_url TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE provider_env_set_policies (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL,
  provider_source TEXT NOT NULL,
  template_id TEXT,
  outbound_policy_json TEXT,
  risk_level TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE connections (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  space_id TEXT,
  provider TEXT NOT NULL,
  status TEXT NOT NULL,
  connection_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
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
  source_id TEXT,
  installation_id TEXT,
  environment TEXT,
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

CREATE TABLE runs_inputs (
  plan_run_id TEXT PRIMARY KEY,
  inputs_json TEXT NOT NULL
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
  installation_id TEXT,
  source_id TEXT,
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
  mode TEXT NOT NULL,
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

CREATE TABLE backups (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL,
  installation_id TEXT,
  environment TEXT,
  created_by_run_id TEXT,
  backup_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX spaces_handle_unique
  ON spaces(handle);

CREATE INDEX sources_space_idx
  ON sources(space_id);

CREATE INDEX source_snapshots_source_idx
  ON source_snapshots(source_id);

CREATE INDEX provider_templates_source_idx
  ON provider_templates(provider_source);

CREATE INDEX provider_env_set_policies_space_idx
  ON provider_env_set_policies(space_id);

CREATE INDEX provider_env_set_policies_provider_source_idx
  ON provider_env_set_policies(provider_source);

CREATE INDEX connections_space_idx
  ON connections(space_id);

CREATE INDEX connections_status_idx
  ON connections(status);

CREATE UNIQUE INDEX operator_connection_defaults_provider_idx
  ON operator_connection_defaults(provider);

CREATE INDEX install_configs_space_idx
  ON install_configs(space_id);

CREATE INDEX capsule_compatibility_reports_source_snapshot_idx
  ON capsule_compatibility_reports(source_snapshot_id);

CREATE INDEX installations_space_idx
  ON installations(space_id);

CREATE INDEX installations_current_deployment_idx
  ON installations(current_deployment_id);

CREATE UNIQUE INDEX deployment_profiles_installation_environment_unique
  ON deployment_profiles(installation_id, environment);

CREATE INDEX deployment_profiles_installation_idx
  ON deployment_profiles(installation_id);

CREATE INDEX installation_dependencies_space_idx
  ON installation_dependencies(space_id);

CREATE INDEX installation_dependencies_producer_idx
  ON installation_dependencies(producer_installation_id);

CREATE INDEX installation_dependencies_consumer_idx
  ON installation_dependencies(consumer_installation_id);

CREATE INDEX output_snapshots_installation_idx
  ON output_snapshots(installation_id);

CREATE INDEX dependency_snapshots_run_idx
  ON dependency_snapshots(run_id);

CREATE INDEX output_shares_from_space_idx
  ON output_shares(from_space_id);

CREATE INDEX output_shares_to_space_idx
  ON output_shares(to_space_id);

CREATE INDEX output_shares_producer_idx
  ON output_shares(producer_installation_id);

CREATE INDEX run_groups_space_idx
  ON run_groups(space_id);

CREATE INDEX runs_space_idx
  ON runs(space_id);

CREATE INDEX runs_source_idx
  ON runs(source_id);

CREATE INDEX runs_installation_idx
  ON runs(installation_id);

CREATE INDEX runs_type_idx
  ON runs(type);

CREATE INDEX runs_created_at_idx
  ON runs(created_at);

CREATE INDEX state_snapshots_installation_idx
  ON state_snapshots(installation_id);

CREATE INDEX deployments_space_idx
  ON deployments(space_id);

CREATE INDEX deployments_installation_idx
  ON deployments(installation_id);

CREATE INDEX deployments_apply_idx
  ON deployments(apply_run_id);

CREATE INDEX artifacts_run_idx
  ON artifacts(run_id);

CREATE INDEX billing_accounts_owner_idx
  ON billing_accounts(owner_type, owner_id);

CREATE INDEX billing_accounts_status_idx
  ON billing_accounts(status);

CREATE INDEX space_subscriptions_space_idx
  ON space_subscriptions(space_id);

CREATE INDEX space_subscriptions_billing_account_idx
  ON space_subscriptions(billing_account_id);

CREATE INDEX usage_events_space_idx
  ON usage_events(space_id);

CREATE INDEX usage_events_run_idx
  ON usage_events(run_id);

CREATE INDEX credit_reservations_space_idx
  ON credit_reservations(space_id);

CREATE INDEX credit_reservations_run_idx
  ON credit_reservations(run_id);

CREATE INDEX credit_reservations_status_idx
  ON credit_reservations(status);

CREATE INDEX credential_mint_events_run_idx
  ON credential_mint_events(run_id);

CREATE INDEX credential_mint_events_space_idx
  ON credential_mint_events(space_id);

CREATE INDEX credential_mint_events_source_idx
  ON credential_mint_events(source_id);

CREATE INDEX security_findings_space_idx
  ON security_findings(space_id);

CREATE INDEX security_findings_run_idx
  ON security_findings(run_id);

CREATE INDEX security_findings_severity_idx
  ON security_findings(severity);

CREATE INDEX audit_events_space_idx
  ON audit_events(space_id);

CREATE INDEX backups_space_idx
  ON backups(space_id);
```

## 36. Single Worker code layout

This section separates the logical target layout from the current physical repo layout. The public model remains the
logical Space / Source / Connection / Provider Template / Provider Env Set / OpenTofu Capsule /
Capsule Normalizer / Compatibility Report / Capsule Gate / Installation / InstallConfig / DeploymentProfile /
ProviderBinding / Dependency / SourceSnapshot / DependencySnapshot / StateSnapshot / Run / RunGroup / Deployment /
OutputSnapshot / Backup / Billing / Activity surface;
physical directories are service-oriented implementation seams and are not public concepts.

Logical target layout:

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
        providers/
        provider-env-sets/
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

  runner/
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
    providers/
    billing/
    audit/

  opentofu-modules/
    core/
    cloudflare-worker-service/
    cloudflare-static-site/
    cloudflare-r2-storage/
    aws-s3-storage/
```

Current physical source layout:

```txt
takosumi/
  contract/                     public control-plane vocabulary (wire shape)

  core/                         provider-AGNOSTIC control plane
    api/
    adapters/
    domains/
      activity/ backups/ billing/ connections/ dependencies/ deploy-control/
      installations/ output-shares/ sources/ templates/   (templates/registry.ts = id+version Capsule registry)
    shared/

  providers/                    per-provider managed-resource impls + single-source registry
    registry.ts                 MANAGED_PROVIDERS (alias @takosumi/providers); types.ts
    cloudflare/                 connection + credentials drivers, hosting (WfP/cf-proxy), modules/<id>/
    aws/                        connection + credentials drivers, modules/<id>/
    git/                        git credential driver
    provider-env-set/           Space-owned env-set credential driver

  accounts/                     account-plane (contract / service / platform-services / cli)

  src/
    service/                    legacy code being folded into core/ per conformance M1
    runtime-agent/
    cli/

  worker/
    src/
      index.ts
      handler.ts
      container_runner.ts
      durable/
        CoordinationObject.ts
        OpenTofuRunnerObject.ts
      scheduled/
        polling.ts
        drift.ts

  deploy/
    platform/
      wrangler.toml
      worker.ts
    cloudflare/
      wrangler.toml
      wrangler.dispatch.toml
    local-substrate/
    node-postgres/

  dashboard/
    src/

  runner/
    Dockerfile
    entrypoint.ts
    tofu.rc.template

  lib/
    graph/
    policy/
    rootgen/

  opentofu-modules/             provider-agnostic `core` module + shared bundled-HCL catalog (module-files.ts).
    core/                       Provider-specific Capsule modules live under providers/<provider>/modules/<id>/.
```

## 37. wrangler shape

The operator-deployed platform Worker shape is represented in this repo by `deploy/platform/wrangler.toml`. The realized
config with real Cloudflare ids lives outside the public repo in the operator-private `takosumi-private` repository. The
public repo keeps placeholder ids only.

```toml
name = "takosumi"
main = "worker.ts"
compatibility_date = "2026-04-01"
compatibility_flags = ["nodejs_compat"]

[[routes]]
pattern = "app.takosumi.com"
custom_domain = true

# local-substrate canonical mirror:
# https://app.takosumi.test

[assets]
directory = "../../dashboard/dist"
binding = "ASSETS"
not_found_handling = "single-page-application"
run_worker_first = true

[[d1_databases]]
binding = "TAKOSUMI_ACCOUNTS_DB"
database_name = "takosumi-accounts"

[[d1_databases]]
binding = "TAKOS_D1"
database_name = "takosumi-deploy"

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
max_batch_size = 1

[[durable_objects.bindings]]
name = "COORDINATION"
class_name = "CoordinationObject"

[[durable_objects.bindings]]
name = "RUNNER"
class_name = "OpenTofuRunnerObject"

[[containers]]
class_name = "OpenTofuRunnerObject"
image = "../../runner/Dockerfile"
image_build_context = "../.."

[triggers]
crons = ["*/5 * * * *"]
```

## 38. API

Version prefix は置かず `/api` にまとめる。`/install` は public deep link で、dashboard session gate へ渡す。
`/hooks/*` は inbound webhook seam であり、operator bearer の `/api` surface ではない。

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
GET  /api/sources?spaceId={spaceId}
GET  /api/sources/:sourceId
GET  /api/sources/:sourceId/snapshots
POST /api/sources/:sourceId/sync
POST /hooks/sources/:sourceId
```

### Connections

```txt
POST /api/connections/source/https-token
POST /api/connections/source/ssh-key
POST /api/connections/cloudflare/oauth/start
GET  /api/connections/cloudflare/oauth/callback
POST /api/connections/cloudflare/token
POST /api/connections/aws/assume-role
POST /api/connections/gcp/oauth/start
GET  /api/connections/gcp/oauth/callback
POST /api/connections/gcp/impersonation
GET  /api/connections
POST /api/connections/:connectionId/test
POST /api/connections/:connectionId/revoke
PUT  /api/operator-connection-defaults
GET  /api/operator-connection-defaults
```

### Providers

```txt
GET  /api/providers
GET  /api/providers/:providerId
```

### Capsule compatibility

```txt
POST /api/sources/:sourceId/compatibility-check
GET  /api/compatibility-reports/:reportId
```

### Install configs

```txt
GET /api/install-configs
GET /api/install-configs/:installConfigId
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
POST /api/output-shares/:shareId/approve
POST /api/output-shares/:shareId/revoke
```

### Runs

```txt
POST /api/installations/:installationId/plan
POST /api/runs/:runId/approve
POST /api/runs/:runId/cancel
POST /api/installations/:installationId/destroy-plan
POST /api/installations/:installationId/drift-check
GET  /api/runs/:runId
GET  /api/runs/:runId/logs
GET  /api/runs/:runId/events
```

### Run groups

```txt
POST /api/spaces/:spaceId/plan-update
POST /api/spaces/:spaceId/drift-check
POST /api/run-groups/:runGroupId/approve
GET  /api/run-groups/:runGroupId
```

### Deployments

```txt
GET /api/installations/:installationId/deployments
GET /api/deployments/:deploymentId
POST /api/deployments/:deploymentId/rollback-plan
```

### Activity

```txt
GET /api/spaces/:spaceId/activity
```

### Billing

```txt
GET  /api/spaces/:spaceId/billing
GET  /api/spaces/:spaceId/usage
GET  /api/spaces/:spaceId/credit-reservations
POST /api/spaces/:spaceId/credits/top-up
POST /api/spaces/:spaceId/subscription/change
```

### Backups

```txt
POST /api/installations/:installationId/backups
POST /api/spaces/:spaceId/backups
GET  /api/spaces/:spaceId/backups
```

### Install link

```txt
GET /install?source=git::https://...
GET /install?git=https://...&ref=...&path=...
```

## 39. UI

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
Providers
Graph
Output shares
Backups
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
- provider "aws" -> Space AWS connection
- provider "cloudflare" -> default Cloudflare connection

[Continue]
```

Unknown provider。

```txt
This Capsule requires an unknown provider

Provider:
registry.opentofu.org/vercel/vercel

Takosumi can run it as a Custom Provider using your own credentials.

[Add Provider]
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
cloudflare.main: default
cloudflare.zone: default
aws.archive: @shota AWS connection

Policy
passed

Billing
Takosumi: 28 credits estimated
Your AWS: S3 charges may apply

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

## 40. MVP

最初に作る範囲。

```txt
Single Worker
Dashboard
Space作成
Operator default Cloudflare connection
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
Provider Templates basic
Provider Env Set basic
Provider binding: default / connection / manual
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
Billing public API basic
Stale propagation
Activity
```

最初の first-party OpenTofu Capsule catalog。

これらは Takosumi の product feature として内蔵する機能ではなく、generated root から呼ぶ plain OpenTofu child module
として管理する。`core` / `files` / `talk` は上の Space DAG で使う service example であり、`files` / `talk` という
module id がこの repo に bundled されているという意味ではない。

```txt
core
cloudflare-worker-service
cloudflare-static-site
cloudflare-r2-storage
aws-s3-storage
```

最初の managed default。

```txt
Cloudflare only
```

最初の verified Space providers。

```txt
Cloudflare
AWS
GCP
GitHub
Kubernetes
```

ここでの provider template は catalog / policy / docs support を意味する。MVP で runnable な connection helper は
Cloudflare API token、Git HTTPS token、Git SSH key、AWS AssumeRole、generic provider env set から
始める。Cloudflare OAuth / GCP OAuth / impersonation、GitHub token、Kubernetes kubeconfig は
`user_env_set` Connection を作成・更新・mint する補助機能として追加する。helper 未配線の host では該当 route が
認証後 `501 not_implemented` を返してよいが、credential source は `takosumi_managed` と `user_env_set` の2種類だけに保つ。

最初の user env set support。

```txt
generic provider source
template hint
credential env mapping
generic policy
custom runner
```

## 41. 実装順序

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
Operator default Cloudflare connection
Connection vault
Cloudflare token
Git token
Git SSH key
Provider binding
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
core first-party OpenTofu Capsule
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
provider binding
Plan/Apply
```

### Phase 7: Provider Templates

```txt
Provider Templates
Cloudflare entry
AWS entry
GCP entry
Provider Env Set
Generic env-set route
```

### Phase 8: Dependency Graph

```txt
installation_dependencies
variable_injection
DependencySnapshot
stale propagation
Graph UI
RunGroup basic
```

### Phase 9: Policy

```txt
provider allowlist
resource allowlist
data source allowlist
provisioner policy
scope boundary
action policy
output policy
quota
provider env set generic policy
```

### Phase 10: Billing

```txt
Space plan
CreditBalance
UsageEvent
CreditReservation
Apply estimate
Apply reservation
Stripe subscription integration
```

### Phase 11: Advanced

```txt
remote_state same-Space
OutputShare cross-Space
Auto-capsulized provider/backend lift
backup/export
provider_snapshot provider-scoped command/pointer adapters
migration
provider mirror/cache
Workers for Platforms adapter
```

## 42. 最終正本

```txt
Takosumi = Space直下のOpenTofu Capsule DAG Manager
```

```txt
Space
  GitHubのuser/orgに近い軽いowner namespace。
  billingはoptional。

Source
  Git URL / default ref / module path / optional auth connection を持つ source record。

OpenTofu Capsule
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

Provider Templates
  provider source / credential sources / recommended env names / helper を定義。

Provider Env Set
  ユーザーが Space に任意 provider の env credential set を追加する仕組み。
  Space-owned Connection として動く。

Connection
  operator default or space connection。

DeploymentProfile
  Installation / environment ごとの ProviderBinding set。

ProviderBinding
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
  source_sync / compatibility_check / plan / apply / destroy_plan / destroy_apply / drift_check / backup / restore を記録する execution ledger。

RunGroup
  DAG update / install / destroy / migration の複数 Run を順序づける単位。

Deployment
  成功したapply。

Backup
  control/state/artifact/service-data export 世代。

Activity
  audit_events から作る public-safe activity projection。

Billing
  Space plan + managed credits + apply reservation。
```

この仕様で、OpenTofu ecosystem を使いながら、顧客の Git URL をワンタッチで安全寄りにインストールできる。鍵は
generated root の provider configuration に閉じ、Capsule Gate と plan policy と IAM/connection boundary で不正利用を
抑え、互換性は Compatibility Report で明確に出す。
