# RFC 0001: Kernel kind-agnostic 化 {#rfc-0001-kernel-kind-agnostic}

> **Status**: Draft\
> **Date**: 2026-05-21\
> **Wave**: N\
> **Implementation**: component kind externalization implemented; BuildSpec
> parser / remote build service production implementation pending

この RFC は Takosumi kernel をさらに小さくし、specific kind の semantics を
official type catalog または operator-adopted catalog に移すための設計です。
current public concepts は AppSpec / Installation / Deployment で、public
Installer API の正本は [Installer API](../reference/installer-api.md) です。
takosumi.com の kind descriptors は Takosumi official type catalog の descriptor
documents であり、operator distribution が opt-in して Space に公開します。

この文書では、`manifestDigest` など既存 wire field の名前を除き、source root の
`.takosumi.yml` を **AppSpec** と呼びます。

## Summary {#summary}

Wave J / K / L で AppSpec contract は次の形まで縮小されました。

```ts
type AppSpec = {
  apiVersion: "v1";
  metadata: Metadata;
  components: Record<string, Component>;
};

type Component = {
  kind: string;
  spec?: unknown;
  publish?: Record<string, Publication>;
  listen?: Record<string, ListenTarget>;
};

type Publication = {
  as: string;
};
```

Wave N は、この縮小の次段階として次を目標にします。

- component kind resolution を operator distribution に移す。
- `Component.build` を kernel contract から外し、BuildSpec / build service に
  分離する。
- specific kind は official type catalog または operator-adopted catalog が
  descriptor metadata として表し、operator distribution が implementation
  binding で実行可能にする。Takosumi official type catalog は JSON-LD を公開形式
  として使う。
- kernel は kind URI、publish/listen graph、operator implementation binding
  dispatch を扱う pure contract executor に近づける。

## Non-goals {#non-goals}

Wave N は次を扱いません。

- runtime-agent の hardcoded worker types を完全分離すること。
- workflow runner、cron、scheduler を kernel に入れること。
- account-plane、billing、OIDC issuer、customer onboarding を kernel に入れる
  こと。
- existing Installer API の endpoint を増やすこと。

runtime-agent の完全 kernel-decouple は別 RFC で扱います。

## End state {#end-state}

Wave N 後の kernel は、operator が起動時に渡す alias map と implementation
binding で kind を解決します。kind descriptor は operator tooling / docs /
validation layer が持ちます。Takosumi reference kernel では implementation
binding を reference adapter array で渡します。

```ts
const { app } = await createPaaSApp({
  kindAliases: {
    worker: "https://takosumi.com/kinds/v1/worker",
    postgres: "https://takosumi.com/kinds/v1/postgres",
  },
  plugins: [
    cloudflareWorkerProvider(...),
    cloudflareR2Provider(...),
  ],
});
```

AppSpec author は short alias を使えます。未解決 alias は provider operation
の前に reject されます。ここでいう **fail-closed** は、kernel
が不明な入力を黙って fallback せず、副作用の前に明示的に失敗することです。

## Decisions {#decisions}

### 1. Alias resolution {#alias-resolution}

Decision: operator-injected alias map を採用します。

- `worker` のような short alias は operator が完全 URI に解決する。
- unresolved alias は provider operation 前に fail-closed。
- AppSpec は完全 URI を直接書くこともできる。

kernel は `https://takosumi.com/kinds/v1/worker` のような reference URI
を特別扱いしません。

### 2. Worker source shape {#worker-source-shape}

Decision: reference worker kind は `spec.entrypoint` を resolved source snapshot
内の source-root-relative path として読む。

理由:

- AppSpec 上に DataAsset metadata kind / hash を要求すると build service
  の出力形式が kind contract に漏れる。
- build 後 file path は worker kind の `spec` に置く方が、image / env / route 等
  と同じ system で扱える。
- provider implementation / runtime-agent は resolved source snapshot locator
  を受け取り、必要な file だけを読む。

### 3. Build sandbox {#build-sandbox}

Decision: build sandbox は operator responsibility に移し、`.takosumi.build.yml`
を build service input として定義します。

Wave N 後の AppSpec component は `kind` / `spec` / `publish` / `listen` の 4
field だけです。source を準備する recipe は BuildSpec に書きます。build service
は `.takosumi.yml` と `.takosumi.build.yml` を読み、Linux container などの build
kind を batch 実行し、build 後 source tree を prepared source archive として
固定します。kernel はその archive を `source.kind: "prepared"` として受け取り、
取得した archive payload bytes の sha256 を計算し、`manifestDigest` と prepared
source archive digest を Deployment に記録します。

reference build kind は次の URI です。

```text
https://takosumi.com/build-kinds/v1/linux-container
```

short alias `linux-container` は operator / build service distribution がこの
URI に解決できます。

BuildSpec は `nodes` map に build graph node を持ちます。各 node は `kind` /
`spec` / `dependsOn` を使います。BuildSpec graph は build-time DAG で、runtime
component connection は AppSpec component graph が所有します。

### 4. Source snapshot model {#source-snapshot-follow-up}

Decision: artifact / build の最終形は source snapshot model に寄せます。

- AppSpec public contract and build-service input docs から generic `artifact`
  concept を消す。
- build service は build 後 source tree / git state を content-addressed
  snapshot として固定する。
- provider implementation は lifecycle apply 時に source snapshot locator
  を受け取り、自分の kind contract に従って必要な file / path / metadata
  を読む。
- `spec` 内の parameter は Takosumi が意味解釈しない implementation-owned
  variables として扱う。
- kernel の public Deployment record が記録するのは resolved source identity /
  `manifestDigest` / non-secret outputs。provenance や implementation output
  の詳細は retained implementation/operator evidence として扱う。DataAsset
  extension を使う provider は、その metadata value を operator / connector
  policy として扱う。

### 5. Reference distribution wording {#reference-distribution-wording}

Decision: takosumi-cloud は 1 つの reference operator distribution
として扱います。

別 distribution も同じ contract を満たせば置き換え可能です。docs では「current
kernel contract」と「operator distribution / reference kernel の実装例」を混ぜ
ません。

### 6. Package architecture {#package-architecture}

Decision: `@takos/takosumi-plugins` は残し、scope を narrow します。

package URL stability を保ちつつ、official catalog helper、reference-kernel
adapter、test fixture の置き場へ縮小します。

### 7. Runtime-agent decoupling {#runtime-agent-decoupling}

Decision: runtime-agent decoupling は別 RFC で扱います。

runtime-agent が持つ worker-specific type の完全分離は別 RFC で扱います。Wave N
の実装は kernel registry と build responsibility の切り離しに集中します。

## Migration outline {#migration-outline}

1. operator config に alias map を追加する。
2. current reference kind を official type catalog descriptor として移す。
3. kernel validation を alias map + implementation binding lookup に切り替える。
4. reference provider adapter が完全 URI の `provides[]` を宣言するようにする。
5. `Component.build` の kernel-owned execution を削除し、BuildSpec / build
   service / prepared source handoff へ移す。
6. `.takosumi.build.yml` の parser と build service handoff を追加する。
7. source snapshot locator model を導入し、worker source input を
   `spec.entrypoint` に統一する。
8. current short alias を operator migration alias map として保持し、unresolved
   alias は fail-closed にする。

## Migration {#migration}

Wave N implementation は breaking change です。ただし migration 中は operator が
migration alias map と build migration tool を提供すれば、既存 AppSpec の short
alias と previous build recipe は移行できます。最終状態では
`components.<name>.build` は fail-closed で reject されます。

`manifestDigest` は Installer API の existing wire field name として残ります。
これは `.takosumi.yml` raw file bytes の sha256 です。

## Open follow-up RFCs {#open-follow-up-rfcs}

- RFC 0002: runtime-agent hardcoded worker spec の完全分離。
- RFC 0003: Takos CLI app packaging contract の再整理。
- RFC 0004: worker source inputs の richer bundle / multi-file contract。
- RFC 0005: build service provenance / cache / remote execution policy。

## Implementation notes {#implementation-notes}

2026-05-23 時点で、component kind definitions の contract
外部化、`Component.build` 削除、prepared source handoff、reference worker の
`spec.entrypoint` 化は実装済みです。BuildSpec parser / remote build service の
production implementation は operator distribution の follow-up です。

## History {#history}

- Wave J: `Component.routes`、`AppSpec.interfaces`、`AppSpec.permissions`
  を削除。
- Wave K: AppSpec root の `kind: "App"` を削除。
- Wave L: `apiVersion: "takosumi.dev/v1"` を `apiVersion: "v1"` に変更。
- Wave N: kernel kind-agnostic 化、kind descriptor ownership の official catalog
  / operator distribution 化、 `Component.build` 削除、prepared source / worker
  entrypoint model へ移行。
