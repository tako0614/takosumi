# Takosumi hosted service

Takosumi hosted service は、Git repository の OpenTofu module を実行し、必要なクラウドサービスに
接続する Takosumi のホスティングサービスです。plan、apply、state、output、監査、利用量、クレジットを
一つの Workspace で確認できます。

> **Status:** Pre-GA。コードや catalog entry が存在しても、利用可能とは限りません。
> Dashboard と認証済み Takosumi catalog に表示される `available` が現在の提供状態です。

## 最初のデプロイ

1. [Dashboard](https://app.takosumi.com/) にサインインし、Workspace を選びます。
2. Store または Git URL から repository を追加します。
3. 選んだ module が使う provider ごとに、対応する Connection を選びます。複数 provider が
   必要なら、それぞれに接続を割り当てます。
4. plan と見積りを確認し、apply します。
5. Run の Output と、アプリが公開した Interface から接続先を開きます。

Git URL から追加した場合、実行する module は取得した Git revision の scan 結果から選びます。
module の provider 要件に合う Connection を割り当てます。repository の表示ヒントや Connection
の名前は provider の照合を置き換えません。接続、plan の確認、失敗後の確認方法は
[Takosumi software docs](https://takosumi.com/docs/)を参照してください。Cloudflare や AWS などの
provider を使うために、別の Takoserver service を追加する必要はありません。

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
