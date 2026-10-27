# Takosumi hosted service

Takosumi hosted service は、Git repository の OpenTofu module を実行し、必要なクラウドサービスに
接続する Takosumi のホスティングサービスです。plan、apply、state、output、監査、利用量、クレジットを
一つの Workspace で確認できます。

> **Status:** Pre-GA。コードや catalog entry が存在しても、利用可能とは限りません。
> Dashboard と認証済み Takosumi catalog に表示される `available` が現在の提供状態です。

## 最初のデプロイ

1. [ダッシュボード](https://app.takosumi.com/) にサインインし、ワークスペースを選びます。
2. **ストア** でアプリを選びます。Git URL やアプリの追加リンクからも同じ詳細画面を開けます。
3. アプリ情報を確認して **インストール** を押すと、同じ画面に設定が展開されます。
   Takosumi は Git の版と module を確認し、必要な項目だけを表示します。初期値は入力済みです。
   この時点ではアプリのリソースは作られません。高度な設定は必要に応じて開きます。
4. クラウド接続が必要なら **接続** を押します。同じ画面のパネルで既存の接続を選ぶか、
   対応する Provider の接続を作成・検証します。パネルを閉じてもアプリの入力は残ります。
5. 設定欄の **インストール** を押します。削除がなく、ポリシーを通過し、追加承認が不要な
   Plan はそのまま Apply に進みます。それ以外は、その場の **インストール内容の確認** で
   変更を確認・承認します。進捗とログを開け、ページの再読み込み後も既存の実行を確認できます。
   再読み込みや URL だけで Apply が承認されることはありません。
6. **インストール完了** 後、アプリが認可済みの起動 URL を公開していれば **サービスを開く**
   から起動できます。起動 URL がないアプリは **アプリを管理** で状態を確認します。
   失敗時には原因を確認し、新しい Plan で再試行できます。部分的に作成された状態を捨てません。
7. **アンインストール** は確認後に削除を予約します。サービスとデータは猶予期間中は保持され、
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
