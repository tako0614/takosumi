# 用語集

Takosumi のドキュメントで使う言葉を、ひとことずつ説明します。
仕組みの詳細は [Model reference](./model.md) を参照してください。

## 画面で使う言葉

通常の画面では内部の用語をそのまま出さず、次の言葉を使います。

| 画面の言葉 | 内部の用語 | 意味 |
| --- | --- | --- |
| サービス / アプリ | Capsule | ホストするアプリ、worker、API、site、storage など |
| 接続 | ProviderConnection / ProviderBinding | Cloudflare / AWS / GCP などのアカウント連携 |
| 変更内容 | plan (Run) | 反映する前に確認する変更の一覧 |
| 履歴 | Run の記録 / AuditEvent | いつ誰が何を変更したか |
| 復元ポイント | StateVersion | 変更のたびに保存される、戻れる状態 |

## 基本の言葉

| 用語 | 意味 |
| --- | --- |
| Takosumi | Git に置いた OpenTofu/Terraform module を、計画 → 確認 → 反映の流れで安全にデプロイ・管理する基盤ソフトウェアです。 |
| OpenTofu | インフラをコードで定義するオープンソースツール (Terraform 互換) です。Takosumi はこれを実行する側です。 |
| Workspace | ユーザーまたはチームの境界です。プロジェクト、接続、シークレット、履歴がこの中で分離されます。 |
| Project | Workspace の中の 1 つの製品・サービス・インフラのまとまりです。 |
| Capsule | 1 つの OpenTofu/Terraform module の実行単位です。ふつうは Git URL + ref + path から取り込みます。 |
| Source | Capsule の取り込み元です。Git URL / ブランチ / commit / ディレクトリで指定します。 |
| Run | 1 回の実行の記録です。plan / apply / destroy などの操作が、ログ・結果・実行者つきで残ります。 |
| plan / apply / destroy | plan は「何が変わるか」の計算と確認、apply は反映、destroy はリソースの削除です。どれも Run として記録されます。 |
| StateVersion | apply のたびに保存される state のバージョンです。復元ポイントとして使えます。 |
| Output | `tofu output -json` で取り出した値です。URL などの接続情報を、別の Capsule の入力につなげます。 |
| Secret | 暗号化して保存される秘密の値です。API からは書き込み専用で、ログには出ません。 |
| Runner | OpenTofu を実際に実行する隔離された実行環境 (sandbox) です。 |
| AuditEvent | 「誰が・何を・どうしたか」の監査記録です。 |
| Operator | Takosumi を自分や自分のユーザーのために運用する組織・人です。 |

## 接続と認証の言葉

| 用語 | 意味 |
| --- | --- |
| ProviderConnection | Cloudflare や AWS などの認証情報を安全に保存したものです。Run の実行中にだけ環境変数やファイルとして渡されます。 |
| CredentialRecipe | その provider を動かすために必要な環境変数・ファイル・事前処理の定義です。 |
| ProviderBinding | 「この Capsule のこの provider には、この接続を使う」という対応付けです。未設定の provider は勝手に補完されず、安全側に停止します。 |

## Resource Shape の言葉

`takosumi_*` リソースを使う場合にだけ出てくる言葉です。普通の OpenTofu module を使うだけなら読み飛ばせます。

| 用語 | 意味 |
| --- | --- |
| Resource Shape | 「オブジェクトストレージが 1 つほしい」のような、実装に依存しないリソースの型です。 |
| Target / TargetPool | Shape の解決先です。operator が有効化した実行先の候補とその集まりです。 |
| Policy | どの Shape をどこへ解決してよいかのルールです。 |
| Adapter | Shape を実際のリソースに変換する実装です。 |
| ResolutionLock | 一度解決した Shape → Target の対応を固定する記録です。 |
| NativeResource | 解決の結果つくられた実リソースの記録です。 |
| Space / Environment / Stack | Shape 用の名前空間・環境 (dev/prod など)・まとまりの単位です。 |
| Compatibility API | `compat.s3.v1` のように範囲とバージョンを明示した互換 API です。AWS や Cloudflare の完全互換ではありません。 |
