# RFC 0001: Kernel kind-agnostic 化 {#rfc-0001-kernel-kind-agnostic}

> **Status**: Draft\
> **Date**: 2026-05-21\
> **Wave**: N\
> **Implementation**: component kind externalization implemented; build/source
> snapshot redesign pending

この RFC は Takosumi kernel をさらに小さくし、specific kind の descriptor
ownership を operator distribution 側へ移すための設計です。current
implementation の正本は
[AppSpec](../reference/app-spec.md)、[Installer API](../reference/installer-api.md)、
[Reference Kind Descriptors](../reference/kind-registry.md) です。

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
  publish?: string[];
  listen?: Record<string, ListenTarget>;
};
```

Wave N は、この縮小の次段階として次を目標にします。

- component kind resolution を operator distribution に移す。
- `Component.build` を kernel contract から外し、BuildSpec / build service に
  分離する。
- specific kind は operator distribution が JSON-LD descriptor と provider
  plugin で持ち込む。
- kernel は kind URI、namespace graph、provider lifecycle を実行する pure
  contract executor に近づける。

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
の前 に reject されます。ここでいう **fail-closed** は、kernel
が不明な入力を黙って fallback せず、副作用の前に明示的に失敗することです。

## Decisions {#decisions}

### 1. Alias resolution {#alias-resolution}

Decision: operator-injected alias map を採用します。

- `worker` のような short alias は operator が完全 URI に解決する。
- unresolved alias は provider operation 前に fail-closed。
- AppSpec は完全 URI を直接書くこともできる。

kernel は `https://takosumi.com/kinds/v1/worker` のような reference URI
を特別扱い しません。

### 2. Worker source shape {#worker-artifact-shape}

Decision: reference worker kind は `spec.entrypoint` を prepared source snapshot
内の source-root-relative path として読む。

理由:

- AppSpec 上に DataAsset metadata kind / hash を要求すると build service
  の出力形式が kind contract に漏れる。
- build 後 file path は worker kind の `spec` に置く方が、image / env / route 等
  と同じ system で扱える。
- provider implementation / runtime-agent は prepared source locator
  を受け取り、必要な file だけを読む。

### 3. Build sandbox {#build-sandbox}

Decision: build sandbox は operator responsibility に移し、`.takosumi.build.yml`
を build service input として定義します。

Wave N 後の AppSpec component は `kind` / `spec` / `publish` / `listen` の 4
field だけです。source を準備する recipe は BuildSpec に書きます。build service
は `.takosumi.yml` と `.takosumi.build.yml` を読み、Linux container などの build
kind を batch 実行し、build 後 source tree を tar + sha256 の prepared source
snapshot として固定します。kernel はその snapshot を `source.kind=prepared` と
して受け取り、AppSpec digest と source digest を Deployment に記録します。

reference build kind は次の URI です。

```text
https://takosumi.com/build-kinds/v1/linux-container
```

short alias `linux-container` は operator / build service distribution がこの
URI に解決できます。

BuildSpec component も AppSpec component と同じく `kind` / `spec` / `publish` /
`listen` を持ちますが、BuildSpec namespace は build-only であり AppSpec runtime
namespace とは混ぜません。

### 4. Source snapshot model {#source-snapshot-follow-up}

Decision: artifact / build の最終形は source snapshot model に寄せます。

- public AppSpec / BuildSpec から generic `artifact` concept を消す。
- build service は build 後 source tree / git state を content-addressed
  snapshot として固定する。
- provider implementation は lifecycle apply 時に source snapshot locator
  を受け取り、 自分の kind contract に従って必要な file / path / metadata
  を読む。
- `spec` 内の parameter は Takosumi が意味解釈しない implementation-owned
  variables と して扱う。
- kernel が Deployment evidence として記録するのは source snapshot digest /
  provenance / implementation output。DataAsset extension を使う provider
  は、その metadata value を operator / connector policy として扱う。

### 5. Reference distribution wording {#reference-distribution-wording}

Decision: takosumi-cloud は 1 つの reference operator distribution
として扱います。

別 distribution も同じ contract を満たせば置き換え可能です。docs では「current
kernel contract」と「reference distribution の実装例」を混ぜません。

### 6. Package architecture {#package-architecture}

Decision: `@takos/takosumi-plugins` は残し、scope を narrow します。

package URL stability を保ちつつ、reference descriptor helper、adapter、test
fixture の置き場へ縮小します。

### 7. Runtime-agent decoupling {#runtime-agent-decoupling}

Decision: runtime-agent decoupling は別 RFC で扱います。

runtime-agent が持つ worker-specific type の完全分離は別 RFC で扱います。Wave N
の実装は kernel registry と build responsibility の切り離しに集中します。

## Migration outline {#migration-outline}

1. operator config に alias map を追加する。
2. current reference kind を reference distribution 側の descriptor として移す。
3. kernel validation を alias map + implementation binding lookup に切り替える。
4. reference provider adapter が完全 URI の `provides[]` を宣言するようにする。
5. `Component.build` の kernel-owned execution を削除し、BuildSpec / build
   service / prepared source handoff へ移す。
6. `.takosumi.build.yml` の parser と build service handoff を追加する。
7. source snapshot locator model を導入し、worker artifact input を削除する。
8. current short alias を operator compatibility map として保持し、unresolved
   alias は fail-closed にする。

## Compatibility {#compatibility}

Wave N implementation は breaking change です。ただし migration 中は operator が
compatibility alias map と build migration tool を提供すれば、既存 AppSpec の
short alias と旧 build recipe は移行できます。最終状態では
`components.<name>.build` は fail-closed で reject されます。

`manifestDigest` は Installer API の existing wire field name として残ります。
docs 上では AppSpec digest と説明します。

## Open follow-up RFCs {#open-follow-up-rfcs}

- RFC 0002: runtime-agent hardcoded worker spec の完全分離。
- RFC 0003: Takos CLI app packaging contract の再整理。
- RFC 0004: worker source inputs の richer bundle / multi-file contract。
- RFC 0005: build service provenance / cache / remote execution policy。

## Implementation notes {#implementation-notes}

2026-05-23 時点で、component kind definitions の contract
外部化、`Component.build` 削除、prepared source handoff、reference worker の
`spec.entrypoint` 化は実装済み です。BuildSpec parser / remote build service の
production implementation は operator distribution の follow-up です。

## History {#history}

- Wave J: `Component.routes`、`AppSpec.interfaces`、`AppSpec.permissions`
  を削除。
- Wave K: AppSpec root の `kind: "App"` を削除。
- Wave L: `apiVersion: "takosumi.dev/v1"` を `apiVersion: "v1"` に変更。
- Wave N: kernel kind-agnostic 化、reference descriptor ownership の operator
  distribution 化、 `Component.build` 削除、prepared source / worker entrypoint
  model へ移行。
