# Takosumi hosted service

Takosumi hosted service は、Git repository の OpenTofu module を実行し、必要なクラウドサービスに
接続する Takosumi のホスティングサービスです。plan、apply、state、output、監査、利用量、クレジットを
一つの Workspace で確認できます。

> **Status:** Pre-GA。コードや catalog entry が存在しても、利用可能とは限りません。
> Dashboard と認証済み Takosumi catalog に表示される `available` が現在の提供状態です。

## 最初のインストール

1. [ダッシュボード](https://app.takosumi.com/) にサインインします（ワークスペースを切り替える必要がある場合だけ選択します）。
2. **ストア** でアプリを選びます。Git URL やアプリのインストールリンクからも同じアプリの画面を開けます。
3. アプリの説明と公開元を確認して **インストール** を押します。この時点ではクラウドに何も作りません。
   このあとも同じアプリのページで進みます。取得元と固定された版は **このアプリについて** から確認でき、
   **バージョン** で tag・branch・commit、**構成** で接続先・アプリ名・任意設定を変更できます。
   必須入力や接続が不足しているとき、入力に問題があるときは、その欄が開きます。
4. 接続が足りないときは、その接続の行の **接続する** から、同じ画面で接続を作成・確認します。
   候補が 1 つだけの接続と、ストアで指定された構成または候補が 1 つだけの構成は自動で選び、設定の初期値も入力済みです。
   複数の候補から構成を特定できないときだけ、同じ画面で使う構成を選びます。
5. 足りないものがなくなると、Takosumi が「作られるものを確認しています」と表示して料金の目安を出します（見積もれないときは「不明」）。
   この確認ではクラウドに何も作りません。作成するものの一覧は **リソースの詳細** から確認でき、既存リソースの変更や削除を含むときは詳細も開きます。
   **インストール** ボタンは最初から表示し、押せるようになるまでは理由（「接続を選ぶと確認できます」「必須の設定を入力してください」「確認しています…」など）を横に出します。
   内容を確かめて **インストール** を押したときだけ適用します（削除や置き換えを含む変更は確認のチェックが必要）。自動で適用することはなく、再読み込みや URL で適用が承認されることもありません。
6. インストールが終わると、同じ画面で **開く**（アプリが認可済みの画面を持っていれば）と
   **アプリを管理**（そのアプリのページ）を表示します。失敗したときは原因と次の操作が出て、
   新しい内容の確認から再試行できます。部分的に作成された状態は捨てません。
7. **アンインストール** は確認後に予約します。アプリとデータは猶予期間中は保持され、
   **アンインストールを取り消す** で戻せます。このアプリを使っている他のアプリは確認の画面に表示します。

### 途中で変更・再開・中断するとき

- **版の扱いと入力の反映**: ストアで版を指定しないときは **最新** と表示し、開始時点の最新の安定版を使います。保存済みの試行を開いたときはその試行の版を表示し、自動で新しい版へ切り替わることはありません。入力した設定・アプリ名・版は、欄を離れる（または Enter を押す）と反映し、入力中は確認も許可も待ちます。
- **確認後の変更と再確認**: 確認が出た後にアプリ名・版・接続・設定を変えると、表示中の内容は古くなったものとして押せなくなり、「内容を作り直しています」と表示して、変えた内容で自動的に確認し直します。
- **途中でやめる**: **やめる** を押すと、このインストールの試みを丸ごと捨て、未適用のアプリも片付けます。
- **離れた後に再開する**: やめずに離れたインストールは、ストアの **途中のインストール** から続きを開くか、やめられます。開き直しただけでは何も進めず、**続ける** を押すと再開します。この画面を使わずに始めたインストールがアプリを作る前に止まっていれば、ここに「ここでは続けられません」と表示され、**やめる** だけを選べます。
- **秘密情報の扱い**: 秘密の設定値は保存せず、作られるものを確認するときにだけ送ります。接続の秘密値やインストール入力をブラウザの保存領域へ記録することはありません。

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

## Takoform と Takoserver

[Takoform](https://takoform.com/) は移植可能な Form 定義と Host API・OpenTofu provider の仕様です。
[Takoserver](https://takoserver.com/) は、独立して運用できるクラウド制御基盤・Takoform Host です。
Takosumi hosted service は公式の Takoform Host 連携を予定していますが、現在の candidate Host は未公開・
未接続です。公開前の FormRef、schema digest、Host route は production capability として
広告しません。

公開後も Takoform は hidden runner mode にはなりません。hosted service の既定接続は通常の
ProviderConnection / ProviderBinding を使い、利用者は自分の互換 Host 接続へ差し替えられます。

## データエンドポイント

既存サービスのデータを扱うため、Takosumi hosted service は S3-compatible object access と
OpenAI-compatible AI access を提供できます。これらは作成 API ではありません。service の
lifecycle は repository の provider graph が管理し、endpoint と権限は Output / Interface
から取得します。

- [リソースとプロバイダー](./resources.md)
- [データエンドポイント](./endpoints.md)
- [料金](./pricing.md)
- [サポート](./support.md)
- [SLA](./sla.md)
- [Takosumi ソフトウェアのドキュメント](https://takosumi.com/docs/)
