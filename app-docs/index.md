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
   Takosumi が Git の版を読み、「インストール内容」にこのアプリが作るもの（予定）、必要な接続、
   設定を表示します。ストアのアプリは最新の安定版を使い、実際に読んだ版を画面に表示します。
   別の版を使うときは、押す前に **取得元と版** で指定します。
4. 接続が足りないときは、その接続の行の **接続する** から、同じ画面で接続を作成・確認します。
   アプリ名と設定もこの段階で変えられます。初期値は入力済みです。
5. **内容を確認** を押すと、このアプリがあなたのクラウドに作るもの（作成・変更・置き換え・削除の一覧）と
   料金の目安を表示します。料金を見積もれないときは「不明」と表示します。内容を確かめて
   **許可してインストール** を押したときだけ適用します。削除や置き換えを含む変更は確認のチェックが必要です。
   自動で適用することはなく、再読み込みや URL で適用が承認されることもありません。
   途中でやめるときは **やめる** を押すと、この試みで作った未適用のアプリを片付けます。
6. インストールが終わると、アプリが認可済みの起動 URL を公開していれば **開く** から起動できます。
   起動 URL がないアプリは **アプリを管理** で状態を確認します。失敗したときは原因を確認し、
   新しい変更内容で再試行できます。部分的に作成された状態は捨てません。
7. **アンインストール** は確認後に削除を予約します。アプリとデータは猶予期間中は保持され、
   削除の進行状態を同じ画面で確認できます。取り消しが許される間は予約を取り消せます。
   接続の秘密値やインストール入力をブラウザの保存領域へ記録することはありません。

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
