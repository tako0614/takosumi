# Takosumi

Takosumi は、Git に置いた OpenTofu / Terraform のソフトウェアを、接続したクラウドへ
アプリのように追加して使うための管理サーバーです。追加や更新の前に、作られるものと
変わるものを確かめてからデプロイできます。

使う module と provider はそのままで、Takosumi 専用の設定言語はありません。

## できること

- **選んで追加する** — ストアのサービスや Git URL を選び、必要な接続と設定を入れて追加します。
- **デプロイする前に確かめる** — 作成・変更・削除されるリソースの数を見てからデプロイします。
  削除・置き換え・import を含む変更は、承認するまで進みません。
- **鍵を module に書かない** — クラウドの API key や token は Takosumi に保存します。
  値は読み戻せず、変更の確認やデプロイを実行している間だけ runner に渡ります。
- **記録を残し、戻せる** — 誰がどの commit をデプロイし、何が変わったかを記録します。
  デプロイごとの state を版として output とともに残し、以前の版の取得元に戻す変更も、
  確認してから適用できます。

## 始め方

目的に合わせて入口を選びます。

- **公式ホスティングで使う** — [app.takosumi.com](https://app.takosumi.com/)
  にサインインし、**ストア** でサービスを選ぶか、**Gitリポジトリから追加** で Git URL を
  入れて追加します。公式ホスティング（Takosumi hosted service）は正式提供前（Pre-GA）です。手順、
  料金、提供状況、サポートは[公式ホスティングのドキュメント](https://app.takosumi.com/docs/)に
  あります。
- **手元で追加からデプロイまで試す** — [クイックスタート](./getting-started/quickstart.md)
  に従い、Linux と Docker で dashboard、サインイン、データベース、runner を起動します。
  ローカル証明書と DNS の設定に `sudo` を使います。サンプルは外部リソースを作らないため、
  クラウドの認証情報は要りません。
- **自分の環境で運用する** — [自分で動かす](./concepts/self-host.md)で構成を選びます。
  Cloudflare の雛形は runner を含みます。Bun と PostgreSQL の雛形で plan と apply を
  実行するには、runner を別に組み込みます。
- **API だけ動かす** — 開発中の API 確認用に、[API だけ動かす](./getting-started/api-only.md)
  の手順でメモリ上の API サーバーを起動します。

## 仕組み

dashboard では、ストアで選んで追加するものを **サービス** と呼び、追加したサービスは
**ワークロード** の一覧に並びます。ホームから開く、サービス自身の画面は **アプリ** です。
docs と API では、追加したサービスを **Capsule** と呼びます。デプロイの 1 単位で、
Git URL・ref・module path と、変数・接続をまとめたものです（[用語集](./reference/glossary.md)）。

Capsule への変更は、変更の確認（plan）とデプロイ（apply）を別々の Run として記録します。
デプロイの Run は確認した変更の Run に結び付けられる（`planRunId`）ため、読んだ差分と
実際にデプロイする差分が一致します。

追加や更新は、次の順に進みます。

1. Git URL と module を指定する
2. 接続と入力を確認する
3. plan で変更内容を作る
4. 変更内容を確認する。削除・置き換え・import を含む場合は承認する
5. apply でデプロイする
6. state・output・履歴を保存する

Takosumi は first-party Terraform/OpenTofu provider を同梱しません。Cloudflare、AWS
などは、それぞれの既存 provider が操作します。

## 次に読むもの

- [全体像](./concepts/index.md) — 最小限の用語と、デプロイが進む順序
- [Source と Capsule](./concepts/sources.md) — Git の ref を commit に固定する方法
- [実行モデル](./concepts/run-model.md) — plan、承認、apply、destroy
- [認証情報](./concepts/credentials.md) — provider に接続を渡す方法
- [Interface](./concepts/interfaces.md) — デプロイの接続方法と利用許可
- [自分で動かす](./concepts/self-host.md) — production を運用するための構成
- [Repository manifest](./reference/repository-manifest.md) /
  [Store API](./reference/store-api.md) /
  [API](./reference/api.md) / [CLI](./reference/cli.md) /
  [設定](./reference/configuration.md)

旧 Resource Shape / Form Host API の資料は [Resource の移行メモ](./concepts/resources.md)
にまとめています。新しい authoring surface ではありません。
