# Takosumi hosted service

Takosumi hosted service は、Git repository の OpenTofu module を実行し、必要なクラウドサービスに
接続する Takosumi のホスティングサービスです。plan、apply、state、output、監査、利用量、クレジットを
一つの Workspace で確認できます。

> **Status:** Pre-GA。コードや catalog entry が存在しても、利用可能とは限りません。
> Dashboard と認証済み Takosumi catalog に表示される `available` が現在の提供状態です。

## 最初のインストール

1. [ダッシュボード](https://app.takosumi.com/) にサインインし、ワークスペースを選びます。
2. **ストア** でアプリを選びます。Git URL やアプリのインストールリンクからも同じアプリの画面を開けます。
3. アプリの説明と公開元を確認して **インストール** を押します。この時点ではクラウドに何も作りません。
   押すと「インストール内容」の画面を開き、ここから先はこの 1 画面で進みます。
   Takosumi が Git の版を読む間は「リポジトリを読んでいます」と表示し、読み終えると
   このアプリが作るもの（予定）、必要な接続、設定、アプリ名と版を折りたたまずに並べます。
   ストアのアプリは最新の安定版を使い、実際に読んだ版を表示します。別の版は **版** の欄で
   tag・branch・commit を指定できます（押す前でも、画面を開いた後でも変えられます）。
4. 接続が足りないときは、その接続の行の **接続する** から、同じ画面で接続を作成・確認します。
   候補が 1 つだけの接続は自動で選びます。アプリ名と設定も同じ画面で変えられます。初期値は入力済みです。
   リポジトリに複数のアプリがあるときは、使うモジュールを同じ画面で選びます。
   入力した設定・アプリ名・版は、欄を離れる（または Enter を押す）と反映します。入力中は確認も許可も待ちます。
5. 足りないものがなくなると、Takosumi が「作られるものを確認しています」と表示して
   このアプリがあなたのクラウドに作るもの（作成・変更・置き換え・削除の一覧）と料金の目安を
   自動で表示します。この確認ではクラウドに何も作りません。料金を見積もれないときは「不明」と表示します。
   **許可してインストール** は最初から表示し、押せるようになるまでは理由（「接続を選ぶと確認できます」
   「必須の設定を入力してください」「確認しています…」など）を横に出します。内容を確かめて
   **許可してインストール** を押したときだけ適用します。削除や置き換えを含む変更は確認のチェックが必要です。
   自動で適用することはなく、再読み込みや URL で適用が承認されることもありません。
   確認が出た後にアプリ名・版・接続・設定を変えると、表示中の内容は古くなったものとして押せなくなり、
   「内容を作り直しています」と表示して、変えた内容で自動的に確認し直します。
   途中でやめるときは **やめる** を押すと、このインストールの試みを丸ごと捨て、未適用のアプリも片付けます。
   やめずに離れたインストールは、ストアの **途中のインストール** から続きを開くか、やめられます。
   開き直しただけでは何も進めず、**続ける** を押すと再開します。秘密の設定値は保存せず、
   作られるものを確認するときにだけ送ります。
6. インストールが終わると、同じ画面で **開く**（アプリが認可済みの画面を持っていれば）と
   **アプリを管理**（そのアプリのページ）を表示します。失敗したときは原因と次の操作が出て、
   新しい内容の確認から再試行できます。部分的に作成された状態は捨てません。
7. **アンインストール** は確認後に予約します。アプリとデータは猶予期間中は保持され、
   **アンインストールを取り消す** で戻せます。このアプリを使っている他のアプリは確認の画面に表示します。
   接続の秘密値やインストール入力をブラウザの保存領域へ記録することはありません。

## インストールしたアプリを保つ

ホームには、インストールしたアプリがすべて並びます（画面のないアプリ、インストール中のアプリも含みます）。
要対応・更新あり・インストール中は各アプリに表示し、画面のあるアプリは **開く** から起動できます。
アプリ名を押すとアプリのページを開きます。

- **要対応**: 失敗した変更、開けなかった画面、予約中のアンインストールを、そのアプリの問題として表示します。
- **版**: 現在の版（tag・commit）と新しい版、**更新**、自動更新、前の版に戻す、版の指定。
- **設定**: 値と、クラウドごとに使う接続を変えられます。接続はその場で作れます。
- **作られたもの**: 最後に適用した変更があなたのクラウドに作ったリソースをクラウドごとに数え、料金を表示します。
  料金が分からないときは「不明」と表示します。
- **連携しているアプリ**、**履歴**（各出来事から理由とログを開けます）、**アンインストール**。

更新・版の変更・設定の変更は、どれも同じページで **内容を確認** → 作られるものと料金の目安 →
**許可して更新** / **許可して適用** の順に進みます。自動で適用することはありません。

```text
Git repository
  → OpenTofu plan / review / apply
  → provider control plane
  → state + typed Output
  → authorized Interface
```

Cloudflare、AWS、Takoform などは runner から見ると同じ通常の provider です。各 provider
の control plane が作成した object の lifecycle を所有し、Takosumi は同じ object を別の
resource ledger に複製しません。

## Takosumi hosted service の役割

Takosumi hosted service は次を提供します。

- hosted dashboard、Accounts、runner、state、Output、audit
- provider connection と credential を、実行する runner の中にだけ実体として用意する仕組み
- prepaid credit、利用量、quota、spend guard
- 利用可能な hosted service と標準 protocol endpoint
- deployed service へ安全に接続する Interface / InterfaceBinding

Takosumi hosted service 独自の提供可否、価格、容量、請求、support は Takoform の Form maturity とは別です。
provider や schema が公開されただけでは hosted service は有効になりません。

## Takoform

Takosumi hosted service は official Takoform Host になる予定ですが、現在の candidate Host は未公開・
未接続です。公開前の FormRef、schema digest、Host route は production capability として
広告しません。

公開後も Takoform は hidden runner mode にはなりません。hosted service の既定接続は通常の
ProviderConnection / ProviderBinding を使い、利用者は自分の互換 Host 接続へ差し替えられます。

## Data endpoints

既存サービスのデータを扱うため、Takosumi hosted service は S3-compatible object access と
OpenAI-compatible AI access を提供できます。これらは作成 API ではありません。service の
lifecycle は repository の provider graph が管理し、endpoint と権限は Output / Interface
から取得します。

- [Resources and providers](./resources.md)
- [Data endpoints](./endpoints.md)
- [Pricing](./pricing.md)
- [Support](./support.md)
- [SLA](./sla.md)
- [Takosumi software docs](https://takosumi.com/docs/)
