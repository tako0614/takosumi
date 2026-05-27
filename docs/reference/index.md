# リファレンス {#reference}

## 章の分け方

Takosumi docs は、Takosumi 本体仕様と Takosumi 公式型仕様を同じ docs site に置きます。ただし章は分けます。operator distribution の具体的な account layer 仕様は、その distribution の docs を正本にします。

Component kind の schema と出力データの vocabulary は Takosumi 公式型カタログが扱います。Cloud account layer の具体仕様は `takosumi-cloud/docs/` 側に置きます。

## Takosumi 本体仕様

- [仕様境界](./spec-boundaries.md) — Takosumi core、公式型カタログ、operator distribution の責務分離。
- [Takosumi core 仕様](./core-spec.md) — manifest / Installation / Deployment、Installer API、source/digest guard、connection grammar。
- [manifest (`.takosumi.yml`)](./manifest.md) — source root に置く declarative spec。root は required `apiVersion` / `metadata` / `components` と任意 `publish`。
- [プラットフォームサービス](./platform-services.md) — manifest 外の platform service path が提供する出力データを `listen.path` から受け取る model。
- [Installer API](./installer-api.md) — Installation / Deployment を作成・更新・ rollback する public Installer API。
- [HTTP 公開](./http-exposure.md) — public app endpoint を workload component output、gateway output、root publish による Installation output declaration で表現する model。
- [用語集](./glossary.md) — manifest / Installation / Deployment と隣接する用語の短い定義。

## Takosumi 公式型仕様

- [Takosumi 公式型カタログ](./type-catalog.md) — Takosumi が公開する kind の定義の語彙、出力の形式、注入モード、JSON-LD catalog metadata。
- [アクセスモード](./access-modes.md) — プラットフォームサービスの出力データの access metadata vocabulary。

## Takosumi Cloud 入口

Takosumi Cloud は別の operator distribution 仕様です。この docs site では入口だけを持ち、規定本文は `https://cloud.takosumi.com/docs/` と `takosumi-cloud/docs/{ja,en}/` に置きます。

- [Takosumi Cloud 入口](./takosumi-cloud.md) — Takosumi core / official catalog から別管理の Cloud docs へ進む入口。Cloud 側の account layer profile 正本は `takosumi-cloud/docs/ja/spec.md` と `takosumi-cloud/docs/en/spec.md`。

## 操作と補助

- [CLI](./cli.md) — Installer API を呼ぶ `takosumi` command surface。

## ビルド連携

- [ビルドサービス境界](./build-spec.md) — build service / CI が prepared source archive payload を作るための convention。
- [ビルドサービス例](../operator/build-service-profile.md) — Linux container を使う build service profile の非規定例。
- [ダイジェスト計算](./digest-computation.md) — `manifestDigest` と prepared source digest の計算。

## Reference implementation / package inventory

公式型を reference kernel に接続するための実装資料です。AppSpec core 仕様として読む章ではありません。

- [Kind Packages](./kind-packages.md) — portable / native kind package の所有境界。
- [Kind Binding 実装](./kind-bindings.md) — reference kernel が implementation binding を attach する方式。
- [Reference Adapter Loading](./plugin-loading.md) — `plugins` option を reference implementation の配線として扱う説明。

## 拡張

採用済み kind の定義の裏側に binding を追加するための資料です。

- [Takosumi を拡張する](../extending.md) — kind の定義と implementation binding の関係、互換境界、operator distribution が決める配線方法。

内部設計メモ、implementation binding メモ、operator 固有の運用メモは公開仕様の導線からは外しています。仕様として読ませるページはここに集約し、実装詳細は各 operator distribution と implementation repository の資料で扱います。
