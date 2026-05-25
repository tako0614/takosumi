# オペレーター {#operator}

operator は Takosumi を起動し、どの provider 実装、storage、 secret、runtime execution を使うかを決めます。アカウント管理 (課金・認証) / signup flow は operator のアカウント管理資料で扱います。Takosumi Cloud を使う場合は [Takosumi Cloud](../reference/takosumi-cloud.md) から参照します。

## 前提知識

- Manifest / Installation / Deployment のライフサイクル
- source の受け渡し (`git` / `prepared` / `local`) と dry-run 時のハッシュ照合
- 対応 kind 一覧の採用、kind の実行環境への接続、secret store、参照 API の分担
- public ingress を扱う場合の DNS / TLS の基礎

reference self-host 構成や Takosumi Cloud 構成が要求する runtime、 database、object storage は、それぞれの distribution docs に置きます。

## 読む順序

1. [コンセプト](../getting-started/concepts.md)
2. [仕様境界](../reference/spec-boundaries.md)
3. [Installer API](../reference/installer-api.md)
4. [外部サービス](../reference/external-publications.md)
5. [ビルドサービス境界](../reference/build-spec.md)
6. [ビルドサービス例](./build-service-profile.md)
7. [Takosumi Cloud 入口](../reference/takosumi-cloud.md)

## Operator が決めること

| 領域                 | 例                                                                    |
| -------------------- | --------------------------------------------------------------------- |
| source intake        | git source、ビルド済みアーカイブ、dev / operator-local source         |
| Space / actor policy | token claim、Space visibility、外部サービスへのアクセス               |
| kind resolution      | alias map、kind の定義、provider 実装の公開範囲                       |
| state / secret store | Postgres、secret encryption key、backup / restore                     |
| runtime execution    | embedded execution role、別 host execution role、cloud API credential |
| optional extensions  | content storage、observability、operator UI                           |

## 実装資料の置き場所

このサイトの公開導線は仕様と読者向け説明に絞っています。bootstrap、環境変数、 execution host、backup、readiness などの手順は、運用する distribution または repository-local の実装資料に置きます。Takosumi Cloud のアカウント管理 (課金・認証) と admin API は `takosumi-cloud/docs/` を正本にします。

## 関連ページ

- [Installer API](../reference/installer-api.md)
- [ビルドサービス境界](../reference/build-spec.md)
- [HTTP 公開](../reference/http-exposure.md)
- [CLI](../reference/cli.md)
