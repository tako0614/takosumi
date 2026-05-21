# RFC 0001 — Kernel kind-agnostic 化 + Component.build 削除 + curated catalog 廃止

> **Status**: Draft (= 2026-05-21) **Wave**: N (= planned、 code implementation
> は別 wave / 後日) **Supersedes**: なし **Related**: Wave J (Component contract
> minimization)、 Wave K (AppSpec root envelope minimization)、 Wave L
> (apiVersion group prefix removal)

## 1. Summary

Takosumi kernel を **pure contract executor** に純化し、 specific な kind 概念
(= worker / postgres / object-store / custom-domain / build / oidc / etc.) を
**全て operator distribution が JSON-LD + plugin で 持ち込む** model
に移行する。 具体的には:

- `Component.build` field を削除 (= Component は 4 field に minimize)
- `spec/contexts/kinds/v1/*.jsonld` (= curated 4-kind catalog) を物理削除
- `packages/plugins/src/kinds/*` (= curated kind plugins) を物理削除
- `packages/contract/src/app-spec.ts` の `COMPONENT_KINDS` / `KIND_URI_BY_NAME`
  等 hardcoded kind list を全削除
- takosumi-cloud に新 JSR package `@takos/takosumi-cloud-kinds` を新設し、
  worker / postgres / object-store / custom-domain / build / oidc の 6 kind を
  `https://cloud.takosumi.com/kinds/v1/` 系で publish (= reference operator
  distribution として)
- 6 consumer apps の `.takosumi.yml` を新 contract に migration

これは Wave J → K → L 系列の **「底は自由」 minimization sequence の自然な
終点**。

## 2. Motivation

直近 Wave J / K / L で AppSpec contract を minimize した結果、 現状:

```typescript
interface AppSpec {
  apiVersion: "v1";
  metadata;
  components;
} // 3 field
interface Component {
  kind;
  spec?;
  publish?;
  listen?;
  build?;
} // 5 field
```

このうち `Component.build` は **唯一の non-kind-agnostic field** であり、 「全
kind が build を持ちうる」 という暗黙の前提と固定 shape (`{ command, output }`)
が contract に embed されている。

更に、 takosumi kernel は
`COMPONENT_KINDS = ["worker", "postgres",
"object-store", "custom-domain"]`
という curated 4-kind list を hardcoded で 持ち、 `KIND_URI_BY_NAME` 等で alias
解決を行う。 これは「kernel が specific kind を知っている」 という最後の特権で、
「底は自由」 原則 (= 「実装層の convention は spec contract の外」) に反する。

これらを取り除けば AppSpec は完全に kind-agnostic な接続 primitive (= namespace
pub/sub + Installation lifecycle) のみで構成され、 kernel は「contract
executor」 として specific な意味論を持たない。 全ての kind 意味論は operator
distribution の domain に。

User mandate (= 直近対話で確認):

- 「buildをコンポーネントから外していっぺんにやるべきだと思うし再現性があって今の
  コンポーネントと同じぐらい平等な仕組みにしたい」
- 「そもそも公式 kind 自体廃止したいかも → 本気 完全廃止」
- 「型をそれぞれ jsonld で定義して plugin 作って運用するだけじゃないの」

## 3. Contract end-state (= 第 1 軸 detail)

**AppSpec root** (= 3 field、 不変):

```typescript
interface AppSpec {
  apiVersion: "v1";
  metadata: AppSpecMetadata;
  components: Record<string, Component>;
}
```

**Component** (= 4 field、 `build` 削除):

```typescript
interface Component {
  kind: string; // URI or short alias
  spec?: JsonObject; // kind-defined, open
  publish?: readonly NamespacePath[]; // namespace edge out
  listen?: Record<NamespacePath, ListenOptions>; // namespace edge in
  // build?: ← 削除
}
```

**`kind` field の値**:

- 完全 URI: `https://<operator-domain>/kinds/<version>/<name>` (= 例
  `https://cloud.takosumi.com/kinds/v1/worker`)
- short alias: `worker` / `build` / etc. (= operator が installation 時に alias
  map で resolve、 §4 参照)

**`Component.build` 削除に伴う migration**:

- build recipe は別 component (= `kind: build`) に移管
- artifact は **namespace pub/sub** 経由で consumer component に届く (= build
  component が `publish: [<app-id>.<component-name>]` で artifact descriptor を
  namespace に置き、 consumer (= worker 等) が `listen: { ... }` で受ける)
- `Component.build` を含む YAML は parser が `validationPhase: "schema"` で
  fail-closed reject (= Wave J/K/L 同形 pattern)

**worker.spec.artifact 等の既存 spec field**:

- **keep** (= inline hash も listen 経由でも accept)
- 例: worker plugin の materializer が
  `spec.artifact: { kind: "js-bundle", hash:
  "sha256:..." }` の inline
  形式と、 `spec.artifact: { listen: "<namespace-path>"
  }` の listen 形式の
  oneOf を accept する。 worker.jsonld の spec schema を oneOf に拡張
- (= 完全 listen-only に純化するのは別 wave、 Open Question §7-2 参照)

## 4. Kind catalog architecture (= 第 2 軸 detail)

### 4.1 Pure contract executor 化

takosumi kernel (= `@takos/takosumi-kernel` + `@takos/takosumi-installer` +
`@takos/takosumi-contract`) は **specific kind を一切 ship しない**:

- `packages/contract/src/app-spec.ts` から `COMPONENT_KINDS`、
  `KIND_URI_BY_NAME`、 `KIND_NAME_BY_URI`、 `kindNameFromUri()`、
  `TAKOSUMI_KIND_URI_BASE` を削除
- `packages/installer/src/yaml-parser.ts` の kind validation を「URI 形式 check
  のみ」 に simplify (= hardcoded list 参照削除)
- `packages/plugins/src/kinds/` ディレクトリ完全削除 (= worker / postgres /
  object-store / custom-domain の `.ts` + `.generated.ts` 8 file)
- `spec/contexts/kinds/v1/` ディレクトリ完全削除 (= 4 jsonld file)
- `scripts/check-kind-uri-sync.ts` 削除 (= 同期チェック対象が無くなる)

`@takos/takosumi-plugins` package は **空に近くなる**: 旧 curated kind plugins
は移動済 (= 新 `@takos/takosumi-cloud-kinds` package に)、 残るのは factory
machinery (= `kernelPluginFromProviderPlugin` adapter 等の generic helper)
のみ。 deprecation narrative で明示 (= Open Question §7-5 で 廃止 vs keep
判断)。

### 4.2 Operator distribution が kind catalog を持ち込む

各 operator (= takosumi-cloud / 3rd party operator / self-host operator) が:

1. **JSON-LD で kind を publish**: 自分の domain 配下に
   `https://<operator-domain>/kinds/<version>/<name>.jsonld` を 配備
2. **Materializer plugin を実装**: `KernelPlugin` interface を満たす TypeScript
   plugin、 `provides: ["https://<operator-domain>/kinds/<version>/<name>"]` で
   自分が materialize できる kind URI を declare
3. **operator が `createPaaSApp({ plugins: [...] })` で kernel に attach**

kernel は plugin の `provides` list を見て kind URI → plugin の lookup table を
作る。 unknown kind (= 何 plugin も provide していない URI) は install 時に
reject。

### 4.3 Kind URI scheme

`https://<operator-domain>/kinds/<version>/<name>`:

- URI は **operator domain の identity** = 誰が責任を持つ kind catalog かを URI
  自体が示す
- 例:
  - `https://cloud.takosumi.com/kinds/v1/worker` (= takosumi-cloud が ship する
    worker、 = 「公式」 reference)
  - `https://example.com/kinds/v1/my-custom-resource` (= 3rd party operator が
    定義する custom kind)
- version segment (`v1`) は kind 進化のための namespace、 operator が独自に
  version bump 管理
- name segment は operator domain 内で unique、 各 operator が自由に命名

### 4.4 Alias resolution

AppSpec の `kind: worker` (= short alias) は kernel 単独では URI に resolve
できない (= kernel は specific kind を知らない)。 解決は **operator** が 担当:

**Option A (= default 推奨)**: **operator-injected alias map** — installation
context に `aliases: { "worker": "https://cloud.takosumi.com/kinds/v1/worker" }`
を inject、 kernel parser が AppSpec parse 時に alias を URI に resolve。
operator は `createPaaSApp({ aliases: {...} })` で alias map を kernel に渡す

**Option B (= alternative)**: **AppSpec metadata で kindCatalog declare** —
AppSpec root に `metadata.kindCatalog: "https://cloud.takosumi.com/kinds/v1/"`
を追加して、 各 kind alias を 当該 catalog の sub-path として解決。 これは
explicit だが contract surface が増える

Default は **Option A** (= operator-injected、 kernel pure を 保つ)。 Open
Question §7-1 で 議論余地あり。

### 4.5 Multi-operator app

1 AppSpec が **複数 operator の kind を mix** できる:

```yaml
apiVersion: v1
metadata: { id: com.example.app }
components:
  web:
    kind: https://cloud.takosumi.com/kinds/v1/worker # = takosumi-cloud
  custom:
    kind: https://example.com/kinds/v1/my-resource # = 3rd party
```

各 operator の plugin が `createPaaSApp({ plugins: [...] })` で attached されて
いれば kernel が DAG 解決 + materialize。 alias は必要に応じて operator が 全
catalog 分の map を 1 つに merge して inject。

### 4.6 Reference distribution: takosumi-cloud

takosumi-cloud は **公式 reference operator distribution** として 6 kind を
`https://cloud.takosumi.com/kinds/v1/` 系で publish:

- `worker` (= 既存 curated kind を移植 + 「artifact は inline / listen 両方 OK」
  shape 拡張)
- `postgres` (= 既存 curated kind を移植)
- `object-store` (= 既存 curated kind を移植)
- `custom-domain` (= 既存 curated kind を移植)
- `build` (= 新規、 §5 参照)
- `oidc` (= 既存 Wave I の oidc.jsonld を移植 + URI re-anchor)

「公式 = blessed」 ではなく **「1 つの reference implementation」**、
alternative operator distribution が同 contract (= 同じ kind JSON-LD shape +
materializer interface) を満たして置き換え可能。

self-host operator は典型的に `import "@takos/takosumi-cloud-kinds"` を
deno.json に追加するだけで標準セット取得 + cloud provider package を attach する
だけで動く形に (= migration の摩擦を最小化)。

## 5. Build kind details (= 第 3 軸 detail)

### 5.1 JSON-LD design

`https://cloud.takosumi.com/kinds/v1/build`:

```jsonld
{
  "@context": "https://takosumi.com/contexts/v1.jsonld",
  "@id": "https://cloud.takosumi.com/kinds/v1/build",
  "@type": "ComponentKind",
  "name": "build",
  "version": "v1",
  "aliases": ["build"],
  "description": "Artifact production recipe — shell command が source root で 走り、 output path の bytes を sha256-digest して namespace に publish する。 sandbox の有無は operator 責務。",
  "spec": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "type": "object",
    "required": ["command", "output"],
    "additionalProperties": false,
    "properties": {
      "command": {
        "type": "string",
        "description": "shell command (= sh -c で実行される)"
      },
      "output": {
        "type": "string",
        "description": "artifact path relative to source root + spec.source"
      },
      "source": {
        "type": "string",
        "default": ".",
        "description": "sub-path within AppSpec source tree (= monorepo 用)"
      }
    }
  },
  "publishes": [
    {
      "namespacePath": "<app-id>.<component-name>",
      "material": {
        "artifactUrl": "$outputs.url",
        "digest": "$outputs.digest",
        "kind": "$outputs.kind"
      }
    }
  ],
  "listens": {},
  "outputs": [
    {
      "name": "url",
      "type": "string",
      "required": true,
      "meaning": "digest-pinned artifact URL (= kernel artifact store の content-addressed locator)"
    },
    {
      "name": "digest",
      "type": "string",
      "required": true,
      "meaning": "sha256:<hex>"
    },
    {
      "name": "kind",
      "type": "string",
      "required": true,
      "meaning": "artifact kind: js-bundle / oci-image / tarball / etc."
    }
  ]
}
```

### 5.2 Materializer logic

既存 `defaultRunBuild()` (=
`packages/kernel/src/domains/installer/mod.ts:1048-1079`) 同等の logic:

1. AppSpec source root + `spec.source` で working directory 解決
2. `sh -c <spec.command>` で shell spawn (= 同期実行)
3. `spec.output` path の bytes を読む
4. sha256 hash を計算
5. kernel artifact store に upload (= 既存 store API: `POST /v1/artifacts`)
6. namespace material を `{ artifactUrl, digest, kind }` の shape で publish

sandbox の有無は operator 責務 (= Open Question §7-3)。 takosumi-cloud reference
implementation では unsandboxed (= host で直 spawn)、 sandbox 化したい operator
は自前 plugin で wrap。

### 5.3 Polyglot

1 AppSpec に **複数 `kind: build` component** を置ける:

```yaml
components:
  web-bundle:
    kind: build
    spec: {
      command: deno task build:web,
      output: dist/web.js,
      source: ./packages/web,
    }
    publish: [com.example.app.web-bundle]
  worker-bundle:
    kind: build
    spec: {
      command: deno task build:worker,
      output: dist/worker.js,
      source: ./packages/worker,
    }
    publish: [com.example.app.worker-bundle]
  migration-script:
    kind: build
    spec: {
      command: cargo build --release --bin migrate,
      output: target/release/migrate,
      source: ./services/db,
    }
    publish: [com.example.app.migration]
```

kernel DAG 解決で各 build が並列実行可能 (= 互いに listen していなければ依存
なし)、 consumer (= web / worker / db migrations) が個別に listen で受ける。

### 5.4 Worked example: yurucommu の build flow 変換

**Before (= Wave J/K/L 時点、 現状)**:

```yaml
apiVersion: v1
metadata: { id: jp.yurucommu.test }
components:
  web:
    kind: worker
    build:
      command: deno task build:worker
      output: dist/worker.js
    spec:
      artifact: { kind: js-bundle, hash: "{{ build.digest }}" }
      # ... 他 worker config
```

**After Wave N**:

```yaml
apiVersion: v1
metadata: { id: jp.yurucommu.test }
components:
  web-bundle:
    kind: build # = aliases ["build"] → resolved by operator to https://cloud.takosumi.com/kinds/v1/build
    spec:
      command: deno task build:worker
      output: dist/worker.js
    publish:
      - jp.yurucommu.test.web-bundle
  web:
    kind: worker # = aliases ["worker"] → resolved by operator to https://cloud.takosumi.com/kinds/v1/worker
    listen:
      jp.yurucommu.test.web-bundle:
        as: artifact
    spec:
      artifact:
        listen: jp.yurucommu.test.web-bundle # listen-based reference
      # ... 他 worker config
```

OR worker.spec.artifact を inline で keep する場合:

```yaml
web:
  kind: worker
  spec:
    artifact: {
      kind: js-bundle,
      hash: "...",
    } # = inline (= operator が事前 build 済)
    # ... 他 worker config
```

(= worker plugin の materializer が両方の shape を accept、 oneOf で declare)

## 6. Migration path (= 第 4 軸 detail)

### 6.1 Phase ordering

旧 Wave N-A〜F sub-wave に対応する 6 phase:

| Phase       | Scope                                                     | 主 touch point                                     |
| ----------- | --------------------------------------------------------- | -------------------------------------------------- |
| **Phase 1** | takosumi kernel kind-agnostic 化 + Component.build 削除   | takosumi 単一 commit、 60-80 file 修正             |
| **Phase 2** | takosumi-cloud に kind catalog 新設 + JSON-LD CDN publish | takosumi-cloud / packages/kinds/ 新設、 25-30 file |
| **Phase 3** | 6 cloud provider package `provides` URI re-anchor         | takosumi の 6 provider package、 24 ts file        |
| **Phase 4** | 6 consumer apps `.takosumi.yml` migration                 | yurucommu / road-to-me / takos-apps × 4            |
| **Phase 5** | cross-product docs / cli scaffold sweep                   | takos / takos-cli / takosumi-cloud docs            |
| **Phase 6** | ecosystem-root pointer bump + ROADMAP / CHANGELOG         | ecosystem-root 単一 commit                         |

各 phase で
`deno task check / lint / fmt:check / spec:check-drift / deno test
--allow-all`
全 PASS gate。

### 6.2 Rejection policy

Wave J / K / L 同形 **fail-closed reject**:

- 旧 `Component.build` 含む YAML は parser が `validationPhase: "schema"` で
  reject + migration message を返す
- 旧 hardcoded short alias (= `kind: worker` で alias map が未 inject の case)
  も同様に reject

backward compat なし (= 仕様策定中 phase の慣習)。

### 6.3 JSR package 影響

- `@takos/takosumi-plugins` package: 空に近くなる (= 旧 curated kind plugins は
  新 `@takos/takosumi-cloud-kinds` package に移動)
- 新 `@takos/takosumi-cloud-kinds` JSR package: 6 kind 全 ship する
  takosumi-cloud 由来 package
- 6 cloud provider package (=
  `@takos/takosumi-{cloudflare,aws,gcp,kubernetes,deno-deploy,selfhost}-providers`)
  は `provides: [URI]` を `cloud.takosumi.com` 系に re-anchor、 alternative
  として `createXProvider({ kindUri?: string })` factory で operator 自身が URI
  inject する形も検討 (= Open Question)

### 6.4 Reference distribution の継続性

self-host operator は 1 行追加で 現状互換:

```jsonc
// deno.json
{
  "imports": {
    "@takos/takosumi-kernel": "jsr:@takos/takosumi-kernel",
    "@takos/takosumi-cloud-kinds": "jsr:@takos/takosumi-cloud-kinds", // ← NEW
    "@takos/takosumi-cloudflare-providers": "jsr:@takos/takosumi-cloudflare-providers"
  }
}
```

`createPaaSApp({
  plugins: [...cloudKinds, ...cloudflareProviders],
  aliases: cloudKindAliases,
})`
の形で 標準 catalog + cloud provider + alias map を 1 まとめに attach。

### 6.5 Code state preservation

直近 (= 2026-05-21) に dispatch した Wave N-A code agent が **70 file 修正まで
進行 後 user 判断で中断**。 修正内容は `git stash@{0}` に "Wave N-A code changes
WIP" として保全:

```bash
# Wave N code implementation 再開時の手順
cd /root/dev/takos/takosumi
git stash list   # = stash@{0} を 確認
git stash apply stash@{0}   # = 70 file 修正を tree に戻す
# 以降 Phase 1〜6 を 連続実行
```

(= `git stash pop` ではなく `apply` を使えば、 万一の 失敗時に stash 自体は残る)

## 7. Open questions

実装に入る前に dialogue で 詰めるべき設計判断:

### 7.1 Kind alias resolution

| Option                                         | Pros                                                        | Cons                                                                      |
| ---------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------- |
| **A. operator-injected alias map**             | kernel surface 増加なし、 alias 解決を operator に delegate | alias 来歴が implicit、 同じ AppSpec が operator によって意味変わる可能性 |
| **B. AppSpec metadata で kindCatalog declare** | explicit、 同 AppSpec が portable                           | contract surface 増加、 多 catalog mix が冗長                             |

default: A、 dialogue で確定。

### 7.2 worker.spec.artifact inline mode 廃止のタイミング

| Option                                            | Trade-off                                                     |
| ------------------------------------------------- | ------------------------------------------------------------- |
| **Wave N で keep** (= safer migration)            | inline + listen の oneOf shape、 plugin が両方 accept         |
| **別 wave で remove** (= 完全 listen-only に純化) | より orthogonal だが consumer apps の migration cost が増える |

default: Wave N で keep。

### 7.3 Build kind sandbox

| Option                        | 責務                                                                                 |
| ----------------------------- | ------------------------------------------------------------------------------------ |
| **operator 責務** (= default) | takosumi-cloud reference は unsandboxed、 自前 plugin で wrap したければ operator が |
| **kernel 責務** (= 仕様 強制) | kernel が container / VM 内 で build を run、 reproducibility 強化だが complexity 増 |

default: operator 責務。

### 7.4 Curated catalog wording

| Option                                     | Wording                                                                    |
| ------------------------------------------ | -------------------------------------------------------------------------- |
| **A. 「公式 reference」**                  | takosumi-cloud が ship する kind catalog を「公式 / blessed」 と narrative |
| **B. 「1 つの reference implementation」** | takosumi-cloud は「単なる 1 operator distribution」、 alternative が同列   |

default: B (= sovereignty model と一貫)、 dialogue で確定。

### 7.5 JSR package architecture

| Option                        | `@takos/takosumi-plugins` package の 扱い   |
| ----------------------------- | ------------------------------------------- |
| **A. 空 keep** (= URL 安定性) | 既存 import 文が壊れない、 ただし confusing |
| **B. deprecate + remove**     | clean、 ただし migration cost               |

default: A。

### 7.6 runtime-agent の WorkerSpec etc 完全 kernel-decouple

Wave N scope に **含めない** (= 別 RFC 0002+ で扱う)。 narrative で先に明示
する? (= 「runtime-agent も別 wave で kernel-decouple する vision」 を 触れる)。
default: 触れる程度の言及のみ。

## 8. Implementation reference

実装の出発点として、 `git stash@{0}` の WIP code が **70 file 規模の参考実装**
に なる:

- 削除 file 一覧 (= `spec/contexts/kinds/v1/*.jsonld` 4 file、
  `packages/plugins/src/kinds/*` 8 file、 etc.)
- 修正 file (= contract / parser / kernel installer / 6 provider package / cli
  scaffold / AGENTS.md / CHANGELOG)
- 削除されなかった file (= 例: `runtime-agent/connectors/_spec.ts` の WorkerSpec
  narrative は touched but kept)

実装再開時は `git stash apply stash@{0}` + Phase 1〜6 連続実行 + 検証 gate 全
PASS。

## 9. Related RFCs / future work

- **RFC 0002 (= 想定、 未起票)**: runtime-agent kernel-decouple (= `_spec.ts` の
  hardcoded WorkerSpec / 他 spec types を完全 kernel-independent に)
- **RFC 0003 (= 想定、 未起票)**: takos-cli app-manifest contract rework (= 既に
  `build:` を reject 済の現状から、 .takosumi.yml format との関係を整理)
- **Future docs**: operator が独自 kind catalog で運用する end-to-end tutorial
  (= reference distribution narrative 確定後)

## 10. Acknowledgements

- Wave J / K / L (= 直近の minimization sequence) で確立した「底は自由」 原則 +
  fail-closed reject pattern を本 RFC が継承
- 直近の dialogue で user が示した design intuition (= 「公式 kind 自体廃止」 +
  「型をそれぞれ jsonld で定義して plugin 作って運用するだけ」) が本 RFC の core
- 直近 Wave N-A の code agent dispatch + 中断 + stash preserve workflow が本 RFC
  の implementation reference を 残してくれた
