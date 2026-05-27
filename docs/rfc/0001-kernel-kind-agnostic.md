# RFC 0001: Kernel kind-agnostic 化 {#rfc-0001-kernel-kind-agnostic}

> **Status**: Draft\
> **Date**: 2026-05-21\
> **Wave**: N\
> **Implementation**: component kind externalization implemented; BuildSpec parser / remote build service production implementation pending

この RFC は Takosumi をさらに小さくし、specific kind の semantics を Official Type Catalog または operator-adopted catalog に移すための設計です。 Public contract の正本は [Installer API](../reference/installer-api.md) です。 takosumi.com の kind schemas は Takosumi Official Type Catalog の kind の定義 documents であり、operator の設定が opt-in して Space に公開します。

この文書では、`manifestDigest` など既存 wire field の名前を除き、source root の `.takosumi.yml` を **manifest** と呼びます。

## Summary {#summary}

この RFC の current end state では、manifest contract は次の形まで縮小されます。

```ts
type Manifest = {
  apiVersion: "v1";
  metadata: Metadata;
  components: Record<string, Component>;
  publish?: Record<string, ServicePathExposure>;
};

type Component = {
  kind: string;
  spec?: unknown;
  connect?: Record<string, ConnectTarget>;
  listen?: Record<string, ListenTarget>;
};

type ConnectTarget = {
  output: `${string}.${string}`;
  inject: string;
  prefix?: string;
  mount?: string;
};

type ListenTarget = {
  path: string;
  inject: string;
  prefix?: string;
  mount?: string;
  required?: boolean;
};

type ServicePathExposure = {
  output: `${string}.${string}`;
  path: string;
};
```

Wave N は、この縮小のために次を目標にします。

- component kind resolution を operator の設定に移す。
- `Component.build` を Takosumi contract から外し、BuildSpec / build service に分離する。
- specific kind は Official Type Catalog または operator-adopted catalog が kind の定義として表し、operator の設定が implementation binding で実行可能にする。Takosumi Official Type Catalog は JSON-LD を公開形式として使う。
- Takosumi は kind URI、connect/listen graph、root publish service path、operator binding dispatch を扱う pure contract executor に近づける。

## Non-goals {#non-goals}

Wave N は次を扱いません。

- runtime-agent の hardcoded worker types を完全分離すること。
- workflow runner、cron、scheduler を Takosumi に入れること。
- account layer、billing、OIDC issuer、customer onboarding を Takosumi に入れること。
- existing Installer API の endpoint を増やすこと。

runtime-agent の完全 Takosumi-decouple は別 RFC で扱います。

## End state {#end-state}

Wave N 後の Takosumi は、operator が起動時に渡す alias map と implementation binding で kind を解決します。kind schema は operator tooling / docs / validation layer が持ちます。Takosumi reference implementation では implementation binding を reference adapter array で渡します。

```ts
const { app } = await createPaaSApp({
  kindAliases: {
    worker: "https://takosumi.com/kinds/v1/worker",
    postgres: "https://takosumi.com/kinds/v1/postgres",
  },
  plugins: [
    cloudflareWorkerPlugin({ lifecycle: workerLifecycle }),
    cloudflareR2ObjectStorePlugin({ lifecycle: objectStoreLifecycle }),
  ],
});
```

manifest author は short alias を使えます。未解決 alias はリソースの作成・更新の前に reject されます。ここでいう **fail-closed** は、Takosumi が不明な入力を黙って fallback せず、副作用の前に明示的に失敗することです。

## Decisions {#decisions}

### 1. Alias resolution {#alias-resolution}

Decision: operator-injected alias map を採用します。

- `worker` のような short alias は operator が完全 URI に解決する。
- unresolved alias はリソースの作成・更新の前に fail-closed。
- manifest は完全 URI を直接書くこともできる。

Takosumi は `https://takosumi.com/kinds/v1/worker` のような reference URI を特別扱いしません。

### 2. Worker source shape {#worker-source-shape}

Decision: reference worker kind は `spec.entrypoint` を resolved source view 内の source-root-relative path として読む。

理由:

- manifest 上に asset metadata value / hash を要求すると build service の出力形式が kind contract に漏れる。
- build 後 file path は worker kind の `spec` に置く方が、image / env / route 等と同じ system で扱える。
- implementation binding / runtime-agent は resolved source view locator を受け取り、必要な file だけを読む。

### 3. Build sandbox {#build-sandbox}

Current direction: build sandbox は operator / build-service responsibility に移す。`.takosumi.build.yml` は Takosumi core manifest ではなく、build-service の設定が採用できる input convention の一例です。

Wave N 後の manifest component は `kind` / `spec` / `connect` / `listen` の 4 field だけです。same-AppSpec component output は `connect.<binding>.output: component.outputSlot` で参照し、operator-provided platform service は `listen.<binding>.path: dotted.service.path` で参照します。Installation output service path declaration として記録する必要がある component output だけ、root `publish.<name>: { output: component.outputSlot, path: dotted.service.path }` に置きます。

source を準備する recipe は build-service の設定 / CI / operator automation が定義します。build service は `.takosumi.yml` と自分の build recipe input を読み、Linux container などの build runner profile を実行し、build 後 source tree を prepared source archive として固定します。Takosumi はその archive を `source.kind: "prepared"` として受け取り、取得した archive payload bytes の sha256 を計算し、`manifestDigest` と prepared archive payload digest を Deployment に記録します。

Example operator-local build runner profile name: `linux-container`. This is build-service vocabulary, not a Takosumi core kind URI and not official type catalog vocabulary.

BuildSpec は `nodes` map に build graph node を持ちます。各 node は `kind` / `spec` / `dependsOn` を使います。BuildSpec graph は build-time DAG で、runtime component connection は manifest component graph が所有します。

### 4. Resolved source view model {#resolved-source-view-follow-up}

Decision: artifact / build の最終形は resolved source view model に寄せます。

- manifest public contract and build-service input docs から generic `artifact` concept を消す。
- build service は build 後 source tree / git state を content-addressed prepared source archive として固定する。
- implementation binding は lifecycle apply 時に resolved source view locator を受け取り、自分の kind contract に従って必要な file / path / metadata を読む。
- `spec` 内の parameter は Takosumi が意味解釈しない implementation-owned variables として扱う。
- Takosumi の public Deployment record が記録するのは resolved source identity / `manifestDigest` / non-secret outputs。provenance や implementation output の詳細は deploy record として扱う。asset extension を使う provider は、その metadata value を operator / connector policy として扱う。

### 5. Reference distribution wording {#reference-distribution-wording}

Decision: takosumi-cloud は 1 つの reference operator の設定として扱います。

別 distribution も同じ contract を満たせば置き換え可能です。docs では「current Takosumi contract」と「operator の設定 / reference Takosumi の実装例」を混ぜません。

### 6. Package architecture {#package-architecture}

Decision: official descriptors and reference bindings are package-owned under `@takos/takosumi-kind-*`.

Portable kind packages define catalog descriptors and helper types. Native kind packages provide reference kernel bindings for concrete backends. The package name now tells readers which kind they are importing.

### 7. Runtime-agent decoupling {#runtime-agent-decoupling}

Decision: runtime-agent decoupling は別 RFC で扱います。

runtime-agent が持つ worker-specific type の完全分離は別 RFC で扱います。Wave N の実装は kernel registry と build responsibility の切り離しに集中します。

## Migration outline {#migration-outline}

1. operator config に alias map を追加する。
2. current reference kind を Official Type Catalog descriptor として移す。
3. Takosumi validation を alias map + binding lookup に切り替える。
4. reference adapter が完全 URI の `provides[]` を宣言するようにする。
5. `Component.build` の Takosumi-owned execution を削除し、BuildSpec / build service / prepared source handoff へ移す。
6. `.takosumi.build.yml` の parser と build service handoff を追加する。
7. resolved source view locator model を導入し、worker source input を `spec.entrypoint` に統一する。
8. current short alias を operator migration alias map として保持し、unresolved alias は fail-closed にする。

## Migration {#migration}

Wave N implementation は breaking change です。ただし migration 中は operator が migration alias map と build migration tool を提供すれば、既存 manifest の short alias と previous build recipe は移行できます。最終状態では `components.<name>.build` は fail-closed で reject されます。

`manifestDigest` は Installer API の existing wire field name として残ります。これは `.takosumi.yml` raw file bytes の sha256 です。

## Open follow-up RFCs {#open-follow-up-rfcs}

- RFC 0002: runtime-agent hardcoded worker spec の完全分離。
- RFC 0003: Takos CLI app packaging contract の再整理。
- RFC 0004: worker source inputs の richer bundle / multi-file contract。
- RFC 0005: build service provenance / cache / remote execution policy。

## Implementation notes {#implementation-notes}

2026-05-23 時点で、component kind definitions の contract 外部化、`Component.build` 削除、prepared source handoff、reference worker の `spec.entrypoint` 化は実装済みです。BuildSpec parser / remote build service の production implementation は operator の設定の follow-up です。

## History {#history}

- Wave J: `Component.routes`、`manifest.interfaces`、`manifest.permissions` を削除。
- Wave K: manifest root の `kind: "App"` を削除。
- Wave L: `apiVersion: "takosumi.dev/v1"` を `apiVersion: "v1"` に変更。
- Wave N: Takosumi kind-agnostic 化、kind schema は official catalog / operator の設定が決める形へ、 `Component.build` 削除、prepared source / worker entrypoint model へ移行。
